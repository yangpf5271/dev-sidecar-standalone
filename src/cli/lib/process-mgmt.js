// 进程管理 — PID 文件 / 存活探测 / 身份验证(防 PID 复用误杀) / 端口反查 / 终止
const fs = require('node:fs')
const { pidFilePath, ensureUserBasePath } = require('./paths')
const { IS_WIN, runCommand } = require('./exec')

function readPidFile () {
  try {
    return parseInt(fs.readFileSync(pidFilePath(), 'utf8').trim(), 10) || null
  } catch {
    return null
  }
}

function writePidFile (pid) {
  ensureUserBasePath()
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

/** 进程命令行/comm 文本是否为本代理（verifyProcessIdentity 各平台共用的判定核心） */
function identityTextMatches (text) {
  return !!text && (text.includes('dev-sidecar-standalone') || text.includes('index.js'))
}

// 端口反查的平台输出解析 — 纯函数（文本, 端口）→ PID 列表, 可单测

/** PowerShell Get-NetTCPConnection OwningProcess 输出（每行一个 PID） */
function parsePowerShellPortPids (text) {
  const pids = []
  for (const line of String(text).split('\n')) {
    const n = parseInt(line.trim(), 10)
    if (Number.isInteger(n)) pids.push(n)
  }
  return pids
}

/** netstat -ano：锚定 TCP 行的本地地址列，不依赖本地化的状态文本。
 *  -ano 含所有状态且无法过滤，同端口的非监听行(如 ESTABLISHED)同样计入 — 命名如实反映 */
function parseNetstatLocalPortPids (text, port) {
  const pids = []
  for (const line of String(text).split('\n')) {
    const tokens = line.trim().split(/\s+/)
    if (!/^TCP/i.test(tokens[0])) continue
    const local = tokens[1] || ''
    if (local.endsWith(`:${port}`)) {
      const pid = parseInt(tokens[tokens.length - 1], 10)
      if (Number.isInteger(pid)) pids.push(pid)
    }
  }
  return pids
}

/** ss -tlnp：本地地址列（含 IPv6 的 ]:port 形式）匹配后提取行内 pid=N */
function parseSsListenPids (text, port) {
  const pids = []
  for (const line of String(text).split('\n')) {
    const tokens = line.trim().split(/\s+/)
    const local = tokens[3] || ''
    if (local.endsWith(`:${port}`) || local.endsWith(`]:${port}`)) {
      for (const m of line.matchAll(/pid=(\d+)/g)) pids.push(parseInt(m[1], 10))
    }
  }
  return pids
}

/** lsof -t 输出（每行一个 PID） */
function parseLsofPids (text) {
  const pids = []
  for (const line of String(text).split('\n')) {
    const n = parseInt(line.trim(), 10)
    if (Number.isInteger(n)) pids.push(n)
  }
  return pids
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
      return identityTextMatches(cmd)
    }
    if (process.platform === 'win32') {
      const r = await runCommand('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`])
      return r.ok && identityTextMatches(r.stdout)
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
  try {
    if (process.platform === 'win32') {
      const r = await runCommand('powershell', ['-NoProfile', '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`])
      if (r.ok && r.stdout) {
        for (const n of parsePowerShellPortPids(r.stdout)) pids.add(n)
      }
      if (pids.size === 0) {
        // 回退：解析 TCP 行的本地地址列（不依赖本地化的状态文本）
        const ns = await runCommand('netstat', ['-ano'])
        if (ns.ok) {
          for (const n of parseNetstatLocalPortPids(ns.stdout, port)) pids.add(n)
        }
      }
    } else if (process.platform === 'linux') {
      const ss = await runCommand('ss', ['-tlnp'])
      if (ss.ok) {
        for (const n of parseSsListenPids(ss.stdout, port)) pids.add(n)
      }
      if (pids.size === 0) {
        const lsof = await runCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
        if (lsof.ok && lsof.stdout) {
          for (const n of parseLsofPids(lsof.stdout)) pids.add(n)
        }
      }
    } else {
      // macOS
      const lsof = await runCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
      if (lsof.ok && lsof.stdout) {
        for (const n of parseLsofPids(lsof.stdout)) pids.add(n)
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

module.exports = {
  readPidFile,
  writePidFile,
  removePidFile,
  isProcessAlive,
  waitForExit,
  identityTextMatches,
  verifyProcessIdentity,
  parsePowerShellPortPids,
  parseNetstatLocalPortPids,
  parseSsListenPids,
  parseLsofPids,
  findPidsByPort,
  terminateProcess,
}
