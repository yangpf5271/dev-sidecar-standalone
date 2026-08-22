// 独立版不需要 IPC 通信，提供空桩函数
module.exports = {
  fireStatus (status) {
    // no-op
  },
  fireError (error) {
    console.error('代理服务错误:', error)
  },
}
