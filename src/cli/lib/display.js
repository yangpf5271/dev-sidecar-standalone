// 配置值显示契约 — 工具读取结果 → 状态文本(npm/git status 共用)

/** 读失败 → 获取失败; 值 null → (未设置); 其余原样 */
function makeConfigValueLabel (readOk) {
  return (v) => (readOk ? (v != null ? v : '(未设置)') : '获取失败')
}

module.exports = { makeConfigValueLabel }
