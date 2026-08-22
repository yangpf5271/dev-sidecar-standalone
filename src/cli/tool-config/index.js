// tool-config store — 唯一拥有"各工具代理配置怎么读、怎么写、什么算未设置"知识的 module
// （CONTEXT.md 词汇: tool-config store / adapter / capabilities / classify / isOurs / 快照）
//
// interface（每个 adapter 满足）:
//   read()                   → { ok, error?, values }   值已归一化(未设置→null)
//   classify(addr)           → { ok, error?, mode, address }   展示用, 宽松语义
//   clean(addr, {dryRun})    → { ok, error?, removed: [标签], notes: [] }   清理用, 严格语义
//
// 两种匹配语义是设计而非漂移(spec: tool-config-store):
//   classify 宽松(端口子串) — "看起来像就提醒";  isOurs 严格(精确候选集) — "确凿才动手"
//   docker 是文档化的例外: 网关地址恢复时无法重推, isOurs 退化为端口匹配
//
// 错误契约: 全部返回结果对象, 不 throw、不 process.exit — 退出码由命令壳层决定
//
// 快照工具段生命周期归本 module(写入时记录、恢复干净时清段);
// 快照文件机械存取保留在 utils(共享存储), mirror 段留给镜像引擎
const os = require('node:os')
const { runCommand, readSnapshot, updateSnapshot, clearSnapshotSection } = require('../utils')
const shared = require('./shared')

/**
 * 工厂: 注入面仅限三项 — run(命令执行器)/homedir/snapshot。
 * 出现第四项注入需求时视为 adapter 划分问题, 应重新审视(design 风险约定)。
 * 同时导出绑定真实依赖的默认实例, 生产侧零成本。
 */
function createAdapters (ctx = {}) {
  const deps = {
    run: ctx.run || runCommand,
    homedir: ctx.homedir || (() => os.homedir()),
    snapshot: ctx.snapshot || {
      read: readSnapshot,
      updateTool: updateSnapshot,
      clearTool: clearSnapshotSection,
    },
  }
  return {
    npm: require('./npm')(deps),
    git: require('./git')(deps),
    pip: require('./pip')(deps),
    docker: require('./docker')(deps),
  }
}

const adapters = createAdapters()

module.exports = {
  createAdapters,
  adapters,
  // 共享语义(纯函数, 单测对象)
  ...shared,
}
