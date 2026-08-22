// dss status — 探测代理运行状态
const pkg = require('../../package.json')
const {
  resolveProxyAddress,
  resolveCertPaths,
  probePort,
  readPidFile,
  isProcessAlive,
  verifyProcessIdentity,
} = require('./utils')
const { detectResidue } = require('./restore-config')

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
    console.log('  代理状态: ✅ 运行中')
    // PID 展示（守护进程才有 PID 文件；前台实例无）
    const pid = readPidFile()
    if (pid != null && isProcessAlive(pid)) {
      console.log(`  进程 PID:  ${pid}${await verifyProcessIdentity(pid) ? '' : ' (⚠️ 身份未确认)'}`)
    }
  } else {
    console.log('  代理状态: ❌ 未运行')
    if (!addr.isDefaultPort) {
      console.log(`  (探测端口 ${addr.httpPort}/${addr.mitmPort}，来自${addr.configPath ? '配置文件' : 'PORT 环境变量'}，`)
      console.log('   请确认代理启动时使用了相同的配置)')
    }
  }
  console.log(`  HTTP 代理:  ${addr.host}:${addr.httpPort}  ${httpUp ? '✅' : '—'}`)
  console.log(`  HTTPS 代理: ${addr.host}:${addr.mitmPort}  ${mitmUp ? '✅' : '—'}  (MITM)`)
  console.log(`  CA 证书:    ${certExists ? '✅ 已生成' : '❌ 未生成 (运行 dss cert 查看安装方法)'}`)

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

function help () {
  console.log('用法: dss status [-c <配置文件>]')
  console.log('')
  console.log('探测代理端口，显示运行状态、监听地址、进程 PID、证书状态；')
  console.log('未运行时检测 npm/git 是否有指向本代理的残留配置')
}

module.exports = { run, help }
