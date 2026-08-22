// pip adapter — 能力位示例: dss 只有 pip 镜像切换, 从未写入过 pip 代理配置
// capabilities.proxy = false: clean 为显式 no-op —— 用户自设的 global.proxy
// 哪怕指向本代理地址也不清理(dss 不拥有它, 也就不负责恢复它)
const { normalizeProxyUrlValue, classifyValues } = require('./shared')

module.exports = (deps) => {
  /** 探测 pip / pip3, 返回命令名或 null */
  async function detectPip () {
    for (const cmd of ['pip', 'pip3']) {
      const r = await deps.run(cmd, ['--version'])
      if (r.ok) return cmd
    }
    return null
  }

  async function withPip (fn) {
    const pipCmd = await detectPip()
    if (!pipCmd) throw new Error('未检测到 pip / pip3 命令')
    return fn(pipCmd)
  }

  return {
    name: 'pip',
    capabilities: { proxy: false, mirror: true },

    /** values: { http: global.proxy, mirror: global.index-url } */
    async read () {
      try {
        return await withPip(async (pipCmd) => {
          const get = async (key) => {
            const r = await deps.run(pipCmd, ['config', 'get', key])
            return (r.ok && r.stdout) ? normalizeProxyUrlValue(r.stdout) : null
          }
          const [http, mirror] = await Promise.all([get('global.proxy'), get('global.index-url')])
          return { ok: true, values: { http, https: null, mirror } }
        })
      } catch (e) {
        return { ok: false, error: e.message, values: null }
      }
    },

    /** 写入镜像源(global.index-url; 镜像切换引擎消费) */
    async setMirror (value) {
      try {
        return await withPip(async (pipCmd) => {
          const r = await deps.run(pipCmd, ['config', 'set', 'global.index-url', value])
          if (!r.ok) return { ok: false, error: `pip config set global.index-url 失败: ${r.error || r.stderr}` }
          return { ok: true }
        })
      } catch (e) {
        return { ok: false, error: e.message }
      }
    },

    /** 回到默认源 = 清除键(pip 语义: 未设置即用官方源; unset 未设置的键返回非 0 属正常) */
    async restoreDefault () {
      try {
        return await withPip(async (pipCmd) => {
          const r = await deps.run(pipCmd, ['config', 'unset', 'global.index-url'])
          if (!r.ok && !/not exist|no such/i.test(r.stderr || '')) {
            return { ok: false, error: `pip config unset global.index-url 失败: ${r.error || r.stderr}` }
          }
          return { ok: true }
        })
      } catch (e) {
        return { ok: false, error: e.message }
      }
    },

    async classify (addr) {
      const r = await this.read()
      if (!r.ok) return r
      const c = classifyValues(r.values, addr)
      return { ok: true, ...c, values: r.values }
    },

    /** 显式 no-op: dss 从未写入 pip 代理, 无可清理 */
    async clean () {
      return { ok: true, removed: [], notes: [] }
    },
  }
}
