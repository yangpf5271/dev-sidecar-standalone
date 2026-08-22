// dss start — 后台启动代理（守护进程）
//
// 与旧 -d 的区别：PID 文件 + 日志文件 + 单实例保护 + 启动失败可感知。
// PID 文件由子进程在 listen 成功后自己写入（避免父进程盲写导致
// "打印成功但子进程随即崩溃"的竞态），父进程监听子进程早退。
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const {
  resolveProxyAddress,
  resolveCertPaths,
  probePort,
  readPidFile,
  removePidFile,
  writePidFile,
  verifyProcessIdentity,
  isProcessAlive,
  logFilePath,
} = require('./utils')

const START_TIMEOUT_MS = 20000
const EARLY_EXIT_WAIT_MS = 1500

/**
 * 后台启动守护进程。`dss start` 和 `dss -d` 共用此入口。
 * @param {string[]} args 传给代理的参数（-c 等；不含 start/-d 自身）
 */
async function startDaemon (args) {
  const addr = resolveProxyAddress(args)

  // 单实例检查：PID 文件存活 → 已在运行；进程已死 → 清理残留
  const savedPid = readPidFile()
  if (savedPid != null) {
    if (isProcessAlive(savedPid) && await verifyProcessIdentity(savedPid)) {
      console.log(`✅ 代理已在运行 (PID: ${savedPid})`)
      console.log('   停止: dss stop   重启: dss restart')
      return savedPid
    }
    removePidFile() // 残留的过期 PID 文件
  }

  // 端口预检：被占用（可能是前台实例或其他进程）时直接拒绝，
  // 避免子进程 EADDRINUSE 后僵死（server error 不走 start promise rejection）
  const [httpUp, mitmUp] = await Promise.all([
    probePort(addr.host, addr.httpPort),
    probePort(addr.host, addr.mitmPort),
  ])
  if (httpUp || mitmUp) {
    console.error(`❌ 端口 ${httpUp ? addr.httpPort : addr.mitmPort} 已被占用`)
    console.error('   可能是前台实例或其他进程。运行 dss status 查看，或更换 PORT。')
    process.exit(1)
  }

  // 日志文件（跟随 DEV_SIDECAR_HOME）
  const logPath = logFilePath()
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const fd = fs.openSync(logPath, 'a')

  const cleanArgs = args.filter((a) => a !== '-d' && a !== '--daemon' && a !== '--keep-config')
  let child
  try {
    child = spawn(process.execPath, [path.join(__dirname, '../../index.js'), ...cleanArgs], {
      cwd: process.cwd(),
      stdio: ['ignore', fd, fd], // 子进程持有 fd 副本，父进程关闭不影响
      detached: true,
      env: { ...process.env, DSS_DAEMON: '1' },
    })
  } catch (e) {
    fs.closeSync(fd)
    console.error(`❌ 启动失败: ${e.message}`)
    process.exit(1)
  }
  fs.closeSync(fd)
  child.unref()

  if (!Number.isInteger(child.pid)) {
    console.error('❌ 启动失败: 未获取到子进程 PID')
    process.exit(1)
  }

  const pid = child.pid

  // 等待启动结果：子进程早退（配置错/证书问题）→ 报错并展示日志尾部；
  // PID 文件出现（子进程 listen 成功后写入）→ 成功；端口就绪 → 成功兜底
  const result = await new Promise((resolve) => {
    let settled = false
    const finish = (v) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    child.on('error', (e) => finish({ fail: `spawn 失败: ${e.message}` }))
    child.on('exit', (code) => finish({ fail: `子进程已退出 (code: ${code})` }))

    const deadline = Date.now() + START_TIMEOUT_MS
    const poll = async () => {
      if (settled) return
      if (Date.now() > deadline) {
        finish({ fail: `启动超时 (${START_TIMEOUT_MS / 1000}s)` })
        return
      }
      const current = readPidFile()
      if (current === pid) {
        finish({ ok: true })
        return
      }
      if (await probePort(addr.host, addr.httpPort, 800)) {
        writePidFile(pid) // 子进程可能未写（如旧版本代码），父进程补写
        finish({ ok: true })
        return
      }
      setTimeout(poll, 400)
    }
    poll()
  })

  if (result.fail) {
    console.error(`❌ 后台启动失败: ${result.fail}`)
    printLogTail(logPath)
    removePidFile()
    process.exit(1)
  }

  // 保持与旧版一致的输出字面量，兼容用户脚本解析
  console.log(`✅ Daemon PID: ${pid}`)
  console.log(`日志: ${logPath}`)
  console.log('停止: dss stop   状态: dss status   日志: dss log')
  return pid
}

function printLogTail (logPath, lines = 20) {
  try {
    const content = fs.readFileSync(logPath, 'utf8').trim()
    if (!content) return
    const tail = content.split('\n').slice(-lines).join('\n')
    console.error(`--- 日志尾部 (${logPath}) ---`)
    console.error(tail)
  } catch {
    // 无日志
  }
}

async function run (args) {
  await startDaemon(args)
}

function help () {
  console.log('用法: dss start [-c <配置文件>]')
  console.log('')
  console.log('后台启动代理（守护进程）：')
  console.log('  - PID 文件: ~/.dev-sidecar/dev-sidecar.pid（跟随 DEV_SIDECAR_HOME）')
  console.log('  - 日志文件: ~/.dev-sidecar/logs/dev-sidecar.log（dss log 查看）')
  console.log('  - 单实例保护：已在运行/端口被占用时拒绝启动')
  console.log('')
  console.log('示例:')
  console.log('  dss start')
  console.log('  dss start -c ./my-config.json')
  console.log('  PORT=8080 dss start')
}

module.exports = { run, help, startDaemon }
