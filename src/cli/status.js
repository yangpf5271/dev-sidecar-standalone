// dss status — 探测代理运行状态
const pkg = require('../../package.json')
const { resolveProxyAddress, resolveCertPaths, probePort } = require('./utils')

async function run (args) {
  const addr = resolveProxyAddress(args)
  const { certExists } = resolveCertPaths()

  const [httpUp, mitmUp] = await Promise.all([
    probePort(addr.host, addr.httpPort),
    probePort(addr.host, addr.mitmPort),
  ])

  const running = httpUp || mitmUp

  console.log(`dev-sidecar-standalone v${pkg.version}`)
  console.log('')
  if (running) {
    console.log(`  代理状态: ✅ 运行中`)
  } else {
    console.log(`  代理状态: ❌ 未运行`)
    if (!addr.isDefaultPort) {
      console.log(`  (探测端口 ${addr.httpPort}/${addr.mitmPort}，来自${addr.configPath ? '配置文件' : 'PORT 环境变量'}，`)
      console.log(`   请确认代理启动时使用了相同的配置)`)
    }
  }
  console.log(`  HTTP 代理:  ${addr.host}:${addr.httpPort}  ${httpUp ? '✅' : '—'}`)
  console.log(`  HTTPS 代理: ${addr.host}:${addr.mitmPort}  ${mitmUp ? '✅' : '—'}  (MITM)`)
  console.log(`  CA 证书:    ${certExists ? '✅ 已生成' : '❌ 未生成 (运行 dss cert 查看安装方法)'}`)

  if (!running) {
    console.log('')
    console.log('  启动代理: dss   (后台运行: dss -d)')
  }
}

function help () {
  console.log('用法: dss status [-c <配置文件>]')
  console.log('')
  console.log('探测代理端口，显示运行状态、监听地址和证书状态')
}

module.exports = { run, help }
