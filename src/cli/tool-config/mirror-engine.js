// 镜像切换引擎 — 参数化实现(spec: mirror-engine)，npm/pip 共享
//
// 消费: 镜像表 { key: { name, url } } + 官方源 + adapter 的
//       read().values.mirror / setMirror() 读写原语 + 快照 mirror 段访问
// 拥有: 快照 mirror 段生命周期(首次快照原值不覆盖、off 恢复、空段清理)——
//       "企业源快照保护"不变量在此单点实现、单测锁定
// 不拥有: 界面文案(返回结果对象, 中文提示/工具警示由命令层生成)
const { readSnapshot, writeSnapshot } = require('../utils')

function createMirrorEngine ({ name, official, mirrors, adapter, snapshot }) {
  const snap = snapshot || {
    read: readSnapshot,
    write: writeSnapshot,
  }

  // 兼容历史快照键(npm 曾用 registry / pip 曾用 indexUrl)，统一写 original;
  // 'null'/空串按未设置处理(旧 pip 的防护语义)
  const readSaved = () => {
    const section = snap.read().mirror && snap.read().mirror[name]
    if (!section) return null
    const v = section.original || section.registry || section.indexUrl || null
    return (v && v !== 'null') ? v : null
  }

  const saveOriginalIfAbsent = (current) => {
    const state = snap.read()
    if (state.mirror && state.mirror[name]) return // 重复切换不覆盖快照
    if (!state.mirror) state.mirror = {}
    state.mirror[name] = { original: current }
    snap.write(state)
  }

  const clearSaved = () => {
    const state = snap.read()
    if (!(state.mirror && state.mirror[name])) return
    delete state.mirror[name]
    if (Object.keys(state.mirror).length === 0) delete state.mirror
    snap.write(state)
  }

  const readCurrent = async () => {
    const r = await adapter.read()
    return r.ok ? (r.values.mirror || null) : null
  }

  return {
    /** 切换到表内镜像; 返回 { ok, changed, from?, to?, entryName? } 或 { ok:false, error, available } */
    async switch (targetName) {
      const entry = mirrors[targetName]
      if (!entry) {
        return { ok: false, error: 'unknown-mirror', available: Object.keys(mirrors) }
      }
      const current = await readCurrent()
      if (current === entry.url) {
        return { ok: true, changed: false, current }
      }
      saveOriginalIfAbsent(current)
      const r = await adapter.setMirror(entry.url)
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, changed: true, from: current, to: entry.url, entryName: entry.name }
    },

    /**
     * 恢复: 快照原值优先(setMirror); 无快照经 adapter.restoreDefault 回默认
     * (npm=显式设官方源 / pip=清除键, "如何回默认"的知识归 adapter)。
     * 成功后清理快照段; 失败保留快照供重试。
     */
    async off () {
      const saved = readSaved()
      const r = saved
        ? await adapter.setMirror(saved)
        : await adapter.restoreDefault(official)
      if (!r.ok) return { ok: false, error: r.error }
      clearSaved()
      return { ok: true, target: saved, saved }
    },

    /** 当前状态: { ok, current, saved, known } — known 为当前值对应的表内镜像名(不在表内为 null) */
    async status () {
      const current = await readCurrent()
      const saved = readSaved()
      const known = Object.entries(mirrors).find(([, m]) => m.url === current)
      return { ok: true, current, saved, known: known ? known[1].name : null }
    },
  }
}

module.exports = { createMirrorEngine }
