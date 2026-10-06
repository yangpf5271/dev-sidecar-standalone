// 服务定义生成器契约测试 — 三不变式负例锁定 / PATH 解析式 / 数据目录钉死 / 守护标记
// (规格: openspec service-management; 全部断言脱离真实平台可跑)
const { test } = require('node:test')
const assert = require('node:assert')
const {
  createServiceDefinition,
  createWrapperContent,
  SERVICE_VALUE_NAME,
  SERVICE_UNIT_NAME,
  SERVICE_LABEL,
} = require('./service-definitions')

const CTX = {
  user: 'yangpf',
  userBasePath: 'C:\\Users\\90904\\.dev-sidecar',
  devSidecarHome: null,
  npmPrefix: 'C:\\Users\\90904\\AppData\\Roaming\\npm',
  host: '127.0.0.1',
  mitmPort: 31181,
}

// ---------------------------------------------------------------------------
// 不变式①: 入口恒为前台 dss — 全平台模板禁止后台启动子命令
// ---------------------------------------------------------------------------

test('三平台模板负例: 禁止后台启动子命令(dss start / dss -d / --daemon)', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const def = createServiceDefinition(platform, CTX)
    const allText = JSON.stringify(def.auxFiles) + JSON.stringify(def.definition)
    assert.equal(/dss\s+start/.test(allText), false, `${platform} 模板出现 dss start`)
    assert.equal(/dss\s+-d\b/.test(allText), false, `${platform} 模板出现 dss -d`)
    assert.equal(/--daemon/.test(allText), false, `${platform} 模板出现 --daemon`)
    assert.equal(/DSS_DAEMON=1/.test(allText), true, `${platform} 模板缺守护标记`) // 前台拉起共享 PID 簿记
  }
})

// ---------------------------------------------------------------------------
// 不变式②: 运行身份恒为安装用户 — Windows 禁 ONSTART/SYSTEM
// ---------------------------------------------------------------------------

test('Windows 定义: HKCU Run 登录项(免管理员, 天然 per-user) + 无窗口包装', () => {
  const def = createServiceDefinition('win32', CTX)
  assert.equal(def.kind, 'runkey')
  assert.equal(def.name, SERVICE_VALUE_NAME)
  assert.equal(/ONSTART|SYSTEM/i.test(JSON.stringify(def)), false)
  assert.equal(def.definition.logonUser, 'yangpf') // HKCU 天然绑定安装用户(不变式②)
  assert.ok(def.definition.runKeyPath.includes('CurrentVersion\\Run'))
  assert.ok(def.definition.data.startsWith('wscript.exe "')) // Run 键数据 = 无窗口包装命令
  // wscript 无窗口包装; vbs 是唯一的 aux 文件; 守护标记 + 隐藏窗口参数
  assert.equal(def.definition.action.program, 'wscript.exe')
  assert.equal(def.auxFiles.length, 1)
  assert.ok(def.auxFiles[0].absPath.endsWith('dss-service.vbs'))
  const vbsOneLine = def.auxFiles[0].content.replace(/\r\n/g, ' ')
  assert.ok(/Run "cmd \/c set DSS_DAEMON=1&& /.test(vbsOneLine))
  assert.ok(/, 0, True/.test(vbsOneLine)) // 0=隐藏窗口, True=等待
})

test('Windows 定义: npm 前缀 shim 优先且加引号; 前缀未知时回退 PATH 解析', () => {
  const withPrefix = createServiceDefinition('win32', CTX)
  assert.ok(withPrefix.auxFiles[0].content.includes('AppData\\Roaming\\npm\\dss.cmd'))

  const noPrefix = createServiceDefinition('win32', { ...CTX, npmPrefix: null })
  assert.ok(noPrefix.auxFiles[0].content.includes(' dss"')) // 裸 dss = PATH 解析
  assert.ok(!noPrefix.auxFiles[0].content.includes('node.exe')) // 绝不写死解释器
})

// ---------------------------------------------------------------------------

test('Linux 定义: 系统级 unit 含 User= 与 Restart=always, wrapper 为前台入口', () => {
  const def = createServiceDefinition('linux', { ...CTX, userBasePath: '/home/yangpf/.dev-sidecar' })
  assert.equal(def.kind, 'systemd')
  assert.equal(def.name, SERVICE_UNIT_NAME)
  const unit = def.definition.unitContent
  assert.ok(unit.includes('User=yangpf'))
  assert.ok(unit.includes('Restart=always'))
  assert.ok(unit.includes('WantedBy=multi-user.target'))
  assert.ok(unit.includes('Environment=DSS_DAEMON=1'))
  assert.ok(unit.includes("ExecStart=/bin/sh -c 'exec /usr/local/bin/dss-service-wrapper'"))
  // sudo 标记: unit 与 wrapper 都落系统路径
  assert.ok(def.auxFiles.every((f) => f.sudo === true))
})

test('macOS 定义: launchd RunAtLoad + KeepAlive 仅异常退出拉起, 用户级免 sudo', () => {
  const def = createServiceDefinition('darwin', { ...CTX, userBasePath: '/Users/yangpf/.dev-sidecar' })
  assert.equal(def.kind, 'launchd')
  assert.equal(def.name, SERVICE_LABEL)
  const plist = def.auxFiles.find((f) => f.absPath.endsWith('.plist'))
  assert.ok(plist)
  assert.ok(plist.content.includes(`<key>Label</key>\n    <string>${SERVICE_LABEL}</string>`))
  assert.ok(plist.content.includes('<key>RunAtLoad</key>'))
  assert.ok(plist.content.includes('<key>SuccessfulExit</key>\n        <false/>'))
  assert.ok(def.auxFiles.every((f) => f.sudo !== true)) // 用户级, 无 sudo 标记
})

// ---------------------------------------------------------------------------
// PATH 解析式 + 数据目录钉死 + nvm wrapper 语义
// ---------------------------------------------------------------------------

test('wrapper: 每次启动重扫 nvm 版本目录(sort -V 取最新), 回退 PATH; 不写死解释器', () => {
  const w = createWrapperContent('linux', CTX)
  assert.ok(w.includes('sort -V | tail -1'))
  assert.ok(w.includes('exec dss'))
  assert.ok(!w.includes('node.exe') && !w.includes('/bin/node'))
})

test('wrapper: systemd 环境经 /etc/passwd 取主目录, darwin 用 HOME', () => {
  assert.ok(createWrapperContent('linux', CTX).includes('getent passwd'))
  assert.ok(createWrapperContent('darwin', CTX).includes('${HOME:-'))
})

test('数据目录钉死: DEV_SIDECAR_HOME 设置时固化进三平台定义; 未设置时不出现', () => {
  const home = 'D:\\data\\dss-home'
  const win = createServiceDefinition('win32', { ...CTX, devSidecarHome: home })
  assert.ok(win.auxFiles[0].content.includes(`set DEV_SIDECAR_HOME=${home}&&`))

  const linux = createServiceDefinition('linux', { ...CTX, devSidecarHome: '/data/dss-home' })
  assert.ok(linux.definition.unitContent.includes('Environment=DEV_SIDECAR_HOME=/data/dss-home'))

  const darwin = createServiceDefinition('darwin', { ...CTX, devSidecarHome: '/data/dss-home' })
  assert.ok(darwin.auxFiles.find((f) => f.absPath.endsWith('.plist')).content.includes('DEV_SIDECAR_HOME'))

  // 未设置: 三平台定义中不出现该键(Windows 回退 ONLOGON 会话天然一致)
  const winNone = createServiceDefinition('win32', CTX)
  assert.ok(!winNone.auxFiles[0].content.includes('DEV_SIDECAR_HOME'))
  const linuxNone = createServiceDefinition('linux', CTX)
  assert.ok(!linuxNone.definition.unitContent.includes('DEV_SIDECAR_HOME'))
})

test('未知平台拒绝生成(三平台枚举之外视为编程错误)', () => {
  assert.throws(() => createServiceDefinition('sunos', CTX))
})
