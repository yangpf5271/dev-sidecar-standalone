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
    servers = newServers

    // 等待全部端口监听成功才算启动成功。
    // 此前监听失败(如端口被占用 EADDRINUSE)只记日志, start() 仍会 resolve,
    // 导致主程序打印"启动成功"但实际没有任何端口在工作
    try {
      await waitForListening(newServers)
    } catch (e) {
      // 关闭已绑定的端口(不留半启动状态), 让调用方以非零退出码结束
      await api.close()
      throw e
    }

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

/**
 * 等待全部 server 监听成功; 任一 listen 失败(如端口占用)则 reject。
 * createProxy 内部同步调用 listen, 事件均为异步派发, 返回后立即挂监听不会漏接。
 * resolve 后残留的 once('error') 由 settled 标记屏蔽, 不影响运行期错误处理
 */
function waitForListening (serverList) {
  return new Promise((resolve, reject) => {
    let pending = serverList.length
    let settled = false
    if (pending === 0) return resolve()
    for (const server of serverList) {
      if (server.listening) {
        if (--pending === 0) resolve()
        continue
      }
      server.once('listening', () => {
        if (settled) return
        if (--pending === 0) {
          settled = true
          resolve()
        }
      })
      server.once('error', (e) => {
        if (settled) return
        settled = true
        const hint = e.code === 'EADDRINUSE'
          ? '（可能已有代理实例在运行：dss status 查看状态，dss stop 停止后重试）'
          : ''
        reject(new Error(`代理端口监听失败 ${e.address || ''}:${e.port || ''} [${e.code}]${hint}`))
      })
    }
  })
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
