# Design — add-mirror-engine-routing

## Context

tool-config store 已落地归档（factory + 四 adapter + 33 单测），adapter 的 read 已返回 mirror 值（npm registry / pip index-url）。本变更是架构评审候选 B（Strong）与 C（Worth exploring）的实施；候选 D（快照收紧）的 mirror 段部分随 B 完成；候选 E（可测性底座）作为模式随两块的测试落地；候选 F（docker 拆分）按评审结论搁置，等触发条件（第 5 个子命令或跨命令复用需求）。

## Goals / Non-Goals

**Goals:**

- 镜像切换逻辑一份实现：npm/pip 各只剩"表 + 工具特有文案"，"企业源快照保护"不变量单点单测。
- 入口参数单点解析：route 纯函数，顺序不变量从注释变为函数内的判定顺序；文法统一；`dss -d -h` 显示帮助。

**Non-Goals:**

- 镜像表扩充（新镜像源/新生态）。
- env/docker 警告收口之外的任何命令行为变化。
- docker.js 内部分层（候选 F）。
- 主命令外的子命令参数文法变化（`dss npm mirror` 的参数维持现状）。

## Decisions

**D1 引擎位置与形状**：`src/cli/tool-config/mirror-engine.js`，工厂 `createMirrorEngine({ name, official, mirrors, adapter, snapshot })`。adapter 提供 `read().values.mirror`（已有）与 `setMirror(value)`（本变更补齐）；snapshot 为 mirror 段访问器（默认绑 utils 快照的 mirror 子树）。选择消费 adapter 原语而非自行 runCommand——镜像读写知识同样归 tool-config（与代理配置同 seam）。

**D2 引擎返回结果对象、不含文案**：switch/off/status 返回结构化结果（{ changed, from, to, target, savedOriginal } 等），命令层负责中文文案与工具特有提示（npm 的"发布需官方源"、代理冲突提醒；pip 无）。理由与 tool-config D11 相同：module 不拥有 UI。

**D3 快照 mirror 段生命周期归引擎**：首次切换记原值（重复切换不覆盖）；off 恢复快照或官方源；恢复后删段、mirror 父段空则删父段——"建段→写→删段→空删父"的舞步从 npm.js/pip.js 的两份手抄收敛为引擎一份。

**D4 route 的判定顺序（顺序即不变量）**：① argv[0] 是已知子命令 → subcommand（保证 `dss npm -d` 不 fork 守护进程）→ ② 任一参数为 -h/--help 或 -v/-V/--version → help/version（**优先于 daemon**，修 `dss -d -h`）→ ③ 含 -d/--daemon → daemon（剥离该旗标，其余参数转交子进程）→ ④ 解析 -c/--config <v> 与 --config=<v>（统一文法）、未知选项、位置参数 → error（带类型与建议）→ ⑤ 否则 run。函数内从上到下的判定顺序就是从前靠注释维护的全部顺序不变量。

**D5 route 的落点**：`src/cli/router.js` 独立 module（index.js 保持入口身份，require router + 执行各分支）。suggestSubcommand/editDistance/printUnknownCommand 一并迁入 router（它们只服务入口错误路径）。

**D6 主命令文法统一后 utils.resolveProxyAddress 不动**：它本就支持 `--config=`，分叉在 main() 一侧，route 统一后自然消除；两处解析保持兼容语义。

**D7 版本策略**：并入 v1.5.0 单版本发布（用户决策：做完再发一个版本），不另设 1.6.0。

## Risks / Trade-offs

- [镜像行为回归] → 引擎单测覆盖"企业源不丢/重复切换不覆盖快照/空段清理"不变量 + 现有 CI mirror switch 测试原样保留（npm 切换往返 + runner pip 清除分支）。
- [route 重构引入入口回归] → route 表驱动单测覆盖全部决策分支（含 -d -h、--config=、`npm -d`）；现有 CI 的未知命令/未知选项/位置参数/守护生命周期断言原样保留。
- [npm/pip 文案差异混入引擎的诱惑] → 引擎只回数据；两命令的提示文案逐字保留（切片验证 diff 仅剩表与文案）。

## Migration Plan

1. 切片一：router module + route 纯函数 + 表驱动单测 + index.js 切换（行为等价 + 两处修正）。
2. 切片二：adapter setMirror 原语 + mirror engine + 引擎单测（假原语/假快照）。
3. 切片三：npm.js / pip.js 镜像段改薄为表 + 文案，行为与文案逐字对照。
4. 收尾：全量回归 + 双轴 code-review + 归档。回滚：各切片独立可 revert。

## Open Questions

（无——决策延续架构评审两轮 grilling 的既定结论。）
