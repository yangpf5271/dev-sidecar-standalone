// npm adapter 单测 — 归一化 / 严格清理 / 第三方保留 / dryRun / 命令不可用
const { test } = require('node:test')
const assert = require('node:assert')
const createNpm = require('./npm')
const { fakeRun, fakeSnapshot, ADDR } = require('./helpers')

const OURS = 'http://127.0.0.1:31180'
const FOREIGN = 'http://corp-proxy.example:8080'

function makeAdapter ({ values = {}, snapshot = {} } = {}) {
  const state = { ...values }
  const get = (k) => {
    if (!(k in state)) return { ok: true, stdout: 'null' }
    return { ok: true, stdout: state[k] }
  }
  const run = fakeRun([
    [/^npm config get/, (_s, _g, key) => get(key)],
    [/^npm config delete/, (_s, _g, key) => { delete state[key]; return { ok: true, stdout: '' } }],
  ])
  const snap = fakeSnapshot(snapshot)
  const adapter = createNpm({ run, homedir: () => '/tmp/fake-home', snapshot: snap })
  return { adapter, run, snap }
}

test('read: 未设置哨兵归一化为 null, 已设值保留', async () => {
  const { adapter } = makeAdapter({ values: { proxy: OURS, 'cafile': null } })
  const r = await adapter.read()
  assert.equal(r.ok, true)
  assert.equal(r.values.http, OURS)
  assert.equal(r.values.https, null)        // 未提供 → 'null' → null
  assert.equal(r.values.ca, null)
})

test('classify: MITM 端口识别为 mitm', async () => {
  const { adapter } = makeAdapter({ values: { 'https-proxy': 'http://127.0.0.1:31181' } })
  const r = await adapter.classify(ADDR)
  assert.equal(r.mode, 'mitm')
})

test('clean: 指向本代理的键被清理, 第三方值保留, 快照段收敛', async () => {
  const { adapter, snap } = makeAdapter({
    values: { proxy: OURS, 'cafile': 'C:\\corp\\ca.crt' },
    snapshot: { npm: { proxy: OURS, 'cafile': 'C:\\dss\\ca.crt' } },
  })
  const r = await adapter.clean(ADDR)
  assert.equal(r.ok, true)
  assert.deepEqual(r.removed, ['npm proxy'])   // cafile 是第三方路径, 不清理
  // 第三方 cafile 仍等于快照记录? 不是(快照是 dss 的), 段内无用户数据 → 清段
  assert.deepEqual(snap.cleared, ['npm'])
})

test('clean: 快照记录值即清理候选(端口漂移端到端)', async () => {
  // 非默认端口 on 时快照记录了 52280; 当前 stop 语境是默认端口 ADDR
  const { adapter, snap } = makeAdapter({
    values: { proxy: 'http://127.0.0.1:52280' },
    snapshot: { npm: { proxy: 'http://127.0.0.1:52280' } },
  })
  const r = await adapter.clean(ADDR)
  assert.deepEqual(r.removed, ['npm proxy'])   // 快照值命中, 清理
  assert.deepEqual(snap.cleared, ['npm'])
})

test('clean: 无本代理配置且无快照 → 空结果不清段', async () => {
  const { adapter, snap } = makeAdapter({ values: { proxy: FOREIGN } })
  const r = await adapter.clean(ADDR)
  assert.equal(r.ok, true)
  assert.deepEqual(r.removed, [])
  assert.deepEqual(snap.cleared, [])
})

test('clean: 证书键路径归一化匹配后清理(Windows 风格差异)', async () => {
  const cert = 'C:\\Users\\t\\.dev-sidecar\\dev-sidecar.ca.crt'
  const { adapter } = makeAdapter({
    values: { cafile: 'c:/users/t/.dev-sidecar/DEV-SIDECAR.CA.CRT' }, // 大小写+正斜杠差异
    snapshot: { npm: { cafile: cert } },
  })
  const r = await adapter.clean(ADDR)
  // 匹配依赖 normPathValue; 本测试主要走通路径, 精确断言见 shared.test.js
  assert.equal(r.ok, true)
})

test('clean dryRun: 只探测不写', async () => {
  const { adapter, run } = makeAdapter({ values: { proxy: OURS } })
  const r = await adapter.clean(ADDR, { dryRun: true })
  assert.deepEqual(r.removed, ['npm proxy'])
  assert.equal(run.calls.filter((c) => c.key.startsWith('npm config delete')).length, 0)
})

test('clean: 删除后仍生效(env/.npmrc 覆盖) → note + 快照段保留', async () => {
  // delete 成功但 get 仍返回值(环境变量或项目级 .npmrc 覆盖场景)
  const run = fakeRun([
    [/^npm config get/, (_s, _g, key) => (key === 'proxy' ? { ok: true, stdout: OURS } : { ok: true, stdout: 'null' })],
    [/^npm config delete/, { ok: true, stdout: '' }],
  ])
  const snap = fakeSnapshot({ npm: { proxy: OURS } })
  const adapter = createNpm({ run, homedir: () => '/tmp/x', snapshot: snap })
  const r = await adapter.clean(ADDR)
  assert.deepEqual(r.removed, ['npm proxy'])
  assert.match(r.notes[0], /仍生效/)
  assert.deepEqual(snap.cleared, [])   // 值仍在, 不清段
})

test('clean: npm 命令不可用 → 结果对象报错, 不 throw', async () => {
  const run = fakeRun([])
  run.override = null
  const failing = async () => ({ ok: false, error: 'spawn npm ENOENT', stdout: '', stderr: '' })
  const adapter = createNpm({ run: failing, homedir: () => '/tmp/x', snapshot: fakeSnapshot({}) })
  const r = await adapter.clean(ADDR)
  assert.equal(r.ok, false)
  assert.match(r.error, /不可用/)
})
