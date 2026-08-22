// 独立版桩模块：替换 @docmirror/dev-sidecar/src/config/local-config-loader
const path = require('node:path')
const os = require('os')

module.exports = {
  getConfigFromFiles () {
    return {}
  },
  getUserBasePath () {
    const userHome = process.env.DEV_SIDECAR_HOME || os.homedir()
    return path.resolve(userHome, '.dev-sidecar')
  },
  getUserConfig () {
    return {}
  },
  getAutomaticCompatibleConfigPath () {
    return path.join(this.getUserBasePath(), 'automaticCompatibleConfig.json')
  },
}
