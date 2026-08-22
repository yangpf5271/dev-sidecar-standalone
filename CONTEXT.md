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

## 冻结区

- `src/mitmproxy/lib/**` — 上游继承代码，刻意贴近上游；改动必须外科手术式，不做结构性重构。
