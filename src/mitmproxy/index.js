const mitmproxy = require('./lib/proxy')
const proxyConfig = require('./lib/proxy/common/config')
const ProxyOptions = require('./options')
const log = require('./utils/util.log.server')

let servers = []

const api = {
  async start (config) {
    const serverConfig = config.server || config
    const proxyOptions = ProxyOptions(serverConfig)
    const setting = serverConfig.setting
    if (setting && setting.userBasePath) {
      proxyConfig.setDefaultCABasePath(setting.userBasePath)
    }

    if (proxyOptions.setting && proxyOptions.setting.NODE_TLS_REJECT_UNAUTHORIZED === false) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1'
    }

    const newServers = mitmproxy.createProxy(proxyOptions, (server, port, host, ssl) => {
      log.info(`代理服务已启动：${host}:${port}, ssl: ${ssl}`)
    })

    for (const newServer of newServers) {
      newServer.on('close', () => {
        log.info('server will closed')
        if (servers.includes(newServer)) {
          servers = servers.filter(item => item !== newServer)
        }
      })
      newServer.on('error', (e) => {
        log.error('server error', e)
      })
    }
    servers = newServers

    registerProcessListener()
  },
  async close () {
    const list = servers
    servers = []
    if (!list || list.length === 0) {
      log.info('server is null, no need to close.')
      return
    }
    return new Promise((resolve) => {
      // 优雅关闭：立即停止接受新连接并关闭空闲连接。
      // 活跃的 CONNECT 隧道会无限期挂住 close 回调，内部宽限后强制关闭全部连接，
      // 保证 close 在有限时间内完成（不依赖外部超时强杀）。
      for (const server of list) {
        if (typeof server.closeIdleConnections === 'function') {
          server.closeIdleConnections()
        }
      }
      const forceTimer = setTimeout(() => {
        for (const server of list) {
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections()
          }
        }
      }, 1500)
      // 兜底：即使 close 回调异常未触发也不永久挂起
      const safetyTimer = setTimeout(() => {
        clearTimeout(forceTimer)
        resolve()
      }, 5000)
      let remaining = list.length
      for (const server of list) {
        server.close(() => {
          remaining--
          if (remaining <= 0) {
            clearTimeout(forceTimer)
            clearTimeout(safetyTimer)
            log.info('代理服务关闭成功')
            resolve()
          }
        })
      }
    })
  },
}

function registerProcessListener () {
  process.on('SIGINT', () => {
    log.info('收到 SIGINT 信号，正在关闭代理服务...')
    api.close().then(() => process.exit(0))
  })
  process.on('SIGTERM', () => {
    log.info('收到 SIGTERM 信号，正在关闭代理服务...')
    api.close().then(() => process.exit(0))
  })
  process.on('uncaughtException', (err) => {
    if (err && (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET')) return
    log.error('Process uncaughtException:', err)
  })
  process.on('unhandledRejection', (err, p) => {
    log.info('Process unhandledRejection at: Promise', p, 'err:', err)
  })
  process.on('exit', (code, signal) => {
    log.info('代理服务进程被关闭:', code, signal)
  })
}

module.exports = {
  ...api,
  config: proxyConfig,
  log,
}
