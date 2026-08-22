// CLI 子命令分发入口
// 注意：此模块在 index.js 顶部被调用，早于 daemon/help/main 逻辑，
// 只能依赖轻量模块，不能 require src/mitmproxy（避免副作用）
const SUBCOMMANDS = {
  npm: () => require('./npm'),
  git: () => require('./git'),
  env: () => require('./env'),
  cert: () => require('./cert'),
  status: () => require('./status'),
}

const USAGE = `子命令:
  dss npm on [--mitm]   配置 npm 走代理（--mitm 启用 HTTPS 拦截加速）
  dss npm off           取消 npm 代理配置
  dss git on [--simple] 配置 git 走代理（--simple 仅 HTTP 隧道，无需证书）
  dss git off           取消 git 代理配置
  dss env on|off        输出 shell 代理环境变量（配合 eval 使用）
  dss cert              显示 CA 证书路径和安装方法
  dss status            查看代理运行状态`

/** 判断 argv[2] 是否为已知子命令 */
function isSubcommand (arg) {
  return arg != null && Object.prototype.hasOwnProperty.call(SUBCOMMANDS, arg)
}

/** 分发执行子命令，返回 Promise（完成后进程退出） */
async function dispatch (subcommand, args) {
  const mod = SUBCOMMANDS[subcommand]()
  if (args.includes('-h') || args.includes('--help')) {
    mod.help()
    process.exit(0)
  }
  await mod.run(args)
}

module.exports = {
  isSubcommand,
  dispatch,
  USAGE,
}
