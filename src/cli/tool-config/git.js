// git adapter — git 全局代理配置(.gitconfig)的读写与清理
// 骨架(读取归一化/分类/严格清理/写入与部分快照/off 清除)由 cli-config-adapter
// 单点实现; 本文件只剩命令细节与元数据声明。
// git 是真实可执行文件, 不用 shell; unset 不存在的键返回非 0(退出码 5 / no such section)属正常
const createCliConfigAdapter = require('./cli-config-adapter')
const { normalizeProxyUrlValue } = require('./shared')

module.exports = (deps) => {
  const KEYS = ['http.proxy', 'https.proxy', 'http.sslCAInfo']

  const readKey = async (key) => {
    const r = await deps.run('git', ['config', '--global', '--get', key])
    if (r.error && /ENOENT/i.test(r.error)) throw new Error('命令不可用')
    return (r.ok && r.stdout) ? normalizeProxyUrlValue(r.stdout) : null
  }

  const core = createCliConfigAdapter({
    tool: 'git',
    keys: KEYS,
    certKey: 'http.sslCAInfo',
    // 作用域: git config --global --get 仅读全局配置层(仓库级/系统级不进视野),
    // 同作用域 unset 成功即确证, 无需删除后重读验证 —— 与 npm(合并源)的本质
    // 差异, 以元数据文档化, 不可当作漂移"顺手统一"
    postVerify: false,
    deps,
    readKey,
    // values: { http: http.proxy, https: https.proxy, ca: http.sslCAInfo }
    read: async () => {
      const [http, https, ca] = await Promise.all(KEYS.map(readKey))
      return { http, https, ca }
    },
    writeKey: async (key, value) => {
      const r = await deps.run('git', ['config', '--global', key, value])
      return r.ok ? { ok: true } : { ok: false, error: `git config --global ${key} 失败: ${r.error || r.stderr}` }
    },
    removeKey: async (key) => {
      const del = await deps.run('git', ['config', '--global', '--unset', key])
      if (!del.ok && del.code !== 5 && !/no such section/i.test(del.stderr || '')) {
        return { ok: false, error: `git config --unset ${key} 失败: ${del.error || del.stderr}` }
      }
      return { ok: true }
    },
  })

  return {
    capabilities: { proxy: true, mirror: false },
    ...core,
  }
}
