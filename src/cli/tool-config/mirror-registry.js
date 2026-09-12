// 镜像源注册表 — npm/pip 的镜像表 + 官方源 + 绑定默认 adapter 的引擎实例
//
// 下沉自命令层 npm.js/pip.js: 引擎实例与镜像表是工具域知识而非命令文案,
// 之前 status.js 为拿引擎实例不得不横向 require 命令模块(命令层内部耦合)。
// 命令层(npm.js/pip.js)与状态聚合(status.js)统一从此处取。
const { adapters } = require('./index')
const { createMirrorEngine } = require('./mirror-engine')

const NPM_OFFICIAL = 'https://registry.npmjs.org'
const NPM_MIRRORS = {
  npmmirror: { name: 'npmmirror（淘宝）', url: 'https://registry.npmmirror.com' },
  ustc: { name: '中国科学技术大学', url: 'https://npmreg.proxy.ustclug.org' },
}

const PIP_OFFICIAL = 'https://pypi.org/simple/'
const PIP_MIRRORS = {
  tsinghua: { name: '清华大学', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  aliyun: { name: '阿里云', url: 'https://mirrors.aliyun.com/pypi/simple/' },
  ustc: { name: '中国科学技术大学', url: 'https://pypi.mirrors.ustc.edu.cn/simple' },
  nju: { name: '南京大学', url: 'https://mirror.nju.edu.cn/pypi/web/simple/' },
}

const npmMirrorEngine = createMirrorEngine({
  name: 'npm',
  official: NPM_OFFICIAL,
  mirrors: NPM_MIRRORS,
  adapter: adapters.npm,
})

const pipMirrorEngine = createMirrorEngine({
  name: 'pip',
  official: PIP_OFFICIAL,
  mirrors: PIP_MIRRORS,
  adapter: adapters.pip,
})

module.exports = {
  NPM_OFFICIAL,
  NPM_MIRRORS,
  npmMirrorEngine,
  PIP_OFFICIAL,
  PIP_MIRRORS,
  pipMirrorEngine,
}
