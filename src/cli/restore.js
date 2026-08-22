// dss restore — 独立的配置恢复命令（不动进程）
//
// 覆盖崩溃场景：进程被 kill -9 / OOM / 机器重启后走不到 dss stop 的
// 清理逻辑，但 npm/git 配置里的死地址还在。本命令只做智能恢复，
// 幂等（重复执行无副作用），工具缺失时跳过而非报错。
const { resolveProxyAddress } = require('./utils')
const { smartRestore } = require('./restore-config')

async function run () {
  const addr = resolveProxyAddress()
  await smartRestore(addr, { verbose: true })
  console.log('')
  console.log('提示: 若使用过 dss env on，请执行以下命令取消 shell 环境变量:')
  console.log('  eval "$(dss env off)"    # bash / zsh')
  console.log('  dss env off | iex        # PowerShell')
}

function help () {
  console.log('用法: dss restore')
  console.log('')
  console.log('恢复 npm/git 中指向本代理的配置（不停止进程）：')
  console.log('  - 只清理 dss 设置的值（快照 + 地址匹配），其他代理配置不受影响')
  console.log('  - 适用于代理崩溃/被强杀后配置残留的扫尾')
  console.log('  - 幂等，可重复执行')
  console.log('')
  console.log('示例:')
  console.log('  dss restore')
}

module.exports = { run, help }
