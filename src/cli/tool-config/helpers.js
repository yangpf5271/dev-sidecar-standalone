// 测试辅助 — 工厂注入 seam 的假依赖(假命令执行器/假快照/临时主目录)
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * 假命令执行器: routes 为 [pattern, response] 列表。
 * pattern 是精确字符串(cmd + ' ' + args.join(' '))或 RegExp; response 是结果对象或 fn(...args)。
 * 未匹配默认 { ok: true, stdout: '', stderr: '' }。run.calls 记录全部调用。
 */
function fakeRun (routes = []) {
  const run = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    run.calls.push({ cmd, args, key })
    for (const [pattern, resp] of routes) {
      if (typeof pattern === 'string' ? key === pattern : pattern.test(key)) {
        return typeof resp === 'function' ? resp(...args) : resp
      }
    }
    return { ok: true, stdout: '', stderr: '' }
  }
  run.calls = []
  return run
}

/** 假快照: 内存对象, 记录 updateTool/clearTool 调用 */
function fakeSnapshot (initial = {}) {
  const state = JSON.parse(JSON.stringify(initial))
  const updated = []
  const cleared = []
  return {
    state,
    updated,
    cleared,
    read: () => JSON.parse(JSON.stringify(state)),
    updateTool: (tool, entries) => { state[tool] = entries; updated.push({ tool, entries }) },
    clearTool: (tool) => { delete state[tool]; cleared.push(tool) },
  }
}

/** 临时主目录(docker adapter 文件读写用), 返回 { homedir, dir, cleanup } */
function tempHomedir () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-tc-test-'))
  return {
    homedir: () => dir,
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

const ADDR = { host: '127.0.0.1', httpPort: 31180, mitmPort: 31181 }

module.exports = { fakeRun, fakeSnapshot, tempHomedir, ADDR }
