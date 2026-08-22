# Spec Delta — mirror-engine

## ADDED Requirements

### Requirement: 参数化镜像切换引擎
镜像切换 SHALL 由单一参数化引擎提供（switch / off / status），消费镜像表、官方源、adapter 的镜像读写原语与快照访问；npm 与 pip 的镜像命令 SHALL 仅为"表 + 工具特有文案"的薄调用方，不得存在第二份切换/恢复/快照实现。

#### Scenario: 引擎驱动两个工具
- **WHEN** `dss npm mirror <name>` 与 `dss pip mirror <name>` 执行
- **THEN** 两者走同一引擎实现，仅镜像表与文案不同

### Requirement: 企业源快照保护不变量单点实现
首次切换前 SHALL 快照当前源（重复切换不覆盖快照）；off SHALL 恢复快照原值（无快照时恢复官方源）；恢复后 SHALL 删除该工具的 mirror 快照段，mirror 父段为空时 SHALL 删除父段。该不变量 SHALL 由引擎单测锁定（企业内网源场景不丢失）。

#### Scenario: 企业源不丢
- **WHEN** 当前源为企业内网源，执行切换到公共镜像再执行 off
- **THEN** 源恢复为企业内网源原值，快照段被清理

#### Scenario: 重复切换不覆盖快照
- **WHEN** 已从官方源切到镜像 A（快照=官方源），再从 A 切到镜像 B
- **THEN** 快照仍为官方源

### Requirement: 引擎不拥有界面文案
switch/off/status SHALL 返回结构化结果对象（含变更前后值、快照原值等），中文提示与工具特有警示（如 npm 发布需官方源、代理冲突提醒）SHALL 由命令层生成。

#### Scenario: 结果对象
- **WHEN** 引擎 switch 成功
- **THEN** 返回 { ok, from, to, changed: true } 类结构，不含任何打印副作用

### Requirement: adapter 镜像写原语
npm 与 pip adapter SHALL 提供 `setMirror(value)` 写原语（与已有的 read().values.mirror 读原语配对），镜像值的落盘知识（npm config set registry / pip config set global.index-url）SHALL 归 adapter。

#### Scenario: 经由 adapter 写入
- **WHEN** 引擎执行切换
- **THEN** 值写入经由对应 adapter 的 setMirror，引擎不直接构造工具命令
