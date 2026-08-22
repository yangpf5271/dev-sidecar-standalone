// dss npm on|off — 配置/取消 npm 代理
const { resolveProxyAddress, resolveCertPaths, runCommand, probePort, updateSnapshot, clearSnapshotSection } = require('./utils')

async function run (args) {
  const action = args[0]
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
  console.log('用法: dss npm <on|off|status> [--mitm]')
  console.log('')
  console.log('  on        配置 npm 走代理（简单模式：proxy/https-proxy 均指向 HTTP 端口）')
  console.log('  on --mitm MITM 加速模式（https-proxy 指向 MITM 端口并配置 CA 证书，')
  console.log('            需先启动代理生成证书并安装到系统信任列表）')
  console.log('  off       清除 npm 代理配置（proxy / https-proxy / cafile）')
  console.log('  status    查看当前 npm 相关配置')
  console.log('')
  console.log('示例:')
  console.log('  dss npm on')
  console.log('  dss npm on --mitm')
  console.log('  dss npm off')
}

module.exports = { run, help }
