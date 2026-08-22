# Dev-Sidecar Standalone (纯服务器版)

[Dev-Sidecar](https://github.com/docmirror/dev-sidecar) 的纯服务器改造版，去掉了 Electron GUI、认证 API、PAC/梯子等依赖，只保留核心 MITM 代理加速功能。

适用于服务器、CI/CD 环境、Docker 容器、无图形界面的 Linux VPS、树莓派等场景。

---

## 快速开始

**源码运行：**

```bash
git clone <仓库地址>
cd dev-sidecar-standalone
npm install
node index.js
```

**打包安装：**

```bash
npm pack
npm install -g ./dev-sidecar-standalone-1.0.0.tgz
dss
```

启动后输出：

```
HTTP 代理:  127.0.0.1:31180    # 简单 HTTP 代理（CONNECT 隧道）
HTTPS 代理: 127.0.0.1:31181   # HTTPS MITM 代理（拦截解密加速）
```

> 打包安装的完整部署指南（CLI 命令、systemd、PM2、Docker、CI/CD）见 [docs/deploy-guide.md](docs/deploy-guide.md)。

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

### 浏览器

设置 HTTP 代理为 `127.0.0.1:31180`（HTTP 代理端口），安装 CA 证书到系统信任列表后，浏览器会自动通过 HTTPS MITM 端口 `31181` 进行拦截加速。

> 如果浏览器只配置 31180 而不安装 CA 证书，HTTPS 网站会退化为普通 CONNECT 隧道，域名加速（镜像替换）不生效。要使用完整加速，需安装 CA 证书。

### 命令行 (curl / wget)

**简单隧道（无需证书，走 HTTP 代理端口 31180）：**
```bash
# curl
curl -x http://127.0.0.1:31180 https://github.com
# wget
wget -e use_proxy=yes -e http_proxy=http://127.0.0.1:31180 https://github.com
```

**完整 MITM 加速（需先安装 CA 证书，走 MITM 端口 31181）：**
```bash
# curl（需指定 CA 证书）
curl --proxy http://127.0.0.1:31181 --cacert ~/.dev-sidecar/dev-sidecar.ca.crt https://raw.githubusercontent.com/...
```

### npm 通过代理

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

### Git 通过代理

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

### 全局系统代理

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
