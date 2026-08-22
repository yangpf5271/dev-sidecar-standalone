# tool-config-store delta — refactor-adapter-factory-and-pull-layer

## ADDED Requirements

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
