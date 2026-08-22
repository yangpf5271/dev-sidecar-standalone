// npm adapter — npm 代理配置(.npmrc)的读写与清理
// 骨架(读取归一化/分类/严格清理/写入与部分快照/off 清除)由 cli-config-adapter
// 单点实现; 本文件只剩命令细节与元数据声明。
// npm 在 Windows 上是 npm.cmd, 必须 shell:true; 'null'/'undefined' 是未设置哨兵
const createCliConfigAdapter = require('./cli-config-adapter')
const { normalizeProxyUrlValue } = require('./shared')

module.exports = (deps) => {
  const KEYS = ['proxy', 'https-proxy', 'cafile']

  const readKey = async (key) => {
    const r = await deps.run('npm', ['config', 'get', key], { shell: true })
    if (r.error && /ENOENT/i.test(r.error)) throw new Error('命令不可用')
    return r.ok ? normalizeProxyUrlValue(r.stdout) : null
  }

  const core = createCliConfigAdapter({
    tool: 'npm',
    keys: KEYS,
    certKey: 'cafile',
    // 作用域: npm config get 是合并源(环境变量 + 项目级 .npmrc + 用户级 .npmrc),
    // 删除后值仍可能被外层覆盖, 故需要 postVerify 重读验证
    postVerify: true,
    deps,
    readKey,
    // values: { http: proxy, https: https-proxy, ca: cafile, mirror: registry }
    read: async () => {
      const [http, https, ca, mirror] = await Promise.all([
        readKey('proxy'),
        readKey('https-proxy'),
        readKey('cafile'),
        readKey('registry'),
      ])
      return { http, https, ca, mirror }
    },
    writeKey: async (key, value) => {
      const r = await deps.run('npm', ['config', 'set', key, value], { shell: true })
      return r.ok ? { ok: true } : { ok: false, error: `npm config set ${key} 失败: ${r.error || r.stderr}` }
    },
    removeKey: async (key) => {
      const r = await deps.run('npm', ['config', 'delete', key], { shell: true })
      return r.ok ? { ok: true } : { ok: false, error: `npm config delete ${key} 失败: ${r.error || r.stderr}` }
    },
    verifyFailNote: (key) => `npm ${key} 删除后仍生效（可能来自环境变量或项目级 .npmrc），请手工检查`,
  })

  return {
    capabilities: { proxy: true, mirror: true },
    ...core,

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
  }
}
