// docker adapter 单测 — auths 保留 / 格式统一 / 端口匹配例外 / 第三方不动
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const createDocker = require('./docker')
const { fakeRun, tempHomedir, ADDR } = require('./helpers')

function makeAdapter (configJson) {
  const home = tempHomedir()
  if (configJson !== undefined) {
    fs.mkdirSync(path.join(home.dir, '.docker'), { recursive: true })
    fs.writeFileSync(path.join(home.dir, '.docker', 'config.json'), JSON.stringify(configJson))
  }
  const adapter = createDocker({ run: fakeRun([]), homedir: home.homedir, snapshot: { read: () => ({}), updateTool: () => {}, clearTool: () => {} } })
  return { adapter, home }
}

test('read: 无文件 → values 全 null 且 ok', async () => {
  const { adapter, home } = makeAdapter(undefined)
  const r = await adapter.read()
  assert.equal(r.ok, true)
  assert.deepEqual(r.values, { http: null, https: null })
  home.cleanup()
})

test('read/classify: proxies.default → 已注入/隧道', async () => {
  const { adapter, home } = makeAdapter({
    auths: {},
    proxies: { default: { httpProxy: 'http://host.docker.internal:31180', httpsProxy: 'http://host.docker.internal:31180' } },
  })
  const r = await adapter.read()
  assert.equal(r.values.http, 'http://host.docker.internal:31180')
  assert.equal((await adapter.classify(ADDR)).mode, 'tunnel')
  home.cleanup()
})

test('clean: 清理本代理注入 — auths 逐键保留 + 统一格式(2空格+尾换行)', async () => {
  const { adapter, home } = makeAdapter({
    auths: { '58.247.122.126:62185': { auth: 'dXNlcjpwYXNz' }, 'registry.example': { auth: 'eHg=' } },
    proxies: { default: { httpProxy: 'http://host.docker.internal:31180', httpsProxy: 'http://host.docker.internal:31180', noProxy: '58.247.122.126:62185' } },
  })
  const r = await adapter.clean(ADDR)
  assert.equal(r.ok, true)
  assert.equal(r.removed.length, 1)
  assert.match(r.removed[0], /^docker proxies\.default \(http:.*:31180\)$/)

  const after = JSON.parse(fs.readFileSync(path.join(home.dir, '.docker', 'config.json'), 'utf8'))
  assert.equal(after.proxies, undefined)
  assert.deepEqual(Object.keys(after.auths), ['58.247.122.126:62185', 'registry.example'])

  const raw = fs.readFileSync(path.join(home.dir, '.docker', 'config.json'), 'utf8')
  assert.match(raw, /\n$/, '写盘统一尾换行')
  assert.match(raw, /^{\n {2}"/, '写盘统一 2 空格缩进')
  home.cleanup()
})

test('clean: 指向其他代理的 proxies.default 绝不动', async () => {
  const { adapter, home } = makeAdapter({
    proxies: { default: { httpProxy: 'http://corp-proxy.example:8080' } },
  })
  const r = await adapter.clean(ADDR)
  assert.equal(r.ok, true)
  assert.deepEqual(r.removed, [])
  const after = JSON.parse(fs.readFileSync(path.join(home.dir, '.docker', 'config.json'), 'utf8'))
  assert.equal(after.proxies.default.httpProxy, 'http://corp-proxy.example:8080')
  home.cleanup()
})

test('clean dryRun: 探测不落盘', async () => {
  const { adapter, home } = makeAdapter({
    proxies: { default: { httpProxy: 'http://host.docker.internal:31180' } },
  })
  const before = fs.readFileSync(path.join(home.dir, '.docker', 'config.json'), 'utf8')
  const r = await adapter.clean(ADDR, { dryRun: true })
  assert.deepEqual(r.removed, ['docker proxies.default (build 层)'])
  assert.equal(fs.readFileSync(path.join(home.dir, '.docker', 'config.json'), 'utf8'), before)
  home.cleanup()
})
