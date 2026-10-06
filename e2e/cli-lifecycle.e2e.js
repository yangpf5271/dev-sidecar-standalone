// e2e 第二层: CLI 生命周期 — 真实 CLI 子进程 × 隔离 HOME × 真实文件系统副作用
// 覆盖: status 形态 / start→status→stop 生命周期与 PID 清理 / npm on-off 快照恢复 /
//       service 真实 systemd 安装卸载(Linux+systemd+免密 sudo 环境)
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const {
  freePort, isolatedHome, childEnv, waitPort, waitPortClosed, runCli, hasSystemdAndSudo,
} = require('./helpers')
const { spawnSync } = require('node:child_process')

/** 读取隔离 HOME 内的 PID 文件内容 */
function readPidFile (home) {
  try { return fs.readFileSync(path.join(home, '.dev-sidecar', 'dev-sidecar.pid'), 'utf8') } catch { return null }
}

test('CLI status: 代理未运行时如实报告且退出码 0', async () => {
  const home = isolatedHome(test)
  const port = await freePort()
  const r = await runCli(['status'], { home, port })
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes('未运行'), `输出缺"未运行": ${r.stdout}`)
  assert.ok(r.stdout.includes('未生成') || r.stdout.includes('未运行'), '应包含证书/进程状态')
})

test('CLI 生命周期: start → PID 文件 + status 运行中 → stop → 端口关闭 + PID 清理', async () => {
  const home = isolatedHome(test)
  const port = await freePort()

  const started = await runCli(['start'], { home, port })
  assert.equal(started.code, 0, `dss start 失败: ${started.stdout}${started.stderr}`)
  assert.ok(/Daemon PID: \d+/.test(started.stdout), `输出缺 PID: ${started.stdout}`)

  // PID 文件(JSON 化)就位
  const pidRaw = readPidFile(home)
  assert.ok(pidRaw, 'PID 文件应存在')
  const pidInfo = JSON.parse(pidRaw)
  assert.equal(pidInfo.pid > 0, true)
  assert.equal(pidInfo.version, require('../package.json').version, 'PID 文件应记录版本(版本僵比对基准)')

  await waitPort('127.0.0.1', port - 1, 20000)

  const status = await runCli(['status'], { home, port })
  assert.equal(status.code, 0)
  assert.ok(status.stdout.includes('运行中'), `status 应报运行中: ${status.stdout}`)

  const stopped = await runCli(['stop'], { home, port })
  assert.equal(stopped.code, 0)
  assert.ok(stopped.stdout.includes('代理已停止'), stopped.stdout)

  await waitPortClosed('127.0.0.1', port - 1)
  assert.equal(readPidFile(home), null, '停止后 PID 文件应清理')
}, { timeout: 90000 })

test('CLI npm on/off: 隔离 .npmrc 写入代理 → 快照记录 → off 恢复', async () => {
  const home = isolatedHome(test)
  const port = await freePort()

  const on = await runCli(['npm', 'on'], { home, port })
  assert.equal(on.code, 0, `npm on 失败: ${on.stdout}${on.stderr}`)

  const npmrcPath = path.join(home, '.npmrc')
  if (!fs.existsSync(npmrcPath)) {
    throw new Error(`.npmrc 未生成; home 内容: ${fs.readdirSync(home)}; on 输出: ${on.stdout}${on.stderr}`)
  }
  const npmrc = fs.readFileSync(npmrcPath, 'utf8')
  assert.ok(npmrc.includes(`proxy=http://127.0.0.1:${port - 1}`), `.npmrc 应写入代理: ${npmrc}`)
  assert.ok(npmrc.includes('https-proxy='), '.npmrc 应写入 https-proxy')

  const snapPath = path.join(home, '.dev-sidecar', 'last-applied.json')
  assert.ok(fs.existsSync(snapPath), '快照文件应存在(智能恢复基准)')
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'))
  assert.ok(snap.npm && snap.npm.proxy, '快照应记录 npm 段')

  const off = await runCli(['npm', 'off'], { home, port })
  assert.equal(off.code, 0)
  // off 后 .npmrc 变空时 npm 会删除空 userconfig 文件 — 文件消失也是"代理配置已移除"的合法终态
  const npmrcAfter = fs.existsSync(npmrcPath) ? fs.readFileSync(npmrcPath, 'utf8') : ''
  assert.ok(!npmrcAfter.includes(`proxy=http://127.0.0.1:${port - 1}`), 'off 后代理配置应移除')
}, { timeout: 60000 })

test('CLI service: 真实 systemd 安装 → active → 卸载 → 移除(Linux+systemd+免密 sudo)', { skip: !hasSystemdAndSudo() }, async () => {
  const home = isolatedHome(test)
  const port = await freePort()
  const repo = path.join(__dirname, '..')
  const nodeExe = process.execPath

  // 前置: 全局安装(CI runner 的 systemd 默认 PATH 里有 npm 全局 bin, wrapper 依赖它)
  const gi = spawnSync('sudo', ['-n', 'npm', 'install', '-g', repo], { encoding: 'utf8' })
  assert.equal(gi.status, 0, `全局安装失败: ${gi.stderr}`)

  const install = spawnSync('sudo', ['-n', nodeExe, path.join(repo, 'index.js'), 'service', 'install'],
    { env: childEnv({ home, port }), encoding: 'utf8', cwd: repo })
  assert.equal(install.status, 0, `service install 失败: ${install.stdout}${install.stderr}`)

  const active = spawnSync('systemctl', ['is-active', 'dss.service'], { encoding: 'utf8' })
  assert.equal(active.stdout.trim(), 'active', 'unit 应处于 active')

  const svcStatus = spawnSync('sudo', ['-n', nodeExe, path.join(repo, 'index.js'), 'service', 'status'],
    { env: childEnv({ home, port }), encoding: 'utf8', cwd: repo })
  assert.ok(svcStatus.stdout.includes('运行中') || svcStatus.stdout.includes('版本不一致'),
    `service status 应报运行态: ${svcStatus.stdout}`)

  const uninstall = spawnSync('sudo', ['-n', nodeExe, path.join(repo, 'index.js'), 'service', 'uninstall'],
    { env: childEnv({ home, port }), encoding: 'utf8', cwd: repo })
  assert.equal(uninstall.status, 0, `service uninstall 失败: ${uninstall.stdout}${uninstall.stderr}`)

  const gone = spawnSync('systemctl', ['is-active', 'dss.service'], { encoding: 'utf8' })
  assert.notEqual(gone.stdout.trim(), 'active', '卸载后 unit 不应再 active')
}, { timeout: 120000 })
