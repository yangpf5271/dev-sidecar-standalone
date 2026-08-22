// dss pip mirror <name>|off|status — 切换/恢复/查看 pip 镜像源
//
// 只提供 https 镜像（不引入 trusted-host，避免跳过证书校验的安全降级）。
// 与 npm 镜像同理：首次切换前快照原值，off 恢复快照而非硬编码官方源，
// 企业内网源不会被覆盖丢失。
const { runCommand, readSnapshot, writeSnapshot } = require('./utils')

const PIP_OFFICIAL = 'https://pypi.org/simple/'
const PIP_MIRRORS = {
  tsinghua: { name: '清华大学', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  aliyun: { name: '阿里云', url: 'https://mirrors.aliyun.com/pypi/simple/' },
  ustc: { name: '中国科学技术大学', url: 'https://pypi.mirrors.ustc.edu.cn/simple' },
  nju: { name: '南京大学', url: 'https://mirror.nju.edu.cn/pypi/web/simple/' },
}

/** 探测可用的 pip 命令（pip / pip3），返回命令名或 null */
async function detectPip () {
  for (const cmd of ['pip', 'pip3']) {
    const r = await runCommand(cmd, ['--version'])
    if (r.ok) return cmd
  }
  return null
}

async function getIndexUrl (pipCmd) {
  const r = await runCommand(pipCmd, ['config', 'get', 'global.index-url'])
  return r.ok ? r.stdout.trim() : null
}

async function run (args) {
  const pipCmd = await detectPip()
  if (!pipCmd) {
    console.error('❌ 未检测到 pip / pip3 命令，请先安装 Python/pip')
    process.exit(1)
  }

  const action = args[0]
  if (action === 'mirror' || action === undefined) {
    return mirror(pipCmd, args[0] === 'mirror' ? args.slice(1) : args)
  }
  if (action === 'status') return mirrorStatus(pipCmd)
  if (action === 'off') {
    // dss pip off = 镜像恢复的快捷方式
    return mirrorOff(pipCmd)
  }
  help()
  process.exit(1)
}

async function mirror (pipCmd, args) {
  const action = args[0]
  if (!action || action === 'status') return mirrorStatus(pipCmd)
  if (action === 'off') return mirrorOff(pipCmd)

  const m = PIP_MIRRORS[action]
  if (!m) {
    console.error(`未知镜像: ${action}`)
    console.error(`可选: ${Object.keys(PIP_MIRRORS).join(' / ')}, off(恢复), status(查看)`)
    process.exit(1)
  }

  const current = await getIndexUrl(pipCmd)
  if (current === m.url) {
    console.log(`pip 源已经是 ${m.name} (${m.url})`)
    return
  }

  // 首次切换时快照原值（重复切换不覆盖快照）
  const snap = readSnapshot()
  if (!snap.mirror) snap.mirror = {}
  if (!snap.mirror.pip) {
    snap.mirror.pip = { indexUrl: current }
    writeSnapshot(snap)
  }

  const r = await runCommand(pipCmd, ['config', 'set', 'global.index-url', m.url])
  if (!r.ok) {
    console.error(`❌ pip config set index-url 失败: ${r.error || r.stderr}`)
    process.exit(1)
  }
  console.log(`✅ pip 源已切换: ${m.name}`)
  console.log(`   ${current || '(未设置)'}  →  ${m.url}`)
  console.log('')
  console.log('说明: 镜像同步有延迟，刚发布的包可能尚未同步；')
  console.log('      Ubuntu 23.04+/Debian 12 等系统的 pip 受 PEP 668 限制，')
  console.log('      镜像只加速下载，不解除安装限制（请使用 venv/pipx）')
  console.log('恢复: dss pip mirror off')
}

async function mirrorOff (pipCmd) {
  const snap = readSnapshot()
  const saved = snap.mirror && snap.mirror.pip ? snap.mirror.pip.indexUrl : null
  const hasSaved = saved != null && saved !== 'null' && saved !== ''

  if (hasSaved) {
    const r = await runCommand(pipCmd, ['config', 'set', 'global.index-url', saved])
    if (!r.ok) {
      console.error(`❌ 恢复 pip 源失败: ${r.error || r.stderr}`)
      process.exit(1)
    }
    console.log(`✅ pip 源已恢复: ${saved}（来自切换前快照）`)
  } else {
    const r = await runCommand(pipCmd, ['config', 'unset', 'global.index-url'])
    // unset 未设置的键返回非 0，属正常
    if (!r.ok && !/not exist|no such/i.test(r.stderr || '')) {
      console.error(`❌ 恢复 pip 源失败: ${r.error || r.stderr}`)
      process.exit(1)
    }
    console.log(`✅ pip 源已清除（将使用默认官方源 ${PIP_OFFICIAL}）`)
  }

  if (snap.mirror) {
    delete snap.mirror.pip
    if (Object.keys(snap.mirror).length === 0) delete snap.mirror
    writeSnapshot(snap)
  }
}

async function mirrorStatus (pipCmd) {
  const current = await getIndexUrl(pipCmd)
  const snap = readSnapshot()
  const saved = snap.mirror && snap.mirror.pip ? snap.mirror.pip.indexUrl : null
  const known = Object.entries(PIP_MIRRORS).find(([, v]) => v.url === current)

  console.log('pip 镜像源:')
  console.log(`  当前: ${current || '(未设置，默认官方源)'}`)
  if (known) console.log(`        (${known[1].name})`)
  if (saved && saved !== 'null' && saved !== '') {
    console.log(`  切换前原值: ${saved}（dss pip mirror off 可恢复）`)
  }
  console.log('')
  console.log('可用镜像(均为 https，无需 trusted-host):')
  for (const [key, m] of Object.entries(PIP_MIRRORS)) {
    console.log(`  ${key.padEnd(10)} ${m.name}  ${m.url}`)
  }
}

function help () {
  console.log('用法: dss pip <mirror|status|off>')
  console.log('')
  console.log('  dss pip mirror            查看/列出可用镜像')
  console.log(`  dss pip mirror <name>     切换镜像（${Object.keys(PIP_MIRRORS).join(' / ')}）`)
  console.log('  dss pip mirror off        恢复切换前的源（原值快照保护，企业源不丢）')
  console.log('  dss pip status            查看当前源')
  console.log('  dss pip off               同 mirror off')
  console.log('')
  console.log('说明:')
  console.log('  - 只提供 https 镜像，不使用 trusted-host（避免跳过证书校验）')
  console.log('  - 镜像只加速下载；PEP 668 系统限制需用 venv/pipx，与镜像无关')
  console.log('')
  console.log('示例:')
  console.log('  dss pip mirror tsinghua')
  console.log('  dss pip mirror off')
}

module.exports = { run, help }
