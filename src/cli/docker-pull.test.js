// 拉取层知识模块单测 — 职责二分 / 纯函数解析 / 两种读取语境 / WSL 超时保护 (spec: docker-pull)
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const pull = require('./docker-pull')

// ---------------------------------------------------------------------------
// 解析层(纯函数)
// ---------------------------------------------------------------------------

test('parseDoc: 空内容 → data:null; 合法 JSON → data; 损坏 → 错误结果不抛出', () => {
  assert.deepEqual(pull.parseDoc(null), { ok: true, data: null })
  assert.deepEqual(pull.parseDoc(''), { ok: true, data: null })
  assert.deepEqual(pull.parseDoc('{"registry-mirrors":["https://m.example"]}'), {
    ok: true,
    data: { 'registry-mirrors': ['https://m.example'] },
  })
  const bad = pull.parseDoc('{oops')
  assert.equal(bad.ok, false)
  assert.ok(bad.error)
})

test('parseMirrors: 数组原样保留(不滤项, 写回路径不改用户数组), 缺失/非数组 → []', () => {
  assert.deepEqual(pull.parseMirrors({ 'registry-mirrors': ['https://a.example', 'https://b.example'] }), ['https://a.example', 'https://b.example'])
  assert.deepEqual(pull.parseMirrors({ 'registry-mirrors': [42, 'https://a.example'] }), [42, 'https://a.example'])
  assert.deepEqual(pull.parseMirrors({}), [])
  assert.deepEqual(pull.parseMirrors({ 'registry-mirrors': 'not-array' }), [])
  assert.deepEqual(pull.parseMirrors(null), [])
})

test('parseInsecureRegistries: 滤非字符串(消费方 hostOf 需要字符串), 缺失 → []', () => {
  assert.deepEqual(pull.parseInsecureRegistries({ 'insecure-registries': ['127.0.0.1:5000'] }), ['127.0.0.1:5000'])
  assert.deepEqual(pull.parseInsecureRegistries({ 'insecure-registries': [42] }), [])
  assert.deepEqual(pull.parseInsecureRegistries({}), [])
  assert.deepEqual(pull.parseInsecureRegistries(null), [])
})

// ---------------------------------------------------------------------------
// 读取语境层
// ---------------------------------------------------------------------------

test('readLocal: 路径可注入 — 存在返回内容, 不存在 content:null', () => {
  const file = path.join(os.tmpdir(), `dss-pull-test-${Date.now()}.json`)
  fs.writeFileSync(file, '{"registry-mirrors":["https://m.example"]}', 'utf8')
  const hit = pull.readLocal(file)
  assert.equal(hit.ok, true)
  assert.ok(hit.content.includes('m.example'))

  const miss = pull.readLocal(path.join(os.tmpdir(), `dss-pull-miss-${Date.now()}.json`))
  assert.deepEqual(miss, { ok: true, content: null })

  fs.unlinkSync(file)
})

test('readViaWsl: 经注入执行器读取成功内容; 读取失败 → content:null', async () => {
  const okRun = async () => ({ ok: true, stdout: '{"registry-mirrors":[]}', stderr: '' })
  const hit = await pull.readViaWsl({ run: okRun, timeoutMs: 500 })
  assert.equal(hit.ok, true)
  assert.ok(hit.content.includes('registry-mirrors'))
  assert.notEqual(hit.timeout, true)

  const failRun = async () => ({ ok: false, stdout: '', stderr: 'no wsl' })
  const miss = await pull.readViaWsl({ run: failRun, timeoutMs: 500 })
  assert.equal(miss.ok, true)
  assert.equal(miss.content, null)
})

test('readViaWsl: WSL 无响应超时 → timeout:true 且不挂起(spec 必测项)', async () => {
  const hang = () => new Promise(() => {})   // 永不 resolve, 模拟冷启动卡死
  const started = Date.now()
  const r = await pull.readViaWsl({ run: hang, timeoutMs: 80 })
  assert.equal(r.ok, true)
  assert.equal(r.timeout, true)
  assert.equal(r.content, null)
  assert.ok(Date.now() - started < 2000, '应在限定时间内返回而非挂起')
})
