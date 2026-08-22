// 参数化工厂 — npm/git 等 CLI 配置类 adapter 的共享骨架
// (spec: tool-config-store「adapter 骨架参数化单点」)
//
// 骨架单点实现: 读取归一化、分类、严格清理(removed=已验证不再生效)、
// 写入与部分快照(并入不整段替换)、off 清除。
// 工具差异以声明式元数据表达; 其中 postVerify 是作用域语义差异而非漂移:
// 读取为合并源的工具(npm: 环境变量+项目级+用户级)删除后值仍可能被外层
// 覆盖, 需重读验证; 读取仅作用域于单一配置层的工具(git: --global)无需验证。
//
// meta 字段:
//   tool                      快照段名与结果标签前缀('npm'/'git')
//   keys                      代理+证书键清单(clean/clearProxy 遍历)
//   certKey                   证书键(路径归一化匹配)
//   postVerify                删除后是否重读验证(作用域差异, 见上)
//   deps                      { run, homedir, snapshot } 工厂注入面
//   readKey(key)              → 归一化值|null(未设置); 命令不可用时 throw
//   read()                    → values 映射(含工具特有键, 如 npm 的 registry)
//   writeKey(key, value)      → { ok, error? }
//   removeKey(key)            → { ok, error? }(失败容忍判断在实现内, 如 git 退出码 5)
//   removeFailNote(key, err)  clean 删除失败提示文案
//   verifyFailNote(key)       postVerify 仍生效提示文案(postVerify=true 时必需)
const { classifyValues, isOurs, buildProxyCandidates, buildCertCandidates, normPathValue } = require('./shared')

module.exports = function createCliConfigAdapter (meta) {
  const { deps } = meta

  async function read () {
    try {
      return { ok: true, values: await meta.read() }
    } catch (e) {
      return { ok: false, error: e.message, values: null }
    }
  }

  async function classify (addr) {
    const r = await read()
    if (!r.ok) return r
    const c = classifyValues(r.values, addr)
    return { ok: true, ...c, values: r.values }
  }

  /**
   * 写入代理配置并自动记录快照。快照 = 实际写入值: 任一键失败时,
   * 已成功写入的键并入快照段再返回错误, 不留"有配置无快照"半状态。
   */
  async function setProxy (entries) {
    const written = {}
    // 并入而非整段替换: 未尝试的键保留旧快照值(端口漂移候选集不丢)
    const record = () => {
      if (Object.keys(written).length === 0) return
      const section = { ...((deps.snapshot.read()[meta.tool]) || {}), ...written }
      deps.snapshot.updateTool(meta.tool, section)
    }
    try {
      for (const [key, value] of Object.entries(entries)) {
        const r = await meta.writeKey(key, value)
        if (!r.ok) {
          record()
          return { ok: false, error: r.error }
        }
        written[key] = value
      }
      record()
      return { ok: true, written: Object.entries(entries) }
    } catch (e) {
      record()
      return { ok: false, error: e.message }
    }
  }

  /** 清除全部代理键(off 语义: 无条件清除) */
  async function clearProxy () {
    try {
      for (const key of meta.keys) {
        const r = await meta.removeKey(key)
        if (!r.ok) return { ok: false, error: r.error }
      }
      deps.snapshot.clearTool(meta.tool)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  /**
   * 严格清理: 代理键精确候选集匹配, 证书键路径归一化匹配。
   * removed 只收已验证不再生效的项; 删除失败/删除后仍生效记入 notes
   * 并保留快照段; 段内无用户数据时清快照段。
   */
  async function clean (addr, { dryRun = false } = {}) {
    try {
      const snap = deps.snapshot.read()
      const candidates = buildProxyCandidates(addr, snap)
      const certs = buildCertCandidates(deps.homedir, snap)
      const removed = []
      const notes = []
      let sectionClean = true

      for (const key of meta.keys) {
        const value = await meta.readKey(key)
        if (value == null) continue
        const matched = key === meta.certKey
          ? [...certs].some((c) => normPathValue(c) === normPathValue(value))
          : isOurs(candidates, value)
        if (matched) {
          if (!dryRun) {
            const del = await meta.removeKey(key)
            if (!del.ok) {
              notes.push(meta.removeFailNote(key, del.error))
              // 值仍在: 保留快照段供下次重试; removed 只收已验证不再生效的项
              sectionClean = false
              continue
            }
            if (meta.postVerify) {
              const after = await meta.readKey(key)
              if (after != null) {
                notes.push(meta.verifyFailNote(key))
                sectionClean = false
                continue
              }
            }
          }
          removed.push(`${meta.tool} ${key}`)
        } else if (snap[meta.tool] && snap[meta.tool][key] === value) {
          sectionClean = false
        }
      }

      if (!dryRun && snap[meta.tool] && sectionClean) {
        deps.snapshot.clearTool(meta.tool)
      }
      return { ok: true, removed, notes }
    } catch (e) {
      return { ok: false, error: e.message, removed: [], notes: [] }
    }
  }

  return { read, classify, setProxy, clearProxy, clean }
}
