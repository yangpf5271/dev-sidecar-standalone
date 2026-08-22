// 拉取层知识模块 — daemon.json 的读取与解析单点归属(spec: docker-pull)
//
// 职责二分(design D5), 模块保持轻——不聚合、不写回、不持界面文案:
//   读取语境层 — Linux/WSL 内本机直读 / Windows 宿主经 wsl.exe 穿透(带超时防冷启动挂起)
//   解析层     — 纯函数, 不依赖读取语境
// build 层(~/.docker/config.json)归 tool-config 的 docker adapter, 与本模块边界分明。
const fs = require('node:fs')
const { runCommand } = require('./utils')

const DAEMON_JSON = '/etc/docker/daemon.json'

// ---------------------------------------------------------------------------
// 解析层(纯函数)
// ---------------------------------------------------------------------------

/** 原文 → 文档; null/空 → data:null(文件不存在); 损坏 JSON → { ok:false, error } 不抛出 */
function parseDoc (content) {
  if (content == null || content === '') return { ok: true, data: null }
  try {
    return { ok: true, data: JSON.parse(content) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** 数组字段解析: 缺失/非数组 → 空数组; stringsOnly 时滤除非字符串项 */
function parseStringArray (data, key, { stringsOnly = false } = {}) {
  const list = data && data[key]
  if (!Array.isArray(list)) return []
  return stringsOnly ? list.filter((v) => typeof v === 'string') : list
}

/** registry-mirrors 解析: 缺失/非数组 → 空数组(原样保留, 不滤项——写回路径不改用户数组) */
function parseMirrors (data) {
  return parseStringArray(data, 'registry-mirrors')
}

/** insecure-registries 解析: 滤非字符串(消费方 hostOf 需要字符串, 防畸形配置崩溃) */
function parseInsecureRegistries (data) {
  return parseStringArray(data, 'insecure-registries', { stringsOnly: true })
}

// ---------------------------------------------------------------------------
// 读取语境层
// ---------------------------------------------------------------------------

/** 本机直读(拉取层命令语境: 仅 Linux/WSL 内运行): 文件不存在 → content:null */
function readLocal (file = DAEMON_JSON) {
  try {
    return { ok: true, content: fs.readFileSync(file, 'utf8') }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, content: null }
    return { ok: false, content: null, error: e.message }
  }
}

/** Windows 宿主经 WSL 穿透读取; timeoutMs 内未返回 → timeout:true(不挂起, 冷启动保护) */
async function readViaWsl ({ run = runCommand, timeoutMs = 8000 } = {}) {
  const TIMEOUT = Symbol('docker-pull-timeout')
  let timer
  const content = await Promise.race([
    run('wsl.exe', ['-e', 'cat', DAEMON_JSON]).then((r) => (r.ok ? r.stdout : null)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), timeoutMs) }),
  ])
  clearTimeout(timer)
  if (content === TIMEOUT) return { ok: true, content: null, timeout: true }
  return { ok: true, content: content || null }
}

module.exports = { DAEMON_JSON, parseDoc, parseMirrors, parseInsecureRegistries, readLocal, readViaWsl }
