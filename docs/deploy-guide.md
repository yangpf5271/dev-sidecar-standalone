# 部署指南

打包安装（npm pack / npm install -g）后的完整部署运维指南。

> 源码运行用户只需 `npm install && node index.js`，无需阅读本文档。

---

## 目录

- [安装方式](#安装方式)
- [CLI 命令参考](#cli-命令参考)
- [环境变量](#环境变量)
- [systemd 服务 (Linux)](#systemd-服务-linux)
- [PM2 进程管理](#pm2-进程管理)
- [Docker 部署](#docker-部署)
- [CI/CD 集成](#cicd-集成)

---

## 安装方式

### npm 安装（推荐）

```bash
npm install -g dev-sidecar-standalone
dss
```

### npm link（开发调试）

```bash
# 在项目目录内注册到全局
npm link
dss
```

### 离线部署（npm pack）

```bash
# 在开发机器上打包（或从 GitHub Release 下载 tgz）
npm pack
# 生成 dev-sidecar-standalone-x.y.z.tgz

# 传到目标服务器后安装
npm install -g ./dev-sidecar-standalone-x.y.z.tgz
dss
```

**发布到 npm 源：**

```bash
npm login
npm publish
# 更新版本
npm version patch  # 或 minor / major
npm publish
```

---

## CLI 命令参考

### 基本命令

```bash
dss           # 启动（前台，Ctrl+C 停止）
dss -d        # 后台守护进程（Linux/Mac）
dss -h        # 帮助
dss -V        # 版本号
```

也可用全称：`--help`、`--version`、`--daemon`。

---

## 环境变量

所有配置通过环境变量传入，无需修改配置文件：

| 变量 | 说明 | 默认值 | 示例 |
|------|------|--------|------|
| `PORT` | HTTPS 代理端口 | `31181` | `PORT=8080 dss` |
| `HOST` | 监听地址 | `127.0.0.1` | `HOST=0.0.0.0 dss` |
| `DEV_SIDECAR_HOME` | 数据目录（CA 证书存放位置） | `~/.dev-sidecar` | `DEV_SIDECAR_HOME=/data/ds dss` |

**跨平台用法：**

```bash
# Linux / macOS
PORT=8080 HOST=0.0.0.0 dss

# Windows (cmd)
set PORT=8080 && set HOST=0.0.0.0 && dss

# Windows (PowerShell)
$env:PORT=8080; $env:HOST='0.0.0.0'; dss
```

**运行示例：**

```bash
# 开发环境 - 仅本地
dss

# 团队服务器 - 监听所有网卡
HOST=0.0.0.0 dss

# 自定义端口 - 避免冲突（HTTP 端口自动为 PORT-1）
PORT=8888 dss

# 自定义数据目录
DEV_SIDECAR_HOME=/data/dev-sidecar dss

# Linux 后台运行
dss -d
# 或
nohup dss > /var/log/dev-sidecar.log 2>&1 &
```

---

## systemd 服务 (Linux)

> **注意：** 如果使用 nvm 安装的 Node.js，systemd 环境默认不包含 nvm 路径，
> 直接使用 `ExecStart=/usr/bin/dss` 会因找不到 node 解释器而失败（`status=127`）。
> 建议使用 wrapper 脚本自动查找可用的 Node.js 环境：

```bash
# 创建 wrapper 脚本（自动适配 nvm / 直接安装 / 二进制包等多种 Node.js 安装方式）
# 注意：通过 getent 从 /etc/passwd 获取主目录，因为 systemd 环境下 $HOME 未设置
sudo tee /usr/local/bin/dss-wrapper << 'SCRIPT'
#!/bin/bash
# 1. 优先从 nvm 中查找已安装 dss 的 Node 版本
USER_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
NVM_DIR="$USER_HOME/.nvm"
if [ -d "$NVM_DIR/versions/node" ]; then
  # 在所有 nvm 版本中查找 dss 可执行文件，选版本号最大的
  for bin in "$NVM_DIR"/versions/node/*/bin/dss; do
    [ -x "$bin" ] && DEVS_CANDIDATES="$DEVS_CANDIDATES"$'\n'"$(dirname "$bin")"
  done
  if [ -n "$DEVS_CANDIDATES" ]; then
    BEST=$(echo "$DEVS_CANDIDATES" | sort -V | tail -1)
    export PATH="$BEST:$PATH"
    exec dss "$@"
  fi
fi
# 2. 回退到系统 PATH（适配直接安装的 Node.js：apt/dnf/binary）
exec dss "$@"
SCRIPT
sudo chmod +x /usr/local/bin/dss-wrapper
```

```bash
sudo tee /etc/systemd/system/dev-sidecar.service << 'EOF'
[Unit]
Description=Dev-Sidecar Proxy
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/dss-wrapper
Restart=always
RestartSec=5
Environment=HOST=0.0.0.0
Environment=PORT=31181

[Install]
WantedBy=multi-user.target
EOF
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable dev-sidecar
sudo systemctl start dev-sidecar
sudo systemctl status dev-sidecar
```

> **切换 Node.js 版本后：** 只需在新版本中全局安装 dev-sidecar-standalone，wrapper 会自动找到并使用它，无需修改 systemd 配置。

> **常见问题：** 如果启动后进程立即退出，先检查端口是否被占用：
> ```bash
> sudo lsof -i :31181    # 查看端口占用
> fuser -k 31181/tcp     # 释放端口后重启
> sudo systemctl restart dev-sidecar
> ```

---

## PM2 进程管理

```bash
npm install -g pm2

# 启动
pm2 start dss --name dev-sidecar

# 保存进程列表（开机自启）
pm2 save
pm2 startup   # WSL 环境下可能报错 "Init system not found"，可忽略

# 常用操作
pm2 status
pm2 logs dev-sidecar
pm2 restart dev-sidecar
pm2 stop dev-sidecar

# 带环境变量启动
HOST=0.0.0.0 PORT=31181 pm2 start dss --name dev-sidecar
```

---

## Docker 部署

### 方式一：从源码构建

**Dockerfile：**

```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

EXPOSE 31180 31181

CMD ["node", "index.js"]
```

**docker-compose.yml：**

```yaml
version: '3'
services:
  dev-sidecar:
    build: .
    ports:
      - "31180:31180"
      - "31181:31181"
    environment:
      - HOST=0.0.0.0
      - PORT=31181
    volumes:
      - dev-sidecar-data:/root/.dev-sidecar
    restart: unless-stopped

volumes:
  dev-sidecar-data:
```

**构建运行：**

```bash
docker-compose up -d
# 或
docker build -t dev-sidecar .
docker run -d \
  --name dev-sidecar \
  -p 31180:31180 \
  -p 31181:31181 \
  -e HOST=0.0.0.0 \
  -e PORT=31181 \
  -v dev-sidecar-data:/root/.dev-sidecar \
  --restart unless-stopped \
  dev-sidecar
```

### 方式二：在已有容器中安装（npm pack）

将 `.tgz` 包复制到目标容器中安装，然后用 `CMD` 或 `ENTRYPOINT` 启动：

```bash
# 1. 将包复制到目标容器
docker cp dev-sidecar-standalone-1.0.0.tgz <容器名或ID>:/tmp/

# 2. 进入容器安装
docker exec -it <容器名或ID> sh
npm install -g /tmp/dev-sidecar-standalone-1.0.0.tgz
```

**如果使用 Dockerfile 构建新镜像：**

```dockerfile
FROM node:18-alpine

COPY dev-sidecar-standalone-1.0.0.tgz /tmp/
RUN npm install -g /tmp/dev-sidecar-standalone-1.0.0.tgz && rm /tmp/dev-sidecar-standalone-1.0.0.tgz

EXPOSE 31180 31181
VOLUME /root/.dev-sidecar

CMD ["dss"]
```

```bash
docker build -t dev-sidecar .
docker run -d \
  --name dev-sidecar \
  -p 31180:31180 \
  -p 31181:31181 \
  -e HOST=0.0.0.0 \
  -e PORT=31181 \
  -v dev-sidecar-data:/root/.dev-sidecar \
  --restart unless-stopped \
  dev-sidecar
```

**关键点：** `restart: unless-stopped` 确保 Docker 重启或容器异常退出后自动拉起，不需要 PM2 或 systemd。

> **Docker 中保存 CA 证书：** 挂载数据卷 `-v dev-sidecar-data:/root/.dev-sidecar`，证书会持久化在卷中。也可从容器复制到宿主机：
> ```bash
> docker cp dev-sidecar:/root/.dev-sidecar/dev-sidecar.ca.crt .
> ```

---

## CI/CD 集成

**准备工作：构建 Docker 镜像并推送到仓库**

```bash
docker build -t your-registry/dev-sidecar:latest .
docker push your-registry/dev-sidecar:latest
```

**GitHub Actions - 在 CI 中启动代理加速构建：**

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    services:
      dev-sidecar:
        image: your-registry/dev-sidecar:latest
        ports:
          - 31180:31180
          - 31181:31181
        env:
          HOST: 0.0.0.0
          PORT: 31181
    steps:
      - uses: actions/checkout@v4

      - name: 等待代理就绪
        run: |
          for i in $(seq 1 10); do
            curl -s -o /dev/null http://localhost:31180 && break
            sleep 2
          done

      - name: 安装 CA 证书（使 MITM 加速生效）
        run: |
          docker cp $(docker ps -q --filter name=dev-sidecar):/root/.dev-sidecar/dev-sidecar.ca.crt /tmp/
          sudo cp /tmp/dev-sidecar.ca.crt /usr/local/share/ca-certificates/
          sudo update-ca-certificates

      - name: 通过代理构建
        run: |
          export HTTP_PROXY=http://localhost:31180
          export HTTPS_PROXY=http://localhost:31181
          npm install
```
