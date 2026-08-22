# Spec Delta — cli-routing

## ADDED Requirements

### Requirement: 入口参数单点路由
`dss` 的入口参数 SHALL 由一个纯函数 `route(argv)` 单点解析，返回结构化决策（subcommand / help / version / daemon / run / error）；index.js SHALL 仅按决策分发执行。判定顺序即不变量：① argv[0] 为已知子命令 → subcommand（保证 `dss npm -d` 等子命令参数不会被误判为 daemon 旗标）② help/version 旗标 → help/version（优先于 daemon）③ daemon 旗标 → daemon ④ 配置/未知选项/位置参数解析 ⑤ 其余 → run。

#### Scenario: 子命令优先于 daemon
- **WHEN** 执行 `dss npm -d`
- **THEN** 路由为 subcommand npm，不 fork 守护进程

#### Scenario: help 优先于 daemon
- **WHEN** 执行 `dss -d -h`
- **THEN** 显示帮助并退出 0，不启动守护进程（旧行为为直接启动守护进程）

### Requirement: 配置文件文法统一
`-c <path>`、`--config <path>` 与 `--config=<path>` 三种形式 SHALL 在主命令与子命令语境下同等接受（SHALL NOT 出现同一旗标两套文法）。

#### Scenario: 等号形式
- **WHEN** 执行 `dss --config=./x.json`
- **THEN** 按指定配置运行，而非报"未知选项"（旧行为）且与 `dss npm on --config=./x.json` 一致

### Requirement: 入口错误路径的提示语义
未知子命令与未知选项 SHALL 由路由层统一给出错误类型与建议（编辑距离 ≤2 的子命令建议、可用命令列表、配置文件用法提示），退出码 1；建议函数（suggestSubcommand 等）SHALL 随路由同居一个 module。

#### Scenario: 未知命令建议
- **WHEN** 执行 `dss state`
- **THEN** 输出"未知命令 + 你是不是想输入 + 命令列表"，退出码 1（与既有行为一致，由路由层测试锁定）

### Requirement: 路由可表驱动测试
route SHALL 为无副作用纯函数，全部决策分支（含 `-d -h`、`--config=`、空参数、`-c` 缺值）SHALL 由表驱动单测覆盖，不需要启动代理或 fork 进程。

#### Scenario: 表驱动单测
- **WHEN** 以参数数组逐条调用 route 并断言决策
- **THEN** 全部分支在 node:test 下秒级覆盖
