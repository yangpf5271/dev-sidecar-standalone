// 服务编排契约测试 — 幂等覆盖/失败清理/WSL 拒绝/监管器探测/四态判定
// (注入面: runCommand/existsFile/writeFile/unlinkFile/probePort/sudoCopy/sudoRemove/platform/isWSL/readPidInfo)
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
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

const VBS = path.join(CTX.userBasePath, 'dss-service.vbs')

function winOps ({ routes = [], disk = {}, isWSL = () => false, pidInfo = null, cliVersion = '1.6.0' } = {}) {
  const ffs = fakeFs(disk)
  const { run, calls } = recordingFakeRun(routes)
  const ops = createServiceOps({
    platform: 'win32',
    runCommand: run,
    existsFile: ffs.existsFile,
    writeFile: ffs.writeFile,
    unlinkFile: ffs.unlinkFile,
    probePort: async () => true,
    userBasePath: CTX.userBasePath,
    isWSL,
    readPidInfo: () => pidInfo,
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

test('win32 uninstall: reg delete → 删 vbs', async () => {
  const { ops, calls, ffs } = winOps({ disk: { [VBS]: 'fake' } })
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

  const running = winOps({ routes: [[/reg query/, { ok: true }]], pidInfo: { pid: 1, version: '1.6.0', execPath: null }, cliVersion: '1.6.0' })
  assert.equal((await running.ops.status(CTX.addr)).state, 'running')

  const mismatch = winOps({ routes: [[/reg query/, { ok: true }]], pidInfo: { pid: 1, version: '1.5.0', execPath: null }, cliVersion: '1.6.0' })
  const s = await mismatch.ops.status(CTX.addr)
  assert.equal(s.state, 'version-mismatch')
  assert.equal(s.daemonVersion, '1.5.0')
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
  const manifestPath = path.join(CTX.userBasePath, 'dss-service.json')
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
    existsFile: () => true,
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
  const ops = createServiceOps({
    platform: 'darwin',
    runCommand: run,
    existsFile: ffs.existsFile,
    writeFile: ffs.writeFile,
    unlinkFile: ffs.unlinkFile,
    probePort: async () => true,
    userBasePath: '/Users/yangpf/.dev-sidecar',
  })
  const r = await ops.installDefinition({
    user: 'yangpf', userBasePath: '/Users/yangpf/.dev-sidecar', devSidecarHome: null, npmPrefix: null,
    addr: CTX.addr,
  })
  assert.equal(r.ok, true)
  assert.ok(ffs.writes.some((w) => w.p.endsWith('com.dss.daemon.plist')))
  assert.ok(ffs.writes.some((w) => w.p.endsWith('dss-service-wrapper')))
  assert.ok(calls.some((c) => c.includes('launchctl load -w /Users/yangpf/.dev-sidecar/Library/LaunchAgents/com.dss.daemon.plist')))
})
