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
| `ACCESS_TOKEN` | **建议设置** | 访问令牌（自定义随机串，防域名泄露后被白嫖）。设置后支持两种认证方式（见下节） |
| `DOCKERHUB_AUTH` | 建议 | 你的 Docker Hub `用户名:访问令牌`（hub.docker.com → Account Settings → Personal access tokens 创建，只读权限即可，**仅 ASCII 字符**）。避开匿名拉取限额 |
| `R2_CACHE` | 可选 | layer 缓存，见下下节 |

### 5. 接入认证（设置 ACCESS_TOKEN 时二选一）

**方式 A：Basic 模式（推荐，兼容所有 Docker 版本）**

```bash
# 客户端一次性登录（用户名任意，密码 = ACCESS_TOKEN）
docker login mirror.你的域名.com -u any -p <token>

# 之后 mirror 地址不带路径
dss docker mirror add https://mirror.你的域名.com
```

**方式 B：路径前缀模式（需 Docker Engine ≥ 24）**

```bash
dss docker mirror add https://mirror.你的域名.com/<token>
```

> ⚠️ **版本要求**：Docker ≤ 23.x 的 daemon 会因 registry-mirror 地址含路径而**拒绝启动**
>（`invalid mirror: path...`，[moby#36598](https://github.com/moby/moby/issues/36598)）。
> `dss docker mirror add` 会检测你的 Docker 版本并在旧版本上阻止路径模式（`--force` 可越过）。
> 不确定版本就用方式 A。

两种方式可以共存：带 token 路径的请求走路径模式，带 Basic 头的请求走 Basic 模式。
未认证的 `/v2/` 返回 401 Basic 质询，其余路径一律 404（伪装普通站点，不暴露代理存在）。

### 6. R2 layer 缓存（可选）

1. Cloudflare R2 → `Create bucket`（免费 10GB 存储/月）
2. Worker → `Settings` → `Bindings` → `Add` → `R2 bucket`
   - **Variable name 填 `R2_CACHE`**（推荐，绑定名即变量名）
   - 或绑定名任意（如 `CACHE`），再在 Variables 里加 `R2_CACHE` = `CACHE`（填绑定名）
3. 二次拉取同 layer 零回源

已知限制：

- 超过 **512MB** 的 layer 不缓存（防止免费额度被单层吃光）
- 客户端中途断连时，缓存写入最多延续 ~30 秒，超大层可能缓存失败（下次自然重试）
- 桶不会自动清理——建议给 bucket 配置 Lifecycle 规则（如 30 天后删除）控制容量
- manifest 的 digest 引用走 Workers Cache API 自动缓存（不可变，安全）；tag 引用不缓存（避免拉到旧镜像）

### 7. 验证

```bash
# 未设 token:
curl -i https://mirror.你的域名.com/v2/
# 期望: HTTP 200, 响应头含 Docker-Distribution-API-Version: registry/2.0

# 设置了 token(Basic 模式): 期望 401 + WWW-Authenticate: Basic
curl -i https://mirror.你的域名.com/v2/
curl -u any:<token> -i https://mirror.你的域名.com/v2/   # 期望 200

# 设置了 token(路径模式): 期望 200; 错误 token → 404
curl -i https://mirror.你的域名.com/<token>/v2/
```

### 8. 接入 dss

```bash
dss docker mirror add https://mirror.你的域名.com          # Basic 模式
# 或
dss docker mirror add https://mirror.你的域名.com/<token>   # 路径模式(Docker ≥ 24)

docker info | grep -A3 "Registry Mirrors"
docker pull hello-world
```

> dss 会对你的域名做 Cloudflare 边缘 IP 测速，把最优 IP 钉进 `/etc/hosts`
> （缓解「用一段时间变慢」——慢的通常是默认解析到的边缘 IP 拥堵）。
> 变慢时执行 `dss docker mirror refresh` 重测换 IP。

## 常见问题

**Q: 为什么要自定义域名？** `*.workers.dev` 在国内被墙，自定义域名走 Cloudflare 可达边缘。

**Q: 为什么变慢了？** 中国到 CF 免费版的国际链路波动，默认边缘 IP 拥堵。用 `dss docker mirror refresh` 重测优选；晚间高峰属国际出口拥堵，无法完全避免。Worker 已支持断点续传（Range），中断的 layer 下载不会整层重来。

**Q: token 泄露了怎么办？** Worker 变量里换一个 `ACCESS_TOKEN`，然后：
```bash
dss docker mirror remove https://mirror.你的域名.com[/旧token]
dss docker mirror add https://mirror.你的域名.com[/新token]
docker logout mirror.你的域名.com && docker login ... -p <新token>   # Basic 模式
```

**Q: 支持 Docker Hub 之外的 registry 吗？** 模板只代理 Docker Hub。其他 registry 直连或走 `registry-mirrors` 数组里的其他源。

**Q: 和公共镜像站比优势？** 完全自主、任意公共镜像可拉、可加鉴权、可加 R2 缓存。劣势：速度受 CF 免费版链路影响。

**Q: 认证流程是怎样的？** dockerd 拉取时会先 GET `/v2/`——Worker 返回 200（无质询头），dockerd 因此**不会**自己去连被墙的 `auth.docker.io`；Worker 在服务端按仓库向上游换取 token 并代理全部请求。这是社区验证过的标准模式。
