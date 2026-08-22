// dss npm on|off — 配置/取消 npm 代理
// dss npm mirror <name>|off|status — 切换/恢复/查看 npm 镜像源
const { resolveProxyAddress, resolveCertPaths, runCommand, probePort, updateSnapshot, clearSnapshotSection, readSnapshot, writeSnapshot } = require('./utils')

const NPM_OFFICIAL = 'https://registry.npmjs.org'
const NPM_MIRRORS = {
  npmmirror: { name: 'npmmirror（淘宝）', url: 'https://registry.npmmirror.com' },
  ustc: { name: '中国科学技术大学', url: 'https://npmreg.proxy.ustclug.org' },
}

async function run (args) {
  const action = args[0]
  if (action === 'mirror') {
    return mirror(args.slice(1))
  }
  if (action !== 'on' && action !== 'off' && action !== 'status') {
    help()
    process.exit(action ? 1 : 0)
  }
  if (action === 'status') return showStatus()
  if (action === 'on') return enable(args)
  return disable()
}

async function enable (args) {
  const addr = resolveProxyAddress(args)
  const useMitm = args.includes('--mitm')

  // 探测代理是否在运行（仅提示，不阻断）
  const httpUp = await probePort(addr.host, addr.httpPort)
  if (!httpUp) {
    console.log(`⚠️  代理似乎未在运行 (${addr.host}:${addr.httpPort} 未监听)`)
    console.log('   如果代理未启动，npm 将无法联网。建议先运行: dss')
    console.log('')
  }
  if (!addr.isDefaultPort) {
    console.log(`ℹ️  使用非默认端口 (来自${addr.configPath ? '配置文件' : 'PORT 环境变量'})，`)
    console.log('   请确认代理启动时使用了相同的配置')
    console.log('')
  }

  const httpProxy = `http://${addr.host}:${addr.httpPort}`
  const tasks = [
    ['proxy', httpProxy],
    ['https-proxy', useMitm ? `http://${addr.host}:${addr.mitmPort}` : httpProxy],
  ]

  if (useMitm) {
    const { certPath, certExists } = resolveCertPaths()
    if (!certExists) {
      console.log('❌ CA 证书尚未生成，无法配置 --mitm 模式')
      console.log('   请先启动一次代理 (dss) 自动生成证书，或使用默认简单模式')
      process.exit(1)
    }
    tasks.push(['cafile', certPath])
  }

  for (const [key, value] of tasks) {
    const r = await runCommand('npm', ['config', 'set', key, value], { shell: true })
    if (!r.ok) {
      console.error(`❌ npm config set ${key} 失败: ${r.error || r.stderr}`)
      process.exit(1)
    }
    console.log(`✅ npm config set ${key} ${value}`)
  }

  console.log('')
  console.log(useMitm ? 'npm 已配置为 MITM 加速模式（需已安装 CA 证书）' : 'npm 已配置为简单代理模式（HTTP 隧道，无需证书）')
  console.log('取消配置: dss npm off')

  // 记录本次写入的实际值，供 dss stop / dss restore 智能恢复
  updateSnapshot('npm', Object.fromEntries(tasks))
}

async function disable () {
  const keys = ['proxy', 'https-proxy', 'cafile']
  for (const key of keys) {
    const r = await runCommand('npm', ['config', 'delete', key], { shell: true })
    if (!r.ok) {
      console.error(`❌ npm config delete ${key} 失败: ${r.error || r.stderr}`)
      process.exit(1)
    }
  }
  clearSnapshotSection('npm')
  console.log('✅ npm 代理配置已清除 (proxy / https-proxy / cafile)')
}

async function showStatus () {
  const keys = ['proxy', 'https-proxy', 'cafile', 'registry']
  console.log('当前 npm 配置:')
  for (const key of keys) {
    const r = await runCommand('npm', ['config', 'get', key], { shell: true })
    const value = r.ok ? (r.stdout === 'null' || r.stdout === 'undefined' ? '(未设置)' : r.stdout) : '获取失败'
    console.log(`  ${key}: ${value}`)
  }
}

function help () {
  console.log('用法: dss npm <on|off|mirror|status>')
  console.log('')
  console.log('  on        配置 npm 走代理（简单模式：proxy/https-proxy 均指向 HTTP 端口）')
  console.log('  on --mitm MITM 加速模式（https-proxy 指向 MITM 端口并配置 CA 证书，')
  console.log('            需先启动代理生成证书并安装到系统信任列表）')
  console.log('  off       清除 npm 代理配置（proxy / https-proxy / cafile）')
  console.log('  status    查看当前 npm 相关配置')
  console.log('')
  console.log('镜像源切换（与代理模式正交，镜像无需代理即可直连）:')
  console.log('  dss npm mirror            查看/列出可用镜像')
  console.log(`  dss npm mirror <name>     切换镜像（${Object.entries(NPM_MIRRORS).map(([k, v]) => k).join(' / ')}）`)
  console.log('  dss npm mirror off        恢复切换前的源（首次切换前的原值会被快照保护，')
  console.log('                            企业内网源不会被覆盖丢失）')
  console.log('')
  console.log('示例:')
  console.log('  dss npm on')
  console.log('  dss npm on --mitm')
  console.log('  dss npm off')
  console.log('  dss npm mirror npmmirror')
  console.log('  dss npm mirror off')
}

// ---------------------------------------------------------------------------
// 镜像源切换
// ---------------------------------------------------------------------------

async function getRegistry () {
  const r = await runCommand('npm', ['config', 'get', 'registry'], { shell: true })
  return r.ok ? r.stdout.trim() : null
}

async function getProxyState () {
  const r = await runCommand('npm', ['config', 'get', 'proxy'], { shell: true })
  return r.ok && r.stdout && r.stdout !== 'null' && r.stdout !== 'undefined' ? r.stdout.trim() : null
}

/** 冲突提示：镜像国内直连可达，配合代理使用是双重跳转 */
async function warnProxyConflict () {
  const proxy = await getProxyState()
  if (proxy) {
    console.log(`ℹ️  当前 npm 配置了代理 (${proxy})，镜像源无需配合代理使用，`)
    console.log('   同时使用会双重跳转反而可能变慢，建议 dss npm off 后仅用镜像')
  }
}

/** 首次切换时快照原值（重复切换不覆盖快照），off 恢复快照而非硬编码官方源 */
function saveMirrorSnapshot (current) {
  const snap = readSnapshot()
  if (!snap.mirror) snap.mirror = {}
  if (!snap.mirror.npm) {
    snap.mirror.npm = { registry: current }
    writeSnapshot(snap)
  }
}

async function mirror (args) {
  const action = args[0]
  if (!action || action === 'status') return mirrorStatus()
  if (action === 'off') return mirrorOff()

  const m = NPM_MIRRORS[action]
  if (!m) {
    console.error(`未知镜像: ${action}`)
    console.error(`可选: ${Object.keys(NPM_MIRRORS).join(' / ')}, off(恢复), status(查看)`)
    process.exit(1)
  }

  const current = await getRegistry()
  if (current === m.url) {
    console.log(`npm 源已经是 ${m.name} (${m.url})`)
    return
  }

  saveMirrorSnapshot(current)

  const r = await runCommand('npm', ['config', 'set', 'registry', m.url], { shell: true })
  if (!r.ok) {
    console.error(`❌ npm config set registry 失败: ${r.error || r.stderr}`)
    process.exit(1)
  }
  console.log(`✅ npm 源已切换: ${m.name}`)
  console.log(`   ${current || '(未设置)'}  →  ${m.url}`)
  await warnProxyConflict()
  console.log('')
  console.log('⚠️  注意: 镜像为只读，发布 npm 包时需临时指定官方源:')
  console.log(`   npm publish --registry ${NPM_OFFICIAL}`)
  console.log('   （新发布的包约 10 分钟后才会同步到镜像）')
  console.log('恢复: dss npm mirror off')
}

async function mirrorOff () {
  const snap = readSnapshot()
  const saved = snap.mirror && snap.mirror.npm ? snap.mirror.npm.registry : null
  const target = saved || NPM_OFFICIAL

  const r = await runCommand('npm', ['config', 'set', 'registry', target], { shell: true })
  if (!r.ok) {
    console.error(`❌ 恢复 npm 源失败: ${r.error || r.stderr}`)
    process.exit(1)
  }
  if (snap.mirror) {
    delete snap.mirror.npm
    if (Object.keys(snap.mirror).length === 0) delete snap.mirror
    writeSnapshot(snap)
  }
  console.log(`✅ npm 源已恢复: ${target}${saved ? '（来自切换前快照）' : ''}`)
}

async function mirrorStatus () {
  const current = await getRegistry()
  const snap = readSnapshot()
  const saved = snap.mirror && snap.mirror.npm ? snap.mirror.npm.registry : null
  const known = Object.entries(NPM_MIRRORS).find(([, v]) => v.url === current)

  console.log('npm 镜像源:')
  console.log(`  当前: ${current || '(未设置)'}`)
  if (known) console.log(`        (${known[1].name})`)
  if (saved) console.log(`  切换前原值: ${saved}（dss npm mirror off 可恢复）`)
  console.log('')
  console.log('可用镜像:')
  for (const [key, m] of Object.entries(NPM_MIRRORS)) {
    console.log(`  ${key.padEnd(12)} ${m.name}  ${m.url}`)
  }
  console.log(`  ${'npm'.padEnd(12)} 官方源  ${NPM_OFFICIAL}（off 未有快照时恢复到它）`)
}

module.exports = { run, help, NPM_MIRRORS, NPM_OFFICIAL }
