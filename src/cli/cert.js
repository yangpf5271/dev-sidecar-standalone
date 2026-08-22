// dss cert — 显示 CA 证书路径和各平台安装方法
const { resolveCertPaths } = require('./utils')

function run () {
  const { certPath, certExists, userBasePath } = resolveCertPaths()

  console.log('CA 证书（HTTPS 拦截加速需要安装到系统信任列表）')
  console.log('')
  console.log(`  路径: ${certPath}`)
  console.log(`  状态: ${certExists ? '✅ 已生成' : '❌ 尚未生成（启动一次代理后自动生成）'}`)
  console.log(`  目录: ${userBasePath}`)
  console.log('')
  console.log('安装方法:')
  console.log('')
  console.log('  Windows:')
  console.log('    双击证书文件 → 安装证书 → 存储区域选"本地计算机" → "受信任的根证书颁发机构"')
  console.log('')
  console.log('  macOS:')
  console.log(`    sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${certPath}"`)
  console.log('')
  console.log('  Linux (Debian/Ubuntu):')
  console.log(`    sudo cp "${certPath}" /usr/local/share/ca-certificates/dev-sidecar.crt`)
  console.log('    sudo update-ca-certificates')
  console.log('')
  console.log('  Linux (RHEL/CentOS/Fedora):')
  console.log(`    sudo cp "${certPath}" /etc/pki/ca-trust/source/anchors/dev-sidecar.crt`)
  console.log('    sudo update-ca-trust')
  console.log('')
  console.log('提示: 可通过 DEV_SIDECAR_HOME 环境变量自定义证书存放目录')
}

function help () {
  console.log('用法: dss cert')
  console.log('')
  console.log('显示 CA 证书路径、生成状态和各平台安装方法')
}

module.exports = { run, help }
