// dss git on|off — 配置/取消 git 代理（全局配置）
const { resolveProxyAddress, resolveCertPaths, runCommand, probePort } = require('./utils')

async function run (args) {
  const action = args[0]
  if (action !== 'on' && action !== 'off' && action !== 'status') {
    help()
    process.exit(action ? 1 : 0)
  }

  // 探测 git 是否安装
  const gitCheck = await runCommand('git', ['--version'])
  if (!gitCheck.ok) {
    console.error('❌ 未检测到 git 命令，请先安装 git')
    process.exit(1)
  }

  if (action === 'status') return showStatus()
  if (action === 'on') return enable(args)
  return disable()
}

async function enable (args) {
  const addr = resolveProxyAddress(args)
  const simple = args.includes('--simple')

  // 探测代理是否在运行（仅提示，不阻断）
  const httpUp = await probePort(addr.host, addr.httpPort)
  if (!httpUp) {
    console.log(`⚠️  代理似乎未在运行 (${addr.host}:${addr.httpPort} 未监听)`)
    console.log('   如果代理未启动，git 将无法联网。建议先运行: dss')
    console.log('')
  }
  if (!addr.isDefaultPort) {
    console.log(`ℹ️  使用非默认端口 (来自${addr.configPath ? '配置文件' : 'PORT 环境变量'})，`)
    console.log('   请确认代理启动时使用了相同的配置')
    console.log('')
  }

  const tasks = [
    ['http.proxy', `http://${addr.host}:${addr.httpPort}`],
  ]

  if (simple) {
    // 简单模式只设 http.proxy，无需证书
  } else {
    tasks.push(['https.proxy', `http://${addr.host}:${addr.mitmPort}`])
    const { certPath, certExists } = resolveCertPaths()
    if (!certExists) {
      console.log('❌ CA 证书尚未生成，无法配置完整模式（https.proxy + sslCAInfo）')
      console.log('   请先启动一次代理 (dss) 自动生成证书，或使用 --simple 简单模式')
      process.exit(1)
    }
    tasks.push(['http.sslCAInfo', certPath])
  }

  for (const [key, value] of tasks) {
    const r = await runCommand('git', ['config', '--global', key, value])
    if (!r.ok) {
      console.error(`❌ git config --global ${key} 失败: ${r.error || r.stderr}`)
      process.exit(1)
    }
    console.log(`✅ git config --global ${key} ${value}`)
  }

  console.log('')
  console.log(simple ? 'git 已配置为简单代理模式（仅 HTTP 隧道，无需证书）' : 'git 已配置为完整加速模式（HTTPS MITM + CA 证书）')
  console.log('取消配置: dss git off')
}

async function disable () {
  const keys = ['http.proxy', 'https.proxy', 'http.sslCAInfo']
  for (const key of keys) {
    const r = await runCommand('git', ['config', '--global', '--unset', key])
    // unset 已不存在的 key 返回非 0，属正常情况
    if (!r.ok && r.code !== 5 && !/no such section/i.test(r.stderr)) {
      console.error(`❌ git config --unset ${key} 失败: ${r.error || r.stderr}`)
      process.exit(1)
    }
  }
  console.log('✅ git 代理配置已清除 (http.proxy / https.proxy / http.sslCAInfo)')
}

async function showStatus () {
  const keys = ['http.proxy', 'https.proxy', 'http.sslCAInfo']
  console.log('当前 git 全局代理配置:')
  for (const key of keys) {
    const r = await runCommand('git', ['config', '--global', '--get', key])
    const value = r.ok && r.stdout ? r.stdout : '(未设置)'
    console.log(`  ${key}: ${value}`)
  }
}

function help () {
  console.log('用法: dss git <on|off|status> [--simple]')
  console.log('')
  console.log('  on          配置 git 走代理（完整模式：http.proxy + https.proxy + CA 证书，')
  console.log('              需先启动代理生成证书并安装到系统信任列表）')
  console.log('  on --simple 简单模式（仅 http.proxy，HTTP 隧道，无需证书）')
  console.log('  off         清除 git 代理配置（http.proxy / https.proxy / http.sslCAInfo）')
  console.log('  status      查看当前 git 全局代理配置')
  console.log('')
  console.log('示例:')
  console.log('  dss git on')
  console.log('  dss git on --simple')
  console.log('  dss git off')
}

module.exports = { run, help }
