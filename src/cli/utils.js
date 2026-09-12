// CLI 公共工具门面 — 实现按职责拆在 lib/*, 本文件只做聚合导出
//
// 拆分映射(原 469 行大杂烩 → 六个职责模块):
//   lib/proxy-address  代理地址解析(消费 server-config 单点)
//   lib/paths          用户数据目录/证书/PID/日志/快照文件路径
//   lib/exec           子进程执行/端口探测/代理未运行警告
//   lib/process-mgmt   PID 文件/存活探测/身份验证/端口反查/终止
//   lib/snapshot-store 配置快照存取
//   lib/cert-trust     CA 证书系统信任检测
//   lib/display        配置值显示契约
// 存量消费方继续 require('./utils') 不变; 新代码建议直接引对应 lib 模块。
module.exports = {
  ...require('./lib/proxy-address'),
  ...require('./lib/paths'),
  ...require('./lib/exec'),
  ...require('./lib/process-mgmt'),
  ...require('./lib/snapshot-store'),
  ...require('./lib/cert-trust'),
  ...require('./lib/display'),
}
