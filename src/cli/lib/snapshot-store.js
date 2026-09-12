// 配置快照存储 — npm/git 代理段 + mirror 镜像段共用同一文件(last-applied.json)
// 机械存取单点; 各工具段的生命周期(写入/清段)由调用方语义决定
const fs = require('node:fs')
const { snapshotFilePath, ensureUserBasePath } = require('./paths')

function readSnapshot () {
  try {
    return JSON.parse(fs.readFileSync(snapshotFilePath(), 'utf8')) || {}
  } catch {
    return {}
  }
}

function writeSnapshotFile (obj) {
  const file = snapshotFilePath()
  if (Object.keys(obj).length === 0) {
    try {
      fs.unlinkSync(file)
    } catch {
      // 不存在属正常
    }
    return
  }
  ensureUserBasePath()
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
}

/** 记录某个工具（npm/git）本次 on 实际写入的配置值 */
function updateSnapshot (tool, entries) {
  const snap = readSnapshot()
  snap[tool] = entries
  writeSnapshotFile(snap)
}

/** 清除某个工具的快照段（对应 off 后调用） */
function clearSnapshotSection (tool) {
  const snap = readSnapshot()
  if (snap[tool] == null) return
  delete snap[tool]
  writeSnapshotFile(snap)
}

module.exports = {
  readSnapshot,
  writeSnapshot: writeSnapshotFile,
  updateSnapshot,
  clearSnapshotSection,
}
