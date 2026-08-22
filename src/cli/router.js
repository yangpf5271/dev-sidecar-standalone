// dss 入口路由 — route(argv) 纯函数单点解析入口参数（spec: cli-routing）
//
// 判定顺序即不变量（design D4），从上到下：
//  ① argv[0] 是已知子命令 → subcommand（保证 dss npm -d 的 -d 是子命令参数而非 daemon 旗标）
//  ② help/version 旗标 → 优先于 daemon（dss -d -h 显示帮助，不启动守护进程）
//  ③ -d/--daemon → daemon（剥离旗标，其余参数转交子进程）
//  ④ -c/--config <v> | --config=<v>（文法统一）| 未知选项 | 位置参数 → error
//  ⑤ 其余 → run
const { isSubcommand, USAGE, subcommandNames } = require('./index')

const HELP_FLAGS = ['-h', '--help']
const VERSION_FLAGS = ['-v', '-V', '--version']
const DAEMON_FLAGS = ['-d', '--daemon']

/**
 * 解析入口参数，返回结构化决策：
 *   { kind: 'subcommand', name, args }
 *   { kind: 'help' } | { kind: 'version' }
 *   { kind: 'daemon', args }
 *   { kind: 'run', configPath }
 *   { kind: 'error', error: 'unknown-command'|'unknown-option'|'missing-config-value', arg? }
 * 纯函数：无副作用、不读环境、不 require 重模块。
 */
function route (argv) {
  if (isSubcommand(argv[0])) {
    return { kind: 'subcommand', name: argv[0], args: argv.slice(1) }
  }
  if (argv.some((a) => HELP_FLAGS.includes(a))) return { kind: 'help' }
  if (argv.some((a) => VERSION_FLAGS.includes(a))) return { kind: 'version' }
  if (argv.some((a) => DAEMON_FLAGS.includes(a))) {
    return { kind: 'daemon', args: argv.filter((a) => !DAEMON_FLAGS.includes(a)) }
  }

  let configPath = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-c' || arg === '--config') {
      const value = argv[++i]
      if (!value) return { kind: 'error', error: 'missing-config-value' }
      configPath = value
    } else if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length)
      if (!value) return { kind: 'error', error: 'missing-config-value' }
      configPath = value
    } else if (arg.startsWith('-')) {
      return { kind: 'error', error: 'unknown-option', arg }
    } else {
      return { kind: 'error', error: 'unknown-command', arg }
    }
  }
  return { kind: 'run', configPath }
}

/** 未知命令提示：非子命令的位置参数一律按敲错命令处理 */
function printUnknownCommand (arg) {
  console.error(`❌ 未知命令: ${arg}`)
  const suggestion = suggestSubcommand(arg)
  if (suggestion) {
    console.error(`   你是不是想输入: dss ${suggestion} ?`)
  }
  console.error('   指定配置文件请使用: dss -c <配置文件路径>')
  console.error('')
  console.error('可用命令:')
  console.error(USAGE.trimEnd())
  console.error('')
  console.error('完整选项说明: dss --help')
}

/** 编辑距离 ≤ 2 的子命令作为 "你是不是想输入" 建议 */
function suggestSubcommand (input) {
  let best = null
  let bestDist = 3
  for (const name of subcommandNames()) {
    const d = editDistance(input, name)
    if (d < bestDist) {
      best = name
      bestDist = d
    }
  }
  return best
}

function editDistance (a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[a.length][b.length]
}

module.exports = { route, printUnknownCommand, suggestSubcommand, editDistance }
