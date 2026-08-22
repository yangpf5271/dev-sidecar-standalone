# docker-pull Specification

## Purpose
TBD - created by archiving change refactor-adapter-factory-and-pull-layer. Update Purpose after archive.
## Requirements
### Requirement: 拉取层读取与解析职责分离
daemon.json 的访问知识 SHALL 单点归属拉取层知识模块，且读取与解析两个职责 SHALL 独立：读取 SHALL 提供两种显式语境——Linux/WSL 内本机直读，与 Windows 宿主经 WSL 穿透读取；字段解析（registry-mirrors、insecure-registries）SHALL 为纯函数，不依赖读取语境。模块 SHALL NOT 承担聚合、写回或界面文案职责。

#### Scenario: 两种读取语境
- **WHEN** 拉取层命令在 Linux/WSL 内请求读取时走本机直读；status 面板在 Windows 宿主请求读取时经 WSL 穿透
- **THEN** 两种语境各自正确返回 daemon.json 内容或文件不存在的空结果，调用方无需感知路径与平台差异

#### Scenario: 解析为纯函数
- **WHEN** 以任意 daemon.json 文档内容调用字段解析
- **THEN** registry-mirrors 与 insecure-registries 被解析为结构化结果，损坏的 JSON 返回错误而非抛出异常

### Requirement: 展示与命令同源消费
dss status 面板的 Docker 拉取层展示、拉取层命令（dss docker mirror 系列）的读取、以及 noProxy 聚合中的 insecure-registries 解析 SHALL 消费同一拉取层知识模块，仓库中 SHALL NOT 存在第二份 daemon.json 读取或字段解析实现。

#### Scenario: 消费方改道后行为不变
- **WHEN** status 面板与拉取层命令改经拉取层模块取数
- **THEN** 展示文案、命令输出与既有行为逐字一致，各自原有的私有读取实现被删除

### Requirement: WSL 穿透读取超时保护
Windows 宿主经 WSL 穿透读取 daemon.json SHALL 带超时保护：WSL 冷启动或无响应时 MUST 在限定时间内返回超时结果而非挂起，调用方据此展示超时提示。

#### Scenario: WSL 无响应
- **WHEN** WSL 穿透读取超过限定时间仍未返回
- **THEN** 读取返回超时结果，status 面板展示超时提示且不阻塞其余状态项的探测

