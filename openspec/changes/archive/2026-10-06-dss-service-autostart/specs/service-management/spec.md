# service-management 增量规格

## Purpose

服务定义能力覆盖 dss 的开机自启生命周期：以一条命令生成、安装、卸载与检查三平台（Windows HKCU Run 登录项 / Linux 系统级 systemd unit / macOS launchd）的原生服务定义，并保证服务化运行与 dss 自有命令语义（start/stop/status/智能恢复）正确协作——监管器是进程生命周期的唯一所有者，dss 的 PID 簿记只是身份凭证。

## ADDED Requirements

### Requirement: 服务定义三不变式

服务定义生成器 SHALL 满足三不变式：① 定义入口恒为前台 `dss`（MUST NOT 使用后台启动子命令——detached 双层 fork 会逃逸监管，产生 start-loop 或僵尸孤儿）；② 运行身份恒为安装用户（Windows MUST NOT 使用 ONSTART 触发或 SYSTEM 身份——否则数据目录漂移到系统账户导致证书静默换证）；③ 状态检查 SHALL 重放安装时的解析逻辑并与当前 CLI 比对。三平台模板 MUST NOT 包含违反不变式的内容。

#### Scenario: Windows 定义触发与身份

- **WHEN** 在 Windows 上执行 install
- **THEN** 生成的 HKCU Run 登录项绑定当前用户、数据为无窗口包装命令，且不出现 SYSTEM 或 ONSTART

#### Scenario: Linux 单元身份与前台入口

- **WHEN** 在 Linux 上执行 install（具备 sudo）
- **THEN** 生成的系统级 unit 含 `User=<安装用户>`、`Restart=always`，入口为前台进程而非后台启动命令

#### Scenario: 模板负例锁定

- **WHEN** 对三平台模板做内容断言
- **THEN** Windows 模板不含 ONSTART/SYSTEM，全部平台模板不含后台启动子命令（负例作为单测常驻）

### Requirement: PATH 解析式入口

服务定义的入口 SHALL 在每次启动时经 PATH 解析（或引导时重扫 Node 版本目录的 wrapper 形态），MUST NOT 在配置时刻写死解释器绝对路径。

#### Scenario: nvm 切换后自然收敛

- **WHEN** 用户切换 Node 版本且新版本已安装 dss 后服务重启
- **THEN** 服务运行在新版本解释器上的 dss，无需修改服务定义

### Requirement: install 幂等与后验证

install SHALL 在同名服务定义已存在时先移除旧定义再安装并在输出中明确提示覆盖；install 完成后 SHALL 立即验证定义存在性并探测代理端口，如实报告验证结果（MUST NOT 在未验证的情况下声称成功）。

#### Scenario: 重复安装覆盖

- **WHEN** 对已安装的服务再次执行 install
- **THEN** 旧定义被替换且输出包含覆盖提示，系统中只存在一份定义

#### Scenario: 安装后验证

- **WHEN** install 完成
- **THEN** 输出包含定义存在性与代理端口可达性的验证结果；验证失败时明确报错而非声称成功

### Requirement: uninstall 完整移除

uninstall SHALL 停止受管代理进程、移除服务定义与 install 生成的辅助文件；服务定义不存在时 SHALL 如实报告而非报错失败。

#### Scenario: 干净卸载

- **WHEN** 执行 uninstall 后查询服务定义与辅助文件
- **THEN** 全部移除；再次 uninstall 输出"未安装"而非错误

### Requirement: service status 三态报告

`dss service status` SHALL 区分并报告：未安装 / 已安装且运行中 / 已安装但未运行 / 已安装但版本不一致。MUST NOT 将"已安装但未运行"与"未安装"混同表述。

#### Scenario: 已安装但未运行

- **WHEN** 服务定义存在而代理端口不可达
- **THEN** 输出"已安装但未运行"及排查指引，而非"未安装"

### Requirement: 版本僵告警（PID 簿记 JSON 化）

PID 文件 SHALL 记录 {pid, version, execPath} 并在读取时兼容旧整数格式（损坏文件按"无 PID"处理）。`dss status` SHALL 比对守护进程记录的 version 与当前 CLI 的 version：不一致即输出"版本不一致，建议 dss restart 对齐"； SHALL NOT 判断版本新旧方向（wrapper 部署下版本差异属合法常态，判方向会产生假阳性）。服务定义拉起的前台进程 SHALL 与后台启动子进程共享同一套 PID 簿记标记，使版本比对覆盖全部拉起路径。

#### Scenario: 版本不一致提示

- **WHEN** 更新 dss 后守护进程仍运行旧版本，用户执行 `dss status`
- **THEN** 输出版本不一致告警与 `dss restart` 对齐建议

#### Scenario: 旧格式兼容

- **WHEN** 磁盘上残留旧版整数格式 PID 文件
- **THEN** 读取正常、行为与升级前一致，不报错不崩溃

#### Scenario: 守护进程信息缺失

- **WHEN** PID 文件缺失或损坏
- **THEN** status 按既有"未运行/端口反查兜底"逻辑工作，版本比对静默跳过

### Requirement: 监管器归属提示

`dss stop` 执行前 SHALL 探测本机是否存在本代理的服务定义（systemd unit / HKCU Run 值 / launchd label）；存在时 SHALL 输出"建议使用管理器通道停止"的提示，随后照常执行既有 stop 流程——MUST NOT 委托管理器执行、MUST NOT 拒绝执行、MUST NOT 改变 stop 的既有用户可见行为。被监管场景的 restart 边界 SHALL 与 stop 一并文档化（服务在管时 restart 须走管理器通道，`dss restart` 会与管理器自动拉起产生竞态），帮助文案与部署文档 MUST NOT 引导用户在服务在管时使用 `dss restart`。

#### Scenario: 托管场景的提示与照常执行

- **WHEN** 服务定义在管时用户执行 `dss stop`
- **THEN** 先输出管理器通道提示，随后代理照常停止（管理器可能按策略拉回，属预期行为并在提示中说明）

### Requirement: 数据目录钉死

install SHALL 读取安装时环境中的 DEV_SIDECAR_HOME 并固化进服务定义（Windows 由 HKCU 用户会话保证解析一致），使服务进程与诊断 CLI 解析同一数据目录，杜绝数据目录分裂；文档 SHALL 警示"安装后修改 DEV_SIDECAR_HOME 需重新 install"。

#### Scenario: 自定义数据目录一致

- **WHEN** 用户 shell 设置了自定义 DEV_SIDECAR_HOME 后执行 install
- **THEN** 服务定义携带该值，服务进程与后续 CLI 命令读写同一数据目录（证书/快照/PID/日志不分叉）

### Requirement: WSL 上下文拒绝

Windows 平台的 service 命令在 WSL 环境下运行时 SHALL 明确拒绝并指引到 Linux 流程，MUST NOT 在错误上下文中安装出不可用的服务定义。

#### Scenario: WSL 内拒绝

- **WHEN** 在 WSL 发行版内执行 Windows 侧 service 命令
- **THEN** 输出明确拒绝与 Linux 流程指引，退出码非 0

### Requirement: status 面板服务状态行

全景状态面板 SHALL 增加服务定义状态信息（与进程、证书、工具代理信息并列），服务已安装时可见，未安装时不干扰既有面板结构。

#### Scenario: 面板并列展示

- **WHEN** 服务已安装且代理运行中时执行 `dss status`
- **THEN** 面板出现服务定义状态行且其余既有行不变

### Requirement: 非默认端口沿用统一地址解析

service install SHALL 沿用与 `dss start` 相同的地址解析（配置文件 / PORT / HOST 环境变量 / 内置默认），使服务定义中的代理地址与实际启动配置一致。

#### Scenario: 自定义端口一致

- **WHEN** 以 PORT 环境变量或配置文件指定非默认端口执行 install
- **THEN** 服务定义以相同端口拉起代理，status 面板以相同端口探测
