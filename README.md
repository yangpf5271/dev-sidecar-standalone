# Dev-Sidecar Standalone (纯服务器版)

[Dev-Sidecar](https://github.com/docmirror/dev-sidecar) 的纯服务器改造版，去掉了 Electron GUI、认证 API、PAC/梯子等依赖，只保留核心 MITM 代理加速功能。

适用于服务器、CI/CD 环境、Docker 容器、无图形界面的 Linux VPS、树莓派等场景。

---

## 快速开始

**npm 安装（推荐）：**

```bash
npm install -g dev-sidecar-standalone
dss
```

**源码运行：**

```bash
git clone https://github.com/yangpf5271/dev-sidecar-standalone.git
cd dev-sidecar-standalone
npm install
node index.js
```

启动后输出：

```
HTTP 代理:  127.0.0.1:31180    # 简单 HTTP 代理（CONNECT 隧道）
HTTPS 代理: 127.0.0.1:31181   # HTTPS MITM 代理（拦截解密加速）
```

> 服务器部署（systemd、PM2、Docker、CI/CD）见 [docs/deploy-guide.md](docs/deploy-guide.md)。

---

## 加速目标

| 类别 | 站点 | 加速方式 |
|------|------|----------|
| GitHub | `github.com`, `raw.githubusercontent.com`, `github.githubassets.com` 等 | 预设 IP + SNI 伪装 + 镜像代理 |
| Google CDN | `ajax.googleapis.com`, `fonts.googleapis.com` 等 | 镜像代理 |
| Docker | `docker.com`, `hub.docker.com` | 预设 IP + SNI 伪装 |
| Python PyPI | `pypi.org` | DNS 优化 |
| JetBrains | `*.jetbrains.com` | DNS 优化 |
| 广告拦截 | Carbon ads, BuySellAds | 拦截/中止 |

> 注：`registry.npmjs.org` 等其他站点可通过 `config/default.json` 的 `dns.mapping` 自行添加 DNS 优化。

---

## 命令总览

| 类别 | 命令 | 作用 |
|------|------|------|
| 启动 | `dss` / `dss start` | 前台运行 / 后台守护进程 |
| 进程管理 | `dss stop` `restart` `status` `log` | 停止（含智能恢复）/ 重启 / 状态 / 日志 |
| 代理配置 | `dss npm on\|off` `dss git on\|off` | 一键配置 npm/git 走代理 |
| 环境变量 | `dss env on\|off` | 输出 shell 代理变量（配合 eval） |
| 镜像源 | `dss npm\|pip mirror <名称>\|off` | 切换/恢复 npm/pip 国内镜像源 |
| Docker | `dss docker mirror add\|refresh\|remove` | 镜像拉取加速（自建镜像站接入） |
| Docker | `dss docker on\|off` | 构建层依赖安装走代理 |
| 证书 | `dss cert` | CA 证书路径与安装方法 |
| 恢复 | `dss restore` | 清理指向本代理的所有残留配置 |

`dss -h` 查看完整帮助；各命令 `-h` 查看子命令帮助。

---

## 安装 CA 证书

HTTPS 拦截加速需要安装 CA 证书到操作系统信任列表。证书在服务首次启动时自动生成在 `~/.dev-sidecar/dev-sidecar.ca.crt`。

> 如通过 `DEV_SIDECAR_HOME` 自定义了数据目录，替换下面路径中的 `~/.dev-sidecar`。

**Windows：**
双击 `~/.dev-sidecar/dev-sidecar.ca.crt` → 安装证书 → 受信任的根证书颁发机构

**macOS：**
```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.dev-sidecar/dev-sidecar.ca.crt
```

**Linux：**
```bash
# Debian / Ubuntu
sudo cp ~/.dev-sidecar/dev-sidecar.ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates

# RHEL / CentOS / Fedora
sudo cp ~/.dev-sidecar/dev-sidecar.ca.crt /etc/pki/ca-trust/source/anchors/
sudo update-ca-trust
```

**不安装 CA 证书**则仅 HTTP 请求可被加速，HTTPS 请求会直接透传（不拦截不解密），域名镜像替换等核心加速不生效。

---

## 使用方式

### 进程管理

```bash
dss start              # 后台启动（守护进程）
dss stop               # 停止，并自动恢复 npm/git 中指向本代理的配置
dss restart            # 重启（保留配置，不断加速状态）
dss log [-f] [-n 200]  # 查看守护进程日志（-f 持续跟随）
dss status             # 运行状态 / 端口 / PID / 证书状态
```

`dss stop` / `dss restore` 采用**智能恢复**：只清理 dss 设置的、且仍指向本代理地址的配置项，用户自己的其他代理配置（公司代理等）绝对不受影响。代理崩溃/被强杀后的配置残留，用 `dss restore` 一键扫尾；`dss status` 检测到残留会主动提示。

> 说明：直接运行 `dss`（无参数）为前台模式，Ctrl+C 停止。`dss -d` 等价于 `dss start`。

### 代理配置（npm / git / shell 环境变量）

npm / Git / 环境变量都可以用 `dss` 子命令一键配置，无需手动敲多条命令：

```bash
# npm 走代理（简单模式，无需证书）
dss npm on

# npm 完整加速（MITM 模式，需已安装 CA 证书）
dss npm on --mitm

# 取消 npm 代理
dss npm off

# 查看当前配置
dss npm status
```

```bash
# git 走代理（完整模式：HTTP + HTTPS MITM + CA 证书）
dss git on

# git 简单模式（仅 HTTP 隧道，无需证书）
dss git on --simple

# 取消 git 代理
dss git off

# 查看当前配置
dss git status
```

```bash
# 当前 shell 环境变量（需配合 eval / iex 生效）
eval "$(dss env on)"          # bash / zsh
dss env on | iex              # PowerShell
eval "$(dss env off)"         # 取消代理

# 指定 shell 格式
dss env on --shell cmd
```

```bash
# 查看代理运行状态
dss status

# 查看 CA 证书路径和安装方法
dss cert
```

### 镜像源切换（npm / pip）

与代理模式正交——镜像源国内直连可达，无需代理运行：

```bash
# npm：切换到 npmmirror（淘宝）/ 中科大镜像
dss npm mirror npmmirror
dss npm mirror status      # 查看当前源
dss npm mirror off         # 恢复切换前的源

# pip：切换到清华 / 阿里 / 中科大 / 南大镜像（均为 https）
dss pip mirror tsinghua
dss pip mirror off
```

设计说明：

- **快照保护**：首次切换前自动记录当前源，`off` 恢复快照而非硬编码官方源——企业内网源不会被覆盖丢失
- **只提供 https 镜像**，不使用 `trusted-host`（避免跳过证书校验的安全降级）
- **与代理互斥提示**：镜像无需配合代理（双重跳转反而慢），同时开启会提示
- 已知特性：npm 镜像只读，`npm publish` 需临时指定官方源（`npm publish --registry https://registry.npmjs.org`）；新发布的包同步到镜像约有 10 分钟延迟；项目场景注意 `package-lock.json` 的 `resolved` 字段会随源变化

### Docker 加速

Docker 场景分两层，分别解决「拉不动基础镜像」和「构建时依赖装不上」：

**拉取层（docker pull / FROM，需 Linux/WSL + sudo）**

```bash
# 接入自建镜像源（推荐，谁使用谁部署，见下方「自建镜像站」）
# 公网鉴权用路径模式 https://域名/<token>（需 Docker Engine ≥ 24；
# 旧版 Docker 请在 Worker 侧不设 token，CLI 会在旧版上自动拦截路径模式）
dss docker mirror add https://mirror.你的域名.com/<token>

# 变慢时重测优选 IP（CF 边缘 IP 质量会漂移，这是自建站变慢的主因）
dss docker mirror refresh

# 移除
dss docker mirror remove https://mirror.你的域名.com/<token>

# 状态总览
dss docker status
```

`mirror add` 一条命令完成：健康检查（`/v2/` 硬阻断，`--force` 跳过）→ Cloudflare 边缘 IP 测速优选 → `/etc/hosts` 钉定 → `daemon.json` 合并写入（**保留现有全部配置**）→ 重启 docker → `docker info` 验证。配置后 `docker pull` 无感知直拉。

> WSL 注意：WSL 重启时会重新生成 `/etc/hosts`，钉定行可能丢失（拉取变慢的信号）——执行 `dss docker mirror refresh` 重钉；或在 `/etc/wsl.conf` 设置 `[network]` `generateHosts = false` 永久保留。

**自建镜像站（推荐）**：[docs/worker-deploy.md](docs/worker-deploy.md) —— 基于 Cloudflare Worker 的 Docker Hub 代理模板，10 分钟部署：manifest + layer 全代理（客户端不直连被墙的 layer CDN）、Worker 侧代办上游认证（不接触被墙的 auth.docker.io）、可选 token 鉴权（错误返回 404 伪装）、可选 Docker Hub 账号防匿名限额、可选 R2 layer 缓存。背景：Docker Hub 被 DNS 污染 + SNI 掐断双重封锁（GitHub 式方案实测无效），阿里云个人加速器 2024 后对公共镜像失效，自建 Worker 是当前唯一「任意镜像可拉 + 完全自主」的方案。

**构建层（docker build RUN / docker run，三平台，无 sudo）**

```bash
# 一键注入 ~/.docker/config.json proxies 段（auths 严格保留）
# docker build / docker run 自动获得代理环境变量
dss docker on          # 代理地址自动探测（docker0 网关 / host.docker.internal）
dss docker off         # 移除（auths 保留）
```

- **前提**：容器经宿主网关访问代理，dss 需以 `HOST=0.0.0.0 dss start` 启动（命令会探测并提示）
- **noProxy 自动聚合**：内网段 + 你 `config.json` auths 里的 registry 主机 + daemon.json `insecure-registries`——内网镜像仓库绝不会误走代理
- **边界**：构建内访问 `github.com` 等被 MITM 拦截的域名需自带 CA（`docker build --secret` 挂载）或改用镜像源；`registry.npmjs.org`、`pypi.org`、`deb.debian.org` 走纯隧道无需 CA

<details>
<summary>构建内访问被拦截域名的 CA 方案（点击展开）</summary>

```dockerfile
# Dockerfile 中声明 secret（不会进入镜像层）
RUN --mount=type=secret,id=dss_ca \
    cp /run/secrets/dss_ca /usr/local/share/ca-certificates/dss.crt && \
    update-ca-certificates

# 构建时挂载
docker build --secret id=dss_ca,src=~/.dev-sidecar/dev-sidecar.ca.crt .
```

</details>

> 子命令会自动探测代理是否在运行、证书是否已生成，并给出提示。
> 使用了自定义 `PORT` 或 `-c` 配置文件的场景，子命令同样支持 `-c` 参数和环境变量。
>
> **注意：** Yarn Classic (1.x) 不读取 `.npmrc` 代理配置，Yarn 用户请使用 `dss env on` 方式。

### 手动配置方式（参考）

以上命令背后的手动配置方式，供理解原理或自定义时使用。

#### 浏览器

设置 HTTP 代理为 `127.0.0.1:31180`，安装 CA 证书到系统信任列表后，浏览器会自动通过 HTTPS MITM 端口 `31181` 进行拦截加速。

> 如果浏览器只配置 31180 而不安装 CA 证书，HTTPS 网站会退化为普通 CONNECT 隧道，域名加速（镜像替换）不生效。要使用完整加速，需安装 CA 证书。

#### 命令行 (curl / wget)

```bash
# 简单隧道（无需证书，走 HTTP 代理端口 31180）
curl -x http://127.0.0.1:31180 https://github.com
wget -e use_proxy=yes -e http_proxy=http://127.0.0.1:31180 https://github.com

# 完整 MITM 加速（需 CA 证书，走 MITM 端口 31181）
curl --proxy http://127.0.0.1:31181 --cacert ~/.dev-sidecar/dev-sidecar.ca.crt https://raw.githubusercontent.com/...
```

#### npm 通过代理

**简单代理（无证书，走 HTTP 代理端口 31180）：**
```bash
npm config set proxy http://127.0.0.1:31180
npm config set https-proxy http://127.0.0.1:31180
```

**MITM 加速（需安装 CA 证书，走 MITM 端口 31181）：**
```bash
npm config set proxy http://127.0.0.1:31180
npm config set https-proxy http://127.0.0.1:31181
npm config set cafile ~/.dev-sidecar/dev-sidecar.ca.crt
```

**还原：**
```bash
npm config delete proxy
npm config delete https-proxy
npm config delete cafile
```

#### Git 通过代理

dev-sidecar 提供两个端口，Git 可以各取所需：

| 端口 | 用途 | Git 配置 |
|------|------|----------|
| **31180** | HTTP 代理（CONNECT 隧道） | `http.proxy` —— 代理 HTTP 仓库 |
| **31181** | HTTPS MITM 代理（拦截加速） | `https.proxy` —— 代理 HTTPS 仓库，需要 CA 证书 |

**推荐配置（完整加速）：**

```bash
# 先安装 CA 证书到 Git
git config --global http.sslCAInfo ~/.dev-sidecar/dev-sidecar.ca.crt

# 设置代理（两个端口各司其职）
git config --global http.proxy http://127.0.0.1:31180
git config --global https.proxy http://127.0.0.1:31181

# 还原
git config --global --unset http.proxy
git config --global --unset https.proxy
git config --global --unset http.sslCAInfo
```

> **说明：** `https.proxy http://127.0.0.1:31181` 中协议写 `http://` 是**正确的**。Git 通过 HTTP CONNECT 方法与代理建立连接，无论远端仓库是 HTTP 还是 HTTPS，Git 跟代理通信始终用 HTTP 协议。MITM 代理解密 HTTPS 发生在代理侧，不影响 Git 端的连接方式。
>
> 如果自定义了 `PORT`，HTTP 端口为 `PORT - 1`，MITM 端口为 `PORT`。

#### 全局系统代理

**简单隧道（无需证书，两个端口都走 HTTP 代理）：**
```bash
# Linux / macOS
export HTTP_PROXY=http://127.0.0.1:31180
export HTTPS_PROXY=http://127.0.0.1:31180
export NO_PROXY=localhost,127.0.0.1

# Windows
set HTTP_PROXY=http://127.0.0.1:31180
set HTTPS_PROXY=http://127.0.0.1:31180
set NO_PROXY=localhost,127.0.0.1
```

**MITM 加速（需安装 CA 证书，HTTPS 走 MITM 端口 31181）：**
```bash
# Linux / macOS
export HTTP_PROXY=http://127.0.0.1:31180
export HTTPS_PROXY=http://127.0.0.1:31181
export NO_PROXY=localhost,127.0.0.1

# Windows
set HTTP_PROXY=http://127.0.0.1:31180
set HTTPS_PROXY=http://127.0.0.1:31181
set NO_PROXY=localhost,127.0.0.1
```

---

## 配置说明

配置文件位于 `config/default.json`，支持自定义：

- 代理端口、监听地址
- 数据目录（通过 `DEV_SIDECAR_HOME` 环境变量）
- 拦截规则（域名 → 路径 → 动作）
- DNS 提供商（cloudflare / 360 / rubyfish）
- 预设 IP 列表
- 黑白名单
- 超时设置
- 测速开关

**一般场景下无需修改配置，环境变量已满足大部分需求。**

---

## 与原版差异

| 功能 | 原版 | 本版 |
|------|------|------|
| 图形界面 | Electron | 无 |
| API 认证 | OAuth | 无 |
| 系统代理设置 | 自动 | 手动 |
| PAC/梯子 | overwall 插件 | 无 |
| 油猴脚本注入 | InsertScript | 无 |
| 核心 MITM 代理 | 有 | 有 |
| DNS 优化 | 有 | 有 |
| GitHub 加速 | 有 | 有 |
| Google CDN 镜像 | 有 | 有 |
| Docker 加速 | 有 | 有 |
| CA 证书自动生成 | 有 | 有 |
| 测速/择优 | 有 | 有 |
| CLI 命令 | 无 | `dss` 命令 |
| Docker 原生支持 | 无 | 提供 Dockerfile |
| systemd 服务 | 无 | 提供配置方案 |

---

## 常见问题

**Q: 端口被占用？**
```bash
# 查看端口占用
netstat -ano | findstr :31180    # Windows
ss -tlnp | grep -E '3118[01]'   # Linux

# 自定义端口启动
PORT=8888 dss
# 此时 HTTP 端口为 8887，MITM 端口为 8888
```

**Q: HTTPS 请求不被拦截？**
检查 CA 证书是否已安装到系统信任列表。

**Q: 代理后部分网站访问慢？**
调整 `config/default.json` 中的 `timeoutMapping`，或关闭测速功能 `dns.speedTest.enabled: false`。

**Q: 如何更新版本？**
```bash
# npm 全局安装
npm update -g dev-sidecar-standalone

# 源码
git pull
npm install
```

**Q: 能否同时多个进程？**
可以。每个进程使用不同 `PORT` 和独立的配置目录。但单个代理实例已支持并发，通常不需要多开。

---

## 许可证

本项目基于 [Mozilla Public License 2.0 (MPL-2.0)](./LICENSE) 开源。

## 致谢

本项目是 [Dev-Sidecar](https://github.com/docmirror/dev-sidecar) 的衍生作品，感谢原项目作者 [docmirror](https://github.com/docmirror) / [greper](https://github.com/greper) / WangLiang 的开源贡献。
