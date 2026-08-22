// 智能恢复代理配置：只清理指向本代理的配置项，绝不触碰用户的其他代理设置
//
// 匹配值来源（优先级从高到低）：
//   1. last-applied.json 快照（npm on / git on 时写入的真实值，解决端口漂移）
//   2. 当前解析出的地址（含默认 31180/31181 兜底）
const path = require('node:path')
const { IS_WIN, resolveProxyAddress, resolveCertPaths, runCommand, readSnapshot } = require('./utils')

const NPM_KEYS = ['proxy', 'https-proxy', 'cafile']
const GIT_KEYS = ['http.proxy', 'https.proxy', 'http.sslCAInfo']

/** Windows 路径归一化：大小写不敏感 + 统一分隔符（用户手改 .npmrc 可能大小写/正斜杠不一致） */
function normPathValue (v) {
  if (!IS_WIN) return v
  return path.resolve(v).replace(/\//g, '\\').toLowerCase()
}

/** 构建代理地址候选集：快照值 + 当前地址 + 默认地址 */
function buildProxyCandidates (addr) {
  const snap = readSnapshot()
  const set = new Set()
  const hosts = new Set([addr.host, '127.0.0.1', 'localhost'])
  const ports = new Set([addr.httpPort, addr.mitmPort, 31180, 31181])
  for (const p of ports) {
    for (const h of hosts) {
      set.add(`http://${h}:${p}`)
    }
  }
  for (const tool of ['npm', 'git']) {
    const section = snap[tool] || {}
    for (const key of NPM_KEYS.concat(GIT_KEYS)) {
      const v = section[key]
      if (typeof v === 'string' && /^http:\/\//.test(v)) set.add(v)
    }
  }
  return set
}

/** 构建证书路径候选集：快照值 + 当前证书路径 */
function buildCertCandidates () {
  const snap = readSnapshot()
  const set = new Set([resolveCertPaths().certPath])
  for (const tool of ['npm', 'git']) {
    const section = snap[tool] || {}
    for (const key of ['cafile', 'http.sslCAInfo']) {
      const v = section[key]
      if (typeof v === 'string' && v.length > 0) set.add(v)
    }
  }
  return set
}

function isUnsetNpmValue (v) {
  return !v || v === 'null' || v === 'undefined' || v === '(未设置)'
}

async function npmAvailable () {
  const r = await runCommand('npm', ['--version'], { shell: true })
  return r.ok
}

async function gitAvailable () {
  const r = await runCommand('git', ['--version'])
  return r.ok
}

/**
 * 检测 npm/git 配置中是否有指向本代理的残留（status 提示用，不做修改）
 */
async function detectResidue (addr) {
  const proxies = buildProxyCandidates(addr)
  const certs = buildCertCandidates()
  const residue = []
  if (await npmAvailable()) {
    for (const key of NPM_KEYS) {
      const r = await runCommand('npm', ['config', 'get', key], { shell: true })
      if (!r.ok || isUnsetNpmValue(r.stdout)) continue
      const matched = key === 'cafile'
        ? [...certs].some((c) => normPathValue(c) === normPathValue(r.stdout))
        : proxies.has(r.stdout)
      if (matched) residue.push(`npm ${key}`)
    }
  }
  if (await gitAvailable()) {
    for (const key of GIT_KEYS) {
      const r = await runCommand('git', ['config', '--global', '--get', key])
      if (!r.ok || !r.stdout) continue
      const matched = key === 'http.sslCAInfo'
        ? [...certs].some((c) => normPathValue(c) === normPathValue(r.stdout))
        : proxies.has(r.stdout)
      if (matched) residue.push(`git ${key}`)
    }
  }
  return residue
}

/**
 * 执行智能恢复：删除指向本代理的配置项，不匹配的绝对不动。
 * 工具缺失时跳过并记录（容错），全程不抛错。
 * 返回 { restored: string[], skipped: string[], notes: string[] }
 */
async function smartRestore (addr, { verbose = false } = {}) {
  const proxies = buildProxyCandidates(addr)
  const certs = buildCertCandidates()
  const restored = []
  const skipped = []
  const notes = []
  const snap = readSnapshot()
  let snapDirty = false

  const matchValue = (key, value) => {
    if (key === 'cafile' || key === 'http.sslCAInfo') {
      for (const c of certs) {
        if (normPathValue(c) === normPathValue(value)) return true
      }
      return false
    }
    return proxies.has(value)
  }

  // npm
  if (await npmAvailable()) {
    let sectionClean = true
    for (const key of NPM_KEYS) {
      const r = await runCommand('npm', ['config', 'get', key], { shell: true })
      if (!r.ok || isUnsetNpmValue(r.stdout)) continue
      if (matchValue(key, r.stdout)) {
        await runCommand('npm', ['config', 'delete', key], { shell: true })
        const after = await runCommand('npm', ['config', 'get', key], { shell: true })
        if (!after.ok || !isUnsetNpmValue(after.stdout)) {
          notes.push(`npm ${key} 删除后仍生效（可能来自环境变量或项目级 .npmrc），请手工检查`)
        }
        restored.push(`npm ${key}`)
      } else {
        // 不匹配的值保留，快照该段视为仍有用户数据
        if (snap.npm && snap.npm[key] === r.stdout) sectionClean = false
      }
    }
    if (snap.npm && sectionClean) {
      delete snap.npm
      snapDirty = true
    }
  } else {
    skipped.push('npm（命令不可用）')
  }

  // git
  if (await gitAvailable()) {
    let sectionClean = true
    for (const key of GIT_KEYS) {
      const r = await runCommand('git', ['config', '--global', '--get', key])
      if (!r.ok || !r.stdout) continue
      if (matchValue(key, r.stdout)) {
        const del = await runCommand('git', ['config', '--global', '--unset', key])
        if (!del.ok && del.code !== 5 && !/no such section/i.test(del.stderr || '')) {
          notes.push(`git ${key} 清除失败: ${del.error || del.stderr}`)
          sectionClean = false
          continue
        }
        restored.push(`git ${key}`)
      } else {
        if (snap.git && snap.git[key] === r.stdout) sectionClean = false
      }
    }
    if (snap.git && sectionClean) {
      delete snap.git
      snapDirty = true
    }
  } else {
    skipped.push('git（命令不可用）')
  }

  // 快照清理：工具处理完成且无残留用户数据时整段删除
  if (snapDirty) {
    try {
      const { writeSnapshotFile } = require('./utils')
      writeSnapshotFile(snap)
    } catch {
      // 快照清理失败不影响主流程
    }
  }

  if (verbose) {
    if (restored.length > 0) {
      console.log(`✅ 已恢复代理配置: ${restored.join(', ')}`)
    } else {
      console.log('未发现指向本代理的 npm/git 配置，无需恢复')
    }
    for (const s of skipped) console.log(`ℹ️  跳过 ${s}`)
    for (const n of notes) console.log(`⚠️  ${n}`)
  }

  return { restored, skipped, notes }
}

module.exports = {
  smartRestore,
  detectResidue,
  buildProxyCandidates,
  buildCertCandidates,
}
