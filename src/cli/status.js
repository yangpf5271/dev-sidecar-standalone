// dss status — 全景状态面板：进程 / 证书系统信任 / 各工具代理 / 镜像源 / Docker
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const pkg = require('../../package.json')
const {
  IS_WIN,
  resolveProxyAddress,
  resolveCertPaths,
  runCommand,
  probePort,
  readPidFile,
  readSnapshot,
  detectCertTrust,
  isProcessAlive,
  verifyProcessIdentity,
} = require('./utils')
const { NPM_MIRRORS, NPM_OFFICIAL } = require('./npm')
const { PIP_MIRRORS, PIP_OFFICIAL } = require('./pip')
const { detectResidue } = require('./restore-config')

async function run (args) {
  const addr = resolveProxyAddress(args)
  const { certPath, certExists } = resolveCertPaths()

  const [httpUp, mitmUp, certTrust, tools] = await Promise.all([
    probePort(addr.host, addr.httpPort),
    probePort(addr.host, addr.mitmPort),
    certExists ? detectCertTrust(certPath) : Promise.resolve(null),
    collectTools(addr),
  ])

  const running = httpUp || mitmUp

  console.log(`dev-sidecar-standalone v${pkg.version}`)
  console.log('')
  if (running) {
    console.log('  代理进程:  ✅ 运行中')
    // PID 展示（守护进程才有 PID 文件；前台实例无）
    const pid = readPidFile()
    if (pid != null && isProcessAlive(pid)) {
      console.log(`  进程 PID:  ${pid}${await verifyProcessIdentity(pid) ? '' : ' (⚠️ 身份未确认)'}`)
    }
  } else {
    console.log('  代理进程:  ❌ 未运行')
    if (!addr.isDefaultPort) {
      console.log(`  (探测端口 ${addr.httpPort}/${addr.mitmPort}，来自${addr.configPath ? '配置文件' : 'PORT 环境变量'}，`)
      console.log('   请确认代理启动时使用了相同的配置)')
    }
  }
  console.log(`  HTTP 代理:  ${addr.host}:${addr.httpPort}  ${httpUp ? '✅' : '—'}`)
  console.log(`  HTTPS 代理: ${addr.host}:${addr.mitmPort}  ${mitmUp ? '✅' : '—'}  (MITM)`)

  console.log(`  CA 证书:    ${certExists ? '✅ 已生成' : '❌ 未生成 (启动一次代理后自动生成)'}`)
  if (certExists && certTrust) {
    if (certTrust.installed) {
      console.log(`  系统信任:   ✅ 已安装 (${certTrust.where})`)
    } else if (certTrust.unknown) {
      console.log(`  系统信任:   ⚠️ 无法检测 (${certTrust.error})`)
    } else {
      console.log('  系统信任:   ⚠️ 未安装 (MITM 加速需信任，运行 dss cert 查看安装方法)')
    }
  }

  console.log('')
  console.log(`  工具代理:   ${tools.proxySummary}`)
  console.log(`  镜像源:     ${tools.mirrorSummary}`)
  console.log(`  Docker:     ${tools.dockerSummary}`)
  console.log('')
  console.log('  详情: dss npm status / dss git status / dss docker status')

  if (!running) {
    console.log('')
    console.log('  启动代理: dss   (后台运行: dss start 或 dss -d)')

    // 残留配置检测：代理没在跑但 npm/git 还指向它 → 日常使用会受影响
    try {
      const residue = await detectResidue(addr)
      if (residue.length > 0) {
        console.log('')
        console.log(`  ⚠️  检测到仍指向本代理的残留配置: ${residue.join(', ')}`)
        console.log('     运行 dss restore 一键恢复，避免影响 npm/git 日常使用')
      }
    } catch {
      // 检测失败（如 npm/git 均不可用）不影响状态展示
    }
  }
}

// ---------------------------------------------------------------------------
// 各工具状态聚合（全部并行探测，单项失败不影响其他）
// ---------------------------------------------------------------------------

async function collectTools (addr) {
  const snap = readSnapshot()
  const [npm, git, pip, dockerBuild, dockerPull] = await Promise.all([
    collectNpm(addr),
    collectGit(addr),
    collectPip(),
    collectDockerBuild(),
    collectDockerPull(),
  ])

  const proxyParts = [
    `npm ${badge(npm.mode, npm.extra)}`,
    `git ${badge(git.mode, git.extra)}`,
    `pip ${badge(pip.mode, pip.extra)}`,
    `docker build ${badge(dockerBuild.mode, dockerBuild.extra)}`,
  ]
  const mirrorParts = [
    `npm ${mirrorLabel(npm.registry, NPM_OFFICIAL, NPM_MIRRORS, snap.mirror && snap.mirror.npm)}`,
    `pip ${mirrorLabel(pip.indexUrl, PIP_OFFICIAL, PIP_MIRRORS, snap.mirror && snap.mirror.pip)}`,
  ]
  const dockerParts = [
    `pull 镜像源 ${dockerPull.mode ? `✅ ${dockerPull.extra}` : '未配置'}`,
  ]
  if (!dockerPull.mode && dockerPull.hint) dockerParts.push(`(${dockerPull.hint})`)

  return {
    proxySummary: proxyParts.join('  '),
    mirrorSummary: mirrorParts.join('  '),
    dockerSummary: dockerParts.join(' '),
  }
}

function badge (mode, extra) {
  if (!mode) return '—'
  if (mode === 'other') return `⚠️ ${extra}`
  return `✅ ${mode}`
}

/** 镜像源显示：官方 → 默认；已知镜像 → 名称(+dss 标记)；其他 → 原样(企业源等)。尾部斜杠归一化后比较 */
function mirrorLabel (current, official, mirrors, snapshotSaved) {
  const norm = (u) => u.replace(/\/+$/, '')
  if (!current) return '(未设置)'
  if (norm(current) === norm(official)) return '默认'
  const known = Object.values(mirrors).find(m => norm(m.url) === norm(current))
  if (known) return snapshotSaved ? `${known.name} [dss切换]` : known.name
  return `${current} [自定义]`
}

async function npmGet (key) {
  const r = await runCommand('npm', ['config', 'get', key], { shell: true })
  if (!r.ok) return null
  const v = (r.stdout || '').trim()
  return (v && v !== 'null' && v !== 'undefined') ? v : null
}

async function collectNpm (addr) {
  const [proxy, httpsProxy, cafile, registry] = await Promise.all([
    npmGet('proxy'),
    npmGet('https-proxy'),
    npmGet('cafile'),
    npmGet('registry'),
  ])
  return {
    registry,
    ...classifyProxy(proxy, httpsProxy, cafile, addr),
  }
}

async function collectGit (addr) {
  const get = async (key) => {
    const r = await runCommand('git', ['config', '--global', '--get', key])
    return r.ok && r.stdout ? r.stdout.trim() : null
  }
  const [httpProxy, httpsProxy, sslCAInfo] = await Promise.all([
    get('http.proxy'),
    get('https.proxy'),
    get('http.sslCAInfo'),
  ])
  return classifyProxy(httpProxy, httpsProxy, sslCAInfo, addr)
}

/**
 * 按配置值分类代理模式：
 *  httpsProxy 指向 MITM 端口(+CA) → MITM；任一值含 HTTP 端口 → 隧道；
 *  有值但不指向本代理 → other(展示原值，便于发现残留的第三方代理)
 */
function classifyProxy (proxy, httpsProxy, ca, addr) {
  const any = httpsProxy || proxy
  if (!any) return { mode: null }
  if (httpsProxy && httpsProxy.includes(`:${addr.mitmPort}`)) {
    return { mode: 'MITM', extra: ca ? null : '(缺 CA 配置)' }
  }
  if ((proxy && proxy.includes(`:${addr.httpPort}`)) ||
      (httpsProxy && httpsProxy.includes(`:${addr.httpPort}`))) {
    return { mode: '隧道' }
  }
  return { mode: 'other', extra: any }
}

async function collectPip () {
  // pip / pip3 逐个探测（pip.js 的 detectPip 不导出，这里轻量重试）
  let pipCmd = null
  for (const cmd of ['pip', 'pip3']) {
    const t = await runCommand(cmd, ['--version'])
    if (t.ok) { pipCmd = cmd; break }
  }
  if (!pipCmd) return { mode: null, indexUrl: null }
  const get = async (key) => {
    const r = await runCommand(pipCmd, ['config', 'get', key])
    return r.ok && r.stdout ? r.stdout.trim() : null
  }
  const [proxy, indexUrl] = await Promise.all([get('global.proxy'), get('global.index-url')])
  return { mode: proxy ? '隧道' : null, extra: proxy, indexUrl }
}

/** 构建层代理：~/.docker/config.json proxies.default（dss docker on 注入） */
function collectDockerBuild () {
  try {
    const file = path.join(os.homedir(), '.docker', 'config.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const def = data.proxies && data.proxies.default
    if (def && (def.httpProxy || def.httpsProxy)) {
      return { mode: '已注入', extra: def.httpProxy || def.httpsProxy }
    }
  } catch { /* 文件不存在或无 proxies 段 */ }
  return { mode: null }
}

/** 拉取镜像源：Linux/mac 直接读 daemon.json；Windows 经 WSL 读（WSL 冷启动可能较慢，带超时防挂起） */
async function collectDockerPull () {
  const read = async () => {
    if (!IS_WIN) {
      try {
        return fs.readFileSync('/etc/docker/daemon.json', 'utf8')
      } catch {
        return null
      }
    }
    const r = await runCommand('wsl.exe', ['-e', 'cat', '/etc/docker/daemon.json'])
    return r.ok ? r.stdout : null
  }
  const TIMEOUT = Symbol('timeout')
  const content = await Promise.race([
    read(),
    new Promise(resolve => setTimeout(() => resolve(TIMEOUT), 8000)),
  ])
  if (content === TIMEOUT) return { mode: null, hint: 'WSL 检测超时，可稍后重试' }
  if (!content) return { mode: null, hint: IS_WIN ? 'WSL 内无 daemon.json' : null }
  try {
    const mirrors = JSON.parse(content)['registry-mirrors']
    if (Array.isArray(mirrors) && mirrors.length > 0) {
      return { mode: true, extra: `${mirrors[0]}${mirrors.length > 1 ? ` 等 ${mirrors.length} 个` : ''}` }
    }
  } catch { /* daemon.json 损坏时不在此报错，dss docker 命令会处理 */ }
  return { mode: null }
}

function help () {
  console.log('用法: dss status [-c <配置文件>]')
  console.log('')
  console.log('全景状态面板：')
  console.log('  - 代理进程 / 端口 / PID')
  console.log('  - CA 证书生成 + 是否已安装到系统信任列表（Windows 证书存储 / Linux ca-certificates / macOS 钥匙串）')
  console.log('  - 工具代理: npm / git / pip / docker build 当前是否走代理及模式（MITM / 隧道）')
  console.log('  - 镜像源: npm / pip 当前源及是否由 dss 切换')
  console.log('  - Docker 拉取镜像源（daemon.json registry-mirrors）')
  console.log('未运行时额外检测 npm/git 指向本代理的残留配置')
}

module.exports = { run, help }
