# tasks — refactor-adapter-factory-and-pull-layer

垂直切片：每片独立可验证（测试绿 + 行为不变），先独立低风险的拉取层，后行为敏感的工厂。验收底线贯穿全程：既有 55 个单测断言零修改、全程全绿。

## 1. 拉取层模块最小切片（docker-pull: 读取语境 + registry-mirrors 解析）

- [ ] 1.1 新建拉取层知识模块：读取职责提供两种显式语境（Linux/WSL 内本机直读；Windows 宿主经 wsl.exe 穿透 + 超时保护），字段解析职责为纯函数（registry-mirrors），以可注入命令执行器构造、可离线测试
- [ ] 1.2 status 面板的 Docker 拉取层探测改经该模块取数，展示文案与超时提示逐字保留，删除 status 内私有的读取实现
- [ ] 1.3 新增模块单测：解析纯函数直测（含损坏 JSON 返回错误不抛异常）、假执行器模拟 wsl.exe 路由、**WSL 超时场景必测**（超时返回结果不挂起）；全量单测绿

## 2. 拉取层命令与 noProxy 改道（insecure-registries 解析收编）

- [ ] 2.1 模块解析职责补 insecure-registries 纯函数；docker 命令内私有的 daemon.json 读取改经模块的本机直读语境，命令输出逐字不变
- [ ] 2.2 noProxy 聚合的 insecure-registries 解析改消费模块（聚合算法本身留命令层，归属见 design 待讨论区）；仓库内不再存在第二份 daemon.json 读取/解析实现
- [ ] 2.3 新增/调整测试后全量单测绿，CI 矩阵绿

## 3. 参数化工厂 + npm adapter 切换

- [ ] 3.1 在 tool-config 内实现共享骨架工厂：读取归一化、分类、严格清理（removed=已验证不再生效）、写入与部分快照（并入不整段替换）、off 清除单点实现
- [ ] 3.2 npm adapter 改为 spec 元数据声明（键清单/证书键/shell 调用/'null'/'undefined' 哨兵/删除命令/postVerify=true），对外 interface 与 module 导出不变，调用方零改动
- [ ] 3.3 既有 npm adapter 测试断言零修改全部通过（行为复验网）；新增元数据差异分支测试（哨兵归一、postVerify 验证路径）

## 4. git adapter 切换（postVerify=false 元数据落地）

- [ ] 4.1 git adapter 改为 spec 元数据声明（unset 退出码 5 / no such section 容忍、作用域=仅全局层、postVerify=false），对外 interface 不变
- [ ] 4.2 既有 git adapter 测试断言零修改全部通过；元数据文档中保留 postVerify 作用域依据原文（防止被当作漂移抹平）；全量单测绿，CI 矩阵绿

## 5. 微重复清理 + 词汇表落地

- [ ] 5.1 npm/git status 的"(未设置)/获取失败"label 契约收进共享工具，两处消费；unknown-mirror 打印块维持两份（确认不动）
- [ ] 5.2 CONTEXT.md"build 层/拉取层"条目补拉取层的 module 归属句（词汇表描述现实，随本片落地）

## 6. 收尾

- [ ] 6.1 全量回归：55+新增单测全绿、status/npm/git/docker/mirror 链路冒烟、CI unit job + 3×3 矩阵绿、双轴 code-review 一轮并处理发现
- [ ] 6.2 归档提案（openspec archive，delta 并入 openspec/specs/），提交推送双远端；发布交接（与 v1.5.0 已就绪内容合并为单次发布，npm publish 由用户执行，tag/Release 随后）
