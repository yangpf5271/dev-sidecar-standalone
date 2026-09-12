// docker.js 纯函数契约测试 — CIDR 数学 / hosts 钉定解析 / 镜像地址解析
// (均为踩过坑的高风险逻辑: parseCidr 的无符号化、netstat 本地化、Docker mirror 校验)
const { test } = require('node:test')
const assert = require('node:assert')
const {
  parseCidr, ipToInt, isCloudflareIP,
  parseHostsPins, buildHostsLines,
  parseMirrorUrlPure,
} = require('./docker')

// ---------------------------------------------------------------------------
// CIDR 数学 — 回归保护: 首字节≥128 的段必须无符号比较(parseCidr 曾因此静默失效)
// ---------------------------------------------------------------------------

test('parseCidr: 首字节≥128 的段(172.64/13)base 必须为无符号值', () => {
  // 172.64.0.0/13 → 0xAC400000 = 2889875456 (有符号时为负数,与无符号比较永不相等)
  const c = parseCidr('172.64.0.0/13')
  assert.equal(c.base, 2889875456)
  assert.equal(c.mask, 0xFFF80000)
})

test('ipToInt: 标准点分十进制 → 无符号 32 位整数', () => {
  assert.equal(ipToInt('0.0.0.0'), 0)
  assert.equal(ipToInt('104.16.0.1'), (104 * 2 ** 24) + (16 * 2 ** 16) + 1)
  assert.equal(ipToInt('255.255.255.255'), 4294967295)
})

test('isCloudflareIP: CF 官方段命中 / 段边界 / 非 CF / 畸形输入', () => {
  // 104.16.0.0/13 覆盖 104.16-104.23
  assert.equal(isCloudflareIP('104.16.160.1'), true)
  assert.equal(isCloudflareIP('104.23.255.255'), true)
  assert.equal(isCloudflareIP('104.24.0.1'), true)    // 104.24.0.0/14
  assert.equal(isCloudflareIP('172.67.0.1'), true)    // 172.64/13
  assert.equal(isCloudflareIP('104.15.255.255'), false) // 段前
  assert.equal(isCloudflareIP('104.28.0.0'), false)   // 本项目 CF 段清单只到 104.24/14(104.24-27), 104.28 不在
  assert.equal(isCloudflareIP('104.32.0.1'), false)   // 列表外的 104.x
  assert.equal(isCloudflareIP('8.8.8.8'), false)      // Google
  assert.equal(isCloudflareIP('192.168.1.1'), false)  // 内网
  assert.equal(isCloudflareIP('abc'), false)          // 畸形
  assert.equal(isCloudflareIP(''), false)
  assert.equal(isCloudflareIP('104.16.0.1:443'), false) // 带端口不是裸 IP
})

// ---------------------------------------------------------------------------
// /etc/hosts 钉定 — 标记行幂等替换,其余行逐字保留
// ---------------------------------------------------------------------------

const M = '# dss-mirror'

test('parseHostsPins: 只取标记行,容忍多空白与格式噪音', () => {
  const lines = [
    '127.0.0.1 localhost',
    '1.2.3.4 docker.m.example.com # dss-mirror',
    '5.6.7.8\ta.m.example.com  # dss-mirror',
    '9.9.9.9 notpinned.example.com',      // 无标记
  ]
  const pins = parseHostsPins(lines)
  assert.equal(pins.get('docker.m.example.com'), '1.2.3.4')
  assert.equal(pins.get('a.m.example.com'), '5.6.7.8')
  assert.equal(pins.has('notpinned.example.com'), false)
})

test('buildHostsLines: 更新替换旧钉定 / null 只删不加 / 其余行逐字保留', () => {
  const lines = [
    '127.0.0.1 localhost',
    '1.2.3.4 docker.m.example.com # dss-mirror',
    '5.6.7.8 old.m.example.com # dss-mirror',
    '# user comment',
  ]
  const updates = new Map([
    ['docker.m.example.com', '8.8.8.8'],   // 换 IP
    ['old.m.example.com', null],           // 删除
    ['new.m.example.com', '9.9.9.9'],      // 新增
  ])
  const out = buildHostsLines(lines, updates)
  // 用户行原样保留
  assert.equal(out[0], '127.0.0.1 localhost')
  assert.equal(out.find((l) => l === '# user comment'), '# user comment')
  // 旧钉定行全部消失(含被替换的)
  assert.equal(out.filter((l) => l.includes('1.2.3.4')).length, 0)
  assert.equal(out.filter((l) => l.includes('5.6.7.8')).length, 0)
  // 新钉定行
  assert.ok(out.includes('8.8.8.8 docker.m.example.com # dss-mirror'))
  assert.ok(out.includes('9.9.9.9 new.m.example.com # dss-mirror'))
  // 4 原始行 - 2 旧钉定 + 2 新钉定 = 4
  assert.equal(out.length, 4)
})

test('buildHostsLines: 不误删包含标记文本但属用户自己的行', () => {
  // 用户手写的行恰好含 "dss-mirror" 字样但不是标记行格式 — 按契约它含标记即视为钉定行,
  // 其 domain 列不在 updates 中 → 保留
  const lines = ['1.1.1.1 other.example.com # dss-mirror']
  const updates = new Map([['docker.m.example.com', '2.2.2.2']])
  const out = buildHostsLines(lines, updates)
  assert.ok(out.includes('1.1.1.1 other.example.com # dss-mirror'))
  assert.ok(out.includes('2.2.2.2 docker.m.example.com # dss-mirror'))
})

// ---------------------------------------------------------------------------
// 镜像地址解析 — Docker ValidateMirror 兼容性(拒绝 query/fragment)
// ---------------------------------------------------------------------------

test('parseMirrorUrlPure: 补协议 / 去尾斜杠 / 路径模式(token 鉴权)', () => {
  const a = parseMirrorUrlPure('docker.m.example.com')
  assert.equal(a.ok, true)
  assert.equal(a.url, 'https://docker.m.example.com')
  assert.equal(a.host, 'docker.m.example.com')
  assert.equal(a.origin, 'https://docker.m.example.com')
  assert.equal(a.pathBase, '')

  const b = parseMirrorUrlPure('https://mirror.example.com/')
  assert.equal(b.ok, true)
  assert.equal(b.url, 'https://mirror.example.com')

  const c = parseMirrorUrlPure('https://auth.example.com/token-abc')
  assert.equal(c.ok, true)
  assert.equal(c.pathBase, '/token-abc')
})

test('parseMirrorUrlPure: query/fragment 拒绝(reason=query)', () => {
  assert.equal(parseMirrorUrlPure('https://m.example.com/?x=1').reason, 'query')
  assert.equal(parseMirrorUrlPure('https://m.example.com/#frag').reason, 'query')
  assert.equal(parseMirrorUrlPure('m.example.com?a=1').reason, 'query')
})

test('parseMirrorUrlPure: 无法解析的地址(reason=invalid)', () => {
  assert.equal(parseMirrorUrlPure('ht tp://bad host').reason, 'invalid')
  assert.equal(parseMirrorUrlPure('http://a b c').reason, 'invalid')
})

test('parseMirrorUrlPure: http 协议保留(内网镜像站场景)', () => {
  const r = parseMirrorUrlPure('http://192.168.1.10:5000')
  assert.equal(r.ok, true)
  assert.equal(r.origin, 'http://192.168.1.10:5000')
  assert.equal(r.host, '192.168.1.10')
})
