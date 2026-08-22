# refactor-adapter-factory-and-pull-layer

## Why

v1.5.0 架构轮之后的双轴评审留下结构性残留：npm/git 两个 adapter 约 75% 逐行同形——本轮修复 removed 语义与部分快照时，同一行为改动被迫在两处各写一遍，双份成本已被实际支付；daemon.json 的读取知识存在两份（拉取层命令直读 vs status 面板经 WSL 穿透带超时），第三个消费方出现时将变成三份。下一个工具（uv/yarn/pnpm）接入或候选 F（docker 命令拆分）启动前，先把这两处单点化。

## What Changes

- npm/git adapter 的共同骨架（读取归一化/分类/严格清理/写入与部分快照/off 清除）抽为**参数化工厂**；两个 adapter 退化为声明式 spec 元数据（键清单、证书键、shell 调用、未设置哨兵、删除容忍码、作用域描述、postVerify 位）。对外 interface 不变，调用方零改动，全部现有行为由既有测试复验。
- 新建**拉取层知识模块**（docker-pull）：daemon.json 的读取（两种语境：Linux/WSL 内直读；Windows 宿主经 wsl.exe 穿透 + 超时保护）与字段解析（registry-mirrors / insecure-registries）职责二分、单点实现；status 面板、拉取层命令、noProxy 聚合均改为消费该模块，删除各自的私有实现。定位为架构候选 F 的第一刀。
- 微重复清理：npm/git status 的"(未设置)/获取失败"显示契约收进共享工具；unknown-mirror 打印块维持两份（第三份出现再抽）。
- CONTEXT.md"build 层/拉取层"条目补拉取层的 module 归属句（随实现落地）。
- 发布策略：本变更与 v1.5.0 已就绪内容**合并为一次发布**（本变更落地前不发布）。

## Capabilities

### New Capabilities
- `docker-pull`: 拉取层（daemon.json）知识的单点归属——读取语境（本机直读 / WSL 穿透带超时）与字段解析（registry-mirrors、insecure-registries）职责分离；status 展示与拉取层命令同源消费，不存在第二份读取/解析实现。

### Modified Capabilities
- `tool-config-store`: 新增需求"adapter 骨架参数化单点"——npm/git SHALL 由共享工厂构造，工具差异 SHALL 以声明式元数据表达（含 postVerify 差异的作用域依据文档化：git 读取仅作用域于全局配置层故无需删除后验证，npm 为合并源故需要）；removed=已验证不再生效、部分快照并入语义在骨架中单点实现。

## Impact

- 代码：tool-config store 内部（npm/git adapter 改为声明 + 工厂）、新增 docker-pull 模块、status 面板与 docker 命令的 daemon.json 读取改道、utils 增 label 契约函数。
- 行为：**零用户可见变化**（验收底线：现有 55 个单测断言一字不改、全程全绿）。
- 依赖：零新增依赖（继续 node:test、零 devDependencies）。
- 文档：CONTEXT.md 词汇表一处补句；本提案 design.md 承载"已决策/待讨论"分区。
- 发布：v1.5.0 发布时点后移至本变更完成后，一次发出。
