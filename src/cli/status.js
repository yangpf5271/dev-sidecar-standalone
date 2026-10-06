// dss status — 全景状态面板：进程 / 证书系统信任 / 各工具代理 / 镜像源 / Docker
const pkg = require('../../package.json')
const {
  IS_WIN,
  resolveProxyAddress,
  resolveCertPaths,
  probePort,
  readPidInfo,
  daemonVersionDiffers,
  detectCertTrust,
  isProcessAlive,
  verifyProcessIdentity,
} = require('./utils')
const { adapters } = require('./tool-config')
const { NPM_OFFICIAL, npmMirrorEngine, PIP_OFFICIAL, pipMirrorEngine } = require('./tool-config/mirror-registry')
const { normUrl } = require('./tool-config/mirror-engine')
const { createServiceOps } = require('./lib/service-ops')
const { KIND_LABELS } = require('./lib/service-definitions')
const pull = require('./docker-pull')
const { detectResidue } = require('./restore-config')

async function run (args) {
  const addr = resolveProxyAddress(args)
  const { certPath, certExists } = resolveCertPaths()

  // 面板统一地址源: 服务定义在管时以 manifest 固化地址探测(服务按安装时配置运行),
  // 消除"进程行探当前 env 端口 + 服务行探固化端口"的同屏自相矛盾(判定书 P1 #24)
  let svcAddr = addr
  try {
    svcAddr = createServiceOps().effectiveAddr(addr)
  } catch { /* 探测失败回退当前 env 地址 */ }

  const [httpUp, mitmUp, certTrust, tools] = await Promise.all([
    probePort(svcAddr.host, svcAddr.httpPort),
    probePort(svcAddr.host, svcAddr.mitmPort),
    certExists ? detectCertTrust(certPath) : Promise.resolve(null),
    collectTools(addr),
  ])

  const running = httpUp || mitmUp

  console.log(`dev-sidecar-standalone v${pkg.version}`)
  console.log('')
  if (running) {
    console.log('  代理进程:  ✅ 运行中')
    // PID 展示（守护进程才有 PID 文件；前台实例无）。
    // 版本僵告警仅采信「身份验证通过」的 PID —— 死 PID 残留/无关进程复用不再产生假告警
    const pidInfo = readPidInfo()
    if (pidInfo && isProcessAlive(pidInfo.pid)) {
      let trusted = false
      try { trusted = await verifyProcessIdentity(pidInfo.pid) } catch { trusted = false }
      console.log(`  进程 PID:  ${pidInfo.pid}${trusted ? '' : ' (⚠️ 身份未确认)'}`)
      // 版本僵告警: 更新后守护进程仍跑旧代码(npm 更新从不重启在跑的进程) —— 只判相等不判新旧
      if (trusted && daemonVersionDiffers(pidInfo, pkg.version)) {
        console.log(`  ⚠️ 版本僵:  守护进程 v${pidInfo.version} ≠ CLI v${pkg.version}，建议 dss restart 对齐`)
      }
    }
  } else {
    console.log('  代理进程:  ❌ 未运行')
    if (!addr.isDefaultPort) {
      console.log(`  (探测端口 ${svcAddr.httpPort}/${svcAddr.mitmPort}，来自${addr.configPath ? '配置文件' : 'PORT 环境变量'}，`)
      console.log('   请确认代理启动时使用了相同的配置)')
    }
  }
  console.log(`  HTTP 代理:  ${svcAddr.host}:${svcAddr.httpPort}  ${httpUp ? '✅' : '—'}`)
  console.log(`  HTTPS 代理: ${svcAddr.host}:${svcAddr.mitmPort}  ${mitmUp ? '✅' : '—'}  (MITM)`)

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

  // 服务定义状态行(未安装不显示, 不干扰既有面板结构)
  try {
    const svc = await createServiceOps().status(addr)
    if (svc.installed) {
      const kindName = KIND_LABELS[process.platform === 'win32' ? 'runkey' : process.platform === 'darwin' ? 'launchd' : 'systemd']
      let label = svc.state === 'running'
        ? `✅ 运行中 (${kindName})`
        : svc.state === 'version-mismatch'
          ? `✅ 运行中 (${kindName})  ⚠️ 版本不一致(建议 dss restart)`
          : '⚠️ 已安装但未运行'
      // 崩溃循环主动信号(Linux): Restart=always 永远达不到 systemd 熔断阈值, 无此检测则循环静默
      if (svc.crashLoop) {
        label += '  ⚠️ 崩溃循环(反复启动失败)，排查: journalctl -u dss.service -n 50'
      }
      console.log(`  服务定义:   ${label}`)
    }
  } catch {
    // 服务探测失败不影响面板其余部分
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
function mirrorLabel (st, official) {
  if (!st.current) return st.readError ? '获取失败' : '(未设置)'
  if (normUrl(st.current) === normUrl(official)) return '默认'
  if (st.known) return st.saved ? `${st.known} [dss切换]` : st.known
  return `${st.current} [自定义]`
}

/** 拉取镜像源：读取与解析来自 docker-pull 模块（Linux/mac 本机直读；Windows 经 WSL 穿透，模块内带超时防冷启动挂起） */
async function collectDockerPull () {
  const r = IS_WIN ? await pull.readViaWsl() : pull.readLocal()
  if (r.timeout) return { mode: null, hint: 'WSL 检测超时，可稍后重试' }
  if (!r.content) return { mode: null, hint: IS_WIN ? 'WSL 内无 daemon.json' : null }
  const doc = pull.parseDoc(r.content)
  if (doc.ok) {
    const mirrors = pull.parseMirrors(doc.data)
    if (mirrors.length > 0) {
      return { mode: true, extra: `${mirrors[0]}${mirrors.length > 1 ? ` 等 ${mirrors.length} 个` : ''}` }
    }
  }
  return { mode: null }   // daemon.json 损坏时不在此报错，dss docker 命令会处理
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
