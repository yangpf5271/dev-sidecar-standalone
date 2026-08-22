// 独立版桩模块：替换 @docmirror/dev-sidecar/src/config/index.js
// 仅提供 SpeedTester 所需的 familyMapping
const matchUtil = require('../../mitmproxy/utils/util.match')

const familyMapping = matchUtil.domainMapRegexply({
  '*.github.com': '4',
  '*github*.com': '4',
  '*.github.io': '4',
  '*.docker.com': '4',
  '*.stackoverflow.com': '4',
  '*.electronjs.org': '4',
  '*.amazonaws.com': '4',
  '*.yarnpkg.com': '4',
  '*.cloudfront.net': '4',
  '*.cloudflare.com': '4',
  'img.shields.io': '4',
  '*.vuepress.vuejs.org': '4',
  '*.v2ex.com': '4',
  '*.pypi.org': '4',
  '*.jetbrains.com': '4',
  '*.azureedge.net': '4',
})

module.exports = {
  configFromFiles: {
    server: {
      dns: {
        familyMapping,
      },
    },
  },
}
