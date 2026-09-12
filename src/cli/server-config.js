// server-config — 服务端地址配置读取的单点知识(文件结构/环境变量覆盖/默认端口)
//
// 支持两种配置文件结构, 等效处理:
//   嵌套 { server: { host, port } } — config/default.json 与完整 mitmproxy 配置
//   平铺 { host, port }             — 只想改端口的极简配置
// 优先级: PORT/HOST 环境变量 > 配置文件 > 内置默认(127.0.0.1:31181)
//
// 消费方: index.js loadConfig(装饰后交给 mitmproxy)与 utils.resolveProxyAddress
// (工具配置端口推导)。两侧必须看到同一份 host/port —— 独立实现曾分叉
// (平铺结构只在命令侧生效), 本模块即收敛点。
//
// 错误契约: 只返回结果对象, 不 console 不 exit — 报错策略由调用方决定
// (守护进程启动大声退出; 命令侧 -c 文件大声退出, 内置默认静默降级)
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_CONFIG_FILE = path.join(__dirname, '../../config/default.json')
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_MITM_PORT = 31181

/** 读取并解析配置文件 → { ok, config } | { ok: false, phase: 'read'|'parse', error } */
function readConfigJson (configPath) {
  let raw
  try {
    raw = fs.readFileSync(configPath, 'utf8')
  } catch (e) {
    return { ok: false, phase: 'read', error: e.message }
  }
  try {
    return { ok: true, config: JSON.parse(raw) }
  } catch (e) {
    return { ok: false, phase: 'parse', error: e.message }
  }
}

/** 从配置对象提取 { host, port } — 嵌套/平铺双结构等效, 缺失/空值(null/""/0)归 null
 *  (truthy 语义与旧 resolveProxyAddress 的 if (server.host) 一致, 空串不算已设置) */
function serverOf (config) {
  const server = (config && typeof config === 'object' && (config.server || config)) || {}
  return {
    host: server.host || null,
    port: server.port || null,
  }
}

/** PORT/HOST 环境变量覆盖(有环境变量才生效), 入参缺失项保持 null */
function withEnvOverride ({ host, port }) {
  return {
    host: process.env.HOST || host,
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : port,
  }
}

/**
 * server 地址归一化(原位修改): 平铺结构 {host,port} 提升到 config.server,
 * 嵌套结构为恒等 — 保证 mitmproxy 消费侧永远看到嵌套结构。返回同一对象。
 */
function normalizeServer (config) {
  const fileAddr = serverOf(config)
  if (!config.server || typeof config.server !== 'object') {
    config.server = {}
  }
  if (fileAddr.host != null) config.server.host = fileAddr.host
  if (fileAddr.port != null) config.server.port = fileAddr.port
  return config
}

module.exports = {
  readConfigJson,
  serverOf,
  withEnvOverride,
  normalizeServer,
  DEFAULT_CONFIG_FILE,
  DEFAULT_HOST,
  DEFAULT_MITM_PORT,
}
