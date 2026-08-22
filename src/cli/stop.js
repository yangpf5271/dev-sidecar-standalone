// dss stop — 停止代理并恢复代理配置
//
// 终止流程：
//   1. PID 文件 → 身份验证（防 PID 复用误杀）
//   2. 文件缺失/不匹配 → 端口反查 → 同样必须过身份验证
//   3. POSIX: SIGTERM（优雅，handler 走加固后的 api.close）→ 超时 SIGKILL
//      Windows: 无优雅信号语义，直接终止后确认
//
// 停止后默认智能恢复 npm/git/docker build 层中指向本代理的配置（--keep-config 跳过），
// 避免代理停止后各工具指向死端口影响日常使用。
const {
  resolveProxyAddress,
  readPidFile,
  removePidFile,
  isProcessAlive,
  verifyProcessIdentity,
  findPidsByPort,
  terminateProcess,
} = require('./utils')
const { smartRestore } = require('./restore-config')

/**
 * 停止守护进程（不处理配置恢复）。restart 复用此函数。
 * 返回 true 表示「已停止或本来就没运行」。
 */
async function stopDaemon (args) {
  const addr = resolveProxyAddress(args)

  let pid = null

  // 途径一：PID 文件
  const savedPid = readPidFile()
  if (savedPid != null) {
    if (isProcessAlive(savedPid)) {
      if (await verifyProcessIdentity(savedPid)) {
        pid = savedPid
      } else {
        console.log(`⚠️  PID 文件指向的进程 (${savedPid}) 不是 dss，忽略该文件`)
      }
    }
    if (pid == null) {
      removePidFile() // 过期残留
    }
  }

  // 途径二：端口反查（PID 文件丢失时的兜底；也可停掉手动前台实例）
  if (pid == null) {
    const [p1, p2] = await Promise.all([
      findPidsByPort(addr.httpPort),
      findPidsByPort(addr.mitmPort),
    ])
    const candidates = [...new Set([...p1, ...p2])]
    for (const p of candidates) {
      if (await verifyProcessIdentity(p)) {
        pid = p
        break
      }
    }
    if (pid == null && candidates.length > 0) {
      console.log(`⚠️  端口 ${addr.httpPort}/${addr.mitmPort} 被非 dss 进程占用，不执行终止`)
    }
  }

  if (pid != null) {
    console.log(`正在停止 dss 代理 (PID: ${pid})...`)
    const ok = await terminateProcess(pid)
    if (!ok) {
      console.error(`❌ 进程 ${pid} 终止失败，请手工处理`)
      return false
    }
    console.log('✅ 代理已停止')
    if (readPidFile() === pid) {
      removePidFile()
    }
  } else {
    console.log('代理未在运行')
  }
  return true
}

async function run (args) {
  const keepConfig = args.includes('--keep-config')
  const addr = resolveProxyAddress(args)

  const stopped = await stopDaemon(args)
  if (!stopped) {
    process.exit(1)
  }

  if (keepConfig) {
    console.log('已保留代理配置 (--keep-config)')
    return
  }

  console.log('')
  await smartRestore(addr, { verbose: true })

  // shell 环境变量无法从子进程恢复，只能提示
  console.log('')
  console.log('提示: 若使用过 dss env on，请执行以下命令取消 shell 环境变量:')
  console.log('  eval "$(dss env off)"    # bash / zsh')
  console.log('  dss env off | iex        # PowerShell')
}

function help () {
  console.log('用法: dss stop [--keep-config]')
  console.log('')
  console.log('停止代理进程，并默认恢复 npm/git/docker build 层中指向本代理的配置')
  console.log('（只清理 dss 设置的值，用户自己的其他代理配置不受影响）')
  console.log('')
  console.log('  --keep-config  仅停止进程，保留代理配置（临时重启场景用 dss restart）')
  console.log('')
  console.log('示例:')
  console.log('  dss stop')
  console.log('  dss stop --keep-config')
}

module.exports = { run, help, stopDaemon }
