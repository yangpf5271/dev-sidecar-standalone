// dss status — 全景状态面板：进程 / 证书系统信任 / 各工具代理 / 镜像源 / Docker
const fs = require('node:fs')
const pkg = require('../../package.json')
const {
  IS_WIN,
  resolveProxyAddress,
  resolveCertPaths,
  runCommand,
  probePort,
  readPidFile,
  detectCertTrust,
  isProcessAlive,
  verifyProcessIdentity,
} = require('./utils')
const { adapters } = require('./tool-config')
const { NPM_OFFICIAL, mirrorEngine: npmMirrorEngine } = require('./npm')
const { PIP_OFFICIAL, mirrorEngine: pipMirrorEngine } = require('./pip')
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

    // 残留配置检测：代理没在跑但 npm/git/docker 还指向它 → 日常使用会受影响
    try {
      const residue = await detectResidue(addr)
      if (residue.length > 0) {
        console.log('')
        console.log(`  ⚠️  检测到仍指向本代理的残留配置: ${residue.join(', ')}`)
        console.log('     运行 dss restore 一键恢复，避免影响日常使用')
      }
    } catch {
      // 检测失败（如 npm/git 均不可用）不影响状态展示
    }
  }
}

// ---------------------------------------------------------------------------
// 各工具状态聚合（全部并行探测，单项失败不影响其他）
// 匹配语义来自 tool-config store 的 classify(宽松展示语义) — 与清理同源
// ---------------------------------------------------------------------------
async function collectTools (addr) {
  const [npmR, gitR, pipR, dockerR, dockerPull, npmMirror, pipMirror] = await Promise.all([
    adapters.npm.classify(addr),
    adapters.git.classify(addr),
    adapters.pip.classify(addr),
    adapters.docker.classify(addr),
    collectDockerPull(),
    npmMirrorEngine.status(),
    pipMirrorEngine.status(),
  ])

  const proxyParts = [
    `npm ${proxyBadge(npmR)}`,
    `git ${proxyBadge(gitR)}`,
    `pip ${proxyBadge(pipR)}`,
    `docker build ${proxyBadge(dockerR)}`,
  ]
  const mirrorParts = [
    `npm ${mirrorLabel(npmMirror, NPM_OFFICIAL)}`,
    `pip ${mirrorLabel(pipMirror, PIP_OFFICIAL)}`,
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

/** classify 结果 → 展示徽标; 展示语义宽松, "看起来像就提醒"(other 显示原值) */
function proxyBadge (r) {
  if (!r || !r.ok || r.mode === 'none') return '—'
  if (r.mode === 'other') return `⚠️ ${r.address}`
  const mode = r.mode === 'mitm' ? 'MITM' : '隧道'
  const caMissing = r.mode === 'mitm' && r.values && r.values.ca == null
  return `✅ ${mode}${caMissing ? ' (缺 CA 配置)' : ''}`
}

/** 镜像源显示（数据来自镜像引擎 status，与 dss npm/pip mirror 同源）：
 *  官方 → 默认；表内 → 名称(+dss 标记)；其他 → 原样(企业源等)；读失败 → 获取失败 */
const normUrl = (u) => u.replace(/\/+$/, '')
function mirrorLabel (st, official) {
  if (!st.current) return st.readError ? '获取失败' : '(未设置)'
  if (normUrl(st.current) === normUrl(official)) return '默认'
  if (st.known) return st.saved ? `${st.known} [dss切换]` : st.known
  return `${st.current} [自定义]`
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
  console.log('未运行时额外检测 npm/git/docker 指向本代理的残留配置')
}

module.exports = { run, help }
