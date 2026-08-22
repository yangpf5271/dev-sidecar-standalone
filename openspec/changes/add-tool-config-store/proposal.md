# Proposal — add-tool-config-store

## Why

CLI 层对"各工具（npm/git/pip/docker）代理配置存在哪、怎么读、怎么写、什么算未设置"没有任何归属：读 npm 配置存在 6 处独立实现、docker 的 config.json 有 3 个独立读写方、加一个新工具要改 6–7 个文件（上一轮给 stop/restore 补 docker 清理时实际改了 6 个文件还漏改了一处文案）。更严重的是语义分叉：status 按端口子串判定"是否指向本代理"，restore 按精确候选集判定——同一个值会得到两个不同的答案，这是潜伏 bug 而非设计。镜像切换逻辑在 npm 与 pip 之间是约 150 行的改名手抄。

## What Changes

- 新增深 module **tool-config store**：唯一拥有各工具代理配置读写知识的所在；内部为 npm / git / pip / docker 各一个 adapter，满足同一 interface（read / classify / clean，clean 支持 dryRun 探测）。
- 两种匹配语义显式分离并命名：`classify`（宽松，端口子串，供展示）与 `isOurs`（严格，精确候选集 = 快照值 + host×port 组合 + 默认端口兜底，供清理）。证书类键按路径归一化后精确匹配。
- adapter 声明能力位（capabilities：proxy / mirror），调用方按位降级（如 pip 无代理能力、有镜像能力）。
- 错误契约统一为结果对象（含 ok/error 字段），`process.exit` 只发生在命令壳层。
- 快照工具段生命周期（写入时记录、恢复干净时清段）由 tool-config 拥有，"写配置 + 记快照"原子化。
- 现有 6 个调用方分三步迁移为薄调用方：① status 与 restore（两个平行读取方，修分叉本体）；② npm/git 命令的 on/off/status；③ docker 命令的 config.json 读写（写盘格式统一为 2 空格缩进 + 尾换行，auths 保真维持 JSON 值级）。
- 引入 node:test 单元测试（零新依赖）与 CI 快速 unit job；现有 CI shell 断言全部保持通过。
- 非 BREAKING：所有 dss 子命令的用户可见行为不变；唯一外部差异是统一后 status 对边界值（指向非本机地址但端口相同的值）的展示与清理判定出自同一份知识。

## Capabilities

### New Capabilities

- `tool-config-store`: 各工具代理配置的统一访问层——interface（read / classify / clean）、四个工具 adapter、能力位、两种匹配语义（classify 宽松 / isOurs 严格）、快照工具段生命周期、结果对象错误契约。

### Modified Capabilities

（无——openspec/specs/ 基线为空；status 与 restore 的对外行为不变，仅实现来源切换。）

## Impact

- **代码**：src/cli 层（status、restore-config、npm、git、docker 命令模块）与新增 tool-config module 目录；utils 的快照段职责保持为共享文件存储。上游冻结区 src/mitmproxy/lib/** 不动。
- **依赖**：零新运行时依赖；测试用 Node 内置 node:test。
- **CI**：新增独立快速 unit job（先于 3×3 矩阵），现有矩阵全部保留。
- **发布**：v1.5.0 先行发布（已含四块行为修复）；本变更收尾时 bump 1.6.0。
- **文档**：CONTEXT.md 领域词汇表随第①步入库（tool-config store / adapter / capabilities / classify / isOurs 等术语）。
