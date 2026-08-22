// 简化日志：直接使用 console，不依赖 log4js 和 @docmirror/dev-sidecar
const logOrConsole = require('../../core/utils/util.log-or-console')

const logger = {
  debug (...args) { logOrConsole.debug(...args) },
  info (...args) { logOrConsole.info(...args) },
  warn (...args) { logOrConsole.warn(...args) },
  error (...args) { logOrConsole.error(...args) },
}

module.exports = logger
