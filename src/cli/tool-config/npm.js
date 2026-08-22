// npm adapter — npm 代理配置(.npmrc)的读写与清理
// npm 在 Windows 上是 npm.cmd, 必须 shell:true; 'null'/'undefined' 是未设置哨兵
const { normalizeProxyUrlValue, classifyValues, isOurs, buildProxyCandidates, buildCertCandidates, normPathValue } = require('./shared')

module.exports = (deps) => {
  const KEYS = ['proxy', 'https-proxy', 'cafile']

  const readKey = async (key) => {
    const r = await deps.run('npm', ['config', 'get', key], { shell: true })
    if (r.error && /ENOENT/i.test(r.error)) throw new Error('命令不可用')
    return r.ok ? normalizeProxyUrlValue(r.stdout) : null
  }

  return {
    capabilities: { proxy: true, mirror: true },

    /** values: { http: proxy, https: https-proxy, ca: cafile, mirror: registry } */
    async read () {
      try {
        const [http, https, ca, mirror] = await Promise.all([
          readKey('proxy'),
          readKey('https-proxy'),
          readKey('cafile'),
          readKey('registry'),
        ])
        return { ok: true, values: { http, https, ca, mirror } }
      } catch (e) {
        return { ok: false, error: e.message, values: null }
      }
    },

    async classify (addr) {
      const r = await this.read()
      if (!r.ok) return r
      const c = classifyValues(r.values, addr)
      return { ok: true, ...c, values: r.values }
    },

    /** 写入镜像源(registry; 镜像切换引擎消费, 值归一化已由 read 提供) */
    async setMirror (value) {
      try {
        const r = await deps.run('npm', ['config', 'set', 'registry', value], { shell: true })
        if (!r.ok) return { ok: false, error: `npm config set registry 失败: ${r.error || r.stderr}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    },

    /** 回到默认源 = 显式设为官方源(npm 语义, 与历史行为一致) */
    async restoreDefault (official) {
      return this.setMirror(official)
    },

    /**
     * 写入代理配置并自动记录快照(供 dss npm on)。快照 = 实际写入值:
     * 任一键失败时, 已成功写入的键并入快照段再返回错误, 不留"有配置无快照"半状态。
     * entries: { 键: 值 }
     */
    async setProxy (entries) {
      const written = {}
      // 并入而非整段替换: 未尝试的键保留旧快照值(端口漂移候选集不丢)
      const record = () => {
        if (Object.keys(written).length === 0) return
        const section = { ...((deps.snapshot.read().npm) || {}), ...written }
        deps.snapshot.updateTool('npm', section)
      }
      try {
        for (const [key, value] of Object.entries(entries)) {
          const r = await deps.run('npm', ['config', 'set', key, value], { shell: true })
          if (!r.ok) {
            record()
            return { ok: false, error: `npm config set ${key} 失败: ${r.error || r.stderr}` }
          }
          written[key] = value
        }
        record()
        return { ok: true, written: Object.entries(entries) }
      } catch (e) {
        record()
        return { ok: false, error: e.message }
      }
    },

    /** 清除全部代理键(off 语义: 无条件清除; 供 dss npm off) */
    async clearProxy () {
      try {
        for (const key of KEYS) {
          const r = await deps.run('npm', ['config', 'delete', key], { shell: true })
          if (!r.ok) return { ok: false, error: `npm config delete ${key} 失败: ${r.error || r.stderr}` }
        }
        deps.snapshot.clearTool('npm')
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    },

    /**
     * 严格清理: proxy/https-proxy 精确候选集匹配, cafile 路径归一化后精确匹配。
     * removed 只收已验证不再生效的项; 删除后仍生效(env/.npmrc 覆盖)记入 notes
     * 并保留快照段; 段内无用户数据时清快照段。
     */
    async clean (addr, { dryRun = false } = {}) {
      try {
        const snap = deps.snapshot.read()
        const candidates = buildProxyCandidates(addr, snap)
        const certs = buildCertCandidates(deps.homedir, snap)
        const removed = []
        const notes = []
        let sectionClean = true

        for (const key of KEYS) {
          const value = await readKey(key)
          if (value == null) continue
          const matched = key === 'cafile'
            ? [...certs].some((c) => normPathValue(c) === normPathValue(value))
            : isOurs(candidates, value)
          if (matched) {
            if (!dryRun) {
              await deps.run('npm', ['config', 'delete', key], { shell: true })
              const after = await readKey(key)
              if (after != null) {
                notes.push(`npm ${key} 删除后仍生效（可能来自环境变量或项目级 .npmrc），请手工检查`)
                // 值仍在: 保留快照段供下次重试; removed 只收已验证不再生效的项
                sectionClean = false
                continue
              }
            }
            removed.push(`npm ${key}`)
          } else if (snap.npm && snap.npm[key] === value) {
            sectionClean = false
          }
        }

        if (!dryRun && snap.npm && sectionClean) {
          deps.snapshot.clearTool('npm')
        }
        return { ok: true, removed, notes }
      } catch (e) {
        return { ok: false, error: e.message, removed: [], notes: [] }
      }
    },
  }
}
