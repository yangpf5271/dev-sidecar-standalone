# docker-build-proxy

## ADDED Requirements

### Requirement: proxies 段注入且保留 auths
`dss docker on` 必须向 `~/.docker/config.json` 写入 `proxies.default` 段（httpProxy/httpsProxy/noProxy），写入为严格合并：文件中已有的一切其他内容（尤其是 `auths` 认证段）必须逐字保留；`off` 移除 proxies 段时同样保留其余内容。（SHALL）

#### Scenario: 保留内网 registry 认证
- **WHEN** config.json 已含内网 registry 与阿里云 ACR 的 auths，执行 `dss docker on`
- **THEN** auths 原样保留，proxies.default 就位；随后 `dss docker off` 后 proxies 消失、auths 依旧

#### Scenario: 文件不存在
- **WHEN** `~/.docker/config.json` 不存在
- **THEN** 创建仅含 proxies 段的新文件

### Requirement: 代理地址自动探测
构建层代理地址必须按序探测：docker0 网关 IPv4（`ip -4 addr show docker0`）→ Windows/Docker Desktop 场景的 `host.docker.internal` → 兜底 `172.17.0.1`；`--proxy-url` 参数可显式覆盖；写入前探测该地址上 dss 代理端口是否可达，不可达时输出 `HOST=0.0.0.0 dss start` 指引（仅提示不阻断）。（SHALL）

#### Scenario: WSL 原生 docker
- **WHEN** 在 WSL 中存在 docker0 网关（如 172.17.0.1）
- **THEN** proxies 指向 `http://172.17.0.1:31180`

#### Scenario: dss 未对外监听
- **WHEN** dss 仅监听 127.0.0.1，容器网关地址探测失败
- **THEN** 配置仍写入，但输出醒目提示需以 `HOST=0.0.0.0` 启动 dss 才能被容器访问

### Requirement: noProxy 自动聚合
noProxy 默认值必须自动聚合以下来源并去重：`localhost,127.0.0.1,::1`、内网段（`10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16`）、`~/.docker/config.json` auths 中的 registry 主机（含去端口的主机名/IP）、daemon.json 的 `insecure-registries` 主机（文件可读时）、用户通过 `--no-proxy` 追加的项。（SHALL）

#### Scenario: 内网 registry 自动排除
- **WHEN** auths 含 `58.247.122.126:62185`，daemon.json 含 `insecure-registries: ["10.1.2.3:5000"]`
- **THEN** noProxy 包含 `58.247.122.126` 与 `10.1.2.3`，内网拉取不经代理

### Requirement: 构建层与镜像层命令的平台边界
`dss docker on/off/status` 在 Windows、Linux、WSL 均可用（仅操作用户级 config.json，无 sudo）；README 文档需说明构建内容器访问被 MITM 拦截域名（如 github.com）时需自带 CA（`--secret` 方案）或改用镜像源，不做自动注入。（SHALL）

#### Scenario: Windows 使用
- **WHEN** 在 Windows 原生环境执行 `dss docker on`
- **THEN** config.json（`%USERPROFILE%\.docker\config.json`）proxies 注入成功，代理地址探测回退 `host.docker.internal`
