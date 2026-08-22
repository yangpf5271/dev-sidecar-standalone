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

// ---------------------------------------------------------------------------
// 进程管理：PID 文件 / 日志路径 / 进程身份验证 / 端口反查
// 所有路径跟随 DEV_SIDECAR_HOME（与证书目录一致）
// ---------------------------------------------------------------------------

/** 守护进程 PID 文件路径 */
function pidFilePath () {
  return path.join(resolveCertPaths().userBasePath, 'dev-sidecar.pid')
}

/** 守护进程日志文件路径 */
function logFilePath () {
  return path.join(resolveCertPaths().userBasePath, 'logs', 'dev-sidecar.log')
}

function readPidFile () {
  try {
    return parseInt(fs.readFileSync(pidFilePath(), 'utf8').trim(), 10) || null
  } catch {
    return null
  }
}

function writePidFile (pid) {
  const base = resolveCertPaths().userBasePath
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true })
  }
  fs.writeFileSync(pidFilePath(), String(pid), 'utf8')
}

function removePidFile () {
  try {
    fs.unlinkSync(pidFilePath())
  } catch {
    // 文件不存在属正常
  }
}

/** 进程是否存活（signal 0 探测，不发送真实信号） */
function isProcessAlive (pid) {
  if (!Number.isInteger(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM' // 无权限查看但进程存在（Linux 跨用户）
  }
}

/** 轮询等待进程退出，超时返回 false */
async function waitForExit (pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return !isProcessAlive(pid)
}

/**
 * 验证 PID 对应的进程是否为本代理（防 PID 复用误杀）
 *
 * Linux: process.title 会覆写 /proc/<pid>/cmdline，显示为 dev-sidecar-standalone
 * Windows: detached 子进程无控制台，tasklist 看不到标题；用 CIM 查 CommandLine
 *          （不能再用 wmic，Win11 24H2+ 已移除）
 * macOS: process.title 走 setprogname，ps -o comm= 生效
 */
async function verifyProcessIdentity (pid) {
  if (!Number.isInteger(pid) || !isProcessAlive(pid)) return false
  try {
    if (process.platform === 'linux') {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      return cmd.includes('dev-sidecar-standalone') || cmd.includes('index.js')
    }
    if (process.platform === 'win32') {
      const r = await runCommand('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`])
      return r.ok && !!r.stdout && (r.stdout.includes('dev-sidecar-standalone') || r.stdout.includes('index.js'))
    }
    // macOS / 其他 Unix
    const r = await runCommand('ps', ['-p', String(pid), '-o', 'comm='])
    return r.ok && /dev-sidecar/i.test(r.stdout)
  } catch {
    return false
  }
}

/**
 * 端口反查监听进程 PID（PID 文件丢失时的兜底）
 *
 * Windows 优先 Get-NetTCPConnection（结构化输出，免疫系统本地化），
 * 回退 netstat -ano——解析不依赖状态列（状态文本是本地化的），只锚定本地地址列;
 * Linux: ss -tlnp（-p 对自己的进程无需 root），回退 lsof;
 * macOS: lsof。端点归一化覆盖 IPv6（[::]:port / *:port）。
 */
async function findPidsByPort (port) {
  const pids = new Set()
  const addFromText = (text) => {
    for (const m of text.matchAll(/pid=(\d+)/g)) {
      pids.add(parseInt(m[1], 10))
    }
  }
  try {
    if (process.platform === 'win32') {
      const r = await runCommand('powershell', ['-NoProfile', '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`])
      if (r.ok && r.stdout) {
        for (const line of r.stdout.split('\n')) {
          const n = parseInt(line.trim(), 10)
          if (Number.isInteger(n)) pids.add(n)
        }
      }
      if (pids.size === 0) {
        // 回退：解析 TCP 行的本地地址列（不依赖本地化的状态文本）
        const ns = await runCommand('netstat', ['-ano'])
        if (ns.ok) {
          for (const line of ns.stdout.split('\n')) {
            const tokens = line.trim().split(/\s+/)
            if (!/^TCP/i.test(tokens[0])) continue
            const local = tokens[1] || ''
            if (local.endsWith(`:${port}`)) {
              const pid = parseInt(tokens[tokens.length - 1], 10)
              if (Number.isInteger(pid)) pids.add(pid)
            }
          }
        }
      }
    } else if (process.platform === 'linux') {
      const ss = await runCommand('ss', ['-tlnp'])
      if (ss.ok) {
        for (const line of ss.stdout.split('\n')) {
          const tokens = line.trim().split(/\s+/)
          const local = tokens[3] || ''
          if (local.endsWith(`:${port}`) || local.endsWith(`]:${port}`)) addFromText(line)
        }
      }
      if (pids.size === 0) {
        const lsof = await runCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
        if (lsof.ok && lsof.stdout) {
          for (const line of lsof.stdout.split('\n')) {
            const n = parseInt(line.trim(), 10)
            if (Number.isInteger(n)) pids.add(n)
          }
        }
      }
    } else {
      // macOS
      const lsof = await runCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
      if (lsof.ok && lsof.stdout) {
        for (const line of lsof.stdout.split('\n')) {
          const n = parseInt(line.trim(), 10)
          if (Number.isInteger(n)) pids.add(n)
        }
      }
    }
  } catch {
    // 反查失败返回空，由调用方处理
  }
  return [...pids]
}

/**
 * 终止进程：POSIX 先 SIGTERM 优雅（handler 会走加固后的 api.close），
 * 超时 SIGKILL；Windows 无优雅信号语义（SIGTERM 即强杀），直接终止后确认。
 */
async function terminateProcess (pid, { graceMs = 5000 } = {}) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch (e) {
    return e.code === 'ESRCH' // 已退出视为成功
  }
  if (await waitForExit(pid, IS_WIN ? 3000 : graceMs)) return true
  if (!IS_WIN) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已退出
    }
    return await waitForExit(pid, 3000)
  }
  return false
}

// ---------------------------------------------------------------------------
// 配置快照：npm on / git on 写入实际配置值，stop/restore 优先消费，
// 解决「非默认端口 on、默认端口 stop」时的地址漂移匹配不上问题
// ---------------------------------------------------------------------------

function snapshotFilePath () {
  return path.join(resolveCertPaths().userBasePath, 'last-applied.json')
}

function readSnapshot () {
  try {
    return JSON.parse(fs.readFileSync(snapshotFilePath(), 'utf8')) || {}
  } catch {
    return {}
  }
}

function writeSnapshotFile (obj) {
  const file = snapshotFilePath()
  if (Object.keys(obj).length === 0) {
    try {
      fs.unlinkSync(file)
    } catch {
      // 不存在属正常
    }
    return
  }
  const base = resolveCertPaths().userBasePath
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true })
  }
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
}

/** 记录某个工具（npm/git）本次 on 实际写入的配置值 */
function updateSnapshot (tool, entries) {
  const snap = readSnapshot()
  snap[tool] = entries
  writeSnapshotFile(snap)
}

/** 清除某个工具的快照段（对应 off 后调用） */
function clearSnapshotSection (tool) {
  const snap = readSnapshot()
  if (snap[tool] == null) return
  delete snap[tool]
  writeSnapshotFile(snap)
}

function snapshotFilePathForCheck () {
  return snapshotFilePath()
}

module.exports = {
  IS_WIN,
  resolveProxyAddress,
  resolveCertPaths,
  runCommand,
  probePort,
  // 进程管理
  pidFilePath,
  logFilePath,
  readPidFile,
  writePidFile,
  removePidFile,
  isProcessAlive,
  waitForExit,
  verifyProcessIdentity,
  findPidsByPort,
  terminateProcess,
  // 配置快照
  readSnapshot,
  updateSnapshot,
  clearSnapshotSection,
  snapshotFilePath: snapshotFilePathForCheck,
}
