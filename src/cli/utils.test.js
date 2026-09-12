// utils 契约测试 — 配置值显示契约 / 端口反查解析 / 进程身份 / 地址解析 / 存活探测
const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  makeConfigValueLabel,
  identityTextMatches,
  parsePowerShellPortPids,
  parseNetstatLocalPortPids,
  parseSsListenPids,
  parseLsofPids,
  resolveProxyAddress,
  isProcessAlive,
  waitForExit,
} = require('./utils')

test('makeConfigValueLabel: 读成功时 值→原样 / null→(未设置); 读失败→获取失败', () => {
  const ok = makeConfigValueLabel(true)
  assert.equal(ok('http://127.0.0.1:31180'), 'http://127.0.0.1:31180')
  assert.equal(ok(null), '(未设置)')

  const fail = makeConfigValueLabel(false)
  assert.equal(fail(null), '获取失败')
  assert.equal(fail('whatever'), '获取失败')   // 读失败时值不可信, 一律获取失败
})

// ---------------------------------------------------------------------------
// 进程身份判定 — verifyProcessIdentity 各平台共用的核心
// ---------------------------------------------------------------------------

test('identityTextMatches: 命中包名或 index.js / 空值与无关进程不命中', () => {
  assert.equal(identityTextMatches('node D:\\nvm\\v22\\node_modules\\dev-sidecar-standalone\\index.js'), true)
  assert.equal(identityTextMatches('node /usr/lib/node_modules/dev-sidecar-standalone/index.js'), true)
  assert.equal(identityTextMatches('node index.js'), true)   // 开发态直跑
  assert.equal(identityTextMatches('node server.js'), false)
  assert.equal(identityTextMatches(''), false)
  assert.equal(identityTextMatches(null), false)
  assert.equal(identityTextMatches(undefined), false)
})

// ---------------------------------------------------------------------------
// 端口反查解析 — 纯函数(文本, 端口)→ PID 列表
// ---------------------------------------------------------------------------

test('parsePowerShellPortPids: 每行一个 PID, 忽略空行与非数字', () => {
  assert.deepEqual(parsePowerShellPortPids('18328\n18329\n\n'), [18328, 18329])
  assert.deepEqual(parsePowerShellPortPids(''), [])
  assert.deepEqual(parsePowerShellPortPids('not-a-pid'), [])
})

test('parseNetstatLocalPortPids: 锚定本地地址列, 不依赖本地化状态文本', () => {
  // 状态列用非英文占位(模拟非英文系统), 解析只看协议列/本地地址/末列 PID
  const text = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:31180        0.0.0.0:0              LISTENING       18328',
    '  TCP    127.0.0.1:31181        0.0.0.0:0              LISTENING       18328',
    '  TCP    127.0.0.1:31180        127.0.0.1:5000         ESTABLISHED     9999',  // 非监听但本地地址匹配 — 契约: 状态列不可信(本地化), 仍计入
    '  TCP    127.0.0.1:3119         0.0.0.0:0              LISTENING       7777',   // 端口前缀误匹配防护: 3119 ≠ 31180
    '  TCP    [::]:31180             [::]:0                 LISTENING       18328',  // IPv6
    '  UDP    127.0.0.1:31180        *:*                                    4242',   // 非 TCP 行忽略
  ].join('\n')
  assert.deepEqual(parseNetstatLocalPortPids(text, 31180), [18328, 9999, 18328])
  assert.deepEqual(parseNetstatLocalPortPids(text, 31181), [18328])
})

test('parseNetstatLocalPortPids: 端口数字必须是精确后缀(3119 不匹配 :31180)', () => {
  const text = '  TCP    127.0.0.1:31180        0.0.0.0:0              LISTENING       18328'
  assert.deepEqual(parseNetstatLocalPortPids(text, 3119), [])
})

test('parseSsListenPids: IPv4/IPv6 本地地址匹配 + 行内 pid= 提取', () => {
  const text = [
    'State   Recv-Q  Send-Q   Local Address:Port   Peer Address:Port  Process',
    'LISTEN  0       511          127.0.0.1:31181      0.0.0.0:*        users:(("node",pid=18328,fd=20))',
    'LISTEN  0       511              [::]:31180           [::]:*         users:(("node",pid=18328,fd=21))',
    'LISTEN  0       128              0.0.0.0:22           0.0.0.0:*        users:(("sshd",pid=900,fd=3))',
  ].join('\n')
  assert.deepEqual(parseSsListenPids(text, 31181), [18328])
  assert.deepEqual(parseSsListenPids(text, 31180), [18328])
  assert.deepEqual(parseSsListenPids(text, 22), [900])
  assert.deepEqual(parseSsListenPids(text, 9999), [])
})

test('parseSsListenPids: 无 -p 权限时行内无 pid= → 空列表(调用方回退 lsof)', () => {
  const text = 'LISTEN  0  511  0.0.0.0:31181  0.0.0.0:*'
  assert.deepEqual(parseSsListenPids(text, 31181), [])
})

test('parseLsofPids: 每行一个 PID', () => {
  assert.deepEqual(parseLsofPids('18328\n18329\n'), [18328, 18329])
  assert.deepEqual(parseLsofPids(''), [])
})

// ---------------------------------------------------------------------------
// resolveProxyAddress — 配置文件(server 嵌套/平铺) + 环境变量覆盖
// ---------------------------------------------------------------------------

let tmpDir
let savedEnv

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-utils-test-'))
  savedEnv = { PORT: process.env.PORT, HOST: process.env.HOST }
  delete process.env.PORT
  delete process.env.HOST
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  if (savedEnv.PORT != null) process.env.PORT = savedEnv.PORT
  if (savedEnv.HOST != null) process.env.HOST = savedEnv.HOST
})

function writeCfg (name, obj) {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8')
  return p
}

test('resolveProxyAddress: 无配置 → 默认 127.0.0.1:31181/31180', () => {
  const a = resolveProxyAddress([])
  assert.equal(a.host, '127.0.0.1')
  assert.equal(a.mitmPort, 31181)
  assert.equal(a.httpPort, 31180)
  assert.equal(a.isDefaultPort, true)
  assert.equal(a.configPath, null)
})

test('resolveProxyAddress: -c 标准 server 嵌套结构与 --config= 形式', () => {
  const p = writeCfg('nested.json', { server: { host: '0.0.0.0', port: 42181 } })
  const a = resolveProxyAddress(['-c', p])
  assert.equal(a.host, '0.0.0.0')
  assert.equal(a.mitmPort, 42181)
  assert.equal(a.httpPort, 42180)
  assert.equal(a.isDefaultPort, false)

  const b = resolveProxyAddress([`--config=${p}`])
  assert.equal(b.mitmPort, 42181)
  assert.equal(b.configPath, p)
})

test('resolveProxyAddress: 平铺结构 {port,host} 与嵌套等效(契约: 两种都支持)', () => {
  const p = writeCfg('flat.json', { host: '0.0.0.0', port: 43181 })
  const a = resolveProxyAddress(['-c', p])
  assert.equal(a.host, '0.0.0.0')
  assert.equal(a.mitmPort, 43181)
})

test('resolveProxyAddress: PORT/HOST 环境变量优先级高于配置文件', () => {
  const p = writeCfg('nested.json', { server: { host: '0.0.0.0', port: 42181 } })
  process.env.PORT = '44181'
  process.env.HOST = '192.168.1.5'
  const a = resolveProxyAddress(['-c', p])
  assert.equal(a.host, '192.168.1.5')
  assert.equal(a.mitmPort, 44181)
  assert.equal(a.httpPort, 44180)
})

// ---------------------------------------------------------------------------
// 进程存活探测(用测试进程自身, 无副作用)
// ---------------------------------------------------------------------------

test('isProcessAlive: 自身存活 / 非法输入 false', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(null), false)
  assert.equal(isProcessAlive('abc'), false)
  assert.equal(isProcessAlive(99999999), false) // 理论上测试进程不会占用此 PID
})

test('waitForExit: 自身进程在超时窗内不会退出 → false', async () => {
  assert.equal(await waitForExit(process.pid, 400), false)
})
