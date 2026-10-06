// e2e 第一层: 代理数据面 — 真实代理进程 × 本地 mock 上游, 全程不碰外网
// 覆盖: HTTP 正向代理 / CONNECT 裸隧道 / MITM 拦截(假证书+解密转发) / 端口占用拒绝 / 停止清理
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const {
  freePortPair, startProxy, waitPortClosed,
  mockUpstream, mockTlsUpstream, proxyGet, proxyGetHttps, writeTestConfig,
} = require('./helpers')

// 杀代理子进程时, 测试进程内的隧道 socket 会收到 ECONNRESET/EPIPE — 已离开断言窗口, 定向豁免
process.on('uncaughtException', (e) => {
  if (e && (e.code === 'ECONNRESET' || e.code === 'EPIPE' || e.code === 'ERR_STREAM_PREMATURE_CLOSE')) return
  throw e
})

// ---- 共享代理实例: HTTP 正向代理 + 裸隧道用例复用, 降低起停开销 ----
let home
let sharedProxy
let httpPort
let mitmPort

before(async () => {
  home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dss-e2e-plane-'))
  const pair = await freePortPair()
  httpPort = pair.http
  mitmPort = pair.mitm
  sharedProxy = startProxy(null, { port: mitmPort, home })
  await sharedProxy.waitReady()
})

after(async () => {
  try { sharedProxy.child.kill() } catch { /* 已退出 */ }
  fs.rmSync(home, { recursive: true, force: true })
})

test('HTTP 正向代理: 绝对 URI GET → 本地 mock 上游, 请求头与响应体端到端一致', async () => {
  const up = await mockUpstream(null)
  try {
    const res = await proxyGet(httpPort, `http://127.0.0.1:${up.port}/hello?q=1`)
    assert.equal(res.status, 200)
    assert.equal(res.body, 'mock-upstream-ok')
    assert.equal(res.headers['x-mock'], 'yes')
    assert.equal(up.requests.length, 1)
    assert.equal(up.requests[0].url, '/hello?q=1')
    assert.equal(up.requests[0].headers.host, `127.0.0.1:${up.port}`)
  } finally {
    await up.close()
  }
})

test('CONNECT 裸隧道: 非拦截域名端到端透传本地 TLS 上游(客户端见到的是上游自签证书, 证明未被 MITM)', async () => {
  const tls = await mockTlsUpstream(null, { cn: 'tls-mock.local' })
  try {
    const res = await proxyGetHttps(httpPort, '127.0.0.1', tls.port, '/tls-hello')
    assert.equal(res.status, 200)
    assert.equal(res.body, 'mock-tls-ok')
    // 未传 CA 且连接成功 → 客户端信任的是上游自签证书 → 隧道未被打断
    assert.equal(res.peerCert.subject.CN, 'tls-mock.local')
  } finally {
    await tls.close()
  }
})

test('MITM 拦截: 自定义配置把 test.local 钉到本地 TLS 上游 → dss 以自身 CA 重签证书、解密转发', async () => {
  const tls = await mockTlsUpstream(null, { cn: '127.0.0.1' })
  const pair = await freePortPair([tls.port]) // 排除 mock 端口, 防止 proxy http 口撞车
  const home2 = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dss-e2e-mitm-'))
  try {
    const configPath = writeTestConfig(home2, pair.mitm, { upstreamPort: tls.port })
    const proxy2 = startProxy(null, { port: pair.mitm, home: home2, configPath })
    let res = null
    try {
      await proxy2.waitReady()
      const caCertPath = path.join(home2, '.dev-sidecar', 'dev-sidecar.ca.crt')
      assert.ok(fs.existsSync(caCertPath), 'MITM 代理启动应自动生成 CA 证书')
      const ca = fs.readFileSync(caCertPath, 'utf8')

      // skipHostnameCheck: dss 假证书对 IP 主机无 IP SAN(node 强校验会拒), 链与主体自行断言
      res = await proxyGetHttps(pair.mitm, '127.0.0.1', tls.port, '/mitm-hello', { ca, skipHostnameCheck: true })
      assert.equal(res.status, 200, `MITM 请求失败, 代理输出: ${proxy2.getOutput().slice(-500)}`)
      assert.equal(res.body, 'mock-tls-ok')
      // 假证书: 签发者是 dss CA, 主体是目标域名 → 证明拦截解密发生
      assert.equal(res.peerCert.issuer.CN, 'DevSidecar - This certificate is generated locally')
      assert.equal(res.peerCert.subject.CN, '127.0.0.1')
    } finally {
      if (res && res.rawSocket) res.rawSocket.destroy() // 先断客户端 keep-alive socket, 再杀代理(RST 不会变孤儿错误)
      proxy2.child.kill()
      fs.rmSync(home2, { recursive: true, force: true })
    }
  } finally {
    await tls.close()
  }
})

test('端口占用拒绝: 二次启动同端口 → 非零退出, 无"启动成功"谎报', async () => {
  const fresh = await freePortPair()
  const blocker = net.createServer()
  await new Promise((r) => blocker.listen(fresh.mitm, '127.0.0.1', r))
  try {
    const home3 = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dss-e2e-addr-'))
    const dup = startProxy(null, { port: fresh.mitm, home: home3 })
    const exit = await new Promise((resolve) => dup.child.on('close', (c) => resolve(c)))
    assert.notEqual(exit, 0, '端口被占时应非零退出')
    const output = dup.getOutput()
    assert.ok(!/启动成功/.test(output), '不得谎报启动成功')
    fs.rmSync(home3, { recursive: true, force: true })
  } finally {
    await new Promise((r) => blocker.close(r))
  }
})

test('停止清理: 进程终止后两个端口均释放', async () => {
  const pair = await freePortPair()
  const home4 = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dss-e2e-stop-'))
  const p = startProxy(null, { port: pair.mitm, home: home4 })
  await p.waitReady()
  p.child.kill()
  await waitPortClosed('127.0.0.1', pair.mitm)
  await waitPortClosed('127.0.0.1', pair.http)
  fs.rmSync(home4, { recursive: true, force: true })
})
