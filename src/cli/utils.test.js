// utils 契约测试 — 配置值显示契约(npm/git status 共用)
const { test } = require('node:test')
const assert = require('node:assert')
const { makeConfigValueLabel } = require('./utils')

test('makeConfigValueLabel: 读成功时 值→原样 / null→(未设置); 读失败→获取失败', () => {
  const ok = makeConfigValueLabel(true)
  assert.equal(ok('http://127.0.0.1:31180'), 'http://127.0.0.1:31180')
  assert.equal(ok(null), '(未设置)')

  const fail = makeConfigValueLabel(false)
  assert.equal(fail(null), '获取失败')
  assert.equal(fail('whatever'), '获取失败')   // 读失败时值不可信, 一律获取失败
})
