// 共享语义单测 — classify(宽松) / isOurs 候选集(严格) / 归一化
// 核心用例: evil.com:<httpPort> 的分叉对是设计行为, 此处锁定(spec: tool-config-store)
const { test } = require('node:test')
const assert = require('node:assert')
const {
  normalizeProxyUrlValue,
  classifyValues,
  buildProxyCandidates,
  buildCertCandidates,
  normPathValue,
} = require('./shared')
const { ADDR } = require('./helpers')

// ---- normalizeProxyUrlValue: npm 未设置哨兵归一化 ----

test('normalize: 未设置哨兵归一化为 null', () => {
  for (const v of ['', null, undefined, 'null', 'undefined', '  ', 'null\n']) {
    assert.equal(normalizeProxyUrlValue(v), null, `应归一化为 null: ${JSON.stringify(v)}`)
  }
  assert.equal(normalizeProxyUrlValue('http://127.0.0.1:31180'), 'http://127.0.0.1:31180')
  assert.equal(normalizeProxyUrlValue(' http://x:1 '), 'http://x:1')
})

// ---- classifyValues: 宽松展示语义 ----

test('classify: 无值 → none', () => {
  assert.deepEqual(classifyValues({ http: null, https: null }, ADDR), { mode: 'none', address: null })
  assert.deepEqual(classifyValues({}, ADDR), { mode: 'none', address: null })
})

test('classify: https 指向 MITM 端口 → mitm (优先于 tunnel)', () => {
  const r = classifyValues({ http: 'http://127.0.0.1:31180', https: 'http://127.0.0.1:31181' }, ADDR)
  assert.equal(r.mode, 'mitm')
  assert.equal(r.address, 'http://127.0.0.1:31181')
})

test('classify: http 指向 HTTP 端口 → tunnel', () => {
  const r = classifyValues({ http: 'http://127.0.0.1:31180', https: null }, ADDR)
  assert.equal(r.mode, 'tunnel')
})

test('classify: 非默认端口场景按 addr 实际端口判定', () => {
  const addr = { host: '127.0.0.1', httpPort: 42280, mitmPort: 42281 }
  assert.equal(classifyValues({ http: 'http://127.0.0.1:42280', https: null }, addr).mode, 'tunnel')
  assert.equal(classifyValues({ http: null, https: 'http://127.0.0.1:42281' }, addr).mode, 'mitm')
})

test('classify 分叉对(设计行为): 非本机地址 + 本代理端口 → tunnel(展示) 但 isOurs 不认(清理)', () => {
  const value = 'http://evil.com:31180'
  // 展示语义: 端口子串 → tunnel
  assert.equal(classifyValues({ http: value, https: null }, ADDR).mode, 'tunnel')
  // 清理语义: 精确候选集不含该值 → 不清理
  const candidates = buildProxyCandidates(ADDR, {})
  assert.equal(candidates.has(value), false)
})

test('classify: 指向其他代理 → other + 保留原值', () => {
  const r = classifyValues({ http: 'http://corp-proxy.example:8080', https: null }, ADDR)
  assert.equal(r.mode, 'other')
  assert.equal(r.address, 'http://corp-proxy.example:8080')
})

// ---- buildProxyCandidates: isOurs 严格候选集 ----

test('candidates: host×port 全组合 + 默认端口兜底', () => {
  const c = buildProxyCandidates({ host: '10.0.0.5', httpPort: 42280, mitmPort: 42281 }, {})
  assert.equal(c.has('http://10.0.0.5:42280'), true)   // 当前地址
  assert.equal(c.has('http://127.0.0.1:42280'), true)  // 常用主机名兜底
  assert.equal(c.has('http://localhost:42281'), true)
  assert.equal(c.has('http://127.0.0.1:31180'), true)  // 默认端口兜底(反向漂移)
  assert.equal(c.has('http://evil.com:31180'), false)  // 非本机地址永不匹配
})

test('candidates: 快照记录值解决端口漂移(非默认端口 on → 默认端口语境清理)', () => {
  const snapshot = { npm: { proxy: 'http://127.0.0.1:52280' } }
  const c = buildProxyCandidates(ADDR, snapshot) // addr 是默认端口, 快照是 52280
  assert.equal(c.has('http://127.0.0.1:52280'), true)
})

test('certCandidates: 当前证书路径 + 快照证书键值', () => {
  const snapshot = { npm: { cafile: 'C:\\custom\\ca.crt' }, git: {} }
  const c = buildCertCandidates(() => 'C:\\Users\\t', snapshot)
  const list = [...c]
  assert.equal(list.some((p) => p.endsWith('dev-sidecar.ca.crt')), true)
  assert.equal(list.includes('C:\\custom\\ca.crt'), true)
})

// ---- normPathValue ----

test('normPathValue: 非平台敏感的恒等性(全平台可断言不变量)', () => {
  // 在 win32 上做大小写/分隔符归一, 其他平台恒等 — 只断言跨平台稳定的不变量
  assert.equal(normPathValue(null), null)
  assert.equal(normPathValue(undefined), undefined)
  assert.equal(typeof normPathValue('x/y'), 'string')
})
