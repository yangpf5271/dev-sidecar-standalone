# Proposal — add-mirror-engine-routing

## Why

架构评审（2026-08-22，报告见 %TEMP%\architecture-review-20260822-234335.html）认定的两个未完成候选，在 tool-config store（已归档）落地后成为自然收尾：**候选 B** —— pip 的镜像三件套是 npm 的改名手抄（约 150 行），"企业源快照保护"这一最重要不变量存在两份；adapter 的 get/set 原语已就位，引擎此刻是纯参数化工作。**候选 C** —— `process.argv` 解析散布 5 处，入口顺序不变量只活在注释里，且存在文法分叉（`dss npm on --config=./x.json` 合法而 `dss --config=./x.json` 报未知选项）与已知怪行为（`dss -d -h` 直接启动守护进程而不显示帮助）。

## What Changes

- 新增**镜像切换引擎**（mirror engine）：一个参数化实现（switch / off / status），消费 MIRRORS 表 + adapter 的读写原语，拥有快照 mirror 段的生命周期（首次快照、恢复、空段清理）。npm 与 pip 的镜像代码退化为表 + 文案。
- npm/pip adapter 补 `setMirror` 写原语（get 已有）。
- 新增**入口路由纯函数** `route(argv)`：单点解析全部入口参数，返回结构化决策（subcommand / help / version / daemon / run / error）；index.js 收缩为"route → 按需执行"。统一 `--config=<path>` 文法；help/version 优先于 daemon（修 `dss -d -h`）。
- 两块均以 node:test 单测锁定（引擎注入假原语、route 纯函数表驱动）。
- 非 BREAKING：子命令行为不变；唯一可见差异是 `--config=` 形式在主命令也可用、`-d -h` 显示帮助而非启动守护进程。

## Capabilities

### New Capabilities

- `mirror-engine`: 参数化镜像源切换引擎——表驱动的 switch/off/status、企业源快照保护不变量的单点实现、adapter 读写原语消费。
- `cli-routing`: 入口参数路由——route 纯函数的决策语义、文法统一、help/version 优先级。

### Modified Capabilities

（无——tool-config-store 归档基线不受影响；adapter 新增 setMirror 原语属实现细节，接口契约 read/classify/clean 不变。）

## Impact

- **代码**：新增 mirror engine 与 router module；npm.js / pip.js 镜像段改薄；index.js 入口重构；tool-config npm/pip adapter 增补 setMirror。
- **依赖/CI**：零新依赖；unit job 覆盖新增测试。
- **发布**：并入同一个 v1.5.0（单版本发布，不分 1.6.0）。
