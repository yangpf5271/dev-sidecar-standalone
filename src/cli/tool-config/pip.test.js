// pip adapter 单测 — 能力位 / no-op clean / read 探测
const { test } = require('node:test')
const assert = require('node:assert')
const createPip = require('./pip')
const { fakeRun, ADDR } = require('./helpers')

const snap = { read: () => ({}), updateTool: () => {}, clearTool: () => {} }

test('capabilities: pip 无代理能力、有镜像能力', () => {
  const adapter = createPip({ run: fakeRun([]), homedir: () => '/tmp/x', snapshot: snap })
  assert.deepEqual(adapter.capabilities, { proxy: false, mirror: true })
})

test('clean: 显式 no-op — 用户自设 global.proxy 哪怕指向本代理也不清理', async () => {
  const adapter = createPip({ run: fakeRun([]), homedir: () => '/tmp/x', snapshot: snap })
  const r = await adapter.clean(ADDR)
  assert.equal(r.ok, true)
  assert.deepEqual(r.removed, [])
  assert.deepEqual(r.notes, [])
})

test('read: pip/pip3 探测 + 代理与镜像值', async () => {
  const run = fakeRun([
    ['pip --version', { ok: false, code: 1, stdout: '', stderr: '' }],
    ['pip3 --version', { ok: true, stdout: 'pip 24.0', stderr: '' }],
    ['pip3 config get global.proxy', { ok: true, stdout: 'http://127.0.0.1:31180', stderr: '' }],
    ['pip3 config get global.index-url', { ok: true, stdout: 'https://pypi.tuna.tsinghua.edu.cn/simple/', stderr: '' }],
  ])
  const adapter = createPip({ run, homedir: () => '/tmp/x', snapshot: snap })
  const r = await adapter.read()
  assert.equal(r.ok, true)
  assert.equal(r.values.http, 'http://127.0.0.1:31180')
  assert.equal(r.values.mirror, 'https://pypi.tuna.tsinghua.edu.cn/simple/')
  assert.equal((await adapter.classify(ADDR)).mode, 'tunnel')
})

test('read: 无 pip → 结果对象报错', async () => {
  const run = fakeRun([
    ['pip --version', { ok: false, code: 1, stdout: '', stderr: '' }],
    ['pip3 --version', { ok: false, code: 1, stdout: '', stderr: '' }],
  ])
  const adapter = createPip({ run, homedir: () => '/tmp/x', snapshot: snap })
  const r = await adapter.read()
  assert.equal(r.ok, false)
  assert.match(r.error, /pip/)
})
