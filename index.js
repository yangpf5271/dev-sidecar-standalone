#!/usr/bin/env node
// dss 入口：route 单点解析（src/cli/router.js，spec: cli-routing）→ 按决策分发。
// 顺序不变量固化在 route 的判定顺序里；重模块（mitmproxy 等）只在 run 分支 require，
// 保证 -h/-v/子命令路径零副作用日志。
const path = require('node:path')
const fs = require('node:fs')
const { route, printUnknownCommand } = require('./src/cli/router')

;(async () => {
  const decision = route(process.argv.slice(2))

  if (decision.kind === 'subcommand') {
    const cli = require('./src/cli')
    try {
      await cli.dispatch(decision.name, decision.args)
    } catch (e) {
      console.error('❌ 子命令执行失败:', e.message)
      process.exit(1)
    }
    return
  }

  if (decision.kind === 'help') {
    printHelp()
    return
  }
  if (decision.kind === 'version') {
    console.log('v' + require('./package.json').version)
    return
  }
  if (decision.kind === 'daemon') {
    // 委派给 dss start 的实现（PID 文件 + 日志文件 + 启动校验）
    const startDaemon = require('./src/cli/start').startDaemon
    startDaemon(decision.args)
      .then(() => process.exit(0))
      .catch((e) => {
        console.error('❌ 后台启动失败:', e.message)
        process.exit(1)
      })
    return
  }
  if (decision.kind === 'error') {
    if (decision.error === 'unknown-command') {
      printUnknownCommand(decision.arg)
    } else if (decision.error === 'unknown-option') {
      console.error(`❌ 未知选项: ${decision.arg}`)
      console.error('   完整选项说明: dss --help')
    } else {
      console.error('❌ -c/--config 需要一个配置文件路径参数')
      console.error('   示例: dss -c ./config.json')
    }
    process.exit(1)
  }

  startup(decision.configPath)
})()

function printHelp () {
  console.log('用法: dss [选项] 或 dss <子命令>')
  console.log('')
  console.log('选项:')
  console.log('  -h, --help             显示帮助信息')
  console.log('  -v, -V, --version      显示版本号')
  console.log('  -d, --daemon           后台守护进程模式 (Linux/Mac)')
  console.log('  -c, --config <path>    指定配置文件路径（--config=<path> 同效）')
  console.log('')
  console.log(require('./src/cli').USAGE)
  console.log('')
  console.log('环境变量:')
  console.log('  PORT                   覆盖代理端口')
  console.log('  HOST                   覆盖监听地址')
  console.log('  DEV_SIDECAR_HOME       覆盖数据目录 (CA证书存放位置)')
  console.log('')
  console.log('示例:')
  console.log('  dss                               默认启动 (127.0.0.1:31181)')
  console.log('  dss -c ./config.json              使用自定义配置')
  console.log('  dss start / dss -d                后台守护进程')
  console.log('  dss stop                          停止并恢复代理配置')
  console.log('  dss npm on                        一键配置 npm 走代理')
  console.log('  dss status                        查看运行状态')
  console.log('  PORT=8080 dss                     自定义端口 8080')
  console.log('  HOST=0.0.0.0 PORT=8080 dss        监听所有网卡')
}

/**
 * 加载配置文件
 */
function loadConfig (configPath) {
  let config
  if (configPath) {
    let raw
    try {
      raw = fs.readFileSync(configPath, 'utf8')
    } catch (e) {
      console.error(`❌ 无法读取配置文件: ${configPath}`)
      console.error(`   ${e.message}`)
      process.exit(1)
    }
    try {
      config = JSON.parse(raw)
    } catch (e) {
      console.error(`❌ 配置文件不是有效的 JSON: ${configPath}`)
      console.error(`   ${e.message}`)
      process.exit(1)
    }
    log().info('已加载配置文件:', configPath)
  } else {
    // 默认配置
    config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/default.json'), 'utf8'))
    log().info('已加载默认配置')
  }

  // 允许通过环境变量覆盖端口和主机
  if (process.env.PORT) {
    config.server.port = parseInt(process.env.PORT, 10)
    log().info('环境变量 PORT 覆盖端口:', config.server.port)
  }
  if (process.env.HOST) {
    config.server.host = process.env.HOST
    log().info('环境变量 HOST 覆盖监听地址:', config.server.host)
  }

  // 设置用户基础路径（CA 证书存放位置）
  // 优先使用环境变量 DEV_SIDECAR_HOME，否则使用 os.homedir()
  // os.homedir() 在 systemd 等无 $HOME 的环境下仍可通过 /etc/passwd 正确解析
  const os = require('node:os')
  const userHome = process.env.DEV_SIDECAR_HOME || os.homedir()
  const userBasePath = path.resolve(userHome, '.dev-sidecar')
  if (!config.server.setting) {
    config.server.setting = {}
  }
  config.server.setting.userBasePath = userBasePath
  config.server.setting.rootDir = __dirname

  // CA 证书路径
  config.server.setting.rootCaFile = {
    certPath: path.join(userBasePath, '/dev-sidecar.ca.crt'),
    keyPath: path.join(userBasePath, '/dev-sidecar.ca.key.pem'),
  }

  // 确保用户目录存在
  if (!fs.existsSync(userBasePath)) {
    fs.mkdirSync(userBasePath, { recursive: true })
    log().info('创建用户目录:', userBasePath)
  }

  return config
}

/** 延迟 require：mitmproxy 模块加载有副作用日志，只在真正启动时引入 */
function log () {
  return require('./src/mitmproxy/utils/util.log.server')
}

/**
 * 前台启动主流程
 */
async function startup (configPath) {
  const mitmproxy = require('./src/mitmproxy')

  if (configPath && !fs.existsSync(configPath)) {
    console.error(`❌ 配置文件不存在: ${configPath}`)
    process.exit(1)
  }

  const BANNER = [
    '    ____                 _____ _     __',
    '   / __ \\___ _   __     / ___/(_)___/ /__  _________ ______',
    '  / / / / _ \\ | / /_____\\__ \\/ / __/ / _ \\/ ___/ __ "/ ___/',
    ' / /_/ /  __/ |/ /_____/__/ / / /_/ /  __/ /__/ /_/ / /',
    '/_____/\\___/|___/     /____/_/\\__,_/\\___/\\___/\\__,_/_/',
    '',
    '==================== Dev-Sidecar Standalone ====================',
  ].join('\n')
  console.log(BANNER)

  const config = loadConfig(configPath)
  const { host, port } = config.server
  console.log(`  HTTP 端口: ${port - 1}  (自动分配)`)
  console.log(`  HTTPS 端口: ${port} (MITM)`)

  // 检查 CA 证书
  const caCertPath = config.server.setting.rootCaFile.certPath
  const caKeyPath = config.server.setting.rootCaFile.keyPath
  const caExists = fs.existsSync(caCertPath) && fs.existsSync(caKeyPath)
  console.log(`  CA 证书: ${caExists ? '✅ 已存在' : '🔄 将自动生成'}`)
  console.log(`  CA 证书路径: ${caCertPath}`)

  console.log('')
  console.log('  支持的加速目标（部分列表）:')
  console.log('    • GitHub (github.com, raw.githubusercontent.com, githubassets...)')
  console.log('    • Google CDN (ajax.googleapis.com, fonts.googleapis.com...)')
  console.log('    • Docker (docker.com, hub.docker.com)')
  console.log('    • Python PyPI (DNS 优化)')
  console.log('    • JetBrains (DNS 优化)')
  console.log('    • 广告拦截')
  console.log('')
  console.log('  使用方式:')
  console.log('    浏览器/系统代理 → HTTP(S) 代理地址:')
  console.log(`    http://${host}:${port - 1}  (HTTP 代理)`)
  console.log(`    https://${host}:${port} (HTTPS MITM 代理)`)
  console.log('')
  console.log('   需要安装 CA 证书到系统信任列表才可拦截 HTTPS 请求')
  console.log('')
  console.log('================================================================')
  console.log('')

  try {
    await mitmproxy.start(config)
    log().info(`✅ Dev-Sidecar 纯服务器版启动成功！`)
    log().info(`   HTTP 代理: ${host}:${port - 1}`)
    log().info(`   HTTPS 代理: ${host}:${port}`)

    // 守护进程模式（dss start / dss -d fork 出来的子进程）：
    // listen 成功后自己写 PID 文件（父进程不盲写，避免早退竞态）
    if (process.env.DSS_DAEMON === '1') {
      const { writePidFile, readPidFile, removePidFile } = require('./src/cli/utils')
      writePidFile(process.pid)
      process.on('exit', () => {
        // 仅当 PID 文件仍指向自己时清理（强杀场景由 start/stop 的残留清理兜底）
        if (readPidFile() === process.pid) {
          removePidFile()
        }
      })
    }
  } catch (e) {
    log().error('❌ 启动失败:', e)
    process.exit(1)
  }
}

process.title = 'dev-sidecar-standalone'
