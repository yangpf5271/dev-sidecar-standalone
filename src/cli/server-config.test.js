// server-config 单点契约测试 — 双结构等效/环境变量覆盖/归一化
// (此处锁定的分叉曾真实存在: 平铺配置只在命令侧生效, 守护进程侧不识别)
const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  readConfigJson,
  serverOf,
  withEnvOverride,
  normalizeServer,
  DEFAULT_CONFIG_FILE,
  DEFAULT_MITM_PORT,
} = require('./server-config')

let tmpDir
let savedEnv

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-srv-cfg-test-'))
  savedEnv = { PORT: process.env.PORT, HOST: process.env.HOST }
  delete process.env.PORT
  delete process.env.HOST
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  if (savedEnv.PORT != null) process.env.PORT = savedEnv.PORT
  if (savedEnv.HOST != null) process.env.HOST = savedEnv.HOST
})

function writeCfg (name, obj) {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8')
  return p
}

test('readConfigJson: ok / read 失败 / parse 失败 三态且 phase 可区分', () => {
  const ok = readConfigJson(writeCfg('ok.json', { server: { port: 42181 } }))
  assert.equal(ok.ok, true)
  assert.equal(ok.config.server.port, 42181)

  const bad = readConfigJson(path.join(tmpDir, 'missing.json'))
  assert.equal(bad.ok, false)
  assert.equal(bad.phase, 'read')

  const p = path.join(tmpDir, 'broken.json')
  fs.writeFileSync(p, '{not json', 'utf8')
  const broken = readConfigJson(p)
  assert.equal(broken.ok, false)
  assert.equal(broken.phase, 'parse')
})

test('serverOf: 嵌套与平铺等效提取, 缺失项为 null, 非对象输入安全', () => {
  const nested = serverOf({ server: { host: '0.0.0.0', port: 42181 } })
  assert.deepEqual(nested, { host: '0.0.0.0', port: 42181 })

  const flat = serverOf({ host: '0.0.0.0', port: 42181 })
  assert.deepEqual(flat, nested)

  assert.deepEqual(serverOf({}), { host: null, port: null })
  assert.deepEqual(serverOf(null), { host: null, port: null })
  assert.deepEqual(serverOf('garbage'), { host: null, port: null })
  // truthy 语义(与历史行为一致): 空串/0 不算已设置
  assert.deepEqual(serverOf({ host: '', port: 0 }), { host: null, port: null })
})

test('withEnvOverride: 无环境变量时透传 / 有则覆盖(PORT 转数字)', () => {
  assert.deepEqual(withEnvOverride({ host: '0.0.0.0', port: 42181 }), { host: '0.0.0.0', port: 42181 })
  assert.deepEqual(withEnvOverride({ host: null, port: null }), { host: null, port: null })

  process.env.PORT = '44181'
  assert.equal(withEnvOverride({ host: '0.0.0.0', port: 42181 }).port, 44181)
  delete process.env.PORT

  process.env.HOST = '192.168.1.5'
  assert.equal(withEnvOverride({ host: '0.0.0.0', port: 42181 }).host, '192.168.1.5')
})

test('normalizeServer: 平铺提升到 server / 嵌套恒等 / 空对象建段', () => {
  const flat = normalizeServer({ port: 43181 })
  assert.deepEqual(flat.server, { port: 43181 })

  const nested = { server: { host: '0.0.0.0', port: 42181 }, setting: { keep: true } }
  const out = normalizeServer(nested)
  assert.equal(out, nested) // 原位
  assert.deepEqual(out.server, { host: '0.0.0.0', port: 42181 })
  assert.deepEqual(out.setting, { keep: true }) // 其余字段不动

  assert.deepEqual(normalizeServer({}).server, {})
})

test('normalizeServer + withEnvOverride 组合: 平铺文件也能被环境变量覆盖(曾崩溃的场景)', () => {
  process.env.PORT = '45181'
  const cfg = normalizeServer({ port: 43181 })
  const addr = withEnvOverride(serverOf(cfg))
  assert.equal(addr.port, 45181)
})

test('单点常量: 内置默认文件存在且端口与常量一致(防漂移)', () => {
  const r = readConfigJson(DEFAULT_CONFIG_FILE)
  assert.equal(r.ok, true)
  assert.equal(r.config.server.port, DEFAULT_MITM_PORT)
})
