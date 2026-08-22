// dss log — 查看守护进程日志（tail 风格，-f 跟随）
const fs = require('node:fs')
const { logFilePath } = require('./utils')

function readTail (filePath, lines) {
  const content = fs.readFileSync(filePath, 'utf8')
  const arr = content.split('\n')
  if (arr.length > lines) {
    return arr.slice(-lines).join('\n')
  }
  return content
}

async function run (args) {
  let lines = 50
  let follow = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-f' || args[i] === '--follow') {
      follow = true
    } else if (args[i] === '-n' || args[i] === '--lines') {
      lines = parseInt(args[++i], 10) || 50
    }
  }

  const logPath = logFilePath()
  if (!fs.existsSync(logPath)) {
    console.log('暂无日志文件（守护进程从未启动过）。')
    console.log('提示: dss start 后台启动并记录日志到该文件。')
    return
  }

  if (!follow) {
    const stat = fs.statSync(logPath)
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
    console.log(`--- ${logPath} (${sizeMB} MB, 最后 ${lines} 行) ---`)
    console.log(readTail(logPath, lines))
    if (stat.size > 10 * 1024 * 1024) {
      console.log('')
      console.log(`⚠️  日志文件已达 ${sizeMB} MB，建议定期清理或轮转（可直接删除，守护进程会重新创建）`)
    }
    return
  }

  // 跟随模式：轮询文件增量
  console.log(`--- 跟随 ${logPath} (Ctrl+C 退出) ---`)
  let lastSize = fs.statSync(logPath).size
  process.stdout.write(readTail(logPath, lines) + '\n')
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      const stat = fs.statSync(logPath)
      if (stat.size > lastSize) {
        const fd = fs.openSync(logPath, 'r')
        const buf = Buffer.alloc(stat.size - lastSize)
        fs.readSync(fd, buf, 0, buf.length, lastSize)
        fs.closeSync(fd)
        process.stdout.write(buf.toString())
        lastSize = stat.size
      } else if (stat.size < lastSize) {
        // 文件被截断/轮转，重新定位
        lastSize = 0
      }
    } catch {
      // 文件被删除等，退出跟随
      console.log('日志文件已不可用，退出跟随')
      return
    }
  }
}

function help () {
  console.log('用法: dss log [-f] [-n <行数>]')
  console.log('')
  console.log('查看守护进程日志（~/.dev-sidecar/logs/dev-sidecar.log）')
  console.log('')
  console.log('  -f, --follow   持续跟随新输出（类似 tail -f，Ctrl+C 退出）')
  console.log('  -n, --lines N  显示最后 N 行（默认 50）')
  console.log('')
  console.log('示例:')
  console.log('  dss log')
  console.log('  dss log -n 200')
  console.log('  dss log -f')
}

module.exports = { run, help }
