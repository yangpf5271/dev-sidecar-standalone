// 智能恢复代理配置：清理指向本代理的配置，绝不触碰用户自己的其他代理设置
//
// 匹配/读写知识全部来自 tool-config store(唯一归属, 见 CONTEXT.md):
//   classify(宽松展示) 与 isOurs(严格清理) 是两个显式概念, 分叉由单测锁定
// 本模块只剩编排: 遍历有代理能力的 adapter, 汇总清理结果与提示文案
const { adapters } = require('./tool-config')

/** 参与恢复的工具(按 capabilities.proxy 决定; pip 无代理能力, 显式 no-op 不参与) */
const PROXY_TOOLS = ['npm', 'git', 'docker']

/**
 * 检测配置中是否有指向本代理的残留（status 提示用，不做修改）
 */
async function detectResidue (addr) {
  const residue = []
  for (const name of PROXY_TOOLS) {
    const adapter = adapters[name]
    if (!adapter.capabilities.proxy) continue
    const r = await adapter.clean(addr, { dryRun: true })
    if (r.ok) residue.push(...r.removed)
  }
  return residue
}

/**
 * 执行智能恢复：删除指向本代理的配置项，不匹配的绝对不动。
 * 工具缺失时跳过并记录（容错），全程不抛错。
 * 返回 { restored: string[], skipped: string[], notes: string[] }
 */
async function smartRestore (addr, { verbose = false } = {}) {
  const restored = []
  const skipped = []
  const notes = []

  for (const name of PROXY_TOOLS) {
    const adapter = adapters[name]
    if (!adapter.capabilities.proxy) continue
    const r = await adapter.clean(addr)
    if (!r.ok) {
      skipped.push(`${name}（${r.error}）`)
      continue
    }
    restored.push(...r.removed)
    notes.push(...r.notes)
  }

  if (verbose) {
    if (restored.length > 0) {
      console.log(`✅ 已恢复代理配置: ${restored.join(', ')}`)
    } else {
      console.log('未发现指向本代理的 npm/git/docker 配置，无需恢复')
    }
    for (const s of skipped) console.log(`ℹ️  跳过 ${s}`)
    for (const n of notes) console.log(`⚠️  ${n}`)
  }

  return { restored, skipped, notes }
}

module.exports = {
  smartRestore,
  detectResidue,
}
