# Tasks — add-mirror-engine-routing

三个垂直切片 + 收尾，每片可独立验证与回滚。对应 design 迁移计划。

## 1. 切片一：入口路由

- [x] 1.1 新建 src/cli/router.js：route(argv) 纯函数（五级判定顺序），suggestSubcommand/editDistance/printUnknownCommand 自 index.js 迁入
- [x] 1.2 表驱动单测覆盖全部分支：子命令/`npm -d`/`-d -h` help 优先/`-v`/`-d` 剥离/`-c 空格`与`--config=` 文法/未知选项/位置参数/`-c` 缺值/空参数
- [x] 1.3 index.js 切换为 route → 分发；删除原地三段参数循环；本地冒烟（-h/-v/state/-help/config=default.json/daemon 生命周期经 CI）

## 2. 切片二：镜像引擎

- [ ] 2.1 npm/pip adapter 补 setMirror 写原语（落盘知识归 adapter，含 npm shell:true 与 pip 命令探测复用）
- [ ] 2.2 新建 src/cli/tool-config/mirror-engine.js：createMirrorEngine({name, official, mirrors, adapter, snapshot})，switch/off/status 返回结果对象，mirror 段快照生命周期（首切快照/恢复/删段/空删父）单点实现
- [ ] 2.3 引擎单测（假 adapter + 假快照）：企业源不丢、重复切换不覆盖快照、off 无快照回官方源、空段清理、未知镜像名

## 3. 切片三：命令改薄

- [ ] 3.1 npm.js 镜像段改薄：NPM_MIRRORS 表 + 引擎调用 + 工具特有文案（发布警示/代理冲突提醒）逐字保留
- [ ] 3.2 pip.js 镜像段改薄：同上；行为与输出逐字对照（切换/恢复/查看三命令）
- [ ] 3.3 现有 CI mirror switch 断言原样保持绿；本地 npm/pip 镜像往返冒烟

## 4. 收尾

- [ ] 4.1 全量回归：全部单测 + CI（unit job + 3×3 矩阵）全绿
- [ ] 4.2 双轴 code-review（Standards/Spec）+ 修复发现
- [ ] 4.3 归档本变更（openspec archive），提交推送双远端；发布交接（单一 v1.5.0，用户 npm publish 后打 tag/Release）
