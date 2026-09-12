// tool-config 共享语义 — classify(宽松)/isOurs 候选集(严格)/归一化
// 独立成文件避免 index ↔ adapter 循环 require
const path = require('node:path')
const { DEFAULT_MITM_PORT } = require('../server-config')

/**
 * 值归一化: npm 的未设置哨兵('null'/'undefined')与空串 → null
 */
function normalizeProxyUrlValue (v) {
  if (!v) return null
  const s = String(v).trim()
  if (!s || s === 'null' || s === 'undefined' || s === '(未设置)') return null
  return s
}

/**
 * classify 宽松语义(供展示): 按端口子串判定 mode。
 * values: { http, https } 已归一化; addr: { host, httpPort, mitmPort }
 * 返回 { mode: 'none'|'mitm'|'tunnel'|'other', address }
 *
 * 边界值 evil.com:<httpPort> 判为 tunnel 是设计行为(展示要"看起来像就提醒"),
 * 与 isOurs(严格清理)的分歧由单测锁定 — 见 spec: tool-config-store
 */
function classifyValues (values, addr) {
  const http = values && values.http
  const https = values && values.https
  const any = https || http
  if (!any) return { mode: 'none', address: null }
  if (https && https.includes(`:${addr.mitmPort}`)) return { mode: 'mitm', address: https }
  if ((http && http.includes(`:${addr.httpPort}`)) || (https && https.includes(`:${addr.httpPort}`))) {
    return { mode: 'tunnel', address: https || http }
  }
  return { mode: 'other', address: any }
}

/**
 * isOurs 严格语义的候选集(供清理): 快照记录值 + host×port 全组合 + 默认端口兜底。
 * 快照解决端口漂移: 非默认端口 on、默认端口 stop 时仍能匹配
 */
function buildProxyCandidates (addr, snapshot) {
  const set = new Set()
  const hosts = new Set([addr.host, '127.0.0.1', 'localhost'])
  // 默认端口兜底取单点(server-config); +1/-1 组合覆盖 http/mitm 双端口旧值
  const ports = new Set([addr.httpPort, addr.mitmPort, DEFAULT_MITM_PORT - 1, DEFAULT_MITM_PORT])
  for (const p of ports) {
    for (const h of hosts) {
      set.add(`http://${h}:${p}`)
    }
  }
  for (const tool of ['npm', 'git']) {
    const section = (snapshot && snapshot[tool]) || {}
    for (const v of Object.values(section)) {
      if (typeof v === 'string' && /^http:\/\//.test(v)) set.add(v)
    }
  }
  return set
}

/**
 * isOurs 严格语义判定(供清理): 值必须精确命中候选集。
 * 与 classify(宽松)的分叉是设计行为, 由单测锁定 — 见 spec: tool-config-store
 */
function isOurs (candidates, value) {
  return candidates.has(value)
}

/** 证书路径候选集: 当前证书路径 + 快照记录的证书键值。
 * DEV_SIDECAR_HOME 是全项目约定(与 utils.resolveCertPaths 一致)的数据目录重定向,
 * 属共享环境约定而非 tool-config 的注入项 */
function buildCertCandidates (homedir, snapshot) {
  const base = path.resolve(process.env.DEV_SIDECAR_HOME || homedir(), '.dev-sidecar')
  const set = new Set([path.join(base, 'dev-sidecar.ca.crt')])
  for (const tool of ['npm', 'git']) {
    const section = (snapshot && snapshot[tool]) || {}
    for (const key of ['cafile', 'http.sslCAInfo']) {
      const v = section[key]
      if (typeof v === 'string' && v.length > 0) set.add(v)
    }
  }
  return set
}

/** Windows 路径归一化: 大小写不敏感 + 统一分隔符(用户手改配置可能大小写/正斜杠不一致) */
function normPathValue (v) {
  if (!v) return v
  if (process.platform !== 'win32') return v
  return path.resolve(v).replace(/\//g, '\\').toLowerCase()
}

module.exports = {
  normalizeProxyUrlValue,
  classifyValues,
  isOurs,
  buildProxyCandidates,
  buildCertCandidates,
  normPathValue,
}
