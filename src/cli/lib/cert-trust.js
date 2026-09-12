// CA 证书系统信任检测（dss status）：按 dss cert 指引的安装位置逐平台探测
// 返回 { installed: true, where } | { installed: false } | { unknown: true, error }
const fs = require('node:fs')
const { IS_WIN, runCommand } = require('./exec')

async function detectCertTrust (certPath) {
  const crypto = require('node:crypto')
  let pem
  try {
    pem = fs.readFileSync(certPath, 'utf8')
  } catch {
    return { installed: false, missing: true }
  }
  const m = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/)
  if (!m) return { unknown: true, error: '证书文件格式异常' }
  const pemBody = m[1].replace(/\s+/g, '')
  const thumbprint = crypto.createHash('sha1').update(Buffer.from(pemBody, 'base64')).digest('hex').toUpperCase()

  try {
    if (IS_WIN) {
      // PowerShell 证书存储探测（dss cert 指引: 双击安装到受信任的根证书颁发机构）
      const script = [
        `$t='${thumbprint}'`,
        `$f=@()`,
        `foreach($s in 'CurrentUser\\Root','LocalMachine\\Root'){`,
        `  try{ if(Get-ChildItem ("Cert:\\"+$s) -ErrorAction Stop | Where-Object {$_.Thumbprint -eq $t}){ $f+=$s } }catch{}`,
        `}`,
        `Write-Output ($f -join ',')`,
      ].join('\n')
      const r = await runCommand('powershell.exe', ['-NoProfile', '-Command', script])
      if (!r.ok) return { unknown: true, error: r.stderr || r.error || 'powershell 探测失败' }
      const found = r.stdout.split(',').map(s => s.trim()).filter(Boolean)
      return found.length ? { installed: true, where: found.join(' + ') } : { installed: false }
    }
    if (process.platform === 'darwin') {
      // dss cert 指引: security add-trusted-cert 到 System.keychain
      const r = await runCommand('security', ['find-certificate', '-a', '-Z', '/Library/Keychains/System.keychain'])
      if (r.error && /ENOENT/i.test(r.error)) return { unknown: true, error: 'security 命令不可用' }
      return (r.ok && r.stdout.toUpperCase().includes(thumbprint))
        ? { installed: true, where: 'System.keychain' }
        : { installed: false }
    }
    // Linux: update-ca-certificates / update-ca-trust 聚合后的 PEM bundle
    const bundles = [
      '/etc/ssl/certs/ca-certificates.crt',
      '/etc/pki/tls/certs/ca-bundle.crt',
      '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
    ]
    for (const bundle of bundles) {
      try {
        const content = fs.readFileSync(bundle, 'utf8').replace(/\s+/g, '')
        if (content.includes(pemBody)) return { installed: true, where: bundle }
      } catch { /* 尝试下一个 bundle */ }
    }
    return { installed: false }
  } catch (e) {
    return { unknown: true, error: e.message }
  }
}

module.exports = { detectCertTrust }
