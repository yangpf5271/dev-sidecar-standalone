# Proposal: add-docker-acceleration

## Why

国内网络环境下，`docker pull` 与 `docker build` 几乎不可用：

- **Docker Hub 拉取被多重封锁**。经实测（WSL 环境四层连通性实验）：`registry-1.docker.io` 的 DNS 全线污染（系统 DNS 与国内公共 DoH 均返回假 IP），1.1.1.1/8.8.8.8/9.9.9.9 的 DoH 通道 TCP 层不可达，真实 IP + 真实 SNI 的完整请求 100% 被掐断（TLS 握手可过、发数据即断）。GitHub 式「DNS 优选」方案对 Docker Hub 无效——SNI 层封锁是硬伤，且干净 IP 无法获取（死结）。
- **阿里云个人加速器名存实亡**。2024-06 后对 Docker Hub 公共镜像基本失效，只能拉取同步到自有 ACR 的镜像。
- **用户自建的 Cloudflare Worker 镜像「用一段时间就慢」**。根因是中国到 CF 免费版的默认边缘 IP 质量漂移 + 晚高峰国际出口拥堵，而非 Worker 本身。
- **docker build 的依赖安装（npm/pip/apt/GitHub）完全不经过 dss**。容器有独立网络命名空间与全新工具链环境，WSL 侧的任何代理/镜像配置对构建过程无效。

本提案来自 `/grill-with-docs` 三轮设计访谈（Q1–Q14 全部封闭），核心结论：**自建 Cloudflare Worker 镜像站是当前唯一「任意镜像可拉 + 完全自主」的方案**，dss 负责把它做成「一条命令开启、变慢自动救、构建层全覆盖」的完整体验。

## What Changes

新增 `dss docker` 命令族，分两层解决：

**拉取层（docker pull / FROM）**
- `dss docker mirror add <url>`：健康检查（`/v2/` 硬阻断，`--force` 逃生）→ CF 边缘 IP 测速优选 → 钉定 `/etc/hosts`（sudo）→ 合并写入 daemon.json `registry-mirrors`（保留现有键）→ 重启 docker（systemd/service 自动探测）→ 验证。镜像源**谁使用谁部署**：命令只接受任意用户提供的 URL，项目内置 Worker 模板与部署教程供自建。
- `dss docker mirror remove <url>` / `refresh` / `status`：对称移除（hosts 行 + mirrors + 重启）、重测换 IP（解决「过一段时间就慢」）、状态与健康查看。
- Worker 模板（含教程）：manifest + layer 全代理（layer 307 重定向由 Worker 跟进，客户端不直连 CDN）、**Worker 侧代办上游认证**（客户端不接触被墙的 auth.docker.io）、可选路径前缀 token 鉴权（`/<token>`，错误返回 404 伪装）、可选 `DOCKERHUB_AUTH`（防匿名限额）、可选 R2 layer 缓存。

**构建层（docker build RUN / docker run）**
- `dss docker on`：向 `~/.docker/config.json` 注入 `proxies` 段（严格合并，绝不触碰已有 auths），代理地址自动探测（docker0 网关 → host.docker.internal → 172.17.0.1，`--proxy-url` 可覆盖），**noProxy 自动聚合**（内网段 + 已有 auths 的 registry 主机 + daemon.json insecure-registries + `--no-proxy` 追加）——内网 registry 走代理是最易翻车点。
- `dss docker off` / `status`：移除 proxies 段（保留 auths）、状态查看。
- dss 需以 `HOST=0.0.0.0` 运行方可被容器经网关访问，未满足时给出明确提示。

## Capabilities

### New Capabilities

- `docker-mirror`: 管理 daemon.json registry-mirrors 的一生周期——健康检查、CF 优选、hosts 钉定、合并写入、重启验证、移除、刷新
- `docker-cf-optimization`: Cloudflare 边缘 IP 池测速优选与 `/etc/hosts` 钉定管理（含 `isCloudflareIP` 判定与手动刷新节奏）
- `docker-build-proxy`: 构建层代理注入——`~/.docker/config.json` proxies 段的合并写入/移除、代理地址自动探测、noProxy 自动聚合
- `docker-worker-template`: 自建 Docker Hub 镜像 Worker 的模板与部署教程（项目交付物，token 鉴权/上游认证代办/layer 代理/可选 R2）

### Modified Capabilities

（无——均为新增能力，不改变现有命令的行为）

## Impact

- 新增 `src/cli/docker.js` 子命令模块；`src/cli/index.js` 注册 `docker` 子命令并更新帮助文本
- 新增 `docs/worker/docker-proxy.js`（Worker 模板）与 `docs/worker-deploy.md`（部署教程）
- README 新增「Docker 加速」章节；版本升至 1.4.0
- 平台边界：拉取层命令依赖 `/etc/hosts` 与 daemon.json，**限 Linux/WSL**（Windows 下给出指引）；构建层命令三平台可用，但**实测验收范围 = WSL 原生 Docker**（Docker Desktop/纯 Linux 做探测兼容、文档标注「已兼容未实测」）
- 系统影响面：`/etc/docker/daemon.json` 与 `/etc/hosts` 的写入需 sudo（交互提示），重启 docker 会中断运行中容器——命令输出中明确提示
- CI：新增 docker 构建层（config.json 注入/移除/auths 保留断言）；拉取层依赖真实 docker daemon 与 sudo，仅 WSL 本地实测、不进 CI
