// 代理地址解析 — 命令侧消费 server-config 单点的薄封装
// 返回 dss 各命令都认识的 { host, mitmPort, httpPort, isDefaultPort, configPath }
const path = require('node:path')
const {
  readConfigJson,
  serverOf,
  withEnvOverride,
  DEFAULT_CONFIG_FILE,
  DEFAULT_HOST,
  DEFAULT_MITM_PORT,
} = require('../server-config')

/**
 * 从命令行参数和环境变量解析代理端口（不使用 index.js 的 loadConfig，避免副作用）
 *
 * 配置读取/环境变量覆盖/默认端口的单点知识在 ../server-config（spec 注释见该模块）。
 */
function resolveProxyAddress (args) {
  // 容错扫描: 子命令参数里混有其他旗标(如 --mitm/--keep-config), 只提取 -c/--config。
  // (入口 route 的严格文法是另一回事: 顶层未知参数要报错 — 见 router.js)
  let configPath = null
  const argv = args || process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-c' || argv[i] === '--config') {
      configPath = argv[++i]
    } else if (argv[i].startsWith('--config=')) {
      configPath = argv[i].slice('--config='.length)
    }
  }

  let host = DEFAULT_HOST
  let port = null
  if (configPath) {
    const r = readConfigJson(path.resolve(configPath))
    if (!r.ok) {
      console.error(`读取配置文件失败: ${configPath}, error: ${r.error}`)
      process.exit(1)
    }
    ({ host, port } = serverOf(r.config))
  } else {
    // 内置默认读失败 → 静默用常量兜底(真正的启动路径 loadConfig 会大声报错)
    const r = readConfigJson(DEFAULT_CONFIG_FILE)
    if (r.ok) ({ host, port } = serverOf(r.config))
  }

  ;({ host, port } = withEnvOverride({ host, port }))

  const mitmPort = port || DEFAULT_MITM_PORT
  return {
    host,
    mitmPort,
    httpPort: mitmPort - 1,
    isDefaultPort: mitmPort === DEFAULT_MITM_PORT,
    configPath,
  }
}

module.exports = { resolveProxyAddress }
