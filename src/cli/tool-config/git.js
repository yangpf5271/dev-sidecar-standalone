// git adapter — git 全局代理配置(.gitconfig)的读写与清理
// git 是真实可执行文件, 不用 shell; unset 不存在的键返回非 0(退出码 5 / no such section)属正常
const { normalizeProxyUrlValue, classifyValues, buildProxyCandidates, buildCertCandidates, normPathValue } = require('./shared')

module.exports = (deps) => {
  const KEYS = ['http.proxy', 'https.proxy', 'http.sslCAInfo']

  const readKey = async (key) => {
    const r = await deps.run('git', ['config', '--global', '--get', key])
    if (r.error && /ENOENT/i.test(r.error)) throw new Error('git 命令不可用')
    return (r.ok && r.stdout) ? normalizeProxyUrlValue(r.stdout) : null
  }

  return {
    name: 'git',
    capabilities: { proxy: true, mirror: false },

    /** values: { http: http.proxy, https: https.proxy, ca: http.sslCAInfo } */
    async read () {
      try {
        const [http, https, ca] = await Promise.all(KEYS.map(readKey))
        return { ok: true, values: { http, https, ca } }
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

    /** 严格清理: 代理键精确候选集匹配, 证书键路径归一化匹配; 段内无用户数据时清快照段 */
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
          const matched = key === 'http.sslCAInfo'
            ? [...certs].some((c) => normPathValue(c) === normPathValue(value))
            : candidates.has(value)
          if (matched) {
            if (!dryRun) {
              const del = await deps.run('git', ['config', '--global', '--unset', key])
              if (!del.ok && del.code !== 5 && !/no such section/i.test(del.stderr || '')) {
                notes.push(`git config --unset ${key} 失败: ${del.error || del.stderr}`)
                continue
              }
            }
            removed.push(`git ${key}`)
          } else if (snap.git && snap.git[key] === value) {
            sectionClean = false
          }
        }

        if (!dryRun && snap.git && sectionClean) {
          deps.snapshot.clearTool('git')
        }
        return { ok: true, removed, notes }
      } catch (e) {
        return { ok: false, error: e.message, removed: [], notes: [] }
      }
    },
  }
}
