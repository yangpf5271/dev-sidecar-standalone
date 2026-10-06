// 服务编排契约测试 — 幂等覆盖/失败清理/WSL 拒绝/监管器探测/四态判定
// (注入面: runCommand/existsFile/writeFile/unlinkFile/probePort/sudoCopy/sudoRemove/platform/isWSL/readPidInfo)
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { posix: posixPath, win32: win32Path } = require('node:path')
const os = require('node:os')
const { createServiceOps } = require('./service-ops')
const { fakeRun } = require('../tool-config/helpers')

/** 假文件系统: 内存 map 充当磁盘 */
function fakeFs (initial = {}) {
  const disk = new Map(Object.entries(initial))
  const writes = []
  return {
    disk,
    writes,
    existsFile: (p) => disk.has(p),
    writeFile: (p, c) => { disk.set(p, c); writes.push({ p, c }) },
    unlinkFile: (p) => { disk.delete(p) },
  }
}

/** 手工记录型假执行器(fakeRun 之上加调用流水) */
function recordingFakeRun (routes = []) {
  const calls = []
  const run = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    for (const [pattern, resp] of routes) {
      if (typeof pattern === 'string' ? key === pattern : pattern.test(key)) {
        return typeof resp === 'function' ? resp(...args) : resp
      }
    }
    return { ok: true, stdout: '', stderr: '' }
  }
  return { run, calls }
}

const CTX = {
  user: 'yangpf',
  userBasePath: 'C:\\Users\\90904\\.dev-sidecar',
  devSidecarHome: null,
  npmPrefix: 'C:\\npm',
  addr: { host: '127.0.0.1', mitmPort: 31181, httpPort: 31180 },
}

// fake-disk 的 key 必须与实现同款 joinFor 平台语义 —— 宿主 path 模块在 Linux 宿主上
// 会产生混合分隔符, 与实现的 win32Path 产物错位(CI 实测), 故按平台显式选择
const VBS = win32Path.join(CTX.userBasePath, 'dss-service.vbs')

function winOps ({ routes = [], disk = {}, isWSL = () => false, pidInfo = null, cliVersion = '1.6.0', pidTrusted = true, portUp = true } = {}) {
  const ffs = fakeFs(disk)
  const { run, calls } = recordingFakeRun(routes)
  const ops = createServiceOps({
    platform: 'win32',
    runCommand: run,
    existsFile: ffs.existsFile,
    writeFile: ffs.writeFile,
    unlinkFile: ffs.unlinkFile,
    probePort: async () => portUp,
    userBasePath: CTX.userBasePath,
    isWSL,
    readPidInfo: () => pidInfo,
    verifyProcessIdentity: async () => pidTrusted,
    cliVersion,
  })
  return { ops, calls, ffs }
}

test('win32 installDefinition: 写 vbs → 注册 Run 键 → 定义存在性验证通过(不含任何拉起动作)', async () => {
  const { ops, calls, ffs } = winOps()
  const r = await ops.installDefinition(CTX)
  assert.equal(r.ok, true)
  assert.equal(r.installed, true)
  assert.ok(ffs.writes.some((w) => w.p.endsWith('dss-service.vbs')))
  assert.ok(calls.some((c) => c.includes('reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v dss-autostart')))
  assert.ok(calls.some((c) => c.includes('reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v dss-autostart'))) // 定义存在性验证
  assert.equal(calls.some((c) => /^wscript /.test(c)), false, '编排层不得以 wscript 为命令启动进程(WSH 在脏环境下弹内存不足对话框)')
})

test('win32 installDefinition: 幂等覆盖 — 已在管时先移除旧定义再创建', async () => {
  const { ops, calls } = winOps()
  const r = await ops.installDefinition(CTX)
  assert.equal(r.ok, true)
  assert.equal(r.wasInstalled, true) // 首次 install 时 reg query ok → 视为覆盖
  const addIdx = calls.findIndex((c) => c.includes('reg add'))
  assert.ok(calls.slice(0, addIdx).some((c) => c.includes('reg delete')), '创建前先删旧 Run 键')
})

test('win32 installDefinition: reg add 失败 → ok:false 且错误可读', async () => {
  const { ops } = winOps({ routes: [[/reg add/, { ok: false, stderr: 'Access is denied.' }]] })
  const r = await ops.installDefinition(CTX)
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('Access is denied'))
})

test('win32 uninstall: reg delete → 删 vbs(移除后 query 失败=键已不存在)', async () => {
  const { ops, calls, ffs } = winOps({ disk: { [VBS]: 'fake' }, routes: [[/reg query/, { ok: false, stderr: 'unable to find' }]] })
  const r = await ops.removeDefinition()
  assert.equal(r.ok, true)
  assert.ok(calls.some((c) => c.includes('reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v dss-autostart /f')))
  assert.equal(ffs.disk.has(VBS), false)
})

test('detectSupervisor: win32 按任务查询 / linux 按 unit 文件 / darwin 按 plist', async () => {
  const w = createServiceOps({
    platform: 'win32',
    runCommand: recordingFakeRun([[/reg query/, { ok: false, stderr: 'unable to find' }]]).run,
    userBasePath: CTX.userBasePath,
  })
  assert.equal(await w.detectSupervisor(), false)

  const unitPath = '/etc/systemd/system/dss.service'
  const l = createServiceOps({
    platform: 'linux',
    runCommand: recordingFakeRun().run,
    existsFile: (p) => p === unitPath,
    userBasePath: '/home/x/.dev-sidecar',
  })
  assert.equal(await l.detectSupervisor(), true)

  const plistPath = '/home/x/.dev-sidecar/Library/LaunchAgents/com.dss.daemon.plist' // POSIX 语义(与生成器一致)
  const d = createServiceOps({
    platform: 'darwin',
    runCommand: recordingFakeRun().run,
    existsFile: (p) => p === plistPath,
    userBasePath: '/home/x/.dev-sidecar',
  })
  assert.equal(await d.detectSupervisor(), true)
})

test('status 四态: 未安装/已安装未运行/运行中/版本不一致', async () => {
  const notInstalled = winOps({ routes: [[/reg query/, { ok: false }]] })
  assert.equal((await notInstalled.ops.status(CTX.addr)).state, 'not-installed')

  // PID 无 + 端口探测失败 → 已安装但未运行(独立注入 probePort=false)
  const notRunning = createServiceOps({
    platform: 'win32',
    runCommand: recordingFakeRun([[/reg query/, { ok: true }]]).run,
    existsFile: () => false,
    probePort: async () => false,
    userBasePath: CTX.userBasePath,
    readPidInfo: () => null,
  })
  assert.equal((await notRunning.status(CTX.addr)).state, 'installed-not-running')

  // pid 用 process.pid: 存活探测必须通过才能进入版本比对(身份验证由 winOps 注入为 true)
  const running = winOps({ routes: [[/reg query/, { ok: true }]], pidInfo: { pid: process.pid, version: '1.6.0', execPath: null }, cliVersion: '1.6.0' })
  assert.equal((await running.ops.status(CTX.addr)).state, 'running')

  const mismatch = winOps({ routes: [[/reg query/, { ok: true }]], pidInfo: { pid: process.pid, version: '1.5.0', execPath: null }, cliVersion: '1.6.0' })
  const s = await mismatch.ops.status(CTX.addr)
  assert.equal(s.state, 'version-mismatch')
  assert.equal(s.daemonVersion, '1.5.0')
})

test('P1 版本僵假阳消除: PID 身份验证失败 → 版本比对静默跳过(运行证据仅来自端口)', async () => {
  const untrusted = winOps({ routes: [[/reg query/, { ok: true }]], pidInfo: { pid: 1, version: '1.0.0', execPath: null }, cliVersion: '1.6.0', pidTrusted: false })
  const s = await untrusted.ops.status(CTX.addr)
  assert.equal(s.state, 'running')
  assert.equal(s.versionMismatch, false, '不可信 PID 的版本不得给活进程报假告警')
  assert.equal(s.daemonVersion, null)
})

test('P1 假绿消除: PID 存活但身份验证失败 + 端口不通 → 已安装未运行(不被无关进程撑出假绿)', async () => {
  // pid=process.pid 保证存活探测通过, 身份验证注入 false → 不可信
  const ops = createServiceOps({
    platform: 'win32',
    runCommand: recordingFakeRun([[/reg query/, { ok: true }]]).run,
    existsFile: () => false,
    probePort: async () => false,
    userBasePath: CTX.userBasePath,
    readPidInfo: () => ({ pid: process.pid, version: '1.6.0', execPath: null }),
    verifyProcessIdentity: async () => false,
    cliVersion: '1.6.0',
  })
  const s = await ops.status(CTX.addr)
  assert.equal(s.state, 'installed-not-running')
})

test('P1 崩溃循环: activating+重启计数≥2(auto-restart 退避窗) → crashLoop true', async () => {
  const unitPath = '/etc/systemd/system/dss.service'
  const ops = createServiceOps({
    platform: 'linux',
    runCommand: recordingFakeRun([
      [/systemctl show/, { ok: true, stdout: 'ActiveState=activating\nNRestarts=3\nResult=exit-code' }],
    ]).run,
    existsFile: (p) => p === unitPath,
    probePort: async () => false, // 代理未起 — 循环表象恰是 installed-not-running
    userBasePath: '/home/yangpf/.dev-sidecar',
    readPidInfo: () => null,
    verifyProcessIdentity: async () => false,
  })
  const s = await ops.status({ host: '127.0.0.1', httpPort: 31180, mitmPort: 31181 })
  assert.equal(s.state, 'installed-not-running')
  assert.equal(s.crashLoop, true)
})

test('P1 崩溃循环: systemd failed/NRestarts>=3 → crashLoop 主动信号(Linux)', async () => {
  const unitPath = '/etc/systemd/system/dss.service'
  const ops = createServiceOps({
    platform: 'linux',
    runCommand: recordingFakeRun([
      [/systemctl show/, { ok: true, stdout: 'ActiveState=failed\nNRestarts=7\nResult=exit-code' }],
    ]).run,
    existsFile: (p) => p === unitPath,
    probePort: async () => true,
    userBasePath: '/home/yangpf/.dev-sidecar',
    readPidInfo: () => null,
    verifyProcessIdentity: async () => false,
  })
  const s = await ops.status({ host: '127.0.0.1', httpPort: 31180, mitmPort: 31181 })
  assert.equal(s.crashLoop, true)
  assert.equal(s.crash.activeState, 'failed')
})

test('P1 无崩溃循环: ActiveState=running → crashLoop false; 非 Linux → null', async () => {
  const unitPath = '/etc/systemd/system/dss.service'
  const l = createServiceOps({
    platform: 'linux',
    runCommand: recordingFakeRun([
      [/systemctl show/, { ok: true, stdout: 'ActiveState=running\nNRestarts=0\nResult=success' }],
    ]).run,
    existsFile: (p) => p === unitPath,
    probePort: async () => true,
    userBasePath: '/home/yangpf/.dev-sidecar',
    readPidInfo: () => null,
  })
  const s = await l.status({ host: '127.0.0.1', httpPort: 31180, mitmPort: 31181 })
  assert.equal(s.crashLoop, false)

  const w = winOps({ routes: [[/reg query/, { ok: true }]], pidInfo: { pid: 1, version: '1.6.0', execPath: null }, cliVersion: '1.6.0' })
  const sw = await w.ops.status(CTX.addr)
  assert.equal(sw.crash, null)
})

test('P1 重放补全: 固化 configPath 文件被删 → 漂移告警', () => {
  const ops = createServiceOps({
    platform: 'win32',
    runCommand: recordingFakeRun().run,
    userBasePath: CTX.userBasePath,
    existsFile: (p) => p !== 'D:\gone\config.json', // 其它文件存在, 配置文件已删
  })
  const drifts = ops.replayDrifts(
    { npmPrefix: null, devSidecarHome: null, startEnv: {}, configPath: 'D:\gone\config.json' },
    { devSidecarHome: null, npmPrefix: null, startEnv: {} },
  )
  assert.equal(drifts.length, 1)
  assert.ok(drifts[0].includes('配置文件失效'))
})

test('win32 installDefinition: 失败回滚 — reg add 失败后 vbs 被清理(不留半成品)', async () => {
  const { ops, ffs } = winOps({ routes: [[/reg add/, { ok: false, stderr: 'denied' }]] })
  const r = await ops.installDefinition(CTX)
  assert.equal(r.ok, false)
  assert.equal(ffs.disk.has(VBS), false, '回滚应删除已写入的 vbs')
})

test('linux installDefinition: sudo 中途失败 → 回滚已就位的 wrapper', async () => {
  const { run } = recordingFakeRun()
  const ffs = fakeFs()
  let calls = 0
  const ops = createServiceOps({
    platform: 'linux',
    runCommand: run,
    existsFile: ffs.existsFile,
    writeFile: ffs.writeFile,
    unlinkFile: ffs.unlinkFile,
    probePort: async () => true,
    userBasePath: '/home/yangpf/.dev-sidecar',
    sudoCopy: async (src, dst) => {
      calls += 1
      if (calls === 1) { ffs.disk.set(dst, 'placed'); return { ok: true } } // wrapper 就位
      return { ok: false, error: 'denied' } // unit 复制失败
    },
    sudoRemove: async (targets) => { for (const t of targets) ffs.disk.delete(t); return { ok: true } },
  })
  const r = await ops.installDefinition({ user: 'yangpf', userBasePath: '/home/yangpf/.dev-sidecar', devSidecarHome: null, npmPrefix: null, addr: CTX.addr })
  assert.equal(r.ok, false)
  assert.equal(ffs.disk.has('/usr/local/bin/dss-service-wrapper'), false, '回滚应删除已就位的 wrapper')
})

test('installDefinition: 写入安装解析快照 manifest(不变式③基准)', async () => {
  const { ops, ffs } = winOps({ disk: {}, cliVersion: '1.6.0' })
  const r = await ops.installDefinition({ ...CTX, startEnv: { PORT: '44181' } })
  assert.equal(r.ok, true)
  const manifestPath = win32Path.join(os.homedir(), '.dev-sidecar', 'dss-service.json') // 实现: 固定默认主目录(刻意不跟随 DEV_SIDECAR_HOME)
  assert.ok(ffs.disk.has(manifestPath))
  const m = JSON.parse(ffs.disk.get(manifestPath))
  assert.equal(m.installedVersion, '1.6.0')
  assert.equal(m.startEnv.PORT, '44181')
  assert.equal(m.httpPort, CTX.addr.httpPort)
})

test('replayDrifts: 数据目录漂移 / 入口失效 / 无快照跳过', () => {
  const ops = createServiceOps({
    platform: 'win32',
    runCommand: recordingFakeRun().run,
    userBasePath: CTX.userBasePath,
    existsFile: (p) => p === 'C:\\npm\\dss.cmd', // shim 仍在
  })
  const manifest = { npmPrefix: 'C:\\npm', devSidecarHome: null, startEnv: {}, configPath: null }
  assert.deepEqual(ops.replayDrifts(null, { devSidecarHome: null, npmPrefix: null, startEnv: {} }), [])

  const drift1 = ops.replayDrifts(manifest, { devSidecarHome: 'D:\\other', npmPrefix: null, startEnv: {} })
  assert.equal(drift1.length, 1)
  assert.ok(drift1[0].includes('数据目录漂移'))

  const drift2 = ops.replayDrifts(manifest, { devSidecarHome: null, npmPrefix: null, startEnv: {} })
  assert.deepEqual(drift2, []) // shim 存在 + 目录一致 → 无漂移

  const ops2 = createServiceOps({
    platform: 'win32',
    runCommand: recordingFakeRun().run,
    userBasePath: CTX.userBasePath,
    existsFile: () => false, // shim 消失
  })
  const drift3 = ops2.replayDrifts(manifest, { devSidecarHome: null, npmPrefix: null, startEnv: {} })
  assert.equal(drift3.length, 1)
  assert.ok(drift3[0].includes('入口失效'))
})

// ---------------------------------------------------------------------------
// P0 修复回归 — 议会判定书 c-20261006-121045-i1z4 四项
// ---------------------------------------------------------------------------

test('P0-1 manifest 写失败: 降级为成功+警告, 不再报假失败', async () => {
  const manifestPath = win32Path.join(os.homedir(), '.dev-sidecar', 'dss-service.json') // 实现: 固定默认主目录(刻意不跟随 DEV_SIDECAR_HOME)
  const { ops, ffs } = winOps({ disk: {} })
  // 模拟: manifest 目录不可写(vbs 可写) —— 用 writeFile 注入对 manifest 路径抛错
  const ops2 = createServiceOps({
    platform: 'win32',
    runCommand: recordingFakeRun().run,
    existsFile: ffs.existsFile,
    writeFile: (p, c, o) => {
      if (p.endsWith('dss-service.json')) throw new Error('EACCES: readonly')
      ffs.writeFile(p, c, o)
    },
    unlinkFile: ffs.unlinkFile,
    probePort: async () => true,
    userBasePath: CTX.userBasePath,
    isWSL: () => false,
  })
  const r = await ops2.installDefinition(CTX)
  assert.equal(r.ok, true, '定义已注册且验证通过, manifest 失败不得报假失败')
  assert.ok(r.warning && r.warning.includes('安装快照写入失败'), '必须以警告显式声明漂移检测不可用')
  assert.equal(ffs.disk.has(manifestPath), false)
  void ops
})

test('P0-2 removeDefinition: reg delete 失败且键仍在 → ok:false 真实报告', async () => {
  const { ops } = winOps({ routes: [[/reg delete/, { ok: false, stderr: 'denied' }], [/reg query/, { ok: true }]] })
  const r = await ops.removeDefinition()
  assert.equal(r.ok, false, '键仍在管时必须真实报告失败')
  assert.ok(r.notes.some((n) => n.includes('仍在管')))
})

test('P0-2 removeDefinition: 未安装时(键本不存在, query 也失败) → ok:true 幂等', async () => {
  const { ops } = winOps({ routes: [[/reg delete/, { ok: false, stderr: 'unable to find' }], [/reg query/, { ok: false }]] })
  const r = await ops.removeDefinition()
  assert.equal(r.ok, true)
})

test('P0-3 isWSL fail-closed: 环境变量快路径命中 → true(正路)', () => {
  const ops = createServiceOps({
    platform: 'win32',
    runCommand: recordingFakeRun().run,
    userBasePath: CTX.userBasePath,
    spawnSyncOverride: undefined,
  })
  // spawnSync 不在注入面 — 通过 delete 注入不可行, 改为直接验证模块行为:
  // 用 deps 注入不存在(默认 spawnSync), 无法模拟 PS 失败; 该路径由父链实现内测。
  // 这里验证: 环境变量命中时(fail-open 的正路)仍正常返回 true
  process.env.WSL_DISTRO_NAME = 'Ubuntu'
  try {
    assert.equal(ops.isWSL(), true)
  } finally {
    delete process.env.WSL_DISTRO_NAME
  }
})

test('P0-4 覆盖安装失败: 回滚至装前状态(旧 vbs 内容恢复, 新文件被清理)', async () => {
  const OLD_VBS = 'old vbs content'
  const { ops, ffs, calls } = winOps({
    disk: { [VBS]: OLD_VBS }, // 装前已有旧定义(vbs 在)
    routes: [[/reg add/, { ok: false, stderr: 'denied' }]], // 新装注册失败
  })
  // readFile 走 fake 磁盘(safeRead 需要与 existsFile 同一存储域)
  const ops2 = createServiceOps({
    platform: 'win32',
    runCommand: recordingFakeRun([[/reg add/, { ok: false, stderr: 'denied' }]]).run,
    existsFile: ffs.existsFile,
    writeFile: ffs.writeFile,
    unlinkFile: ffs.unlinkFile,
    readFile: (p) => {
      if (!ffs.disk.has(p)) throw new Error('ENOENT')
      return ffs.disk.get(p)
    },
    probePort: async () => true,
    userBasePath: CTX.userBasePath,
    isWSL: () => false,
  })
  void ops; void calls
  const r = await ops2.installDefinition(CTX)
  assert.equal(r.ok, false)
  // 回滚基线=装前状态: 旧 vbs 内容被恢复(而非删除)
  assert.equal(ffs.disk.get(VBS), OLD_VBS, '覆盖失败应恢复旧定义内容')
})

test('P0-4 首次安装失败: 无旧快照 → 清理本次文件(原回滚语义)', async () => {
  const { ops, ffs } = winOps({ routes: [[/reg add/, { ok: false, stderr: 'denied' }]] })
  const r = await ops.installDefinition(CTX)
  assert.equal(r.ok, false)
  assert.equal(ffs.disk.has(VBS), false)
})

test('managerStopHint: 按平台给出管理器通道命令', () => {
  const w = createServiceOps({ platform: 'win32', runCommand: recordingFakeRun().run, userBasePath: CTX.userBasePath })
  assert.ok(w.managerStopHint().includes('dss stop'))
  const l = createServiceOps({ platform: 'linux', runCommand: recordingFakeRun().run, userBasePath: '/h/.dev-sidecar' })
  assert.ok(l.managerStopHint().includes('systemctl stop dss.service'))
  const d = createServiceOps({ platform: 'darwin', runCommand: recordingFakeRun().run, userBasePath: '/h/.dev-sidecar' })
  assert.ok(d.managerStopHint().includes('launchctl unload'))
})

test('linux installDefinition: wrapper+unit 经 sudo 原子就位 → daemon-reload → enable --now', async () => {
  const { run, calls } = recordingFakeRun()
  const ffs = fakeFs()
  const sudoCopies = []
  const ops = createServiceOps({
    platform: 'linux',
    runCommand: run,
    existsFile: ffs.existsFile,
    writeFile: ffs.writeFile,
    unlinkFile: ffs.unlinkFile,
    probePort: async () => true,
    userBasePath: '/home/yangpf/.dev-sidecar',
    sudoCopy: async (src, dst) => { sudoCopies.push(dst); ffs.disk.set(dst, ffs.disk.get(src) || ''); return { ok: true } },
  })
  const r = await ops.installDefinition({
    user: 'yangpf', userBasePath: '/home/yangpf/.dev-sidecar', devSidecarHome: null, npmPrefix: null,
    addr: CTX.addr,
  })
  assert.equal(r.ok, true)
  assert.deepEqual(sudoCopies.sort(), ['/etc/systemd/system/dss.service', '/usr/local/bin/dss-service-wrapper'])
  assert.ok(calls.some((c) => c.includes('sudo systemctl daemon-reload')))
  assert.ok(calls.some((c) => c.includes('sudo systemctl enable --now dss.service')))
})

test('linux uninstall: disable --now → sudo rm → daemon-reload', async () => {
  const { run, calls } = recordingFakeRun()
  const removed = []
  const ops = createServiceOps({
    platform: 'linux',
    runCommand: run,
    existsFile: (p) => p === '/etc/systemd/system/dss.service' && !removed.includes(p), // rm 后视为已移除
    userBasePath: '/home/yangpf/.dev-sidecar',
    sudoRemove: async (targets) => { removed.push(...targets); return { ok: true } },
  })
  const r = await ops.removeDefinition()
  assert.equal(r.ok, true)
  assert.ok(removed.includes('/etc/systemd/system/dss.service'))
  assert.ok(removed.includes('/usr/local/bin/dss-service-wrapper'))
  assert.ok(calls.some((c) => c.includes('sudo systemctl disable --now dss.service')))
  assert.ok(calls.some((c) => c.includes('sudo systemctl daemon-reload')))
})

test('darwin installDefinition: plist+wrapper 落用户目录(免 sudo) → launchctl load', async () => {
  const { run, calls } = recordingFakeRun()
  const ffs = fakeFs()
  // userBasePath 用 runner/CI 均可写的 posix 深路径(真实 macOS 形态是 /Users/<u>/.dev-sidecar,
  // 但 CI Linux runner 无权 mkdir /Users —— 单测关心编排逻辑而非宿主权限)
  const darwinBase = posixPath.join(os.tmpdir(), 'Users', 'yangpf', '.dev-sidecar')
  const ops = createServiceOps({
    platform: 'darwin',
    runCommand: run,
    existsFile: ffs.existsFile,
    writeFile: ffs.writeFile,
    unlinkFile: ffs.unlinkFile,
    probePort: async () => true,
    userBasePath: darwinBase,
  })
  const r = await ops.installDefinition({
    user: 'yangpf', userBasePath: darwinBase, devSidecarHome: null, npmPrefix: null,
    addr: CTX.addr,
  })
  assert.equal(r.ok, true)
  assert.ok(ffs.writes.some((w) => w.p.endsWith('com.dss.daemon.plist')))
  assert.ok(ffs.writes.some((w) => w.p.endsWith('dss-service-wrapper')))
  assert.ok(calls.some((c) => c.includes(`launchctl load -w ${darwinBase}/Library/LaunchAgents/com.dss.daemon.plist`)))
})
