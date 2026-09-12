// dss npm on|off — 配置/取消 npm 代理
// dss npm mirror <name>|off|status — 切换/恢复/查看 npm 镜像源
const { resolveProxyAddress, resolveCertPaths, warnIfProxyDown, makeConfigValueLabel } = require('./utils')
const { adapters } = require('./tool-config')
const { NPM_MIRRORS, NPM_OFFICIAL, npmMirrorEngine: mirrorEngine } = require('./tool-config/mirror-registry')

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
  await warnIfProxyDown(addr, 'npm')

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

  // 写入 + 快照记录原子化在 adapter 内(供 dss stop / dss restore 智能恢复)
  const r = await adapters.npm.setProxy(Object.fromEntries(tasks))
  if (!r.ok) {
    console.error(`❌ ${r.error}`)
    process.exit(1)
  }
  for (const [key, value] of r.written) {
    console.log(`✅ npm config set ${key} ${value}`)
  }

  console.log('')
  console.log(useMitm ? 'npm 已配置为 MITM 加速模式（需已安装 CA 证书）' : 'npm 已配置为简单代理模式（HTTP 隧道，无需证书）')
  console.log('取消配置: dss npm off')
}

async function disable () {
  const r = await adapters.npm.clearProxy()
  if (!r.ok) {
    console.error(`❌ ${r.error}`)
    process.exit(1)
  }
  console.log('✅ npm 代理配置已清除 (proxy / https-proxy / cafile)')
}

async function showStatus () {
  const r = await adapters.npm.read()
  const label = makeConfigValueLabel(r.ok)
  const v = (r.ok && r.values) || {}
  console.log('当前 npm 配置:')
  console.log(`  proxy: ${label(v.http)}`)
  console.log(`  https-proxy: ${label(v.https)}`)
  console.log(`  cafile: ${label(v.ca)}`)
  console.log(`  registry: ${label(v.mirror)}`)
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
// 镜像源切换（引擎驱动: 引擎与镜像表下沉在 tool-config/mirror-registry，
// 命令层只保留文案; 快照保护/恢复/清理由引擎单点实现）
// ---------------------------------------------------------------------------

/** 冲突提示：镜像国内直连可达，配合代理使用是双重跳转 */
async function warnProxyConflict () {
  const r = await adapters.npm.read()
  const proxy = r.ok ? r.values.http : null
  if (proxy) {
    console.log(`ℹ️  当前 npm 配置了代理 (${proxy})，镜像源无需配合代理使用，`)
    console.log('   同时使用会双重跳转反而可能变慢，建议 dss npm off 后仅用镜像')
  }
}

async function mirror (args) {
  const action = args[0]
  if (!action || action === 'status') return mirrorStatus()
  if (action === 'off') return mirrorOff()

  const r = await mirrorEngine.switch(action)
  if (!r.ok) {
    if (r.error === 'unknown-mirror') {
      console.error(`未知镜像: ${action}`)
      console.error(`可选: ${r.available.join(' / ')}, off(恢复), status(查看)`)
    } else {
      console.error(`❌ ${r.error}`)
    }
    process.exit(1)
  }
  if (!r.changed) {
    console.log(`npm 源已经是 ${r.entryName} (${r.to})`)
    return
  }
  console.log(`✅ npm 源已切换: ${r.entryName}`)
  console.log(`   ${r.from || '(未设置)'}  →  ${r.to}`)
  await warnProxyConflict()
  console.log('')
  console.log('⚠️  注意: 镜像为只读，发布 npm 包时需临时指定官方源:')
  console.log(`   npm publish --registry ${NPM_OFFICIAL}`)
  console.log('   （新发布的包约 10 分钟后才会同步到镜像）')
  console.log('恢复: dss npm mirror off')
}

async function mirrorOff () {
  const r = await mirrorEngine.off()
  if (!r.ok) {
    console.error(`❌ 恢复 npm 源失败: ${r.error}`)
    process.exit(1)
  }
  console.log(`✅ npm 源已恢复: ${r.target || NPM_OFFICIAL}${r.target ? '（来自切换前快照）' : ''}`)
}

async function mirrorStatus () {
  const r = await mirrorEngine.status()
  console.log('npm 镜像源:')
  console.log(`  当前: ${r.current || '(未设置)'}`)
  if (r.known) console.log(`        (${r.known})`)
  if (r.saved) console.log(`  切换前原值: ${r.saved}（dss npm mirror off 可恢复）`)
  console.log('')
  console.log('可用镜像:')
  for (const [key, m] of Object.entries(NPM_MIRRORS)) {
    console.log(`  ${key.padEnd(12)} ${m.name}  ${m.url}`)
  }
  console.log(`  ${'npm'.padEnd(12)} 官方源  ${NPM_OFFICIAL}（off 未有快照时恢复到它）`)
}

module.exports = { run, help }
