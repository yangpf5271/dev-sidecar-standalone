// dss service — 开机自启服务定义管理(install/uninstall/status)
// 三平台: Windows HKCU Run 登录项 / Linux 系统级 systemd unit / macOS launchd
// 生成与规格契约见 lib/service-definitions.js(纯函数)与 lib/service-ops.js(编排)
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { resolveProxyAddress } = require('./lib/proxy-address')
const { probePort, runCommand } = require('./lib/exec')
const { resolveCertPaths } = require('./lib/paths')
const { createServiceOps } = require('./lib/service-ops')
const { KIND_LABELS } = require('./lib/service-definitions')
const { stopDaemon } = require('./stop')
const { startDaemon } = require('./start')

function platformKind () {
  return process.platform === 'win32' ? 'runkey' : process.platform === 'darwin' ? 'launchd' : 'systemd'
}

function platformLabel () {
  return {
    runkey: 'Windows 登录项(HKCU Run)',
    systemd: 'Linux systemd 系统级 unit',
    launchd: 'macOS launchd(未实测)',
  }[platformKind()]
}

async function run (args) {
  const action = args[0]
  // spec(service-management): Windows 侧 service 命令在 WSL 环境下 SHALL 明确拒绝并指引 Linux 流程
  if (process.platform === 'win32') {
    const ops = createServiceOps()
    if (ops.isWSL()) {
      console.error('❌ 当前在 WSL 环境中运行 Windows 版 dss，Windows 登录项操作不可用')
      console.error('   请在 Windows 原生终端执行；或在 WSL 内使用 Linux 流程 (sudo dss service install)')
      process.exit(1)
    }
  }
  if (action === 'install') return installCmd(args.slice(1))
  if (action === 'uninstall') return uninstallCmd(args.slice(1))
  if (action === 'status') return statusCmd(args.slice(1))
  help()
  process.exit(action ? 1 : 0)
}

/** Windows 入口定位链(设计 D4 风险缓解):
 *   1) npm 前缀仅当 dss.cmd 实际存在才用(稳定非版本目录) — 否则 VBS 保持裸 dss(PATH 解析式, 不钉版本目录) */
async function resolveEntryDir () {
  const pf = await runCommand('npm', ['config', 'get', 'prefix'], { shell: true })
  const prefix = pf.ok && pf.stdout ? pf.stdout.split(/\r?\n/)[0].trim() : null
  if (prefix && fs.existsSync(path.join(prefix, 'dss.cmd'))) return prefix
  return null
}

/** install 上下文装配: 地址解析与 dss start 同源(server-config 单点);
 *  启动配置(PORT/HOST/-c)在此固化进 ctx, 由生成器写进服务定义 */
async function buildCtx (args) {
  const addr = resolveProxyAddress(args)
  const { userBasePath } = resolveCertPaths()
  const configPath = addr.configPath ? path.resolve(addr.configPath) : null
  const startEnv = {}
  if (process.env.PORT) startEnv.PORT = process.env.PORT
  if (process.env.HOST) startEnv.HOST = process.env.HOST
  const ctx = {
    user: os.userInfo().username,
    userBasePath,
    devSidecarHome: process.env.DEV_SIDECAR_HOME || null,
    npmPrefix: null,
    startEnv,
    configPath,
    addr,
  }
  if (process.platform === 'win32') ctx.npmPrefix = await resolveEntryDir()
  return ctx
}

async function installCmd (args) {
  const ops = createServiceOps()
  const ctx = await buildCtx(args)
  console.log(`正在安装服务定义 (${platformLabel()})...`)
  const r = await ops.installDefinition(ctx)
  if (!r.ok) {
    console.error(`❌ ${r.error}`)
    process.exit(1)
  }
  if (r.wasInstalled) console.log('ℹ️  检测到旧定义，已覆盖安装')
  console.log(`✅ 服务定义已安装: ${r.definition.name}`)

  // 立即拉起(Windows 走 startDaemon —— node 直 spawn, 不经 wscript;
  // Linux/macOS 的注册动作 enable --now / launchctl load 已自带拉起, 此处仅验证)
  if (process.platform === 'win32') {
    console.log('正在启动代理...')
    await startDaemon(args) // 失败时内部 exit(1) 并打印日志尾部
  }

  // 端口验证带轮询(Linux/macOS 的 enable --now / launchctl load 返回时代理仍在启动;
  // Windows 的 startDaemon 内部已轮询, 此处立即通过)
  let portReady = false
  for (let i = 0; i < 30 && !portReady; i++) {
    portReady = await probePort(ctx.addr.host, ctx.addr.httpPort)
    if (!portReady) await new Promise((r) => setTimeout(r, 500))
  }
  if (!portReady) {
    console.error(`❌ 安装完成但代理端口 ${ctx.addr.host}:${ctx.addr.httpPort} 未就绪，请查 dss log`)
    process.exit(1)
  }
  console.log(`   验证: ✅ 定义存在, 代理端口 ${ctx.addr.host}:${ctx.addr.httpPort} 已就绪`)
  console.log('   卸载: dss service uninstall   状态: dss service status')
  if (r.warning) {
    console.log(`   ⚠️  ${r.warning}`)
  }
  if (ctx.devSidecarHome || ctx.configPath || ctx.startEnv.PORT || ctx.startEnv.HOST) {
    console.log('   ℹ️  已固化启动配置(DEV_SIDECAR_HOME/PORT/HOST/-c)；之后修改需重新 install')
  }
}

async function uninstallCmd (args) {
  const ops = createServiceOps()
  if (!(await ops.detectSupervisor())) {
    console.log('服务定义未安装')
    return
  }
  console.log('正在移除服务定义并停止受管代理...')
  const r = await ops.removeDefinition()
  if (!r.ok) {
    // 定义仍在管: 不打"已移除"、不停代理(管理器会立刻拉回, 停了也是假象) —— 判定书 #21③
    for (const n of r.notes) console.error(`   (${n})`)
    console.error('❌ 服务定义移除未完成，未停止代理(避免"已移除"与代理复活同屏的假象)')
    console.error('   修复权限后重试: dss service uninstall')
    process.exit(1)
  }
  for (const n of r.notes) console.log(`   (${n})`)
  // 停受管代理进程(身份验证防误杀; 服务定义已移除, 管理器不会再拉回)
  await stopDaemon(args)
  console.log('✅ 服务定义已移除')
}

async function statusCmd (args) {
  const ops = createServiceOps()
  const addr = resolveProxyAddress(args)
  const s = await ops.status(addr)
  if (s.state === 'not-installed') {
    console.log('服务定义: 未安装 (dss service install 注册开机自启)')
    return
  }
  const kindName = KIND_LABELS[platformKind()]
  if (s.state === 'installed-not-running') {
    console.log(`服务定义: ⚠️ 已安装 (${kindName}) 但代理未运行`)
    if (s.crashLoop) {
      console.log('   ⚠️ 服务处于崩溃循环(反复启动失败)，排查: journalctl -u dss.service -n 50')
    } else {
      console.log('   排查: dss log / 手动触发管理器通道启动')
    }
    return
  }
  if (s.state === 'version-mismatch') {
    console.log(`服务定义: ⚠️ 运行中但版本不一致 (守护进程 v${s.daemonVersion} ≠ CLI v${require('../../package.json').version})，建议 dss restart 对齐`)
  } else {
    console.log(`服务定义: ✅ 运行中 (${kindName})`)
  }
  // 崩溃循环主动信号(Linux): systemd 永远不会熔断 Restart=always, 无此检测则循环静默
  if (s.crashLoop) {
    console.log('   ⚠️ 服务处于崩溃循环(反复启动失败)，排查: journalctl -u dss.service -n 50')
  }
  // 不变式③: 重放安装时解析与当前环境比对
  const manifest = ops.readManifest()
  if (manifest) {
    const current = await buildCtx(args)
    const drifts = ops.replayDrifts(manifest, current)
    for (const d of drifts) console.log(`   ⚠️ ${d}`)
  }
}

function help () {
  console.log('用法: dss service <install|uninstall|status> [-c <配置文件>]')
  console.log('')
  console.log('开机自启服务定义管理(三平台):')
  console.log('  Windows   HKCU Run 登录项(当前用户, 无窗口, 免管理员)')
  console.log('  Linux     系统级 systemd unit(User=<安装用户>, 需 sudo)')
  console.log('  macOS     launchd agent(未实测)')
  console.log('')
  console.log('  install     生成并注册服务定义, 立即拉起代理并验证')
  console.log('  uninstall   移除服务定义并停止受管代理')
  console.log('  status      服务四态 + 安装配置漂移检测(数据目录/入口)')
  console.log('')
  console.log('注意:')
  console.log('  - 自启仅让代理待命; npm/git 代理配置仍由 dss npm on 等命令管理')
  console.log('  - 服务在管时优先用管理器通道停止/重启(systemctl restart 等),')
  console.log('    dss restart 会与管理器的自动拉起产生竞态; dss stop 会给出提示')
  console.log('  - install 后修改 DEV_SIDECAR_HOME/PORT/HOST/-c 需重新 install(启动配置固化)')
  console.log('')
  console.log('示例:')
  console.log('  dss service install')
  console.log('  PORT=44181 dss service install')
  console.log('  dss service status')
  console.log('  dss service uninstall')
}

module.exports = { run, help }
