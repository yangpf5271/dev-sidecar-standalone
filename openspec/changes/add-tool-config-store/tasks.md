# Tasks — add-tool-config-store

按垂直切片组织：每个 `## N.` 是一条可独立验证、可单独交付的完整路径（依赖前序切片，但后续切片可推迟）。对应 design.md 迁移计划的三步：切片 1–5 为第①步，切片 6 为第②步，切片 7 为第③步，切片 8 收尾。

## 1. 切片一：module 骨架 + classify 纯函数 + 测试设施

- [x] 1.1 创建 tool-config module 目录：index 导出工厂 createAdapters(ctx) 与默认实例 adapters，工厂注入面仅限 命令执行器/主目录/快照访问 三项
- [x] 1.2 实现 classifyValues 纯函数（none/mitm/tunnel/other + address，端口子串宽松语义），随 values 归一化规则（未设置→null）一并定义
- [x] 1.3 编写 node:test 单测：四类 mode 判定 + evil.com:31180 边界值（classify=tunnel 且 clean 侧不认）的前半断言
- [x] 1.4 package.json 增加 test 脚本（node --test），CI 增加独立快速 unit job（先于 3×3 矩阵）

## 2. 切片二：npm 与 git adapter

- [x] 2.1 实现 npm adapter：read（'null'/'undefined' 归一化）/ classify / clean+dryRun（删后验证、快照段清理、证书键路径归一化匹配）
- [x] 2.2 实现 git adapter：同 interface（含 unset 对"键不存在"退出码 5 的容忍）
- [x] 2.3 快照候选集构造迁入 module（快照值 + host×port 全组合 + 默认端口兜底），isOurs 严格语义实现
- [x] 2.4 单测（假命令执行器 + 假快照）：归一化、第三方值保留、端口漂移恢复、isOurs 与 classify 的分叉对完整锁定

## 3. 切片三：docker 与 pip adapter（四工具齐备）

- [x] 3.1 实现 docker adapter：独家拥有 ~/.docker/config.json 读写（2 空格缩进 + 尾换行）、auths 值级保留、proxies.default 按端口匹配清理
- [x] 3.2 实现 pip adapter：capabilities 声明（无代理/有镜像）、read 返回 proxy 与 index-url、clean 为显式 no-op
- [x] 3.3 单测（假主目录）：config.json 清理后 auths 逐字保留 + 格式统一；pip 能力位降级路径

## 4. 切片四：restore 切换到 tool-config（第①步收口一半）

- [x] 4.1 smartRestore 与 detectResidue 改为遍历 adapters（npm/git/docker 走 clean/dryRun，pip 按能力位跳过），逐工具保留现有输出语义（restored/notes 文案不变）
- [x] 4.2 迁移后本地冒烟：隔离假 HOME 下 stop/restore 全周期行为与切换前一致
- [ ] 4.3 CI 现有 daemon start/stop + smart restore 断言全部保持绿（不改断言本身）

## 5. 切片五：status 切换到 tool-config（第①步完成，分叉消除）

- [ ] 5.1 status 的 collectTools 改用 adapters.classify（结构化 mode → 命令层中文文案），镜像标签逻辑暂留原地
- [ ] 5.2 切换前后 status 输出逐行对照一致（同机同状态下 diff 为空或仅有预期的边界值差异）
- [ ] 5.3 CONTEXT.md 随本切片入库，README/USAGE 无需变化（外部行为不变）

## 6. 切片六：npm/git 命令改薄（第②步）

- [ ] 6.1 npm/git 的 on/off/status 改走 adapter（set 自动记快照、off 自动清段），命令模块只剩参数解析与文案
- [ ] 6.2 收口 4 处重复的"代理未运行警告"为 cli 层共享 helper（npm/git/env/docker 四处替换）
- [ ] 6.3 CI 的 npm on/off、git on/off 断言全部保持绿（不改断言本身）

## 7. 切片七：docker 命令迁移（第③步）

- [ ] 7.1 docker 命令内部对 config.json 的读写全部改走 docker adapter（含 dss docker on 注入与 off 清理），删除命令模块内的私有读写实现
- [ ] 7.2 CI 的 docker build 层断言（注入/清理/auths 保留/第三方不动）全部保持绿

## 8. 收尾

- [ ] 8.1 全量回归：本地 dss status/stop/restore/npm/git/docker 冒烟 + CI 3×3 矩阵与 unit job 全绿
- [ ] 8.2 版本 bump 1.6.0（在 v1.5.0 已发布之后），提交推送双远端，发布交接（npm publish 由用户执行，tag/Release 随后）
