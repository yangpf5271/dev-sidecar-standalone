// docker adapter — 构建层代理(~/.docker/config.json proxies.default)的读写与清理
//
// 本 adapter 独家拥有该文件的读写: 2 空格缩进 + 尾换行统一格式, auths 等用户字段值级保留。
// isOurs 文档化例外: 注入值指向宿主网关地址(host.docker.internal/docker0 等),
// 恢复时无法重推网关, 因此按端口匹配而非精确候选集(与 npm/git 的差异由单测锁定)。
// 拉取层(daemon.json registry-mirrors)与代理进程无关, 不属于本 adapter。
const fs = require('node:fs')
const path = require('node:path')
const { classifyValues } = require('./shared')

module.exports = (deps) => {
  const configFile = () => path.join(deps.homedir(), '.docker', 'config.json')

  /** 整文档读取(文件不存在返回 data: null, 不算错误) */
  function readDoc () {
    try {
      return { ok: true, data: JSON.parse(fs.readFileSync(configFile(), 'utf8')) }
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: true, data: null }
      return { ok: false, error: `读取 ~/.docker/config.json 失败: ${e.message}` }
    }
  }

  /** 整文档写回: 统一 2 空格缩进 + 尾换行 */
  function writeDoc (data) {
    try {
      fs.mkdirSync(path.dirname(configFile()), { recursive: true })
      fs.writeFileSync(configFile(), JSON.stringify(data, null, 2) + '\n')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: `写入 ~/.docker/config.json 失败: ${e.message}` }
    }
  }

  /** 读取 proxies.default 的代理值 */
  function readDefault () {
    const doc = readDoc()
    if (!doc.ok) return doc
    const def = doc.data && doc.data.proxies && doc.data.proxies.default
    return {
      ok: true,
      def: def || null,
      values: {
        http: (def && def.httpProxy) || null,
        https: (def && def.httpsProxy) || null,
      },
    }
  }

  return {
    name: 'docker',
    capabilities: { proxy: true, mirror: false },

    /** values: { http: httpProxy, https: httpsProxy }（来自 proxies.default） */
    async read () {
      const r = readDefault()
      if (!r.ok) return { ok: false, error: r.error, values: null }
      return { ok: true, values: r.values }
    },

    async classify (addr) {
      const r = await this.read()
      if (!r.ok) return r
      const c = classifyValues(r.values, addr)
      return { ok: true, ...c, values: r.values }
    },

    /** 清理指向本代理端口的 proxies.default(auths 严格保留); 指向其他代理的绝不动 */
    async clean (addr, { dryRun = false } = {}) {
      const doc = readDoc()
      if (!doc.ok) return { ok: false, error: doc.error, removed: [], notes: [] }
      const def = doc.data && doc.data.proxies && doc.data.proxies.default
      if (!def) return { ok: true, removed: [], notes: [] }

      const urls = [def.httpProxy, def.httpsProxy].filter((v) => typeof v === 'string')
      const hit = urls.find((u) => u.includes(`:${addr.httpPort}`))
      if (!hit) return { ok: true, removed: [], notes: [] }

      if (dryRun) {
        return { ok: true, removed: ['docker proxies.default (build 层)'], notes: [] }
      }
      delete doc.data.proxies.default
      if (Object.keys(doc.data.proxies).length === 0) delete doc.data.proxies
      const w = writeDoc(doc.data)
      if (!w.ok) return { ok: false, error: w.error, removed: [], notes: [w.error] }
      return { ok: true, removed: [`docker proxies.default (${hit})`], notes: [] }
    },

    // ---- 整文档原语(docker 命令层使用; auths 由命令层语义保证不动) ----
    readDoc,
    writeDoc,
  }
}
