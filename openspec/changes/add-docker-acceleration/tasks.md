# Tasks: add-docker-acceleration

## 1. 构建层代理注入闭环（无 sudo，三平台可用）

- [x] 1.1 实现 `dss docker on`：合并写入 `~/.docker/config.json` 的 `proxies.default`（已有 auths 逐字保留），代理地址按 docker0 网关 → host.docker.internal → 172.17.0.1 探测（`--proxy-url` 覆盖），探测 dss 端口不可达时输出 `HOST=0.0.0.0 dss start` 指引
- [x] 1.2 实现 noProxy 自动聚合：内网四段 + auths 的 registry 主机 + daemon.json `insecure-registries`（可读时）+ `--no-proxy` 追加，去重输出
- [x] 1.3 实现 `dss docker off`（移除 proxies 段保留其余）与 `dss docker status`（proxies/mirrors/健康一览）
- [x] 1.4 验证：WSL 中预埋含 auths 的 config.json → on → 断言 auths 原样、proxies 就位、内网主机在 noProxy → off → 断言 auths 依旧、proxies 消失；Windows 同样跑一遍

## 2. Worker 模板与教程交付（谁使用谁部署）

- [x] 2.1 交付 `docs/worker/docker-proxy.js` 模板：`/v2/` 探活、manifest 代理 + Cache API、blob 307 跟进流式回传、Worker 侧代办 auth.docker.io 认证（匿名或 `DOCKERHUB_AUTH`，isolate 缓存）、`ACCESS_TOKEN` 路径前缀鉴权（错误 404）、`R2_CACHE` 可选 layer 缓存
- [x] 2.2 交付 `docs/worker-deploy.md` 教程：域名托管 CF → 建 Worker → 绑自定义域名 → 可选变量表（含换 token 流程）→ `/v2/` 验证 → `dss docker mirror add` 接入；说明「变慢→refresh」与晚高峰预期
- [x] 2.3 验证：模板经 `node --check`（或 wrangler/esbuild 语法校验）；教程步骤自查无缺环（token 有无两分支均可走通）

## 3. mirror add 拉取闭环（健康检查 → daemon.json → 重启 → 验证）

- [x] 3.1 实现健康检查：`GET <url>/v2/`，200/401 放行，其余硬阻断（`--force` 跳过）；Windows 环境给指引退出
- [x] 3.2 实现 daemon.json 合并写入：读现有（非法 JSON 硬错误）、设 `registry-mirrors`（去重追加）、临时文件 + `sudo cp`、systemd/service 探测重启 docker、`docker info` 验证 mirrors 生效
- [x] 3.3 验证：WSL 本地起一个 `/v2/` 返回 200 的假镜像站 → `dss docker mirror add http://127.0.0.1:<port>` → 断言 daemon.json 合并正确、docker 重启后 `docker info` 含该 URL、重复 add 幂等、非法 daemon.json 被拒绝、不可达 URL 被阻断

## 4. CF 优选与 hosts 钉定（refresh 解决「变慢」）

- [x] 4.1 实现 CF 判定（按官方 CIDR 段判断解析 IP；`--cf` 强制 / 非 CF 跳过）、IP 池 TCP 测速（并发计时取最优）、hosts 标记行幂等替换（`# dss-mirror:<域名>`）、临时文件 + `sudo cp` 写入
- [x] 4.2 实现 `dss docker mirror refresh`：对已配置域名重测换 IP；池全不可达时警告并保持域名常规解析
- [x] 4.3 验证：对假镜像站（127.0.0.1）断言跳过钉定；用一个真实 CF 域名（或 `--cf` 指定）断言 hosts 出现标记行、refresh 后旧行被替换、同域名恒为一行

## 5. mirror remove 对称移除 + status 总览

- [x] 5.1 实现 `dss docker mirror remove <url>`：daemon.json 移除（数组空删键）+ hosts 对应钉定行删除 + 重启 docker，三处状态一致
- [x] 5.2 扩展 `dss docker status`：daemon.json mirrors（可读时）+ hosts 钉定行 + config.json proxies + 各 mirror 健康探测
- [x] 5.3 验证：add（含钉定）→ remove → 断言 daemon.json/hosts/docker info 三处干净

## 6. 集成收尾：注册、文档、CI、发版

- [ ] 6.1 `src/cli/index.js` 注册 `docker` 子命令，更新 USAGE 与 `index.js -h` 帮助文本；README 新增「Docker 加速」章节（两层命令 + Worker 指引链接 + WSL 全配方 + MITM 域名 CA 文档方案）
- [ ] 6.2 CI 新增构建层步骤：预埋 auths → `dss docker on` → 断言 auths 保留/proxies 就位/noProxy 含内网主机 → `dss docker off` → 断言 auths 依旧（三平台矩阵）
- [ ] 6.3 WSL 端到端实测：假镜像站全流程（add → docker info → remove）+ 真实 CF 域名钉定/refresh 路径；版本升至 1.4.0，提交推送，CI 全绿
