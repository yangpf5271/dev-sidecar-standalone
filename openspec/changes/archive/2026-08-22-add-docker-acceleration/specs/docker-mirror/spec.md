# docker-mirror

## ADDED Requirements

### Requirement: 镜像源健康检查
`dss docker mirror add <url>` 在写入任何系统配置前，必须探测 `<url>/v2/` 端点，仅当响应为 HTTP 200 或 401（registry 合法响应）时继续。（SHALL）

#### Scenario: 健康的镜像源
- **WHEN** 用户执行 `dss docker mirror add https://mirror.example.com/token` 且该地址 `/v2/` 返回 200（含 `Docker-Distribution-API-Version: registry/2.0` 头或正文合法）
- **THEN** 命令继续执行优选与写入流程

#### Scenario: 不可达的镜像源
- **WHEN** 目标 `/v2/` 超时、连接失败或返回非 200/401 状态码
- **THEN** 命令以非零退出码失败，明确提示目标不可作为 registry mirror，且不修改 daemon.json 与 /etc/hosts

#### Scenario: 强制跳过检查
- **WHEN** 用户附加 `--force` 参数
- **THEN** 跳过健康检查直接进入写入流程

### Requirement: daemon.json 合并写入
写入 `/etc/docker/daemon.json` 的 `registry-mirrors` 数组时，必须保留该文件中所有其他已有配置键不变；追加新 URL 时去重；文件不存在时创建仅含 `registry-mirrors` 的新文件；文件存在但为非法 JSON 时必须拒绝写入并以明确错误退出。（SHALL）

#### Scenario: 保留现有配置
- **WHEN** daemon.json 已含 `{"insecure-registries": ["10.0.0.1:5000"]}`，执行 mirror add
- **THEN** 写入后 `insecure-registries` 原样保留，`registry-mirrors` 含新 URL

#### Scenario: 损坏文件保护
- **WHEN** daemon.json 内容不是合法 JSON
- **THEN** 命令失败退出，不写入，提示用户人工修复

#### Scenario: 重复添加
- **WHEN** 添加的 URL 已存在于 `registry-mirrors`
- **THEN** 不产生重复条目，其余流程（hosts、重启提示）照常幂等执行

### Requirement: docker 重启与生效验证
配置写入后必须重启 docker 守护进程（优先 systemd `systemctl restart docker`，探测失败回退 `service docker restart`），并通过 `docker info` 验证 `Registry Mirrors` 已包含新 URL。（SHALL）

#### Scenario: 重启并验证
- **WHEN** mirror add 完成写入
- **THEN** 输出重启动作与结果，`docker info` 的 Registry Mirrors 列表包含新 URL，并提示可选的 `docker pull hello-world` 实测

### Requirement: 对称移除
`dss docker mirror remove <url>`（或 `off`）必须同时：从 daemon.json 的 `registry-mirrors` 移除该 URL（数组空则删除该键）、移除对应 `/etc/hosts` 钉定行（见 docker-cf-optimization）、重启 docker。（SHALL）

#### Scenario: 完整移除
- **WHEN** 对已配置的 URL 执行 mirror remove
- **THEN** daemon.json 不再含该 URL，hosts 中对应钉定行被删除，docker 重启，三处状态一致

### Requirement: 平台限制
拉取层命令依赖 `/etc/hosts` 与 daemon.json 的 Linux 语义，在 Windows（非 WSL）下执行时必须以明确指引退出而非执行半套逻辑。（SHALL）

#### Scenario: Windows 下调用
- **WHEN** 在 Windows 原生环境执行 `dss docker mirror add`
- **THEN** 输出说明该命令需在 Linux/WSL 环境运行（Windows 用户应使用 Docker Desktop 图形配置或进入 WSL），以非零码退出
