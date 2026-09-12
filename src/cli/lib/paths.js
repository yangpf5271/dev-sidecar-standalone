// 路径解析 — 用户数据目录(.dev-sidecar)/证书/PID/日志/快照文件的全项目单点
// 数据目录跟随 DEV_SIDECAR_HOME(与 server-config 的端口单点同级的环境约定)
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/**
 * CA 证书路径
 * 返回 { certPath, keyPath, certExists, userBasePath }
 */
function resolveCertPaths () {
  const userHome = process.env.DEV_SIDECAR_HOME || os.homedir()
  const userBasePath = path.resolve(userHome, '.dev-sidecar')
  const certPath = path.join(userBasePath, 'dev-sidecar.ca.crt')
  const keyPath = path.join(userBasePath, 'dev-sidecar.ca.key.pem')
  return {
    certPath,
    keyPath,
    certExists: fs.existsSync(certPath),
    userBasePath,
  }
}

/** 确保用户数据目录存在(写 PID/快照前调用) */
function ensureUserBasePath () {
  const base = resolveCertPaths().userBasePath
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true })
  }
}

/** 守护进程 PID 文件路径 */
function pidFilePath () {
  return path.join(resolveCertPaths().userBasePath, 'dev-sidecar.pid')
}

/** 守护进程日志文件路径 */
function logFilePath () {
  return path.join(resolveCertPaths().userBasePath, 'logs', 'dev-sidecar.log')
}

/** 配置快照文件路径(npm/git 代理段 + mirror 镜像段共用) */
function snapshotFilePath () {
  return path.join(resolveCertPaths().userBasePath, 'last-applied.json')
}

module.exports = {
  resolveCertPaths,
  ensureUserBasePath,
  pidFilePath,
  logFilePath,
  snapshotFilePath,
}
