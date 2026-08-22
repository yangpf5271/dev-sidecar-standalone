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

test('clean: unset 退出码 5(键不存在)被容忍, 其他失败记入 notes', async () => {
  const { adapter } = makeAdapter({
    values: { 'http.proxy': OURS },
    unsetResult: { ok: false, code: 5, stdout: '', stderr: '' },  // 键不存在, 正常
  })
  const r = await adapter.clean(ADDR)
  assert.deepEqual(r.removed, ['git http.proxy'])
  assert.deepEqual(r.notes, [])

  const { adapter: a2 } = makeAdapter({
    values: { 'http.proxy': OURS },
    unsetResult: { ok: false, code: 128, stdout: '', stderr: 'fatal: bad config' },
  })
  const r2 = await a2.clean(ADDR)
  assert.deepEqual(r2.removed, [])
  assert.match(r2.notes[0], /失败/)
})

test('clean dryRun: 不执行 unset', async () => {
  const { adapter, run } = makeAdapter({ values: { 'http.proxy': OURS } })
  const r = await adapter.clean(ADDR, { dryRun: true })
  assert.deepEqual(r.removed, ['git http.proxy'])
  assert.equal(run.calls.filter((c) => c.key.includes('--unset')).length, 0)
})
