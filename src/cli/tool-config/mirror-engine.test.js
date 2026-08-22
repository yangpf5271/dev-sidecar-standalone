// 镜像引擎单测 — 企业源快照保护不变量、重复切换不覆盖、空段清理（spec: mirror-engine）
const { test } = require('node:test')
const assert = require('node:assert')
const { createMirrorEngine } = require('./mirror-engine')

const OFFICIAL = 'https://official.example/simple'
const MIRRORS = {
  tuna: { name: 'TUNA', url: 'https://mirror.tuna.example/simple' },
  aliyun: { name: '阿里云', url: 'https://mirrors.aliyun.example/simple' },
}

/** 假 adapter: 可读写的镜像值; 假快照: 内存 mirror 段 */
function makeEngine ({ current = OFFICIAL, snapshotState = {} } = {}) {
  const state = { mirrorValue: current }
  const setCalls = []
  const adapter = {
    read: async () => ({ ok: true, values: { mirror: state.mirrorValue } }),
    setMirror: async (v) => { setCalls.push(v); state.mirrorValue = v; return { ok: true } },
    restoreDefault: async (o) => { setCalls.push(`default:${o}`); state.mirrorValue = o; return { ok: true } },
  }
  const snapshot = {
    state: snapshotState,
    read: () => JSON.parse(JSON.stringify(snapshotState)),
    write: (obj) => { Object.keys(snapshotState).forEach(k => delete snapshotState[k]); Object.assign(snapshotState, JSON.parse(JSON.stringify(obj))) },
  }
  const engine = createMirrorEngine({ name: 'test', official: OFFICIAL, mirrors: MIRRORS, adapter, snapshot })
  return { engine, adapter, snapshot, setCalls, state, snapshotState }
}

test('switch: 切换成功并首次快照原值', async () => {
  const { engine, snapshotState } = makeEngine({ current: OFFICIAL })
  const r = await engine.switch('tuna')
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  assert.equal(r.to, MIRRORS.tuna.url)
  assert.deepEqual(snapshotState.mirror, { test: { original: OFFICIAL } })
})

test('switch: 企业源保护——原值是企业内网源时不被覆盖丢失', async () => {
  const CORP = 'https://npm.corp.example/registry'
  const { engine, snapshotState } = makeEngine({ current: CORP })
  await engine.switch('tuna')
  await engine.switch('aliyun')   // 重复切换
  const r = await engine.off()
  assert.equal(r.target, CORP)    // 恢复到企业源原值
  assert.equal(r.saved, CORP)
  assert.equal(snapshotState.mirror, undefined)  // 段清理
})

test('switch: 重复切换不覆盖快照(始终是最早原值)', async () => {
  const { engine, snapshotState } = makeEngine({ current: OFFICIAL })
  await engine.switch('tuna')
  await engine.switch('aliyun')
  assert.deepEqual(snapshotState.mirror.test, { original: OFFICIAL })
})

test('switch: 已是目标镜像 → changed:false 不写快照', async () => {
  const { engine, snapshotState, setCalls } = makeEngine({ current: MIRRORS.tuna.url })
  const r = await engine.switch('tuna')
  assert.equal(r.changed, false)
  assert.equal(setCalls.length, 0)
  assert.equal(snapshotState.mirror, undefined)
})

test('switch: 未知镜像名 → available 列表', async () => {
  const { engine } = makeEngine()
  const r = await engine.switch('nope')
  assert.equal(r.ok, false)
  assert.deepEqual(r.available, ['tuna', 'aliyun'])
})

test('off: 无快照 → 经 restoreDefault 回默认(npm=设官方源/pip=清除键, 知识归 adapter)', async () => {
  const { engine, setCalls } = makeEngine({ current: MIRRORS.tuna.url })
  const r = await engine.off()
  assert.equal(r.ok, true)
  assert.equal(r.target, null)          // 无快照: target 为空, 由 adapter 决定回默认方式
  assert.equal(r.saved, null)
  assert.deepEqual(setCalls, [`default:${OFFICIAL}`])  // 引擎只传官方值
})

test('off: setMirror 失败 → 错误返回, 不清快照', async () => {
  const { engine, adapter, snapshotState } = makeEngine({ current: MIRRORS.tuna.url })
  snapshotState.mirror = { test: { original: OFFICIAL } }
  adapter.setMirror = async () => ({ ok: false, error: '写入失败' })
  const r = await engine.off()
  assert.equal(r.ok, false)
  assert.deepEqual(snapshotState.mirror, { test: { original: OFFICIAL } })  // 快照保留供重试
})

test('status: 当前值/快照/表内识别', async () => {
  const { engine, snapshotState } = makeEngine({ current: MIRRORS.aliyun.url })
  snapshotState.mirror = { test: { original: OFFICIAL } }
  const r = await engine.status()
  assert.equal(r.current, MIRRORS.aliyun.url)
  assert.equal(r.saved, OFFICIAL)
  assert.equal(r.known, '阿里云')
})

test('兼容历史快照键(registry/indexUrl)可被 off 读取恢复且段被清理', async () => {
  const LEGACY = 'https://legacy.example/x'
  const { engine, snapshotState } = makeEngine({ current: MIRRORS.tuna.url })
  snapshotState.mirror = { test: { registry: LEGACY } }   // npm 时代键名
  const r = await engine.off()
  assert.equal(r.target, LEGACY)
  assert.equal(snapshotState.mirror, undefined)           // 段清理(含 legacy 键)

  // pip 时代键名同构
  snapshotState.mirror = { test: { indexUrl: LEGACY } }
  const r2 = await engine.off()
  assert.equal(r2.target, LEGACY)
  assert.equal(snapshotState.mirror, undefined)
})
