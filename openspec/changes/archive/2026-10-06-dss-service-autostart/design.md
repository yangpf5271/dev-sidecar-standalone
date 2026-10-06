# Design: dss-service-autostart

## Context

议会判定书在六个候选（纯文档 / 内置命令 / PM2 / shell hook / 寄生常驻体 / 登录项）攻防后收敛：Windows 上"内置命令"与"登录项"是同一机制的两层封装，内置命令的真实增量 = install/uninstall 事务性 + `service status` 主动信号面。grill 澄清将路线、平台范围、PID JSON 化、监管器边界、Linux 单元层级、发布节奏全部裁决（8 项决策，见判定书与 `.scratch/dss-service-autostart/spec.md`）。既有可复用资产：server-config 地址解析单点、进程管理模块（PID 文件/身份验证/端口反查）、tool-config 测试基建（假执行器/临时主目录）、快照体系。

约束：冻结区 `src/mitmproxy/lib/**` 不动；既有 stop/start/restore 用户可见行为不变（监管器提示为唯一新增输出）；错误契约沿用"编排层结果对象、命令壳层决定退出码"。

## Goals / Non-Goals

**Goals:**

- 三平台服务定义生成器为纯函数，全部规格断言（三不变式、PATH 解析式、数据目录钉死、守护标记）脱离真实平台可测
- install/uninstall/status 完整命令面：事务性（幂等覆盖、失败不留半成品、安装后即验证）
- 版本僵从静默变响亮：PID JSON 化 + 全量拉起路径共享 PID 簿记 + status 比对告警
- 监管器协作边界：stop 提示不改语义；status 面板可见服务状态

**Non-Goals:**

- 托盘壳、自动恢复工具配置、崩溃恢复代码化、自动委托管理器执行（判定书明确划出，见 proposal Out of Scope）
- `dss restart` 与监管器三方竞态的代码修复（判定书 ref#26 悬置，文档边界声明为期间缓解）
- PM2 路径、WSL 发行版内托管

## Decisions

**D1 路线 = 服务定义生成器（已决策）**。纯文档无主动信号面且 Windows 侧与生成器同机制；PM2 在 Windows 机制性出局（双主拉锯）；shell hook 在 PowerShell 5.1 语法不成立且假幂等。备选"纯文档先行"被用户否决（直接上 B）。

**D2 主 seam = 生成器纯函数（已决策）**。`createServiceDefinition(platform, ctx) → 定义内容`：三平台模板收敛一处，跨平台测试不需要真实 schtasks/systemctl/launchctl。编排层（平台命令执行、幂等、探测）注入命令执行器——复用 tool-config 测试基建的假执行器与临时主目录，不新增 seam。

**D3 Linux 采用系统级 unit（已决策）**。`User=<安装用户>` + `Restart=always` + `WantedBy=multi-user.target`，install 需 sudo——开机即起无需登录，与现有部署文档形态一致。备选 user unit + linger 被否决（WSL 默认无 systemd、多一步 linger 且两条路径测试面翻倍）。

**D4 Windows 载体 = HKCU Run 登录项（已决策，实现期实测修正）**。实现期实测：`schtasks /Create /SC ONLOGON` 需管理员权限（非提升 shell 返回"拒绝访问"），与议会收敛的"免管理员"定位冲突。最终取 HKCU Run：纯用户注册表免管理员、天然 per-user（不变式②自动满足）、`reg query/add/delete` 精确值名判定无本地化问题。代价：Run 键是纯触发器无监管面（管理器通道提示改为"下次登录会再拉起，移除自启用 uninstall"）。实现期二次修正：install 的立即拉起最初经 wscript/VBS 链，实测 WSH 在安装 shell 的环境下弹出"内存资源不足"错误对话框（MSYS 畸形环境块），遂改为直接调用 startDaemon（node 直 spawn + windowsHide，即日常 dss start 的路径）；VBS 仅在真实登录时由 explorer 以干净环境执行。备选 ONSTART/SYSTEM 被不变式二禁止。

**D5 PID JSON 化 + 版本僵判定（已决策）**。{pid, version, execPath}，读兼容旧整数、损坏按无 PID；比对只判 version 相等、不判新旧方向（wrapper 部署下差异合法，判方向假阳性——判定书 #22 裁决）。服务定义拉起的前台进程注入与后台子进程相同的守护标记，全量拉起路径共享 PID 簿记——这是不变式③覆盖全部场景的前提。

**D6 数据目录钉死 = install 时固化（已决策）**。install 读取当前 DEV_SIDECAR_HOME 写入服务定义（Linux unit 环境变量；Windows 由 HKCU 用户会话天然一致）+ 文档警示改值需重装。备选"运行时防御检测 homedir 异常"不采纳：治标且误报面大。

**D7 install 语义 = 注册 + 立即拉起 + 验证（已决策，从不变式③与 spec 后验证条推出）**。只注册不拉起则安装后验证必然失败；uninstall 先停受管进程再移除定义。失败路径：定义写入先落临时位置再原子就位，失败即清理，不留半成品。

**D8 监管器探测 = 仅提示（已决策）**。探测方式按平台查本代理命名的 unit/任务/label 存在性；提示后照常执行既有 stop。备选自动委托被否决（跨平台执行链复杂且实质改变 stop 语义）。

**D9 WSL 拒绝判定（已决策，WSL 实测修正）**。实测发现 WSL 默认不把 Linux 环境变量传给互操作启动的 Windows 进程（WSL_DISTRO_NAME 为 undefined），环境变量判定不可靠。最终形态：win32 侧用「父进程链回溯」（spawnSync 单次 PowerShell CIM 回溯 10 层，互操作进程的 Windows 父链上必有 wsl.exe/wslhost.exe；进程生命周期内缓存）叠加环境变量快路径；命中即拒绝并指引 Linux 流程。Linux 原生侧以内核标识（microsoft）判定用于诊断提示（WSL 内的 systemd unit 安装属 Linux 流程，不硬拒绝）。

**D10 三平台全做（已决策）**。macOS launchd plist 生成器以单测锁定内容，真实加载标注"未实测"——模板化边际成本低，接口一次到位。

## 待讨论（不阻塞实施，实现时可定）

| 项 | 说明 | 倾向 |
|---|---|---|
| macOS KeepAlive 与"仅代理待命"的交互 | 用户主动 stop 后 KeepAlive 会拉回进程；需在"仅非零退出码拉起"与"文档规定 uninstall→stop 顺序"间选择 | 前者（语义干净，但需验证 launchd 行为——受"未实测"约束） |
| 三平台命名前缀 | unit 名 / Run 值名 / launchd label 需统一可识别前缀，供归属探测与 uninstall 复用 | 以包名为前缀的派生常量 |
| HKCU Run 的监管面缺失 | Run 键无法像计划任务那样 /End 停止 | 已裁决：停止走 dss stop（提示说明下次登录会再拉起），移除自启走 uninstall |
| Windows 无窗口包装选型 | wscript VBS 包装 vs 其他隐藏形态；VBS 可能被安全软件标记 | wscript 为主、文档给手动闪窗回退 |

## Risks / Trade-offs

- [HKCU Run 登录项触发时用户环境变量尚未完全就绪导致 PATH 解析入口失效] → 入口脚本以 npm 全局前缀目录优先定位（前缀本身稳定），PATH 解析作回退链；install 后验证立即暴露问题
- [wscript 包装被安全软件误报] → 文档提供"接受闪窗"的手动回退形态；包装脚本明文可审计
- [sudo unit 安装中断留半成品] → 临时文件 + 原子就位 + 失败清理（D7 事务性）；status 对"定义存在但未运行"有独立表述（spec 三态）
- [版本僵告警自身漂移（daemon 版本记录与实际不符）] → version 记录在 PID 文件写入时与进程绑定，写入路径唯一；兼容格式读取只做降级不猜版本
- [macOS 行为未实测] → 生成器单测锁内容 + 文档明确标注；平台语义（KeepAlive 交互）在待讨论表跟踪
- [三平台编排命令输出本地化] → 平台命令只做存在性/状态判定，解析逻辑与既有端口反查同纪律（不依赖本地化文本列）

## Migration Plan

无数据迁移：PID 文件向后兼容即迁移策略（旧整数可读、新格式只在新写时产生）。发布随 v1.6.0；回滚 = uninstall 服务定义 + 降级包（旧版读不到新格式按"无 PID"处理，行为退化为升级前，无破坏）。

## Open Questions

见"待讨论"表——三项均为实现时可定细节，不影响规格、approach 与任务切分。
