// dss env on|off — 输出 shell 代理环境变量语句（配合 eval 使用）
//
// 子进程无法直接修改父 shell 的环境变量，因此本命令只输出语句，
// 由用户 eval/执行生效（nvm、rbenv 等工具的标准做法）。
// stdout 保持单一 shell 格式以保证 eval 可用，提示信息走 stderr。
const { resolveProxyAddress, probePort } = require('./utils')

const SHELLS = ['bash', 'powershell', 'cmd']

function detectShell () {
  if (process.env.DSS_SHELL && SHELLS.includes(process.env.DSS_SHELL)) {
    return process.env.DSS_SHELL
  }
  if (process.platform === 'win32') {
    return 'powershell'
  }
  return 'bash'
}

function parseShellFlag (args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--shell' || args[i] === '-s') {
      const v = args[++i]
      if (!SHELLS.includes(v)) {
        console.error(`不支持的 shell: ${v}（可选: ${SHELLS.join(' / ')}）`)
        process.exit(1)
      }
      return v
    }
    if (args[i].startsWith('--shell=')) {
      const v = args[i].slice('--shell='.length)
      if (!SHELLS.includes(v)) {
        console.error(`不支持的 shell: ${v}（可选: ${SHELLS.join(' / ')}）`)
        process.exit(1)
      }
      return v
    }
  }
  return null
}

async function run (args) {
  const action = args[0]
  if (action !== 'on' && action !== 'off') {
    help()
    process.exit(action ? 1 : 0)
  }

  const shell = parseShellFlag(args) || detectShell()
  const addr = resolveProxyAddress(args)

  if (action === 'on') {
    const httpUp = await probePort(addr.host, addr.httpPort)
    if (!httpUp) {
      console.error(`⚠️  代理似乎未在运行 (${addr.host}:${addr.httpPort} 未监听)，建议先运行: dss`)
    }
    if (!addr.isDefaultPort) {
      console.error(`ℹ️  使用非默认端口 (来自${addr.configPath ? '配置文件' : 'PORT 环境变量'})`)
    }
  }

  const lines = action === 'on' ? buildOn(addr, shell) : buildOff(shell)
  for (const line of lines) {
    console.log(line)
  }

  // 用法提示走 stderr，不污染 eval 的 stdout
  if (action === 'on') {
    console.error('')
    console.error('# 生效方式:')
    if (shell === 'bash') {
      console.error('#   eval "$(dss env on)"')
    } else if (shell === 'powershell') {
      console.error('#   dss env on | iex    （PowerShell）')
      console.error('#   或直接复制上面的语句执行')
    } else {
      console.error('#   直接复制上面的 set 语句到 cmd 窗口执行（仅当前窗口会话有效）')
    }
    console.error('# 取消代理: dss env off（同样需要 eval / iex 生效）')
  }
}

function buildOn (addr, shell) {
  const http = `http://${addr.host}:${addr.httpPort}`
  const mitm = `http://${addr.host}:${addr.mitmPort}`
  if (shell === 'bash') {
    return [
      `export HTTP_PROXY=${http}`,
      `export HTTPS_PROXY=${mitm}`,
      `export NO_PROXY=localhost,127.0.0.1`,
      `export http_proxy=${http}`,
      `export https_proxy=${mitm}`,
      `export no_proxy=localhost,127.0.0.1`,
    ]
  }
  if (shell === 'powershell') {
    return [
      `$env:HTTP_PROXY='${http}'`,
      `$env:HTTPS_PROXY='${mitm}'`,
      `$env:NO_PROXY='localhost,127.0.0.1'`,
    ]
  }
  // cmd
  return [
    `set HTTP_PROXY=${http}`,
    `set HTTPS_PROXY=${mitm}`,
    `set NO_PROXY=localhost,127.0.0.1`,
  ]
}

function buildOff (shell) {
  if (shell === 'bash') {
    return [
      'unset HTTP_PROXY',
      'unset HTTPS_PROXY',
      'unset NO_PROXY',
      'unset http_proxy',
      'unset https_proxy',
      'unset no_proxy',
    ]
  }
  if (shell === 'powershell') {
    return [
      "Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue",
      "Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue",
      "Remove-Item Env:NO_PROXY -ErrorAction SilentlyContinue",
    ]
  }
  // cmd（set 空值即为删除）
  return [
    'set HTTP_PROXY=',
    'set HTTPS_PROXY=',
    'set NO_PROXY=',
  ]
}

function help () {
  console.log('用法: dss env <on|off> [--shell bash|powershell|cmd]')
  console.log('')
  console.log('输出当前 shell 的代理环境变量语句，需要配合 eval 执行才能生效')
  console.log('（子进程无法直接修改父 shell 的环境变量）')
  console.log('')
  console.log('  on   输出设置代理的语句')
  console.log('  off  输出取消代理的语句')
  console.log('')
  console.log('shell 选择: 默认按平台自动检测（Windows → PowerShell，其他 → bash），')
  console.log('可用 --shell 覆盖，或设置 DSS_SHELL 环境变量')
  console.log('')
  console.log('示例:')
  console.log('  eval "$(dss env on)"          # bash / zsh')
  console.log('  dss env on | iex              # PowerShell')
  console.log('  eval "$(dss env off)"         # bash 取消代理')
  console.log('  dss env on --shell cmd        # 输出 cmd 格式')
}

module.exports = { run, help }
