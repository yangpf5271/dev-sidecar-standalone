# design — refactor-adapter-factory-and-pull-layer

## Context

v1.5.0 已落地 tool-config store（四 adapter、classify/isOurs 双语义、快照生命周期）与镜像引擎，HEAD `6c098c3`，55 个单测全绿。双轴评审 + 两轮 grilling 确认了两处结构性残留（本提案的来源）：

1. npm/git adapter 同形度 75%（145 行 vs 120 行，规范化工具名后差异仅 67 行）。本轮修复 removed 语义与部分快照时同一改动写了两遍——双份成本已被实际支付，不是预估。
2. daemon.json 读取两份且语境不同：拉取层命令（`dss docker mirror` 系列）被 requireLinux 挡在 Linux/WSL 内运行故同步直读；status 面板在 Windows 宿主运行须经 wsl.exe 穿透并带 8 秒超时防冷启动挂起。**这是同一路径的两种访问语境，不是复制粘贴**——合并时必须保留语境差异。

约束：零用户可见行为变化；现有 55 测试断言一字不改全程全绿；零新增依赖（node:test、零 devDependencies）；tool-config 工厂注入面保持三项（run/homedir/snapshot），不出现第四项注入。

## Goals / Non-Goals

**Goals:**
- npm/git 清理/写入/快照语义单点实现；工具差异声明式化（含 postVerify 不对称的依据文档化）。
- 拉取层知识单点归属；status 展示与拉取层命令同源；WSL 超时保护有测试锁定。
- 为第三个工具 adapter 与候选 F（docker 命令拆分）铺路。

**Non-Goals:**
- 候选 F 完整拆分（本提案只是第一刀）。
- noProxy 聚合归属迁移（待讨论）；拉取层支持 daemon.json 之外的配置（待讨论）。
- 第三个工具的真实适配；docker adapter（build 层）与镜像引擎的任何改动。
- 任何用户可见输出变化。

## Decisions

**已决策区**（grilling 两轮确认，评审时不必重议）：

- **D1 参数化工厂 `createCliConfigAdapter(spec)`**，置于 tool-config 内部。备选被否：只抽 clean 骨架（留半份重复）/ rule-of-three 等第三工具（双份成本已实际发生，不等）/ 保持重复（测试网兜住行为但不兜住双份修改成本）。
- **D2 spec 元数据字段清单**（用户补充的元数据要求）：键清单与证书键、shell 调用差异、未设置哨兵语义（npm 'null'/'undefined'）、删除命令形态与失败容忍（git unset 退出码 5 / no such section）、作用域描述、postVerify 位。每个字段即一条"两 adapter 为什么不同"的显性知识。
- **D3 git 不加 post-delete verify——作用域依据（防"顺手统一"的原文）**：git 的读取命令带 `--global` 作用域，仅读全局配置层，仓库级/系统级同键配置不进视野，删除（同作用域）成功即确证；npm 的读取是合并源（环境变量 + 项目级 .npmrc + 用户级），删除后值仍可能被外层覆盖，故需重读验证。postVerify 差异是 spec 差异不是漂移，以元数据字段保留。
- **D4 removed=已验证不再生效、部分快照"并入不整段替换"在骨架单点实现**，各 adapter 不再各持一份（v1.5.0 修复语义的唯一权威实现点收敛为一处）。
- **D5 docker-pull 模块接口职责二分**（用户补充的接口要求）：读取语境层（本机直读 / WSL 穿透 + 超时）与字段解析层（registry-mirrors、insecure-registries，纯函数）各自独立；模块不聚合、不写回、不持文案。备选被否：收进 docker adapter（模糊 build 层/拉取层词汇边界，违反 CONTEXT.md）。
- **D6 消费方改道**：status 面板、拉取层命令的读取、noProxy 聚合的 insecure-registries 解析均改消费 docker-pull；各处私有实现删除。noProxy 聚合算法本身留命令层。
- **D7 label helper（"(未设置)/获取失败"契约）进共享工具**；unknown-mirror 打印块保持两份（各随镜像表，文案预期分化，第三份出现再抽）。
- **D8 CONTEXT.md 拉取层条目落地时补 module 归属句**；"noProxy 聚合"暂不立词汇条目。
- **D9 发布合并**：本变更落地前不发布；与 v1.5.0 已就绪内容一次发出。

**待讨论区**（本轮不实现，评审可提意见）：
- noProxy 聚合（内网段合并 + auths 主机 + insecure-registries + 用户追加）的最终归属——命令层、docker adapter、或候选 F 拆出的 docker 模块。
- 拉取层是否扩展支持 daemon.json 之外的其他配置（如 buildkit 配置）。

## Risks / Trade-offs

- [工厂 spec 参数表成为"差异清单"，可读性低于两份直白实现] → 元数据字段即 D2 清单，字段名自释；现有 npm/git 测试转为行为复验网，元数据分支（哨兵/容忍/postVerify 两路径）新增显式测试。
- [合并 daemon.json 读取时丢掉 WSL 超时或语境差异] → D5 职责二分 + WSL 超时场景为必测项；解析层纯函数直测。
- [重构引入行为回归] → 验收底线：55 测试断言零修改全程全绿；每切片独立可验证、CI 全绿后才进下一片。
- [status 面板读 daemon.json 的失败语义变化] → 消费方只改取数来源，提示文案与超时提示逐字保留。

## Migration Plan

垂直切片顺序（先独立低风险的拉取层，后行为敏感的工厂）：拉取层模块 + status 改道 → 拉取层命令/noProxy 改道 → 工厂骨架 + npm 切换 → git 切换（postVerify=false）→ 微清理 + 词汇表 → 全量回归 + 双轴评审。回滚策略：每切片独立提交，任一片回归即 revert 该片，不影响其余。

## Open Questions

见"待讨论区"两条（D 决策区之外，不阻塞实现）。
