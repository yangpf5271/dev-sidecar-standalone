# Tasks: dss-service-autostart

## 1. PID 簿记 JSON 化 + 版本僵告警（全量拉起路径的公共底座）

- [x] 1.1 PID 文件写入升级为 {pid, version, execPath} 结构、读取兼容旧整数与损坏文件（损坏按"无 PID"处理）；`dss status` 比对守护进程与 CLI 的 version，不一致输出"版本不一致，建议 dss restart 对齐"（只判相等不判新旧）；单测覆盖：新旧格式读、损坏读、版本相同/不同/信息缺失三边界——`npm test` 全绿
- [x] 1.2 服务定义拉起路径与后台子进程共享守护标记（前台进程带标记时同样写入 PID 文件、退出时按归属清理），验证：以带标记前台方式启动一次代理，`dss status` 能读到 PID 与 version 并在停止后清理——手工验证通过

## 2. 服务定义生成器（纯函数，三平台模板）

- [x] 2.1 实现三平台生成器纯函数（Windows HKCU Run 登录项+当前用户+无窗口入口 / Linux 系统级 unit `User=`+`Restart=always` / macOS launchd RunAtLoad），输入平台与安装上下文（入口、用户、DEV_SIDECAR_HOME、代理地址），输出完整定义；单测锁定：Windows 模板无 ONSTART/SYSTEM、全平台模板无后台启动子命令、Linux 含 User=、PATH 解析式入口、DEV_SIDECAR_HOME 固化、非默认端口一致——生成器契约测试全绿

## 3. Windows 全链路（本机可真实验证的首条 tracer）

- [x] 3.1 service 命令面（install/uninstall/status）+ Windows 编排：定义写入临时位置原子就位、幂等覆盖（先移除旧定义+覆盖提示）、WSL 环境拒绝并指引 Linux 流程；编排层注入命令执行器（复用假执行器先例），编排单测覆盖幂等/失败清理/拒绝分支——`npm test` 全绿
- [x] 3.2 install 后验证：定义存在性检查 + 代理端口探测，失败如实报错；验证：本机真实执行 install → 出现"已安装且运行中"→ `dss status` 出现版本比对与服务状态行 → uninstall → 查询输出"未安装"——全链路手工验证通过

## 4. Linux / macOS 形态接入

- [x] 4.1 Linux 编排分支（sudo 原子就位、失败回滚不留半成品、systemctl 判定不依赖本地化文本）；单测覆盖编排分支与生成器对接；验证：`npm test` 全绿 + WSL Ubuntu 24.04 (systemd) 真机 install→status→uninstall 走通（wrapper 权限 755、User=、真实代理请求 200 均已核验）
- [x] 4.2 macOS launchd 分支：生成器对接与编排单测照常，命令运行时输出"未实测"标注；验证：`npm test` 全绿（真实加载明确不在验证范围）

## 5. 监管器协作与面板集成

- [x] 5.1 `dss stop` 监管器归属探测：按平台查本代理命名的 unit/Run 键/label 存在性，存在则输出"建议使用管理器通道"提示后照常执行既有 stop；探测分支由 ops 单测锁定，stop 接线经真实 stop 输出验证——`npm test` 全绿
- [x] 5.2 全景 status 面板增加服务定义状态行（未安装/已安装且运行中/已安装但未运行/版本不一致四态，混同表述为缺陷）；验证：四态在假执行器下断言 + 本机手工核对面板

## 6. 文档与发布

- [x] 6.1 deploy-guide：三平台 service 章节（macOS 标注未实测）、更新节"更新→重启守护→核对版本"三步指引、跨管理器 stop/restart 边界声明、DEV_SIDECAR_HOME 改值需重装警示；README 能力表"systemd 服务"行改述——文档交付
- [x] 6.2 版本号升 1.6.0、help 文案补 service 命令、`npm test` 全量回归 + dry-run 打包核验 files 清单（新增测试与模块入包正确）
