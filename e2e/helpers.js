// e2e 测试基建 — 真实代理进程/CLI 子进程 × 本地 mock 上游 × 隔离环境
//
// 设计约束:
//   - 全程不碰外网: 上游全是本地 mock(数据面), 平台命令跑在 CI runner 上
//   - 每个用例独立: 随机高位端口 + 一次性 HOME(USERPROFILE/HOME/DEV_SIDECAR_HOME 同指一个临时目录)
//   - 隔离只作用于被 spawn 的子进程 env, 不污染测试进程自身
//   - MITM 拦截用自定义 -c 配置把 test.local 钉到 127.0.0.1(preSetIpList) + 本地 TLS mock,
//     由此在不碰 github 的前提下走通"拦截 → 假证书 → 解密转发"全链路
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const forge = require('node-forge')

const ROOT = path.join(__dirname, '..')
const ENTRY = path.join(ROOT, 'index.js')

/** 取一个空闲的高位端口(绑定 0 由系统分配后释放) */
function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** 一次性隔离 HOME 目录(注册到测试的 after 清理)。
 *  同步设置 HOME/USERPROFILE/DEV_SIDECAR_HOME 三者 → 子进程的 npm/git/证书/PID 全部落进临时目录 */
function isolatedHome (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-e2e-home-'))
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/** 子进程 env: 覆盖 HOME/USERPROFILE/DEV_SIDECAR_HOME/PORT, 其余继承(npm/git 需要 PATH)。
 *  关键隔离: 剥掉全部 npm_config_ 开头的键(含大写 NPM_CONFIG_ 变体) —— 通过 `npm run test:e2e` 启动时,
 *  npm 会注入 npm_config_userconfig=<启动者真实 .npmrc>, 其优先级高于 USERPROFILE 推导,
 *  不剥掉的话 dss npm on 会把测试代理写进开发者真实配置(实测发生过) */
function childEnv ({ home, port, extra } = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^npm_config_/i.test(k)) continue
    env[k] = v
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    DEV_SIDECAR_HOME: home,
    ...(port ? { PORT: String(port) } : {}),
    ...extra,
  }
}

/** 启动真实代理进程(前台 index.js), 返回句柄与输出收集器。
 *  传入 t 时自动注册清理; 不传(文件级 before 场景)由调用方自行 kill */
function startProxy (t, { port, home, configPath, label = 'proxy' }) {
  const args = [ENTRY]
  if (configPath) args.push('-c', configPath)
  const child = spawn(process.execPath, args, {
    env: childEnv({ home, port }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  if (t) {
    t.after(() => {
      try { child.kill() } catch { /* 已退出 */ }
    })
  }
  return {
    child,
    port,
    getOutput: () => out,
    async waitReady (timeoutMs = 20000) {
      await waitPort('127.0.0.1', port, timeoutMs)
      // http 端口 = mitm - 1, 就绪稍晚, 一并等待
      await waitPort('127.0.0.1', port - 1, timeoutMs)
    },
  }
}

/** 取一对连续空闲端口(mitm=p2, http=p2-1); exclude 排除已占端口(如 mock 上游的随机端口) */
async function freePortPair (exclude = []) {
  for (let i = 0; i < 20; i++) {
    const p2 = await freePort()
    const p1 = p2 - 1
    if (p1 > 1024 && !exclude.includes(p1) && !exclude.includes(p2) && !(await portInUse(p1))) {
      return { http: p1, mitm: p2 }
    }
  }
  throw new Error('找不到连续空闲端口对')
}

function portInUse (port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    sock.on('connect', () => { sock.destroy(); resolve(true) })
    sock.on('error', () => resolve(false))
  })
}

/** 轮询等待 TCP 端口就绪 */
function waitPort (host, port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ host, port })
      sock.on('connect', () => { sock.destroy(); resolve() })
      sock.on('error', () => {
        sock.destroy()
        if (Date.now() > deadline) reject(new Error(`端口 ${host}:${port} 在 ${timeoutMs}ms 内未就绪`))
        else setTimeout(attempt, 300)
      })
    }
    attempt()
  })
}

/** 等待端口关闭(停止验证) */
function waitPortClosed (host, port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ host, port })
      sock.on('connect', () => {
        sock.destroy()
        if (Date.now() > deadline) reject(new Error(`端口 ${host}:${port} 在 ${timeoutMs}ms 内仍未关闭`))
        else setTimeout(attempt, 300)
      })
      sock.on('error', () => resolve())
    }
    attempt()
  })
}

/** 本地 mock HTTP 上游: 记录请求并返回 handler 的响应 */
function mockUpstream (t, handler) {
  const requests = []
  const srv = http.createServer((req, res) => {
    const body = []
    req.on('data', (d) => body.push(d))
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(body).toString() })
      if (handler) return handler(req, res)
      res.writeHead(200, { 'content-type': 'text/plain', 'x-mock': 'yes' })
      res.end('mock-upstream-ok')
    })
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      if (t) t.after(() => new Promise((r) => srv.close(r)))
      resolve({ port, requests, close: () => new Promise((r) => srv.close(r)) })
    })
  })
}

/** 自签证书(含 SAN: CN + 127.0.0.1), 供本地 TLS mock 上游使用 */
function selfSignedCert (cn) {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.validity.notBefore = new Date(Date.now() - 3600 * 1000)
  cert.validity.notAfter = new Date(Date.now() + 24 * 3600 * 1000)
  cert.setSubject([{ name: 'commonName', value: cn }])
  cert.setIssuer([{ name: 'commonName', value: cn }])
  cert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 2, value: cn }, { type: 7, ip: '127.0.0.1' }] },
  ])
  cert.sign(keys.privateKey)
  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  }
}

/** 本地 mock TLS 上游(自签证书) */
function mockTlsUpstream (t, { cn, handler }) {
  const { cert, key } = selfSignedCert(cn)
  const srv = https.createServer({ cert, key }, (req, res) => {
    const body = []
    req.on('data', (d) => body.push(d))
    req.on('end', () => {
      if (handler) handler(req, res)
      res.writeHead(200, { 'content-type': 'text/plain', 'x-mock': 'tls-yes' })
      res.end('mock-tls-ok')
    })
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      if (t) t.after(() => new Promise((r) => srv.close(r)))
      resolve({ port, close: () => new Promise((r) => srv.close(r)) })
    })
  })
}

/** 经 HTTP 代理发起绝对 URI GET(经典正向代理形态)。自带 15s 超时, 防止代理静默不响应时挂死整个套件 */
function proxyGet (proxyPort, targetUrl, { headers = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: targetUrl,
      headers: { host: new URL(targetUrl).host, ...headers },
    }, (res) => {
      const body = []
      res.on('data', (d) => body.push(d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(body).toString() }))
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`proxyGet 超时(${timeoutMs}ms): ${targetUrl}`)))
    req.on('error', reject)
    req.end()
  })
}

/** 经代理 CONNECT 隧道建立到目标的 TCP 连接 */
function proxyConnect (proxyPort, host, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${host}:${port}`,
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        return reject(new Error(`CONNECT 失败: ${res.statusCode}`))
      }
      resolve(socket)
    })
    req.on('error', reject)
    req.end()
  })
}

/** 经代理 CONNECT + TLS 访问 https 目标。
 *  ca 传入 dss CA(验证 MITM 假证书链), 不传则 rejectUnauthorized:false(裸隧道场景)。
 *  skipHostnameCheck: 跳过 node 的主机名/IP-SAN 严格校验(IP 主机的 MITM 假证书无 IP SAN),
 *  此时调用方需自行断言 peerCert 的 issuer/subject。自带 15s 超时 */
function proxyGetHttps (proxyPort, host, port, reqPath, { ca, headers = {}, timeoutMs = 15000, skipHostnameCheck = false } = {}) {
  return new Promise((resolve, reject) => {
    const fail = (e) => reject(e)
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: `${host}:${port}` })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`CONNECT 超时(${timeoutMs}ms): ${host}:${port}`)))
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        return reject(new Error(`CONNECT 失败: ${res.statusCode}`))
      }
      // createConnection 提供 CONNECT 隧道 socket; 不用 agent:false —— 否则 node 发
      // Connection: close, dss 侧不建 keepalive agent, unVerifySsl 拦截器无法切换上游校验
      const tlsOpts = {
        host,
        port,
        createConnection: () => require('node:tls').connect({
          socket,
          servername: host,
          rejectUnauthorized: !!ca,
          ...(ca ? { ca } : {}),
          ...(skipHostnameCheck ? { checkServerIdentity: () => undefined } : {}),
        }),
        servername: host,
      }
      // connection: keep-alive 必须显式声明 —— 否则 dss 收到的请求带 connection:close,
      // rOptions.agent=false, unVerifySsl 拦截器无法切换上游校验 agent(实测首个上游请求必挂)
      const tlsReq = https.request({ ...tlsOpts, path: reqPath, headers: { host: `${host}:${port}`, connection: 'keep-alive', ...headers } }, (res2) => {
        const body = []
        res2.on('data', (d) => body.push(d))
        res2.on('end', () => resolve({
          status: res2.statusCode,
          headers: res2.headers,
          body: Buffer.concat(body).toString(),
          peerCert: tlsReq.socket.getPeerCertificate(),
          // keep-alive socket 由调用方在杀代理前销毁(否则 TerminateProcess 的 RST 变孤儿错误)
          rawSocket: tlsReq.socket,
        }))
      })
      tlsReq.setTimeout(timeoutMs, () => tlsReq.destroy(new Error(`TLS 请求超时(${timeoutMs}ms): ${host}:${port}${reqPath}`)))
      tlsReq.on('error', fail)
      tlsReq.end()
    })
    req.on('error', fail)
    req.end()
  })
}

/** 生成测试用 -c 配置: 基于内置默认配置, 端口指向隔离端口,
 *  并把 127.0.0.1 纳入 MITM 拦截(天然可解析, 上游即本地 TLS mock; 不依赖 DNS 映射链) */
function writeTestConfig (home, port, { upstreamPort } = {}) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/default.json'), 'utf8'))
  base.server.port = port
  if (upstreamPort) {
    base.server.intercepts['127.0.0.1'] = { '.*': { unVerifySsl: true } }
    // 预置自动兼容配置: 上游(本地 TLS mock)是自签证书, 首个请求即免上游校验 ——
    // 否则首个请求会失败, 需等 dss 的自动兼容程序持久化后第二个请求才成功
    const compatDir = path.join(home, '.dev-sidecar')
    fs.mkdirSync(compatDir, { recursive: true })
    fs.writeFileSync(path.join(compatDir, 'automaticCompatibleConfig.json'), JSON.stringify({
      connect: {},
      request: { [`127.0.0.1:${upstreamPort}`]: { rejectUnauthorized: false } },
    }, null, 2), 'utf8')
  }
  const p = path.join(home, 'dss-e2e-config.json')
  fs.writeFileSync(p, JSON.stringify(base, null, 2), 'utf8')
  return p
}

/** 跑真实 CLI 子进程, 返回 { code, stdout, stderr } */
function runCli (args, { home, port, extraEnv } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      env: childEnv({ home, port, extra: extraEnv }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }))
  })
}

/** 平台守护能力探测: systemd 在管(PID 1) 且 sudo 免密可用(CI runner 满足) */
function hasSystemdAndSudo () {
  if (process.platform !== 'linux') return false
  try {
    const init = require('node:child_process').spawnSync('ps', ['-p', '1', '-o', 'comm='], { encoding: 'utf8' })
    if (!/systemd/.test(init.stdout || '')) return false
    const sudo = require('node:child_process').spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8' })
    return sudo.status === 0
  } catch {
    return false
  }
}

module.exports = {
  ROOT,
  ENTRY,
  freePort,
  freePortPair,
  portInUse,
  isolatedHome,
  childEnv,
  startProxy,
  waitPort,
  waitPortClosed,
  mockUpstream,
  mockTlsUpstream,
  selfSignedCert,
  proxyGet,
  proxyConnect,
  proxyGetHttps,
  writeTestConfig,
  runCli,
  hasSystemdAndSudo,
}
