# docker-worker-template

## ADDED Requirements

### Requirement: 项目交付 Worker 模板与教程
项目必须在文档中交付可部署的 Docker Hub Registry 代理 Worker 模板与分步部署教程（域名托管 → 创建 Worker → 绑定自定义域名 → 可选变量 → `/v2/` 验证 → `dss docker mirror add` 接入），明确「谁使用谁部署」原则——dss 命令只接受任意用户提供的 URL，不绑定特定部署。（SHALL）

#### Scenario: 按教程完成部署
- **WHEN** 用户按教程在 Cloudflare 部署模板并绑定自定义域名
- **THEN** `curl -i https://<域名>[/token]/v2/` 返回 200 且含 `Docker-Distribution-API-Version: registry/2.0` 头，可用 `dss docker mirror add` 接入

### Requirement: 上游认证代办
Worker 必须代理客户端与 Docker Hub 之间的全部认证交互：客户端不接触 `auth.docker.io`（墙内不可达）；Worker 以匿名或 `DOCKERHUB_AUTH` 环境变量（`username:personal-access-token`）向上游换取 Bearer token 并缓存于 isolate 内存（按 expires_in 失效）。（SHALL）

#### Scenario: 匿名拉取公共镜像
- **WHEN** 客户端经 Worker 请求某公共镜像 manifest，未配置 DOCKERHUB_AUTH
- **THEN** Worker 以匿名 token 代理成功，客户端全程未向 auth.docker.io 发起任何请求

### Requirement: layer 重定向跟进
layer blob 请求（`/v2/<name>/blobs/<digest>`）收到上游 307 重定向时，Worker 必须自行请求重定向目标（CDN）并流式回传响应体，不得把重定向暴露给客户端（客户端无法直连 layer CDN）。（SHALL）

#### Scenario: 拉取完整镜像
- **WHEN** 客户端拉取含多个 layer 的镜像
- **THEN** manifest 与全部 blob 均经 Worker 返回，`docker pull` 端到端成功

### Requirement: 可选 token 路径前缀鉴权
设置环境变量 `ACCESS_TOKEN` 后，Worker 必须仅响应路径以 `/<token>` 开头的请求（前缀剥离后代理），其余请求一律返回 404（伪装普通站点，不暴露代理存在）；未设置时不鉴权。（SHALL）

#### Scenario: 错误 token
- **WHEN** 以错误 token 或无 token 请求已配置 ACCESS_TOKEN 的 Worker
- **THEN** 返回 404，无任何代理特征

#### Scenario: 正确 token
- **WHEN** 请求 `https://<域名>/<token>/v2/`
- **THEN** 前缀剥离，等价于无鉴权模式的 `/v2/` 响应

### Requirement: 可选缓存
manifest 响应默认经 Workers Cache API 缓存（ref+digest 不可变，可安全缓存）；设置 `R2_CACHE` 环境变量（R2 bucket 绑定名）后，layer blob 首次回源时异步写入 R2、命中时零回源返回。（SHALL）

#### Scenario: R2 命中
- **WHEN** 同一 layer 第二次被请求且已配置 R2_CACHE
- **THEN** 响应来自 R2 缓存，无上游请求
