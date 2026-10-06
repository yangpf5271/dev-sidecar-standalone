# CONTEXT — 领域词汇表

本项目（dev-sidecar-standalone / `dss`）的领域语言。代码、文档、对话统一使用这些词。

## 核心概念

- **tool-config store（工具配置存储）** — 唯一拥有"各工具的代理配置存在哪、怎么读、怎么写、什么算未设置"这一知识的 module（`src/cli/tool-config/`）。调用方（npm/git/docker 命令、status、restore）只通过它的 interface 访问工具配置。
- **adapter（适配器）** — tool-config store 内每个工具的具体实现（npm / git / pip / docker 四个 adapter），满足同一 interface。真实存在的 seam：四个 adapter，不是假设。
- **capabilities（能力位）** — adapter 对外声明的可选能力（如 pip：`{ proxy: false, mirror: true }`）。调用方按位降级，不用异常控制流。
- **classify / isOurs（两种匹配语义）** — `classify(value)` 供展示，宽松（端口子串）；`isOurs(value, addr)` 供清理，严格（精确候选集 = 快照值 + host×port 组合）。同一问题、两个目的、显式分开，不允许再分叉。docker 是文档化例外：注入值指向宿主网关地址，恢复时无法重推网关，isOurs 退化为端口匹配。
- **快照（snapshot，last-applied.json）** — `dss on` 写入工具配置时记录的实际值，供 stop/restore 智能恢复。tool-config store 拥有工具段；mirror 段归镜像引擎。
- **智能恢复（smart restore）** — stop/restore 只清理"指向本代理"的配置，用户自己的其他代理（公司代理等）绝不动。清理结果只报告已验证不再生效的项；删除后仍生效的（如被环境变量覆盖）记入提示、保留快照供重试。
- **build 层 / 拉取层** — Docker 加速的两层：build 层 = `~/.docker/config.json` 的 `proxies.default`（构建时依赖安装走代理）；拉取层 = `/etc/docker/daemon.json` 的 `registry-mirrors`（docker pull 镜像源）。拉取层与代理进程无关，不属于 stop/restore 范围。拉取层知识的读取与解析单点归属 docker-pull module（读取分本机直读与 Windows 经 WSL 穿透两种语境）。
- **MITM 端口 / HTTP 端口** — 双端口架构：HTTP=PORT-1（普通隧道），MITM=PORT（HTTPS 拦截加速），默认 31180/31181。
- **镜像源（mirror）** — 与代理正交的源切换（npm/pip registry），无需代理运行。切换前快照原值，企业内网源不覆盖丢失。
- **守护进程（daemon）** — `dss start` 后台实例：PID 文件 + 日志文件 + 启动校验；子进程 listen 成功后自写 PID。
- **监管器（supervisor）** — 平台原生的进程管理器（Linux systemd、Windows 计划任务、macOS launchd）。所有权公理：进程被监管时，监管器是生命周期的唯一所有者；dss 的 PID 文件/stop/restart 只是应用层簿记与被监管进程的身份凭证，绝不能升格为第二监管者。`dss stop`/`dss restart` 在被监管场景必须让位于管理器通道（提示而非委托）。
- **服务定义（service definition）** — `dss service install` 生成的平台原生自启定义。三条不变式：①入口恒为前台 `dss`（禁止 `dss start`——detached 双层 fork 会逃逸监管，产生 start-loop 或僵尸孤儿）；②运行身份恒为安装用户（禁止 ONSTART/SYSTEM——否则数据目录漂移到 systemprofile）；③`service status` 必须重放 install 时的解析并与当前 CLI 比对。
- **登录项（logon trigger）** — 按"用户登录"而非"系统开机"触发的自启方式（Windows 计划任务 ONLOGON / HKCU Run / macOS 登录项）。免管理员、用户会话环境完整；代价是服务器无人登录不适用。Windows 上服务定义与登录项是同一机制的两层封装。
- **版本僵（stale daemon）** — npm 更新后守护进程仍跑旧代码的状态（更新从不重启在跑的进程，单实例检查挡住新版本接管）。不是死，是僵。治理手段：PID 文件 JSON 化（pid+version+execPath），`dss status` 比对守护进程与 CLI 版本，不等即提示（只比相等，不判新旧——wrapper 部署下版本差异属合法常态）。
- **数据目录分裂（data-dir split）** — 服务/登录项进程与诊断 CLI 因环境可见性差异（会话级 DEV_SIDECAR_HOME 对服务进程不可见）解析出不同数据目录，导致证书/快照/PID/日志四件套分裂，且 `dss status` 的证书探测会读旧目录报假安心。治理：install 时把当时的 DEV_SIDECAR_HOME 固化进服务定义。
- **PATH 解析式条目（path-resolving entry）** — 自启条目不在配置时刻写死解释器绝对路径，而是每次启动经 PATH/nvm 扫描重解析（wrapper 模式）。抗 nvm 切版本漂移的唯一形态；服务定义生成器必须生成此形态。

## 冻结区

- `src/mitmproxy/lib/**` — 上游继承代码，刻意贴近上游；改动必须外科手术式，不做结构性重构。
