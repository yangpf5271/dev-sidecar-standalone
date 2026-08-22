#!/usr/bin/env node
// linux daemon support — 提前解析，避免 daemon fork 后重复加载
const DAEMON = process.argv.includes('--daemon') || process.argv.includes('-d')
const VERSION = require('./package.json').version

// 守护进程模式：fork 后台子进程，父进程退出
if (DAEMON) {
  const { spawn } = require('node:child_process')
  // 去掉 -d / --daemon 参数，避免子进程再次 fork
  const childArgs = process.argv.slice(2).filter(a => a !== '-d' && a !== '--daemon')
  const child = spawn(process.execPath, [__filename, ...childArgs], {
    cwd: process.cwd(),
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
  console.log(`✅ Daemon PID: ${child.pid}`)
  process.exit(0)
}

// 快速参数检查：-h/-V 在 require 模块之前退出，避免副作用日志
const args = process.argv.slice(2)
if (args.includes('-h') || args.includes('--help')) {
  console.log('用法: dss [选项] [配置文件路径]')
  console.log('')
  console.log('选项:')
  console.log('  -h, --help             显示帮助信息')
  console.log('  -v, -V, --version      显示版本号')
  console.log('  -d, --daemon           后台守护进程模式 (Linux/Mac)')
  console.log('  -c, --config <path>    指定配置文件路径')
  console.log('')
  console.log('环境变量:')
  console.log('  PORT                   覆盖代理端口')
  console.log('  HOST                   覆盖监听地址')
  console.log('  DEV_SIDECAR_HOME       覆盖数据目录 (CA证书存放位置)')
  console.log('')
  console.log('示例:')
  console.log('  dss                               默认启动 (127.0.0.1:31181)')
  console.log('  dss -c ./config.json              使用自定义配置')
  console.log('  dss -d                            后台守护进程')
  console.log('  PORT=8080 dss                     自定义端口 8080')
  console.log('  HOST=0.0.0.0 PORT=8080 dss        监听所有网卡')
  process.exit(0)
}
if (args.includes('-v') || args.includes('-V') || args.includes('--version')) {
  console.log('v' + VERSION)
  process.exit(0)
}

const path = require('node:path')
const fs = require('node:fs')
const proxyConfig = require('./src/mitmproxy/lib/proxy/common/config')
const mitmproxy = require('./src/mitmproxy')
const log = require('./src/mitmproxy/utils/util.log.server')

const BANNER = [
  '    ____                 _____ _     __',
  '   / __ \\___ _   __     / ___/(_)___/ /__  _________ ______',
  '  / / / / _ \\ | / /_____\\__ \\/ / __  / _ \\/ ___/ __ "/ ___/',
  ' / /_/ /  __/ |/ /_____/__/ / / /_/ /  __/ /__/ /_/ / /',
  '/_____/\\___/|___/     /____/_/\\__,_/\\___/\\___/\\__,_/_/',
  '',
  '==================== Dev-Sidecar Standalone ====================',
].join('\n')

/**
 * 加载配置文件
 */
function loadConfig (configPath) {
  let config
  if (configPath) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    log.info('已加载配置文件:', configPath)
  } else {
    // 默认配置
    config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/default.json'), 'utf8'))
    log.info('已加载默认配置')
  }

  // 允许通过环境变量覆盖端口和主机
  if (process.env.PORT) {
    config.server.port = parseInt(process.env.PORT, 10)
    log.info('环境变量 PORT 覆盖端口:', config.server.port)
  }
  if (process.env.HOST) {
    config.server.host = process.env.HOST
    log.info('环境变量 HOST 覆盖监听地址:', config.server.host)
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
    log.info('创建用户目录:', userBasePath)
  }

  return config
}

/**
 * 主函数
 */
async function main () {
  const args = process.argv.slice(2)
  let configPath = null

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--config':
      case '-c':
        configPath = args[++i]
        break
      default:
        if (!configPath && !args[i].startsWith('-')) {
          configPath = args[i]
        }
        break
    }
  }

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

  if (!caExists) {
    // 将在 createProxy 时自动生成
  }

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
    log.info(`✅ Dev-Sidecar 纯服务器版启动成功！`)
    log.info(`   HTTP 代理: ${host}:${port - 1}`)
    log.info(`   HTTPS 代理: ${host}:${port}`)
    log.info(`  按 Ctrl+C 停止服务`)
  } catch (e) {
    log.error('❌ 启动失败:', e)
    process.exit(1)
  }
}

// 启动
process.title = 'dev-sidecar-standalone'
main()
