// git adapter 单测 — 严格清理 / unset 容忍 / dryRun
const { test } = require('node:test')
const assert = require('node:assert')
const createGit = require('./git')
const { fakeRun, fakeSnapshot, ADDR } = require('./helpers')

const OURS = 'http://127.0.0.1:31180'
const FOREIGN = 'http://corp-proxy.example:8080'

function makeAdapter ({ values = {}, unsetResult = { ok: true, stdout: '' }, snapshot = {} } = {}) {
  const run = fakeRun([
    [/^git config --global --get/, (_a, _b, _c, key) => {
      if (!(key in values)) return { ok: 1, code: 1, stdout: '', stderr: '' }
      return { ok: true, code: 0, stdout: values[key] }
    }],
    [/^git config --global --unset/, unsetResult],
  ])
  const snap = fakeSnapshot(snapshot)
  const adapter = createGit({ run, homedir: () => '/tmp/fake-home', snapshot: snap })
  return { adapter, run, snap }
}

test('read/classify: 隧道与未设置', async () => {
  const { adapter } = makeAdapter({ values: { 'http.proxy': OURS } })
  const r = await adapter.read()
  assert.equal(r.values.http, OURS)
  assert.equal(r.values.https, null)
  assert.equal((await adapter.classify(ADDR)).mode, 'tunnel')
})

test('clean: 本代理键清理 + 快照段收敛, 第三方键保留', async () => {
  const { adapter, snap } = makeAdapter({
    values: { 'http.proxy': OURS, 'https.proxy': FOREIGN },
    snapshot: { git: { 'http.proxy': OURS, 'https.proxy': 'http://127.0.0.1:31181' } },
  })
  const r = await adapter.clean(ADDR)
  assert.deepEqual(r.removed, ['git http.proxy'])   // https.proxy 是第三方, 保留
  // 但快照 git.https-proxy 记录值 ≠ 当前值(第三方值≠快照) → 段内无用户数据 → 清段
  assert.deepEqual(snap.cleared, ['git'])
})

test('clean: unset 退出码 5(键不存在)被容忍; 其他失败保留快照段供重试', async () => {
  const { adapter } = makeAdapter({
    values: { 'http.proxy': OURS },
    unsetResult: { ok: false, code: 5, stdout: '', stderr: '' },  // 键不存在, 正常
  })
  const r = await adapter.clean(ADDR)
  assert.deepEqual(r.removed, ['git http.proxy'])
  assert.deepEqual(r.notes, [])

  // unset 真失败: 值仍在 → 快照段必须保留(端口漂移候选集供下次重试)
  const { adapter: a2, snap } = makeAdapter({
    values: { 'http.proxy': OURS },
    unsetResult: { ok: false, code: 128, stdout: '', stderr: 'fatal: bad config' },
    snapshot: { git: { 'http.proxy': OURS } },
  })
  const r2 = await a2.clean(ADDR)
  assert.deepEqual(r2.removed, [])
  assert.match(r2.notes[0], /失败/)
  assert.deepEqual(snap.cleared, [])   // 不清段
})

test('clean dryRun: 不执行 unset', async () => {
  const { adapter, run } = makeAdapter({ values: { 'http.proxy': OURS } })
  const r = await adapter.clean(ADDR, { dryRun: true })
  assert.deepEqual(r.removed, ['git http.proxy'])
  assert.equal(run.calls.filter((c) => c.key.includes('--unset')).length, 0)
})

test('setProxy: 中途失败 → 已成功键并入快照段, 未尝试键不丢', async () => {
  const run = fakeRun([
    [/^git config --global http/, (_a, _b, key) => (key === 'https.proxy'
      ? { ok: false, stdout: '', stderr: 'fatal: bad config' }
      : { ok: true, stdout: '' })],
  ])
  const snap = fakeSnapshot({ git: { 'http.proxy': 'http://old.example:1' } })
  const adapter = createGit({ run, homedir: () => '/tmp/x', snapshot: snap })
  const r = await adapter.setProxy({ 'http.proxy': OURS, 'https.proxy': OURS })
  assert.equal(r.ok, false)
  assert.match(r.error, /https\.proxy/)
  assert.deepEqual(snap.state.git, { 'http.proxy': OURS })   // http.proxy 并入, 无其他旧键
})

test('setProxy: 全部成功 → 快照段记录全部键', async () => {
  const run = fakeRun([[/^git config --global/, { ok: true, stdout: '' }]])
  const snap = fakeSnapshot({})
  const adapter = createGit({ run, homedir: () => '/tmp/x', snapshot: snap })
  const r = await adapter.setProxy({ 'http.proxy': OURS })
  assert.equal(r.ok, true)
  assert.deepEqual(snap.state.git, { 'http.proxy': OURS })
})
