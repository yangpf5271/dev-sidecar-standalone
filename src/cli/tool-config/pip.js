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

  return {
    name: 'pip',
    capabilities: { proxy: false, mirror: true },

    /** values: { http: global.proxy, mirror: global.index-url } */
    async read () {
      const pipCmd = await detectPip()
      if (!pipCmd) return { ok: false, error: '未检测到 pip / pip3 命令', values: null }
      const get = async (key) => {
        const r = await deps.run(pipCmd, ['config', 'get', key])
        return (r.ok && r.stdout) ? normalizeProxyUrlValue(r.stdout) : null
      }
      const [http, mirror] = await Promise.all([get('global.proxy'), get('global.index-url')])
      return { ok: true, values: { http, https: null, mirror } }
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
