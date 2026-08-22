// route 纯函数表驱动单测（spec: cli-routing）
const { test } = require('node:test')
const assert = require('node:assert')
const { route, suggestSubcommand, editDistance } = require('./router')

// ---- 表驱动：全部决策分支 ----
const CASES = [
  // 空参数 → run
  { argv: [], expect: { kind: 'run', configPath: null } },
  // 子命令（①优先级最高, -d 是子命令参数而非 daemon 旗标）
  { argv: ['npm', 'on'], expect: { kind: 'subcommand', name: 'npm', args: ['on'] } },
  { argv: ['npm', '-d'], expect: { kind: 'subcommand', name: 'npm', args: ['-d'] } },
  { argv: ['status'], expect: { kind: 'subcommand', name: 'status', args: [] } },
  // help/version（②优先于 daemon —— 修 dss -d -h）
  { argv: ['-h'], expect: { kind: 'help' } },
  { argv: ['--help'], expect: { kind: 'help' } },
  { argv: ['-d', '-h'], expect: { kind: 'help' } },
  { argv: ['-d', '--help'], expect: { kind: 'help' } },
  { argv: ['-v'], expect: { kind: 'version' } },
  { argv: ['-V', '-d'], expect: { kind: 'version' } },
  { argv: ['--version'], expect: { kind: 'version' } },
  // daemon（③剥离旗标, 其余转交）
  { argv: ['-d'], expect: { kind: 'daemon', args: [] } },
  { argv: ['--daemon'], expect: { kind: 'daemon', args: [] } },
  { argv: ['-d', '-c', 'x.json'], expect: { kind: 'daemon', args: ['-c', 'x.json'] } },
  // 配置文法（④三形式统一）
  { argv: ['-c', './x.json'], expect: { kind: 'run', configPath: './x.json' } },
  { argv: ['--config', './x.json'], expect: { kind: 'run', configPath: './x.json' } },
  { argv: ['--config=./x.json'], expect: { kind: 'run', configPath: './x.json' } },
  // 错误路径
  { argv: ['-help'], expect: { kind: 'error', error: 'unknown-option', arg: '-help' } },
  { argv: ['-x'], expect: { kind: 'error', error: 'unknown-option', arg: '-x' } },
  { argv: ['state'], expect: { kind: 'error', error: 'unknown-command', arg: 'state' } },
  { argv: ['config/default.json'], expect: { kind: 'error', error: 'unknown-command', arg: 'config/default.json' } },
  { argv: ['-c'], expect: { kind: 'error', error: 'missing-config-value' } },
  { argv: ['--config'], expect: { kind: 'error', error: 'missing-config-value' } },
  { argv: ['--config='], expect: { kind: 'error', error: 'missing-config-value' } },
]

test('route: 表驱动全分支', () => {
  for (const { argv, expect } of CASES) {
    assert.deepEqual(route(argv), expect, `argv=${JSON.stringify(argv)}`)
  }
})

test('suggestSubcommand: 编辑距离 ≤2 建议', () => {
  assert.equal(suggestSubcommand('state') != null, true)   // start/status 距离 2
  assert.equal(suggestSubcommand('stat'), 'start')
  assert.equal(suggestSubcommand('xyzabc'), null)          // 无近邻
})

test('editDistance: 基本值', () => {
  assert.equal(editDistance('', ''), 0)
  assert.equal(editDistance('abc', 'abc'), 0)
  assert.equal(editDistance('state', 'status'), 2)
  assert.equal(editDistance('npm', 'pip'), 3)
})
