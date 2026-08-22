# tool-config-store Specification

## Purpose
TBD - created by archiving change add-tool-config-store. Update Purpose after archive.
## Requirements
### Requirement: 统一的工具代理配置访问接口
tool-config store SHALL 为 npm、git、pip、docker 各提供一个 adapter，全部满足同一 interface：`read()`（返回归一化后的配置值，未设置一律为 null）、`classify(addr)`（返回结构化分类）、`clean(addr, { dryRun })`（清理或探测指向本代理的配置）。调用方（status、restore、各工具命令、后续镜像引擎）SHALL 仅通过该 interface 访问工具配置，不得自行实现工具配置的读写。

#### Scenario: 读取归一化
- **WHEN** npm 配置中 proxy 未设置（读取结果为 'null' 或 'undefined'）
- **THEN** adapter 的 read() 返回值中该键为 null，调用方无需自行判断未设置哨兵值

#### Scenario: 探测不落盘
- **WHEN** 以 dryRun 调用 clean(addr)
- **THEN** 返回与真实清理相同结构的"将被清理项"清单，且不发生任何配置写入

### Requirement: 两种匹配语义显式分离
tool-config store SHALL 提供两个命名不同的匹配语义：`classify`（供展示，宽松——按端口号子串判定 mode ∈ none/mitm/tunnel/other）与 `isOurs`（供清理，严格——按精确候选集判定，候选集 = 快照记录值 + host×port 全组合 + 默认端口兜底）。同一值在两个语义下得到不同答案 SHALL 是被测试锁定的设计行为，而非实现漂移。

#### Scenario: 边界值分叉对（设计行为）
- **WHEN** 某工具的代理值为 `http://evil.com:31180`（非本机地址但端口与本代理 HTTP 端口相同）
- **THEN** classify 判定为 tunnel（展示为隧道模式），而 clean/isOurs 判定为非本代理配置、不清理

#### Scenario: 快照端口漂移恢复
- **WHEN** 用户在非默认端口启动代理并执行过 on（快照记录了实际地址），随后在默认端口语境下执行清理
- **THEN** clean 依据快照候选集正确清理非默认端口的配置

### Requirement: 用户自有配置绝对保护
clean SHALL 仅清理判定为本代理写入的配置项；用户自有的其他代理配置（不同端口的值、公司代理、自设证书路径）MUST 原样保留。证书类键 SHALL 在路径归一化（大小写与分隔符）后精确匹配。

#### Scenario: 第三方代理保留
- **WHEN** npm cafile 指向用户自设证书、git https.proxy 指向公司代理、docker proxies.default 指向其他代理地址
- **THEN** clean 后三者逐项原样保留

### Requirement: adapter 能力位
每个 adapter SHALL 声明 capabilities（proxy / mirror 两个布尔位），调用方 SHALL 按能力位降级而非依赖异常控制流。无代理能力的工具（pip）其 clean SHALL 为显式 no-op——dss 从未写入过的配置不清理。

#### Scenario: pip 代理值不被清理
- **WHEN** 用户自行设置了 pip 的 global.proxy（哪怕指向本代理地址）
- **THEN** clean 不修改它，status 按能力位展示为可用信息而非报错

### Requirement: 结果对象错误契约
adapter 的所有操作 SHALL 返回结果对象（成功含数据、失败含 error 描述），SHALL NOT 抛出异常，SHALL NOT 调用 process.exit。进程退出码 SHALL 仅由命令壳层决定。

#### Scenario: 工具命令不可用
- **WHEN** 执行环境中 npm 命令不存在，调用 npm adapter 的 read()
- **THEN** 返回 { ok: false, error } 描述命令不可用，调用方决定提示方式，进程不因此自行退出

### Requirement: 快照工具段生命周期
写入工具配置（on 路径）时 tool-config store SHALL 自动记录快照，且 SHALL 按实际写入推进：任一键写入失败时，此前已成功写入的键 MUST 已并入快照段（快照即实际写入值），不存在"有配置无快照"的半状态；清理完成且该工具段无残留用户数据时 SHALL 自动清除快照段。清理失败（删除后仍生效 / unset 失败）时 SHALL 保留快照段供下次重试，且此类项 SHALL NOT 计入 removed 清单——removed 仅含已验证不再生效的项。范围限定于按值匹配的工具（npm/git）；docker 的 isOurs 为端口匹配（见"两种匹配语义"），快照候选集对其无作用，不记录也不消费。快照的 mirror 段不属于本能力范围。

#### Scenario: 清理后快照段收敛
- **WHEN** 某工具通过 clean 清理了全部本代理配置且段内无其他用户数据
- **THEN** 该工具的快照段被自动删除

#### Scenario: 写入中途失败不留半状态
- **WHEN** setProxy 多键写入中某键失败而提前返回
- **THEN** 此前已成功写入的键已并入快照段，后续 clean 仍可依快照清理这些键

#### Scenario: 删除后仍生效不入 removed
- **WHEN** npm 键删除后重读仍生效（环境变量或项目级 .npmrc 覆盖）
- **THEN** 该键记入 notes、快照段保留，且不出现在 removed 清单

### Requirement: docker 配置文件独家读写
`~/.docker/config.json` 的读取与写入 SHALL 仅由 docker adapter 拥有：写盘统一 2 空格缩进 + 尾换行；auths 等用户字段 MUST 在 JSON 值级完整保留；构建层代理的注入与移除（on/off 语义）SHALL 由 adapter 的 setProxy/clearProxy 提供，命令层 SHALL NOT 自行拼装 proxies.default 结构；proxies.default 仅在指向本代理时清理。

#### Scenario: auths 保留与格式统一
- **WHEN** clean 清理了注入的 proxies.default
- **THEN** auths 全部键值保留，文件以统一格式（2 空格缩进 + 尾换行）写回

#### Scenario: 注入经 adapter
- **WHEN** dss docker on 注入构建层代理
- **THEN** proxies.default 由 docker adapter 的 setProxy 写入，auths 原样保留，文件保持统一格式

### Requirement: 展示与清理同源
`dss status` 展示的工具代理状态与 `dss stop`/`dss restore` 实际清理的判定 SHALL 来自同一份匹配知识（tool-config store），不存在第二套判定实现。

#### Scenario: status 提示与 restore 行为一致
- **WHEN** status 检测到指向本代理的残留配置并提示
- **THEN** 随后执行的 restore 清理项与提示项一致（同源于同一 interface）

### Requirement: 依赖注入与可离线测试
tool-config store SHALL 以工厂方式构造，支持注入命令执行器、主目录与快照访问；同时 SHALL 导出绑定真实依赖的默认实例供生产使用。全部行为 SHALL 可通过工厂注入在无真实 npm/git/docker、无真实用户目录的环境下测试。

#### Scenario: 假依赖单测
- **WHEN** 以预置返回值的假命令执行器与临时目录构造 adapters 并执行 read/classify/clean
- **THEN** 行为与真实环境一致，且真实用户目录与真实工具配置未被触碰

### Requirement: adapter 骨架参数化单点
npm 与 git 的 adapter SHALL 由 tool-config store 内单一的参数化工厂构造：读取归一化、分类、严格清理（removed=已验证不再生效）、写入与部分快照（并入不整段替换）、off 清除的骨架逻辑 SHALL 只存在一份实现；两个 adapter SHALL 退化为声明式 spec 元数据，MUST 覆盖全部工具差异——键清单与证书键、作用域描述、postVerify 位为数据字段；shell 调用方式、未设置哨兵语义、删除命令形态与失败容忍码为声明于 adapter 内的工具原语（readKey/writeKey/removeKey）实现知识。现有对外 interface 与全部行为契约 SHALL 保持不变。

#### Scenario: 元数据声明差异分支
- **WHEN** 以 npm 的元数据（'null'/'undefined' 哨兵、shell 调用、postVerify=true）与 git 的元数据（unset 退出码 5 容忍、作用域=仅全局层、postVerify=false）分别构造 adapter
- **THEN** 各自的哨兵归一、删除容忍、删除后验证行为与既有测试锁定的行为逐项一致

#### Scenario: 行为契约零回归
- **WHEN** 工厂化改造完成
- **THEN** 既有 npm/git adapter 测试（读取归一化、严格清理、第三方保留、dryRun、快照段生命周期、部分快照）断言不修改且全部通过

#### Scenario: postVerify 差异不可抹平
- **WHEN** 后续维护者尝试让 git 也执行删除后重读验证
- **THEN** 元数据中的作用域描述（git 读取仅作用域于全局配置层，仓库级/系统级不进视野；npm 读取为合并源故需验证）给出不可抹平的依据，该差异以显式字段而非隐式分叉存在

