// dss restart — 重启代理（保留配置，不触发恢复逻辑）
const { stopDaemon } = require('./stop')
const { startDaemon } = require('./start')

async function run (args) {
  const cleanArgs = args.filter((a) => a !== '--keep-config')
  await stopDaemon(cleanArgs)
  await new Promise((r) => setTimeout(r, 1000)) // 等端口完全释放
  await startDaemon(cleanArgs)
}

function help () {
  console.log('用法: dss restart [-c <配置文件>]')
  console.log('')
  console.log('重启代理：内部使用 stop --keep-config + start，')
  console.log('重启过程不触发配置恢复（npm/git 代理配置保持不变）')
  console.log('')
  console.log('示例:')
  console.log('  dss restart')
}

module.exports = { run, help }
