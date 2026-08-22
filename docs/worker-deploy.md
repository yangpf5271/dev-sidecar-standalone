# 自建 Docker Hub 镜像加速（Cloudflare Worker）

10 分钟部署一个完全自主可控的 Docker Registry 代理——「谁使用谁部署」，
不依赖任何公共镜像站的存亡。模板见 [worker/docker-proxy.js](worker/docker-proxy.js)。

## 前置条件

- 一个域名（阿里云/腾讯云注册均可，几十元/年）
- Cloudflare 账号（免费版足够）

## 部署步骤

### 1. 域名托管到 Cloudflare

1. Cloudflare 控制台 → `Add a domain` → 输入你的域名
2. 按提示把注册商的 NS 记录改成 Cloudflare 给的两个地址
3. 等待生效（通常几分钟到几小时）

### 2. 创建 Worker 并粘贴模板

1. Cloudflare 控制台 → `Workers & Pages` → `Create` → `Create Worker`
2. 随意命名（如 `docker-proxy`）→ `Deploy` → `Edit code`
3. 把 [worker/docker-proxy.js](worker/docker-proxy.js) 的全部内容粘贴进去 → `Deploy`

### 3. 绑定自定义域名（关键，workers.dev 被墙）

1. Worker 详情 → `Settings` → `Domains & Routes` → `Add` → `Custom domain`
2. 填 `mirror.你的域名.com`（自动创建 DNS 记录，无需手工添加）

### 4. 配置变量（全部可选，按需）

Worker → `Settings` → `Variables and Secrets`：

| 变量 | 建议 | 说明 |
|------|------|------|
| `ACCESS_TOKEN` | **建议设置** | 访问令牌（自定义随机串）。设置后只有携带 `/<token>` 路径前缀的请求生效，防止域名泄露后被白嫖带宽。错误请求返回 404 |
| `DOCKERHUB_AUTH` | 建议 | 你的 Docker Hub `用户名:访问令牌`（hub.docker.com → Account Settings → Personal access tokens 创建，只读权限即可）。避开匿名拉取限额 |
| `R2_CACHE` | 可选 | layer 缓存。需先创建 R2 bucket（免费 10GB/月），Worker → `Settings` → `Bindings` → `Add R2 bucket`，绑定名填 `CACHE`，然后变量 `R2_CACHE` 填 `CACHE`。二次拉取同层不再回源 |

### 5. 验证

```bash
# 未设 token:
curl -i https://mirror.你的域名.com/v2/
# 期望: HTTP/2 200, 且响应头含 Docker-Distribution-API-Version: registry/2.0

# 设置了 token:
curl -i https://mirror.你的域名.com/<token>/v2/
# 错误 token → 404
```

### 6. 接入 dss

```bash
# 一条命令完成: 健康检查 → CF 优选 IP → 写入 daemon.json → 重启 docker
dss docker mirror add https://mirror.你的域名.com/<token>

# 验证
docker info | grep -A3 "Registry Mirrors"
docker pull hello-world
```

> dss 会对你的域名做 Cloudflare 边缘 IP 测速，把最优 IP 钉进 `/etc/hosts`
> （缓解「用一段时间变慢」——慢的通常是默认解析到的边缘 IP 拥堵）。
> 变慢时执行 `dss docker mirror refresh` 重测换 IP。
> 详见主 README「Docker 加速」章节。

## 常见问题

**Q: 为什么要自定义域名？** `*.workers.dev` 在国内被墙，自定义域名走 Cloudflare 可达边缘。

**Q: 为什么变慢了？** 中国到 CF 免费版的国际链路波动，默认边缘 IP 拥堵。用 `dss docker mirror refresh` 重测优选；晚间高峰属国际出口拥堵，无法完全避免。

**Q: token 泄露了怎么办？** Worker 变量里换一个 `ACCESS_TOKEN`，然后：
```bash
dss docker mirror remove https://mirror.你的域名.com/<旧token>
dss docker mirror add https://mirror.你的域名.com/<新token>
```

**Q: 支持 Docker Hub 之外的 registry 吗？** 模板只代理 Docker Hub。其他 registry 直连或走 `registry-mirrors` 数组里的其他源。

**Q: 和公共镜像站比优势？** 完全自主、任意公共镜像可拉、可加鉴权、可加 R2 缓存。劣势：速度受 CF 免费版链路影响。
