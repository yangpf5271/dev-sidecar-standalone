// 子进程执行与端口探测 — 命令层共享的运行时封装
const { spawn } = require('node:child_process')

const IS_WIN = process.platform === 'win32'

/**
 * 执行子进程命令并等待完成
 *
 * npm 在 Windows 上是 npm.cmd，必须 shell: true（Node 18.20+ 安全限制），
 * 此时含空格的路径参数需要手工加引号；
 * git 是真实可执行文件，不用 shell，args 数组天然处理空格。
 */
function runCommand (cmd, args, { shell = false } = {}) {
  return new Promise((resolve) => {
    const finalArgs = shell
      ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) // shell 模式下引号包裹含空格参数
      : args
    const child = spawn(cmd, finalArgs, { shell, stdio: 'pipe' })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (e) => resolve({ ok: false, error: e.message, stdout, stderr }))
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

/** 探测端口是否有服务在监听（TCP 层连接，不发送 HTTP 请求） */
function probePort (host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const net = require('node:net')
    const socket = net.createConnection({ host, port })
    const done = (result) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeout, () => done(false))
    socket.on('connect', () => done(true))
    socket.on('error', () => done(false))
  })
}

/**
 * "代理未运行"警告 + 非默认端口提示（npm/git/env 等命令 on 前的共享提示，仅提示不阻断）
 */
async function warnIfProxyDown (addr, toolLabel) {
  const httpUp = await probePort(addr.host, addr.httpPort)
  if (!httpUp) {
    console.log(`⚠️  代理似乎未在运行 (${addr.host}:${addr.httpPort} 未监听)`)
    console.log(`   如果代理未启动，${toolLabel} 将无法联网。建议先运行: dss`)
    console.log('')
  }
  if (!addr.isDefaultPort) {
    console.log(`ℹ️  使用非默认端口 (来自${addr.configPath ? '配置文件' : 'PORT 环境变量'})，`)
    console.log('   请确认代理启动时使用了相同的配置')
    console.log('')
  }
}

module.exports = { IS_WIN, runCommand, probePort, warnIfProxyDown }
