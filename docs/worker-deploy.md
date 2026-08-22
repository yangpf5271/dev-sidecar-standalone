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
| `ACCESS_TOKEN` | 公网建议设置 | 访问令牌，防域名泄露后被白嫖。**用 `openssl rand -hex 16` 生成（仅字母数字）**——路径模式要求 URL 安全且不能含冒号。认证方式见下节 |
| `DOCKERHUB_AUTH` | 建议 | 你的 Docker Hub `用户名:访问令牌`（hub.docker.com → Account Settings → Personal access tokens 创建，只读权限即可，**仅 ASCII 字符**）。避开匿名拉取限额 |
| `R2_CACHE` | 可选 | layer 缓存，见下下节 |

### 5. 接入认证（设置 ACCESS_TOKEN 时）

**方式 A：路径前缀模式（registry-mirrors 场景唯一可用，需 Docker Engine ≥ 24）**

```bash
dss docker mirror add https://mirror.你的域名.com/<token>
```

> ⚠️ **版本要求**：Docker ≤ 23.x 的 daemon 会因 registry-mirror 地址含路径而**拒绝启动**
>（`invalid mirror: path...`，[moby#36598](https://github.com/moby/moby/issues/36598)）。
> `dss docker mirror add` 会检测 Docker 版本并在旧版本上阻止（`--force` 可越过）。
> 旧版 Docker 的选择：不设 `ACCESS_TOKEN`（内网/个人低风险）或升级 Docker。

**方式 B：Basic 模式（仅适用于直接拉取，不能用于 registry-mirrors！）**

```bash
docker login mirror.你的域名.com -u any -p <token>
docker pull mirror.你的域名.com/library/nginx   # 直接引用本域名拉取
```

> ⚠️ **重要**：dockerd **不会**把 mirror 域名的登录凭证附加到 `docker pull nginx` 这类
> docker.io 镜像拉取上（[moby#30880](https://github.com/moby/moby/issues/30880)，2017 年至今未实现）。
> 把 Basic 模式的地址配进 `registry-mirrors` 会得到 401 → 回退被墙官方源 → 拉取失败。
> registry-mirrors + 公网鉴权只能用方式 A。

两种方式可共存：带 token 路径的请求走路径模式，带 Basic 头的请求走 Basic 模式。
未认证的 `/v2/` 返回 401 Basic 质询，其余路径一律 404（伪装普通站点，不暴露代理存在）。

### 6. R2 layer 缓存（可选）

**注意两个名字的区别**（容易混淆）：

1. Cloudflare R2 → `Create bucket` → **桶名称**只能小写字母/数字/连字符，建议填 `dss-docker-cache` 之类（桶名随便起，代码不依赖它）
2. Worker → `Settings` → `Bindings` → `Add` → `R2 bucket`，这里有两个字段：
   - **Variable name**：填 `R2_CACHE`（大写没问题——这是 Worker 代码里的 `env.R2_CACHE`）
   - **Bucket**：选择第 1 步创建的桶（如 `dss-docker-cache`）
3. 二次拉取同 layer 零回源

> 也支持「绑定名任意」的配法：Variable name 填 `CACHE`，再在 Worker 的 Variables 里加 `R2_CACHE` = `CACHE`（值填绑定名），但不如上面直接。

已知限制：

- 控制台提示「超过 300MB 的文件只能用 S3 API 或 Workers 上载」**不影响本方案**——Worker 写 R2 走的就是 Workers 绑定 API（上限约 5GB），且代码仅缓存 ≤512MB 的 layer
- 超过 **512MB** 的 layer 不缓存（防止免费额度被单层吃光）
- 客户端中途断连时，缓存写入最多延续 ~30 秒，超大层可能缓存失败（下次自然重试）
- 桶不会自动清理——建议给 bucket 配置 Lifecycle 规则（如 30 天后删除）控制容量
- manifest 的 digest 引用走 Workers Cache API 自动缓存（不可变，安全）；tag 引用不缓存（避免拉到旧镜像）

### 7. 验证

```bash
# 未设 token: 期望 200
curl -i https://mirror.你的域名.com/v2/

# 设置了 token: /v2/ 期望 401 + WWW-Authenticate: Basic(质询)
curl -i https://mirror.你的域名.com/v2/
curl -u any:<token> -i https://mirror.你的域名.com/v2/   # Basic 直接拉取模式 → 200
curl -i https://mirror.你的域名.com/<token>/v2/          # 路径模式 → 200; 错误 token → 404
```

### 8. 接入 dss

```bash
# 公网 + 鉴权: 路径模式(Docker ≥ 24)
dss docker mirror add https://mirror.你的域名.com/<token>

# 内网/个人使用: Worker 不设 ACCESS_TOKEN, 直接
dss docker mirror add https://mirror.你的域名.com

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

**Q: 认证流程是怎样的？** dockerd 拉取时会先 GET `/v2/`——无鉴权/路径模式下 Worker 返回 200（无质询头），dockerd 因此**不会**自己去连被墙的 `auth.docker.io`；Worker 在服务端按仓库向上游换取 token 并代理全部请求。这是社区验证过的标准模式。（Basic 模式的 401 质询会触发客户端凭证查询，但如上所述 mirror 场景 dockerd 查不到凭证，所以 Basic 仅限直接拉取用途。）
