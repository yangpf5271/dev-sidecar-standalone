// dss docker — Docker 场景加速：拉取层(mirror) + 构建层(build proxy)
//
// 拉取层(Linux/WSL): dss docker mirror add/remove/refresh/status
//   健康检查 → CF 边缘 IP 优选 → /etc/hosts 钉定 → daemon.json 合并 → 重启 docker
// 构建层(三平台):  dss docker on/off/status
//   ~/.docker/config.json proxies 注入(严格保留 auths) + noProxy 自动聚合
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const dns = require('node:dns').promises
const { spawn } = require('node:child_process')
const { IS_WIN, resolveProxyAddress, runCommand, probePort } = require('./utils')

const HOSTS_FILE = '/etc/hosts'
const DAEMON_JSON = '/etc/docker/daemon.json'
const HOSTS_MARKER = 'dss-mirror' // 行格式: <ip> <domain> # dss-mirror

// Cloudflare 官方 IPv4 段(用于判定镜像域名是否走 CF,命中才做优选钉定)
const CF_CIDRS = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
].map(parseCidr)

// CF 边缘优选 IP 池(anycast,可按需更新;来源与社区优选列表同段)
const CF_EDGE_POOL = [
  '104.16.0.1', '104.16.160.1', '104.17.0.1', '104.18.32.1', '104.19.0.1',
  '104.20.0.1', '104.21.16.1', '104.22.32.1', '104.24.0.1', '104.25.16.1',
  '104.26.0.1', '104.27.0.1', '104.28.0.1',
  '172.64.32.1', '172.64.155.1', '172.65.0.1', '172.66.0.1', '172.67.0.1',
  '172.68.0.1', '172.69.0.1', '172.70.0.1', '172.71.0.1',
  '162.158.0.1', '162.158.8.1', '162.159.0.1', '162.159.32.1', '162.159.136.1',
  '162.159.192.1', '188.114.96.1', '188.114.97.1', '188.114.98.1', '188.114.99.1',
]

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function parseCidr (cidr) {
  const [ip, bits] = cidr.split('/')
  const mask = ~((1 << (32 - Number(bits))) - 1) >>> 0
  return { base: ipToInt(ip) & mask, mask }
}

function ipToInt (ip) {
  return ip.split('.').reduce((n, o) => ((n << 8) + Number(o)) >>> 0, 0)
}

function isCloudflareIP (ip) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false
  const v = ipToInt(ip)
  return CF_CIDRS.some((c) => (v & c.mask) >>> 0 === c.base)
}

function dockerConfigPath () {
  return path.join(os.homedir(), '.docker', 'config.json')
}

function readJsonFile (file) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, data: null }
    return { ok: false, error: e.message }
  }
}

function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/** sudo 复制(sudo 密码交互走终端 stdio inherit;不能用 tee 管道,密码需要 tty) */
function sudoCopy (src, dst) {
  return new Promise((resolve) => {
    const child = spawn('sudo', ['cp', src, dst], { stdio: 'inherit' })
    child.on('error', (e) => resolve({ ok: false, error: e.message }))
    child.on('close', (code) => resolve({ ok: code === 0 }))
  })
}

/** 重启 docker:systemd 优先,传统 service 回退;短间隔连续重启可能瞬时失败,重试一次 */
async function restartDocker () {
  const sysd = await runCommand('systemctl', ['is-active', '--quiet', 'docker'])
  const cmd = sysd.ok
    ? () => spawn('sudo', ['systemctl', 'restart', 'docker'], { stdio: 'inherit' })
    : () => spawn('sudo', ['service', 'docker', 'restart'], { stdio: 'inherit' })
  const attempt = () => new Promise((resolve) => {
    const child = cmd()
    child.on('error', (e) => resolve({ ok: false, error: e.message }))
    child.on('close', (code) => resolve({ ok: code === 0 }))
  })
  const first = await attempt()
  if (first.ok) return first
  await new Promise((r) => setTimeout(r, 2000))
  return attempt()
}

/** 简单 HTTP GET,只取状态码(不跟随重定向) */
function httpGetStatus (url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url)
      const mod = u.protocol === 'http:' ? http : https
      const req = mod.get(url, { timeout: timeoutMs }, (res) => {
        resolve({ status: res.statusCode })
        res.resume()
        res.destroy()
      })
      req.on('timeout', () => { req.destroy(); resolve({ status: 0 }) })
      req.on('error', () => resolve({ status: 0 }))
    } catch {
      resolve({ status: 0 })
    }
  })
}

/** TCP 连接计时(毫秒),失败返回 null */
function timedTcpProbe (ip, port = 443, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const start = Date.now()
    const socket = net.createConnection({ host: ip, port })
    const done = (v) => { socket.removeAllListeners(); socket.destroy(); resolve(v) }
    socket.setTimeout(timeoutMs, () => done(null))
    socket.on('connect', () => done(Date.now() - start))
    socket.on('error', () => done(null))
  })
}

/** 对 IP 池并发测速,返回按延迟排序的结果(仅可用项) */
async function speedTestPool (pool) {
  const results = await Promise.all(pool.map(async (ip) => ({ ip, ms: await timedTcpProbe(ip) })))
  return results.filter((r) => r.ms != null).sort((a, b) => a.ms - b.ms)
}

// ---------------------------------------------------------------------------
// /etc/hosts 钉定(带标记行,幂等替换)
// ---------------------------------------------------------------------------

function readHostsLines () {
  try {
    return fs.readFileSync(HOSTS_FILE, 'utf8').split('\n')
  } catch {
    return null
  }
}

/**
 * 批量更新 hosts:updates 为 Map<domain, ip|null>(null = 删除钉定)。
 * 只操作带 dss-mirror 标记的行,其余逐字保留;经临时文件 + sudo cp 写入。
 */
async function applyHostsUpdates (updates) {
  const lines = readHostsLines()
  if (lines == null) return { ok: false, error: '无法读取 /etc/hosts' }

  const domains = new Set(updates.keys())
  // 移除所有相关域名的旧钉定行
  const kept = lines.filter((line) => {
    if (!line.includes(`# ${HOSTS_MARKER}`)) return true
    const domain = line.split(/\s+/)[1]
    return !domains.has(domain)
  })
  // 追加新钉定行
  for (const [domain, ip] of updates) {
    if (ip) kept.push(`${ip} ${domain} # ${HOSTS_MARKER}`)
  }

  const tmp = path.join(os.tmpdir(), `dss-hosts-${Date.now()}`)
  fs.writeFileSync(tmp, kept.join('\n'), 'utf8')
  const r = await sudoCopy(tmp, HOSTS_FILE)
  try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }
  return r
}

/** 读取当前钉定 Map<domain, ip> */
function readHostsPins () {
  const pins = new Map()
  const lines = readHostsLines() || []
  for (const line of lines) {
    if (!line.includes(`# ${HOSTS_MARKER}`)) continue
    const parts = line.split(/\s+/)
    if (parts.length >= 2) pins.set(parts[1], parts[0])
  }
  return pins
}

// ---------------------------------------------------------------------------
// daemon.json 管理
// ---------------------------------------------------------------------------

function readDaemonJson () {
  const r = readJsonFile(DAEMON_JSON)
  if (!r.ok) {
    return { ok: false, error: `/etc/docker/daemon.json 已损坏(${r.error}),请人工修复后再试` }
  }
  return { ok: true, data: r.data || {} }
}

async function writeDaemonJson (data) {
  const tmp = path.join(os.tmpdir(), `dss-daemon-${Date.now()}.json`)
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  const r = await sudoCopy(tmp, DAEMON_JSON)
  try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }
  return r
}

// ---------------------------------------------------------------------------
// 构建层: dss docker on/off/status
// ---------------------------------------------------------------------------

/** 探测容器 → 宿主代理地址:docker0 网关 → Windows/Desktop 的 host.docker.internal → 172.17.0.1 */
async function detectGateway () {
  if (!IS_WIN) {
    const r = await runCommand('ip', ['-4', 'addr', 'show', 'docker0'])
    const m = r.ok ? r.stdout.match(/inet (\d+\.\d+\.\d+\.\d+)/) : null
    if (m) return m[1]
  }
  return IS_WIN ? 'host.docker.internal' : '172.17.0.1'
}

/** 从 registry 地址串(可能 host 或 host:port)提取主机名 */
function hostOf (addr) {
  try {
    const u = new URL(addr.startsWith('http') ? addr : `https://${addr}`)
    return u.hostname || addr.split(':')[0]
  } catch {
    return addr.split(':')[0]
  }
}

/** noProxy 自动聚合:内网段 + config.json auths 主机 + daemon.json insecure-registries + 用户追加 */
async function collectNoProxy (extra = []) {
  const list = [
    'localhost', '127.0.0.1', '::1',
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16',
  ]
  const cfg = readJsonFile(dockerConfigPath())
  if (cfg.ok && cfg.data && cfg.data.auths) {
    for (const key of Object.keys(cfg.data.auths)) list.push(hostOf(key))
  }
  const daemon = readDaemonJson()
  if (daemon.ok && daemon.data && Array.isArray(daemon.data['insecure-registries'])) {
    for (const reg of daemon.data['insecure-registries']) list.push(hostOf(reg))
  }
  for (const e of extra) {
    for (const item of String(e).split(',')) {
      if (item.trim()) list.push(item.trim())
    }
  }
  return [...new Set(list)]
}

async function cmdOn (args) {
  const addr = resolveProxyAddress(args)
  let proxyUrl = null
  const extraNoProxy = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--proxy-url') proxyUrl = args[++i]
    if (args[i] === '--no-proxy') extraNoProxy.push(args[++i])
  }

  if (!proxyUrl) {
    const gateway = await detectGateway()
    proxyUrl = `http://${gateway}:${addr.httpPort}`
    const reachable = await probePort(gateway, addr.httpPort, 1500)
    if (!reachable) {
      console.log(`⚠️  未探测到 dss 在 ${gateway}:${addr.httpPort} 监听`)
      console.log('   容器需经宿主网关访问代理,dss 需对外监听:')
      console.log('     HOST=0.0.0.0 dss start')
      console.log('')
    }
  }

  const noProxy = await collectNoProxy(extraNoProxy)
  const file = dockerConfigPath()
  const cfg = readJsonFile(file)
  if (!cfg.ok) {
    console.error(`❌ ${file} 已损坏: ${cfg.error}`)
    process.exit(1)
  }
  const data = cfg.data || {}
  data.proxies = data.proxies || {}
  data.proxies.default = {
    httpProxy: proxyUrl,
    httpsProxy: proxyUrl,
    noProxy: noProxy.join(','),
  }
  writeJson(file, data)

  console.log(`✅ 构建层代理已注入: ${file}`)
  console.log(`   httpProxy / httpsProxy → ${proxyUrl}`)
  console.log(`   noProxy → ${noProxy.join(',')}`)
  console.log('')
  console.log('   docker build / docker run 将自动获得代理环境变量')
  console.log('   注意: 构建内访问 github.com 等被拦截域名需自带 CA(见 README Docker 章节)')
  console.log('取消: dss docker off')
}

async function cmdOff () {
  const file = dockerConfigPath()
  const cfg = readJsonFile(file)
  if (!cfg.ok) {
    console.error(`❌ ${file} 已损坏: ${cfg.error}`)
    process.exit(1)
  }
  if (!cfg.data || !cfg.data.proxies) {
    console.log('未配置构建层代理,无需移除')
    return
  }
  delete cfg.data.proxies.default
  if (Object.keys(cfg.data.proxies).length === 0) delete cfg.data.proxies
  writeJson(file, cfg.data)
  console.log(`✅ 构建层代理已移除(其余配置如 auths 原样保留): ${file}`)
}

// ---------------------------------------------------------------------------
// 拉取层: dss docker mirror add/remove/refresh/status
// ---------------------------------------------------------------------------

function requireLinux (action) {
  if (IS_WIN) {
    console.error(`❌ dss docker mirror ${action} 需要 Linux/WSL 环境(依赖 /etc/hosts 与 daemon.json)`)
    console.error('   Windows 用户: 在 WSL 中运行,或使用 Docker Desktop 图形界面配置')
    process.exit(1)
  }
}

function parseMirrorUrl (raw) {
  let url = raw.replace(/\/+$/, '')
  if (!/^https?:\/\//.test(url)) url = `https://${url}`
  try {
    const u = new URL(url)
    // Docker 的 ValidateMirror 拒绝含 query/fragment 的 mirror,写入会导致 daemon 拒绝启动
    if (u.search || u.hash) {
      console.error(`❌ 镜像地址不能包含查询参数或片段: ${raw}`)
      console.error('   Docker daemon 会拒绝此类 mirror 地址(无法启动)')
      process.exit(1)
    }
    return { url, host: u.hostname, origin: u.origin, pathBase: u.pathname.replace(/\/+$/, '') }
  } catch {
    console.error(`❌ 无效的镜像地址: ${raw}`)
    process.exit(1)
  }
}

async function healthCheck (parsed) {
  const target = `${parsed.origin}${parsed.pathBase}/v2/`
  const r = await httpGetStatus(target)
  return { ok: r.status === 200 || r.status === 401, status: r.status, target }
}

/** 域名是否需要 CF 优选:--cf 强制 / 解析 IP 落在 CF 段自动启用;IP 字面量永不钉定 */
async function shouldOptimize (host, force) {
  if (/^(\d+\.)+\d+$/.test(host) || host === 'localhost') return false
  if (force) return true
  try {
    const { address } = await dns.lookup(host, { family: 4 })
    return isCloudflareIP(address)
  } catch {
    return false // 解析失败不阻断,交由常规解析
  }
}

/** 优选并返回最优 IP(池全挂返回 null 并警告) */
async function optimizeCfIp () {
  const ranked = await speedTestPool(CF_EDGE_POOL)
  if (ranked.length === 0) {
    console.log('⚠️  CF 边缘 IP 池全部不可达,跳过 hosts 钉定(使用域名常规解析)')
    return null
  }
  const top = ranked.slice(0, 3).map((r) => `${r.ip}(${r.ms}ms)`).join(', ')
  console.log(`ℹ️  CF 边缘测速 Top3: ${top}`)
  return ranked[0].ip
}

/** 读取 docker 主版本号(解析失败返回 null) */
async function dockerMajorVersion () {
  const r = await runCommand('docker', ['--version'])
  const m = r.ok ? r.stdout.match(/Docker version (\d+)\./) : null
  return m ? parseInt(m[1], 10) : null
}

async function cmdMirrorAdd (args) {
  requireLinux('add')
  const raw = args[0]
  if (!raw) {
    help()
    process.exit(1)
  }
  const force = args.includes('--force')
  const cf = args.includes('--cf')
  const noPin = args.includes('--no-pin')
  const parsed = parseMirrorUrl(raw)

  // 路径前缀 token 模式需 Docker ≥ 24:旧版 daemon 会因 mirror 含路径拒绝启动,
  // 写入即导致 docker 起不来——比拉取失败严重得多,必须前置拦截。
  // 注意: Basic-auth 不能作为 mirror 的替代方案——dockerd 不会把 mirror 的
  // docker login 凭证附加到 docker.io 拉取(moby#30880),401 后直接回退被墙官方源
  if (parsed.pathBase) {
    const ver = await dockerMajorVersion()
    if (ver != null && ver < 24) {
      console.error(`❌ 镜像地址含路径前缀(路径模式),但当前 Docker Engine 为 ${ver}.x`)
      console.error('   Docker ≤ 23.x 的 daemon 会因 registry-mirror 含路径而拒绝启动')
      console.error('   方案: ① Worker 侧不设 ACCESS_TOKEN(内网/个人使用)')
      console.error('        ② 升级 Docker ≥ 24 后再使用路径模式')
      console.error('        ③ 确认风险后 --force 强制写入')
      if (!force) process.exit(1)
      console.error('   (--force 已指定,继续写入,风险自负)')
    } else if (ver == null) {
      console.log('⚠️  无法探测 Docker 版本(docker 命令不可用?)')
      console.log('   若 Docker ≤ 23.x,含路径的 mirror 会导致 daemon 拒绝启动')
    }
  }

  // 1. 健康检查(硬阻断,--force 逃生)
  if (!force) {
    console.log(`健康检查: ${parsed.origin}${parsed.pathBase}/v2/ ...`)
    const h = await healthCheck(parsed)
    if (!h.ok) {
      console.error(`❌ 镜像源不可用(HTTP ${h.status || '无响应'}): ${h.target}`)
      console.error('   确认部署正确(docs/worker-deploy.md)或使用 --force 跳过检查')
      process.exit(1)
    }
    console.log('✅ 健康检查通过')
  }

  // 2. CF 优选 + hosts 钉定
  const hostsUpdates = new Map()
  if (!noPin && (await shouldOptimize(parsed.host, cf))) {
    console.log(`检测到 Cloudflare 域名,进行边缘 IP 优选: ${parsed.host}`)
    const best = await optimizeCfIp()
    if (best) hostsUpdates.set(parsed.host, best)
  }

  // 3. daemon.json 合并写入
  const daemon = readDaemonJson()
  if (!daemon.ok) {
    console.error(`❌ ${daemon.error}`)
    process.exit(1)
  }
  const mirrors = Array.isArray(daemon.data['registry-mirrors']) ? daemon.data['registry-mirrors'] : []
  const already = mirrors.includes(parsed.url)
  if (!already) mirrors.push(parsed.url)
  daemon.data['registry-mirrors'] = mirrors

  console.log('写入 /etc/docker/daemon.json(需要 sudo)...')
  const w = await writeDaemonJson(daemon.data)
  if (!w.ok) {
    console.error(`❌ daemon.json 写入失败: ${w.error || 'sudo 被拒绝'}`)
    process.exit(1)
  }

  if (hostsUpdates.size > 0) {
    console.log('优选 IP 钉定 /etc/hosts(需要 sudo)...')
    const h = await applyHostsUpdates(hostsUpdates)
    if (h.ok) {
      console.log(`✅ 已钉定: ${[...hostsUpdates].map(([d, ip]) => `${d} → ${ip}`).join(', ')}`)
    } else {
      console.log(`⚠️  hosts 写入失败(${h.error || 'sudo 被拒绝'}),使用域名常规解析`)
    }
  }

  // 4. 重启 docker + 验证
  console.log('重启 docker(运行中容器会被中断)...')
  const r = await restartDocker()
  if (!r.ok) {
    console.error('❌ docker 重启失败,请手动: sudo systemctl restart docker')
    process.exit(1)
  }
  console.log('✅ docker 已重启')

  const info = await runCommand('docker', ['info'])
  if (info.ok && info.stdout.includes(parsed.host)) {
    console.log('✅ docker info 已确认 Registry Mirrors 生效')
  } else {
    console.log('ℹ️  请用 docker info | grep -A3 "Registry Mirrors" 自行确认')
  }
  console.log('')
  console.log(already ? '该镜像源已在配置中(幂等,已重新优选/重启)' : `✅ 镜像源已配置: ${parsed.url}`)
  console.log('实测: docker pull hello-world')
  console.log('变慢时: dss docker mirror refresh    移除: dss docker mirror remove <url>')
}

async function cmdMirrorRemove (args) {
  requireLinux('remove')
  const raw = args[0]
  if (!raw || raw === 'off') {
    // off = 移除全部;无配置时不做无谓重启(避免打断运行中容器)
    const daemon = readDaemonJson()
    if (!daemon.ok) { console.error(`❌ ${daemon.error}`); process.exit(1) }
    const mirrors = Array.isArray(daemon.data['registry-mirrors']) ? daemon.data['registry-mirrors'] : []
    if (mirrors.length === 0) {
      console.log('当前未配置任何镜像源,无需移除')
      return
    }
    for (const url of mirrors) {
      await removeOne(url)
    }
    await finishRemove()
    return
  }
  const parsed = parseMirrorUrl(raw)
  await removeOne(parsed.url)
  await finishRemove()
}

async function removeOne (url) {
  const parsed = parseMirrorUrl(url)
  const daemon = readDaemonJson()
  if (!daemon.ok) { console.error(`❌ ${daemon.error}`); process.exit(1) }
  const mirrors = Array.isArray(daemon.data['registry-mirrors']) ? daemon.data['registry-mirrors'] : []
  const next = mirrors.filter((u) => u !== parsed.url)
  if (next.length === 0) delete daemon.data['registry-mirrors']
  else daemon.data['registry-mirrors'] = next
  const w = await writeDaemonJson(daemon.data)
  if (!w.ok) { console.error(`❌ daemon.json 写入失败: ${w.error}`); process.exit(1) }

  // hosts 钉定行随移除清理
  const pins = readHostsPins()
  if (pins.has(parsed.host)) {
    await applyHostsUpdates(new Map([[parsed.host, null]]))
    console.log(`✅ 已移除: daemon.json ${parsed.url} + hosts 钉定行`)
  } else {
    console.log(`✅ 已移除: daemon.json ${parsed.url}`)
  }
}

async function finishRemove () {
  console.log('重启 docker...')
  const r = await restartDocker()
  console.log(r.ok ? '✅ docker 已重启' : '❌ 重启失败,请手动重启')
}

async function cmdMirrorRefresh (args = []) {
  requireLinux('refresh')
  const cf = args.includes('--cf')
  const daemon = readDaemonJson()
  if (!daemon.ok) { console.error(`❌ ${daemon.error}`); process.exit(1) }
  const mirrors = Array.isArray(daemon.data['registry-mirrors']) ? daemon.data['registry-mirrors'] : []
  if (mirrors.length === 0) {
    console.log('当前未配置任何镜像源(dss docker mirror add <url>)')
    return
  }
  const updates = new Map()
  for (const url of mirrors) {
    const parsed = parseMirrorUrl(url)
    if (!(await shouldOptimize(parsed.host, cf))) {
      console.log(`跳过非 CF 域名: ${parsed.host}`)
      continue
    }
    console.log(`优选: ${parsed.host}`)
    const best = await optimizeCfIp()
    if (best) updates.set(parsed.host, best)
  }
  if (updates.size === 0) {
    console.log('无可刷新的 CF 优选域名')
    return
  }
  console.log('更新 /etc/hosts(需要 sudo)...')
  const r = await applyHostsUpdates(updates)
  if (!r.ok) { console.error(`❌ hosts 写入失败: ${r.error}`); process.exit(1) }
  console.log(`✅ 已刷新: ${[...updates].map(([d, ip]) => `${d} → ${ip}`).join(', ')}`)
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function cmdStatus () {
  const cfg = readJsonFile(dockerConfigPath())
  console.log('构建层(~/.docker/config.json):')
  if (cfg.ok && cfg.data && cfg.data.proxies && cfg.data.proxies.default) {
    const p = cfg.data.proxies.default
    console.log(`  ✅ 代理已注入: ${p.httpProxy} / ${p.httpsProxy}`)
    console.log(`  noProxy: ${p.noProxy}`)
  } else {
    console.log('  — 未注入(dss docker on)')
  }
  if (cfg.ok && cfg.data && cfg.data.auths) {
    console.log(`  auths(受保护): ${Object.keys(cfg.data.auths).join(', ')}`)
  }
  console.log('')

  console.log('拉取层(daemon.json / hosts):')
  if (IS_WIN) {
    console.log('  Windows 环境不支持拉取层命令(请在 WSL/Linux 运行)')
  } else {
    const daemon = readDaemonJson()
    if (daemon.ok && Array.isArray(daemon.data['registry-mirrors']) && daemon.data['registry-mirrors'].length > 0) {
      for (const url of daemon.data['registry-mirrors']) {
        const parsed = parseMirrorUrl(url)
        const h = await healthCheck(parsed)
        console.log(`  ${h.ok ? '✅' : '❌'} ${url}${h.ok ? '' : ` (HTTP ${h.status || '无响应'})`}`)
      }
    } else {
      console.log('  — 未配置镜像源(dss docker mirror add <url>)')
    }
    const pins = readHostsPins()
    if (pins.size > 0) {
      console.log('  hosts 优选钉定:')
      for (const [domain, ip] of pins) console.log(`    ${domain} → ${ip}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function run (args) {
  const sub = args[0]
  if (sub === 'on') return cmdOn(args.slice(1))
  if (sub === 'off') return cmdOff()
  if (sub === 'status') return cmdStatus()
  if (sub === 'mirror') {
    const action = args[1]
    const rest = args.slice(2)
    if (action === 'add') return cmdMirrorAdd(rest)
    if (action === 'remove') return cmdMirrorRemove(rest)
    if (action === 'refresh') return cmdMirrorRefresh(rest)
    if (action === 'status' || action === undefined) {
      // mirror status 复用整体 status
      return cmdStatus()
    }
    help()
    process.exit(action ? 1 : 0)
  }
  help()
  process.exit(sub ? 1 : 0)
}

function help () {
  console.log('用法: dss docker <on|off|mirror|status>')
  console.log('')
  console.log('构建层(解决 docker build 内依赖安装,三平台,无 sudo):')
  console.log('  dss docker on [--proxy-url <url>] [--no-proxy <x>]')
  console.log('        注入 ~/.docker/config.json proxies 段(auths 严格保留),')
  console.log('        代理地址自动探测(docker0 网关/host.docker.internal),')
  console.log('        noProxy 自动聚合内网段与已有 registry 主机')
  console.log('  dss docker off        移除 proxies 段(auths 保留)')
  console.log('')
  console.log('拉取层(解决 docker pull,需 Linux/WSL + sudo):')
  console.log('  dss docker mirror add <url> [--force] [--cf] [--no-pin]')
  console.log('        健康检查 → CF 边缘优选 → hosts 钉定 → daemon.json 合并 → 重启 docker')
  console.log('        公网鉴权用路径模式 https://域名/<token>(需 Docker ≥ 24)')
  console.log('        (Basic/docker login 仅适用于直接 docker pull 域名/镜像,')
  console.log('         不能用于 registry-mirrors — dockerd 不给 mirror 带凭证)')
  console.log('  dss docker mirror remove <url>   移除(或 remove off 移除全部)')
  console.log('  dss docker mirror refresh        重测优选 IP(变慢时执行)')
  console.log('  dss docker status                总览状态')
  console.log('')
  console.log('自建镜像站: 见 docs/worker-deploy.md(Cloudflare Worker 模板,谁使用谁部署)')
}

module.exports = { run, help }
