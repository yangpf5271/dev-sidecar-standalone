# Design — add-tool-config-store

## Context

CLI 层（index.js + src/cli/*，约 3,100 行）是本项目自有代码的集中地（近 30 次提交的热点全部在此）；`src/mitmproxy/lib/**` 为上游冻结区，不参与本次重构。架构评审（2026-08-22，六假设全部实锤）量化了三处摩擦：

- "读 npm 配置"有 6 处独立实现（npm 命令 ×3、status、restore ×2），npm 的 'null'/'undefined' 未设置判定被归一化 4 次；
- `~/.docker/config.json` 有 3 个独立读写方，写盘格式已分叉（是否补尾换行）；
- status 与 restore 对"是否指向本代理"判定语义分叉（子串 vs 精确集）——同一值两个答案；
- npm/pip 镜像逻辑互为改名手抄（约 150 行）；
- 全项目 0 个单元测试，58 处 process.exit 使逻辑无法从测试壳调用。

约束：项目零 devDependency（曾为砍依赖自研 DoH 客户端）；CI 是当前唯一安全网（3 OS × 3 Node 的 shell 断言）；v1.5.0 待发布，重构须以 1.6.0 独立发布、可单独回滚。领域词汇见 CONTEXT.md（tool-config store / adapter / capabilities / classify / isOurs / 快照 / 智能恢复）。

## Goals / Non-Goals

**Goals:**

- 工具配置知识单点归属：新增工具 = 写 1 个 adapter，不再改 6–7 个文件。
- 匹配语义显式分离且永不复分叉：classify（展示，宽松）与 isOurs（清理，严格）。
- tool-config module 可离线单测（工厂注入假命令执行器/假主目录/假快照），CI 获得秒级失败信号。
- 三步迁移，每步 CI 绿、可独立发布、可回滚。

**Non-Goals:**

- 镜像切换引擎（候选 B）的完整实现——本期只预留 adapter 的 get/set 原语。
- 入口参数路由（候选 C）、docker 命令内部分层（候选 F）。
- 58 处 process.exit 的全面清理——只作为模式随迁移顺手收敛（候选 E）。
- 上游冻结区的任何改动。
- 任何用户可见命令行为的改变（status 对边界值的展示更准确除外）。

## Decisions

以下决策来自两轮 grilling（Q1–Q16 全部按推荐锁定），每条附当时考虑过的替代方案。

**D1 范围：只统一代理配置，镜像引擎是后续独立变更。**
替代：连镜像一起做——交付慢、一步不可发布。选择分期，但 adapter 从第一天暴露 get/set 原语，让镜像引擎届时直接消费——一个 seam 的两期工程，不是两套设计。

**D2 匹配语义：两个显式概念，classify（宽松：端口子串）/ isOurs（严格：精确候选集 = 快照值 + host×port 全组合 + 默认端口兜底）。**
替代 (a) 统一为精确集——status 变保守，丢提醒能力；(b) 统一为子串——restore 变激进，有误删用户配置的风险。两个语义服务不同目的：展示要"看起来像就提醒"，清理要"确凿才动手"。分离后分叉从 bug 变成设计。证书类键按路径归一化（大小写/分隔符）后精确匹配。

**D3 地址知识注入：isOurs(value, addr)，addr 由调用方解析后传入。**
替代：module 内部自行解析（依赖全局状态）。注入保持依赖单向（tool-config 不反向依赖参数解析层），且可用假地址直接单测。

**D4 pip 形状：能力位 capabilities: { proxy: false, mirror: true }，调用方按位降级。**
替代 (a) 全量 interface + 抛"不支持"——异常控制流；(c) pip 暂不进 tool-config——status 无法统一遍历。pip 的清理为显式 no-op：dss 从未写入 pip 代理，因此也不清理它（用户自设值绝不动）。

**D5 错误契约：结果对象 { ok, error }，不 throw；process.exit 只发生在命令壳层。**
替代：throw + try/catch——与现有 runCommand 返回风格冲突，全项目无 try/catch 习惯，会形成两种错误风格并存。

**D6 测试框架：Node 内置 node:test，零新 devDependency。**
替代：vitest/mocha——与"零依赖"的项目气质冲突（刚为砍依赖自研 DoH）。

**D7 实例化：工厂 createAdapters(ctx) + 默认真实实例同时导出。**
替代：纯单例——无法注入假依赖；纯工厂——生产代码每次要传依赖，加学习成本。默认实例让生产侧零成本，测试侧全额注入。

**D8 迁移顺序：三步走，且第①步即交付全部四个 adapter 的最小实现（read / classify / clean + dryRun）。**
替代：大爆炸一次切换——在"无单测、CI 是唯一安全网"的当下赌注太大。第①步同时切换 status 与 restore 两个平行读取方（修分叉本体），工作量不亚于后续步骤，但这是核心投入。第②步 npm/git 命令改薄并顺带收口 4 处重复的"代理未运行警告"；第③步 docker 命令的 config.json 读写迁入 adapter。

**D9 目录布局：独立目录（index 承载 interface 与工厂，四个 adapter 各一文件）。**
替代：单文件约 400 行——加第五个工具要动同一个文件。

**D10 快照所有权：tool-config 拥有工具段生命周期（写入时记录、恢复干净时清段），"写配置 + 记快照"原子化；快照文件的机械存取保留在既有共享工具层；mirror 段留给镜像引擎。**
替代：命令层继续手动调快照——存在"配置写了快照忘写"的半状态窗口。

**D11 classify 返回形状：结构化数据（mode ∈ none/mitm/tunnel/other + address），中文文案与 emoji 归命令层。**
替代：返回格式化字符串——module 拥有 UI 文案，未来任何机器可读输出都要改 module。

**D12 docker 写盘统一：docker adapter 独家拥有 config.json 读写，2 空格缩进 + 尾换行；auths 保真维持 JSON 值级（现状承诺不变）。**
替代：维持两个写方——格式分叉继续存在，"谁写的文件长得不一样"无法排查。

**D13 流程：不走 OpenSpec 提案流（用户后续明确选择以本 change 记录）；决策记录 = grilling 对话 + CONTEXT.md + 本 change。**

**D14 发布节奏：v1.5.0 先发（四块行为修复尽快到手），本变更收尾 bump 1.6.0 独立发布、可单独回滚。**

## Risks / Trade-offs

- [第①步体量大（module + 4 adapter + 两个调用方 + 单测 + CI job）] → 拆为可验证的提交序列：module 骨架 + classify 单测先行，adapter 逐个落地，最后切换调用方；每提交跑单测 + 本地 CLI 冒烟。
- [迁移期新旧两套并存（第①步后 npm/git 命令仍用旧实现）] → 分叉点已被 classify/isOurs 显式命名并单测锁定；第②③步是机械替换；现有 CI shell 断言全程作为行为安全网。
- [docker 写盘格式统一可能改变文件 diff 噪声] → 只影响 dss 写过的文件；auths 为 JSON 值级保真（现状即如此），不引入新承诺。
- [factory 注入面设计不当会变成泄漏的 interface] → 注入仅限 run（命令执行）、homedir、snapshot 访问三项；出现第四项时视为 adapter 划分问题，重新审视。
- [node:test 在 CI 最低支持版本（Node 18）上的兼容性] → node:test 自 Node 18 起稳定可用；unit job 单独使用最新 LTS，不进矩阵下限。

## Migration Plan

1. **第①步（核心）**：tool-config module（index + 4 adapter 最小实现：read / classify / clean+dryRun）+ classify/isOurs 单测 + status 与 restore-config 切换 + CI unit job + CONTEXT.md 入库。验收：CI 全绿（shell 断言不变）+ 单测覆盖六类关键用例。
2. **第②步**：npm/git 命令 on/off/status 改薄（set 走 adapter + 自动快照），收口"代理未运行警告" helper。
3. **第③步**：docker 命令 config.json 读写迁入 adapter，写盘格式统一。
4. 收尾：版本 bump 1.6.0，发布。回滚策略：任一步出问题，revert 对应提交即可——三步各自是完整可发布状态，无数据库/格式迁移，快照格式不变。

## Open Questions

（无——两轮 grilling 已穷尽 frontier，Q1–Q16 全部锁定。）
