# Proposal: dss-service-autostart

## Why

dss 代理每次开机或重启后都需要手动 `dss start`：忘了开，浏览器/npm/git 要么没加速、要么指向死端口；Linux 服务器打补丁重启后无人登录时代理静默缺席，而 Windows 主力机（作者主要使用平台）的自启能力完全空白。此外存在一个全平台共有的静默失效——npm 更新 dss 后在跑的守护进程不会自动重启，代理长期运行旧代码（版本僵），用户无从发现。议会判定书（`.scratch/council/c-20261005-164747-ms3e/disposition.md`）在六个候选路线攻防后收敛为"服务定义生成器"路线，grill 澄清已将全部悬置项裁决完毕。

## What Changes

- 新增 `dss service install | uninstall | status` 子命令：一条命令生成、移除、检查平台原生服务定义（service definition）——Windows HKCU Run 登录项（免管理员；实现期实测计划任务 ONLOGON 触发器创建需管理员权限，与本能力"免管理员"定位冲突，故载体取登录项）、Linux 系统级 systemd unit、macOS launchd plist（标注未实测）
- 服务定义生成器满足三不变式：①入口恒为前台 `dss`（禁止 `dss start` 逃逸监管）②运行身份恒为安装用户（禁止 ONSTART/SYSTEM 静默换证）③`service status` 重放 install 时解析并与当前 CLI 比对
- PID 文件从单一整数 JSON 化为 {pid, version, execPath}（读取兼容旧格式），`dss status` 比对守护进程与 CLI 版本，不一致即提示 `dss restart` 对齐（版本僵从静默变响亮）
- `dss stop` 探测监管器归属（服务定义在管）并提示优先使用管理器通道——仅提示，不改变既有 stop 语义
- 全景 status 面板增加服务定义状态行（未安装 / 已安装且运行中 / 已安装但未运行 / 版本不一致）
- deploy-guide 补三平台 service 章节、"更新→重启守护→核对版本"周期指引、跨管理器 stop/restart 边界声明；README 能力表同步改述
- 随 v1.6.0 发布（新增命令面，minor）

## Capabilities

### New Capabilities

- `service-management`: 服务定义的生成、安装、卸载与状态检查——三不变式、PATH 解析式入口、数据目录钉死、幂等 install、监管器归属探测、版本僵告警（PID 文件 JSON 化）、WSL 上下文拒绝、install 后验证。

### Modified Capabilities

（无——cli-routing 的需求是路由机制而非子命令清单，新增子命令不触碰任何现有能力的需求；deploy-guide/README 更新为文档内容，无 spec 级行为变化。）

## Impact

- **新增**：service 命令模块（命令壳 + 平台编排）与服务定义生成器（纯函数，三平台模板）；监管器归属探测逻辑
- **修改**：进程管理模块的 PID 文件读写（JSON 化 + 兼容）；`dss status` 面板（版本比对行 + 服务定义状态行）；`dss stop`（监管器提示）；帮助文案与部署文档
- **不触碰**：冻结区 `src/mitmproxy/lib/**`；tool-config store、镜像引擎、docker-pull 等既有能力的行为
- **用户可见行为**：新增命令面；`dss stop` 在服务定义在管时多一行提示（照常执行）；`dss status` 多两行信息——其余既有命令行为不变
