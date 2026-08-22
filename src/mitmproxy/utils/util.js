const log = require('./util.log.server')

const util = {
  getNodeVersion () {
    const version = process.version
    log.info('Node.js version:', version)
  },
}

module.exports = util
