# docker-cf-optimization Specification

## Purpose
TBD - created by archiving change add-docker-acceleration. Update Purpose after archive.
## Requirements
### Requirement: CF 域名判定
对镜像源 URL 的主机名，系统必须先解析其现有 IP（常规 DNS），若解析结果落于 Cloudflare 官方 CIDR 段（或通过 `--cf` 显式指定）则启用优选，否则跳过 hosts 钉定（本地/内网/非 CF 镜像不受影响）。（SHALL）

#### Scenario: Cloudflare Worker 域名
- **WHEN** mirror add 的 URL 主机名解析到 CF IP 段（如 104.16.0.0/13、172.64.0.0/13 等）
- **THEN** 执行优选测速并钉定 hosts

#### Scenario: 本地镜像源
- **WHEN** URL 为 `http://127.0.0.1:5000` 或解析结果不在 CF 段
- **THEN** 跳过优选与钉定，仅执行健康检查与 daemon.json 写入

### Requirement: 边缘 IP 测速优选
启用优选时，必须对内置的 CF anycast IP 池（TCP 443 连接计时）并发测速，选择延迟最低的可用 IP；池内全部不可达时警告并以域名常规解析继续（不阻断配置）。（SHALL）

#### Scenario: 正常优选
- **WHEN** 优选启用且池中存在可用 IP
- **THEN** 测速结果排序输出摘要，最优 IP 被选出用于钉定

#### Scenario: 池全部不可达
- **WHEN** IP 池全部 TCP 超时
- **THEN** 输出警告（不钉定 hosts），流程继续写入 daemon.json，由域名常规解析兜底

### Requirement: hosts 钉定与标记
钉定写入 `/etc/hosts` 时必须使用带标记的行格式（`<ip> <域名> # dss-mirror:<域名>`），写入前移除同域名旧钉定行（幂等替换）；写入通过临时文件 + `sudo cp` 完成，sudo 密码交互在终端进行。（SHALL）

#### Scenario: 首次钉定
- **WHEN** 优选选出 IP 且 hosts 中无该域名的钉定行
- **THEN** hosts 追加标记行，sudo 提示一次

#### Scenario: 刷新替换
- **WHEN** `dss docker mirror refresh` 测出新最优 IP
- **THEN** 旧钉定行被移除、新行写入，hosts 中同域名始终只有一行

### Requirement: 手动刷新节奏
`refresh` 是重新优选的唯一自动入口；周期性后台刷新不实现，文档提供 sudoers NOPASSWD 可选方案供用户自行自动化。（SHALL）

#### Scenario: 变慢后刷新
- **WHEN** 用户发现拉取变慢，执行 `dss docker mirror refresh`
- **THEN** 重新对已配置的 mirror 域名测速并更新钉定，无需重新执行 add

