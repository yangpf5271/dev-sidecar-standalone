// CLI 子命令公共工具：端口解析、证书路径、进程调用封装
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const IS_WIN = process.platform === 'win32'

/**
 * 从命令行参数和环境变量解析代理端口（不使用 index.js 的 loadConfig，避免副作用）
 *
 * 优先级：PORT 环境变量 > -c 指定配置文件的 server.port > 默认 31181
 * 返回 { host, mitmPort, httpPort, isDefaultPort, configPath }
 */
function resolveProxyAddress (args) {
  let configPath = null
  const argv = args || process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-c' || argv[i] === '--config') {
      configPath = argv[++i]
    } else if (argv[i].startsWith('--config=')) {
      configPath = argv[i].slice('--config='.length)
    }
  }

  let host = '127.0.0.1'
  let port = null
  if (configPath) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'))
      const server = cfg.server || cfg
      if (server.host) host = server.host
      if (server.port) port = server.port
    } catch (e) {
      console.error(`读取配置文件失败: ${configPath}, error: ${e.message}`)
      process.exit(1)
    }
  } else {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config/default.json'), 'utf8'))
      const server = cfg.server || cfg
      if (server.host) host = server.host
      if (server.port) port = server.port
    } catch {
      // 使用默认值
    }
  }

  if (process.env.PORT) {
    port = parseInt(process.env.PORT, 10)
  }
  if (process.env.HOST) {
    host = process.env.HOST
  }

  const mitmPort = port || 31181
  return {
    host,
    mitmPort,
    httpPort: mitmPort - 1,
    isDefaultPort: mitmPort === 31181,
    configPath,
  }
}

/**
 * CA 证书路径（与 index.js loadConfig 保持一致的逻辑）
 * 返回 { certPath, keyPath, certExists, userBasePath }
 */
function resolveCertPaths () {
  const userHome = process.env.DEV_SIDECAR_HOME || os.homedir()
  const userBasePath = path.resolve(userHome, '.dev-sidecar')
  const certPath = path.join(userBasePath, 'dev-sidecar.ca.crt')
  const keyPath = path.join(userBasePath, 'dev-sidecar.ca.key.pem')
  return {
    certPath,
    keyPath,
    certExists: fs.existsSync(certPath),
    userBasePath,
  }
}

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

module.exports = {
  IS_WIN,
  resolveProxyAddress,
  resolveCertPaths,
  runCommand,
  probePort,
}
