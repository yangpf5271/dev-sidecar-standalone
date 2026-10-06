// 服务定义生成器 — 三平台自启定义的纯函数生成(唯一新 seam)
//
// 规格契约(openspec: service-management):
//   三不变式: ①入口恒为前台 dss(禁止后台启动子命令 —— detached 双层 fork 逃逸监管)
//            ②运行身份恒为安装用户(Windows 禁 ONSTART/SYSTEM)
//            ③status 重放 install 时解析并与当前 CLI 比对(经 manifest 固化安装时解析快照)
//   PATH 解析式入口: 不写死解释器绝对路径 —— Windows 优先 npm 全局前缀 shim、回退 PATH;
//            Linux/macOS 生成引导时重扫 Node 版本目录的 wrapper(nvm 兼容), wrapper 路径本身稳定
//   启动配置固化: DEV_SIDECAR_HOME/PORT/HOST/configPath 在 install 时写进定义,
//            保证服务重启后的代理地址与安装时一致(非默认端口不会回落默认)
//   守护标记: 定义注入 DSS_DAEMON=1, 使前台拉起路径与后台子进程共享 PID 簿记
//
// 路径拼装必须按「目标平台」语义(生成器可能在不属于目标平台的宿主上运行/测试):
// Windows 定义用 win32 语义, Linux/macOS 定义用 POSIX 语义
const { posix: posixPath, win32: win32Path } = require('node:path')

// 命名前缀常量(派生自包名) — 归属探测与 uninstall 复用同一常量
const SERVICE_VALUE_NAME = 'dss-autostart'     // Windows HKCU Run 值名
const SERVICE_UNIT_NAME = 'dss.service'        // Linux systemd unit 名
const SERVICE_LABEL = 'com.dss.daemon'         // macOS launchd label
const RUN_KEY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const MANIFEST_NAME = 'dss-service.json'       // 安装解析快照(不变式③的重放基准)

// 平台载体显示名(status 面板与 service status 共用, 单点防漂移)
const KIND_LABELS = {
  runkey: '登录项(HKCU Run)',
  systemd: 'systemd unit',
  launchd: 'launchd agent',
}

/** 平台路径单点(生成器与编排层共用; 消除两处各自拼装的重复) */
function servicePaths (platform, userBasePath) {
  if (platform === 'win32') {
    return { vbs: win32Path.join(userBasePath, 'dss-service.vbs') }
  }
  if (platform === 'linux') {
    return { wrapper: '/usr/local/bin/dss-service-wrapper', unit: `/etc/systemd/system/${SERVICE_UNIT_NAME}` }
  }
  return {
    wrapper: posixPath.join(userBasePath, 'dss-service-wrapper'),
    plist: posixPath.join(userBasePath, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
  }
}

/**
 * 生成三平台服务定义(纯函数, 无 IO)。
 * ctx: {
 *   user           安装用户名(不变式②)
 *   userBasePath   数据目录绝对路径(~/.dev-sidecar, 已随安装时环境解析)
 *   devSidecarHome 安装时环境中的 DEV_SIDECAR_HOME(未设置则 null; 钉死进定义)
 *   npmPrefix      npm 全局前缀目录(Windows shim 优先定位; 探测失败 null → 回退 PATH)
 *   startEnv       启动环境固化 { PORT?, HOST? }(字符串; 来自安装时环境变量)
 *   configPath     安装时 -c 指定的配置文件绝对路径(null = 未指定)
 *   host, mitmPort 代理监听地址(仅写入定义注释与验证用途)
 * }
 * 返回 { kind, name, auxFiles: [{absPath, content, sudo?}], definition: {…平台结构化定义…} }
 */
function createServiceDefinition (platform, ctx) {
  if (platform === 'win32') return createWindowsDefinition(ctx)
  if (platform === 'darwin') return createDarwinDefinition(ctx)
  if (platform === 'linux') return createLinuxDefinition(ctx)
  throw new Error(`不支持的平台: ${platform}(仅 win32/linux/darwin)`)
}

/** dss 启动参数固化: -c 配置文件(configPath)在命令行, PORT/HOST 在环境(startEnv 由各平台模板落地) */
function dssArgsOf (ctx) {
  return ctx.configPath ? [`-c`, `"${ctx.configPath}"`] : []
}

/** Linux/macOS 共用 wrapper: 每次启动重扫 nvm 版本目录取最新(sort -V), 回退 PATH —— PATH 解析式。
 *  参数转发($@)支持 -c 配置文件 */
function createWrapperContent (platform, ctx) {
  const lines = [
    '#!/bin/sh',
    '# dss 服务入口 — 由 dss service install 生成; 每次启动重解析 Node 环境(PATH 解析式, 抗 nvm 切版本漂移)',
    'export DSS_DAEMON=1',
  ]
  if (ctx.devSidecarHome) {
    lines.push(`export DEV_SIDECAR_HOME="${escapeShell(ctx.devSidecarHome)}"`)
  }
  if (ctx.startEnv && ctx.startEnv.PORT) {
    lines.push(`export PORT="${escapeShell(ctx.startEnv.PORT)}"`)
  }
  if (ctx.startEnv && ctx.startEnv.HOST) {
    lines.push(`export HOST="${escapeShell(ctx.startEnv.HOST)}"`)
  }
  lines.push(
    platform === 'darwin'
      ? 'USER_HOME="${HOME:-$(dscl . -read "/Users/$(whoami)" NFSHomeDirectory | awk \'{print $2}\')}"' // launchd 用户代理自带 HOME; 缺失时经 DirectoryService 解析
      : 'USER_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"', // systemd 环境无 $HOME, 经 /etc/passwd 解析
    'NVM_DIR="$USER_HOME/.nvm"',
    'if [ -d "$NVM_DIR/versions/node" ]; then',
    '  BEST="$(for bin in "$NVM_DIR"/versions/node/*/bin; do [ -x "$bin/dss" ] && echo "$bin"; done | sort -V | tail -1)"',
    '  if [ -n "$BEST" ]; then',
    '    export PATH="$BEST:$PATH"',
    '    exec dss "$@"',
    '  fi',
    'fi',
    'exec dss "$@"',
  )
  return lines.join('\n') + '\n'
}

function escapeShell (s) {
  return String(s).replace(/"/g, '\\"')
}

/** Windows: wscript VBS 无窗口包装 + HKCU Run 登录项(免管理员, 天然 per-user, HKCU 仅对安装用户生效)。
 *  实现 note: 计划任务 ONLOGON 触发器创建需要管理员权限(实测拒绝访问), 与"免管理员"的议会收敛冲突 → 载体为 HKCU Run */
function createWindowsDefinition (ctx) {
  const paths = servicePaths('win32', ctx.userBasePath)
  // 入口链: npm 前缀 shim 优先(前缀稳定) → PATH 解析回退; 均不写死 node.exe 绝对路径
  const shim = ctx.npmPrefix
    ? `""${escapeShell(win32Path.join(ctx.npmPrefix, 'dss.cmd'))}""`
    : 'dss'
  const dssArgs = dssArgsOf(ctx).join(' ')
  const envSets = ['set DSS_DAEMON=1&&']
  if (ctx.devSidecarHome) envSets.push(`set DEV_SIDECAR_HOME=${ctx.devSidecarHome}&&`)
  if (ctx.startEnv && ctx.startEnv.PORT) envSets.push(`set PORT=${ctx.startEnv.PORT}&&`)
  if (ctx.startEnv && ctx.startEnv.HOST) envSets.push(`set HOST=${ctx.startEnv.HOST}&&`)
  const inner = `${shim}${dssArgs ? ' ' + dssArgs : ''}`
  // VBS 字符串字面量内的引号需翻倍转义
  const vbs = [
    "' dss 开机自启包装 — 由 dss service install 生成; 无窗口运行, uninstall 时删除",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "cmd /c ${envSets.join(' ')} ${escapeVbsString(inner)}", 0, True`,
  ].join('\r\n')
  const runData = `wscript.exe "${paths.vbs}"`
  return {
    kind: 'runkey',
    name: SERVICE_VALUE_NAME,
    auxFiles: [{ absPath: paths.vbs, content: vbs }],
    definition: {
      runKeyPath: RUN_KEY_PATH,
      valueName: SERVICE_VALUE_NAME,
      data: runData, // 注册表数据(引号内嵌格式)
      logonUser: ctx.user, // HKCU 天然 per-user(不变式②)
      action: { program: 'wscript.exe', args: [paths.vbs] }, // 直接 spawn 用裸路径(node 自行加引号)
      entry: inner,
      daemonMarker: 'DSS_DAEMON=1',
    },
  }
}

function escapeVbsString (s) {
  return String(s).replace(/"/g, '""')
}

/** Linux: 系统级 systemd unit(User=<安装用户>, 系统级需 sudo) + 稳定路径 wrapper */
function createLinuxDefinition (ctx) {
  const paths = servicePaths('linux', ctx.userBasePath)
  const dssArgs = dssArgsOf(ctx).join(' ')
  const execInner = `exec ${paths.wrapper}${dssArgs ? ` ${dssArgs}` : ''}`
  const unit = [
    '[Unit]',
    'Description=Dev-Sidecar Standalone proxy (dss)',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${ctx.user}`,
    `Environment=DSS_DAEMON=1`,
    ctx.devSidecarHome ? `Environment=DEV_SIDECAR_HOME=${ctx.devSidecarHome}` : null,
    ctx.startEnv && ctx.startEnv.PORT ? `Environment=PORT=${ctx.startEnv.PORT}` : null,
    ctx.startEnv && ctx.startEnv.HOST ? `Environment=HOST=${ctx.startEnv.HOST}` : null,
    `ExecStart=/bin/sh -c '${execInner}'`,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].filter((l) => l !== null).join('\n') + '\n'
  return {
    kind: 'systemd',
    name: SERVICE_UNIT_NAME,
    auxFiles: [
      { absPath: paths.wrapper, content: createWrapperContent('linux', ctx), sudo: true },
      { absPath: paths.unit, content: unit, sudo: true },
    ],
    definition: {
      unitName: SERVICE_UNIT_NAME,
      user: ctx.user, // 不变式②
      foregroundEntry: paths.wrapper, // 不变式①: 前台入口
      daemonMarker: 'DSS_DAEMON=1',
      unitContent: unit,
    },
  }
}

/** macOS: 用户级 launchd agent(免 sudo) + 稳定路径 wrapper(数据目录内) */
function createDarwinDefinition (ctx) {
  const paths = servicePaths('darwin', ctx.userBasePath)
  const programArgs = [
    '        <string>/bin/sh</string>',
    '        <string>-c</string>',
    `        <string>exec '${escapeShell(paths.wrapper)}${ctx.configPath ? ` -c \\"${escapeShell(ctx.configPath)}\\"` : ''}'</string>`,
  ].join('\n')
  const envPairs = [
    ['DSS_DAEMON', '1'],
    ctx.devSidecarHome ? ['DEV_SIDECAR_HOME', ctx.devSidecarHome] : null,
    ctx.startEnv && ctx.startEnv.PORT ? ['PORT', ctx.startEnv.PORT] : null,
    ctx.startEnv && ctx.startEnv.HOST ? ['HOST', ctx.startEnv.HOST] : null,
  ].filter(Boolean)
  const envDict = [
    '    <key>EnvironmentVariables</key>',
    '    <dict>',
    ...envPairs.map(([k, v]) => `        <key>${k}</key>\n        <string>${v}</string>`),
    '    </dict>',
  ].join('\n')
  const logPath = escapeShell(posixPath.join(ctx.userBasePath, 'logs', 'launchd.log'))
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
${envDict}
    <key>StandardOutPath</key>
    <string>${logPath}</string>
    <key>StandardErrorPath</key>
    <string>${logPath}</string>
</dict>
</plist>
`
  return {
    kind: 'launchd',
    name: SERVICE_LABEL,
    auxFiles: [
      { absPath: paths.wrapper, content: createWrapperContent('darwin', ctx) },
      { absPath: paths.plist, content: plist },
    ],
    definition: {
      label: SERVICE_LABEL,
      plistPath: paths.plist,
      foregroundEntry: paths.wrapper, // 不变式①
      daemonMarker: 'DSS_DAEMON=1',
      // KeepAlive SuccessfulExit=false: 用户主动 stop(dss stop → SIGTERM → 正常退出 0)不会被拉回,
      // 仅异常退出(非零)拉起 —— 与"仅代理待命"语义对齐
      keepAlive: 'SuccessfulExit=false',
    },
  }
}

module.exports = {
  createServiceDefinition,
  createWrapperContent,
  servicePaths,
  KIND_LABELS,
  SERVICE_VALUE_NAME,
  SERVICE_UNIT_NAME,
  SERVICE_LABEL,
  RUN_KEY_PATH,
  MANIFEST_NAME,
}
