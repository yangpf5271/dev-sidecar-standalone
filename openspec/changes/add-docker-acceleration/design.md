# Design: add-docker-acceleration

## Context

dss（dev-sidecar-standalone）是 Dev-Sidecar 的纯服务器改造版，MITM 代理核心已具备 GitHub（SNI 伪装 + 预设 IP + 测速）、Google CDN 镜像、DNS 优化等加速能力，CLI 已有 `npm/pip mirror`（registry 切换 + 快照恢复）与 `npm/git on/off`（代理配置注入）命令族。

Docker 场景此前完全未覆盖。经 WSL 四层连通性实验确认的封锁现状：

| 层 | 实测结果 |
|----|---------|
| DNS | `registry-1.docker.io` 系统 DNS 返回 Facebook 假 IP；阿里 DoH 同样污染（国内递归缓存了污染答案） |
| 干净 DNS 通道 | 1.1.1.1 / 8.8.8.8 / 9.9.9.9 的 TCP 443 全部不可达 |
| SNI | 真实 AWS IP + 真实 SNI：TLS 握手可过，**发送首个数据包 100% 被掐**（3/3 采样）；对照组 github.com 同法 200 OK |
| 伪装 SNI | 返回证书为无关第三方（IP 已易主/共享 ELB），不可利用 |

结论：GitHub 式方案对 Docker Hub 死路（SNI 层 + IP 来源死结）；镜像站是唯一通路。同时用户的阿里云个人加速器对公共镜像已失效，自建 CF Worker 是唯一自主可控选项——但其「变慢」痛点需要优选 IP 机制解决。

## Goals / Non-Goals

**Goals:**

- `docker pull` 任意 Docker Hub 公共镜像：一条命令配置后无感知直拉
- 自建 Worker 镜像站的完整自助路径：模板 + 教程 + 一条命令接入（谁使用谁部署，dss 镜像源无关）
- 解决「Worker 用一段时间变慢」：CF 边缘 IP 测速优选 + hosts 钉定 + 手动刷新
- `docker build` 构建内依赖安装（npm/pip/apt）经 dss 代理；内网 registry 绝不误走代理
- 现有配置零破坏：daemon.json 合并写入保留现有键；`~/.docker/config.json` 严格保留 auths

**Non-Goals:**

- 不做 Worker 的自动部署/管理（域名、Cloudflare 账号等是用户资产，dss 不代管）
- 不做拉取层的全自动后台 IP 刷新（sudo 常驻提权不做；sudoers NOPASSWD 仅作文档可选）
- 不做 Docker Hub 之外 registry 的代理（内网 registry / ACR 直连）
- 不做构建内 GitHub 类 MITM 域名的 CA 自动注入（仅文档 `--secret` 方案）
- 不做代理层重定向 `registry.npmjs.io` 等认证域（凭证安全红线）
- Windows 平台不做拉取层（`/etc/hosts`、daemon.json 属 Linux 语义；Windows 给指引）

## Decisions

**D1 — 拉取路径选 hosts 钉优选 IP（Q1=C）**，备选弃用理由：
- 全经 dss（A）：dss 停机 = pull 全断，核心工作流强依赖不可接受
- 纯直连（B）：即用户现状痛点，边缘 IP 随缘
- hosts 钉定（C，采纳）：优选生效且 dss 挂后仍用上次钉的 IP（优雅降级）；代价是 sudo 交互与系统级影响（接受，见 D3）

**D2 — Worker 是「谁使用谁部署」的交付物（Q3 修正）**：`dss docker mirror add <url>` 只接受任意 URL 走后续流程；项目内置模板 + 教程。dss 保持镜像源无关，不绑定任何特定部署。

**D3 — hosts 写入时机 = 显式命令**（add/refresh 时 sudo 提示一次），周期自动刷新仅通过文档提供的 sudoers NOPASSWD 行作为可选进阶（Q8）。不做常驻提权。

**D4 — CF IP 池硬编码于代码内**（约 30 个 anycast IP，社区优选列表同源），复用现有 SpeedTester 思路做 TCP 连接计时；`isCloudflareIP` 按 CF 官方 CIDR 段判定域名是否需要优选（本地/非 CF 域名跳过钉定）。不做运行时拉取列表（网络依赖引入新的不可达问题）（Q9）。

**D5 — 健康检查硬阻断**：`<url>/v2/` 非 200/401 拒绝写入（daemon.json 写错要重启 docker，成本高），`--force` 逃生（Q10）。

**D6 — Worker 侧代办上游认证**：客户端（dockerd）绝不接触 `auth.docker.io`（墙内不可达）。Worker 以匿名或 `DOCKERHUB_AUTH` 换取 Bearer token（isolate 内存缓存），layer 的 307 CDN 重定向由 Worker `redirect: manual` 跟进并流式回传。

**D7 — token 鉴权用路径前缀**（Q14=A）：`https://domain/<token>/v2/...`，dockerd 的 mirror URL 天然支持路径；错误 token 返回 404 伪装（不暴露代理存在）。弃子域名方案（需泛解析，门槛高）。

**D8 — noProxy 自动聚合**（Q11）：`localhost,127.0.0.1,::1` + 内网四段 + `~/.docker/config.json` auths 的 registry 主机 + daemon.json `insecure-registries`（可读则读）+ `--no-proxy` 追加。内网 registry 误走代理是最危险故障模式，全自动聚合优先。

**D9 — 代理地址自动探测**（Q13）：docker0 网关 IP（`ip -4 addr show docker0`）→ Windows/Docker Desktop 用 `host.docker.internal` → 兜底 `172.17.0.1`；`--proxy-url` 覆盖；探测 dss 网关可达性，不可达提示 `HOST=0.0.0.0 dss start`。

**D10 — R2 缓存默认关**（Q4）：模板内注释开关；manifest 走 Workers Cache API（零配置默认开，manifest 按 ref+digest 不可变可安全缓存）。

**D11 — sudo 操作统一走临时文件 + `sudo cp`**（tee 管道与 sudo 密码 tty 冲突）；重启 docker 探测 systemd 优先、`service` 回退。

## Risks / Trade-offs

| 风险 | 缓解 |
|------|------|
| 重启 docker 中断运行中容器 | 命令输出明确提示；`mirror add/remove` 是低频操作 |
| hosts 钉定的 CF IP 彻底失效 | 拉取全断（hosts 覆盖 DNS 无兜底）→ `refresh` 重测即恢复；文档写明手动摘除 hosts 行的逃生 |
| daemon.json 已损坏（非法 JSON） | 硬错误拒绝写入，不猜测修复 |
| sudo 交互在 CI/脚本环境不可用 | 拉取层命令不进 CI；文档提供 sudoers 可选方案 |
| Worker 匿名拉取撞 Docker Hub 限额（CF 出口共享 IP） | 模板 `DOCKERHUB_AUTH` 可选 + 教程建议设置 |
| 晚高峰国际出口拥堵（优选 IP 也救不了的部分） | 预期管理：文档说明属链路固有波动；R2 缓存减少重复回源 |
| WSL 实测外的平台（Docker Desktop、纯 Linux） | 探测逻辑兼容 + 文档标注「已兼容未实测」 |
| 镜像站 URL 含 token 泄露风险 | 404 伪装不暴露服务性质；教程含换 token 流程 |
