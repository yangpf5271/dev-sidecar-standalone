// 简单的日志控制台输出，不依赖 log4js
const dateUtil = require('./util.date')

function prefix (level) {
  return `[${dateUtil.now()}][${level}]`
}

module.exports = {
  debug (...args) {
    console.debug(prefix('DEBUG'), ...args)
  },
  info (...args) {
    console.info(prefix('INFO'), ...args)
  },
  warn (...args) {
    console.warn(prefix('WARN'), ...args)
  },
  error (...args) {
    console.error(prefix('ERROR'), ...args)
  },
}
