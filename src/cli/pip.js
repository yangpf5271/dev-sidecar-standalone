// dss pip mirror <name>|off|status — 切换/恢复/查看 pip 镜像源
//
// 只提供 https 镜像（不引入 trusted-host，避免跳过证书校验的安全降级）。
// 切换/恢复/快照保护由镜像引擎单点实现（tool-config/mirror-engine），
// 命令层只保留表与文案。
const { runCommand } = require('./utils')
const { createMirrorEngine } = require('./tool-config/mirror-engine')

const PIP_OFFICIAL = 'https://pypi.org/simple/'
const PIP_MIRRORS = {
  tsinghua: { name: '清华大学', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  aliyun: { name: '阿里云', url: 'https://mirrors.aliyun.com/pypi/simple/' },
  ustc: { name: '中国科学技术大学', url: 'https://pypi.mirrors.ustc.edu.cn/simple' },
  nju: { name: '南京大学', url: 'https://mirror.nju.edu.cn/pypi/web/simple/' },
}

// pip adapter 持有命令探测/读写知识; 引擎经 require 工厂注入默认实例
const mirrorEngine = createMirrorEngine({
  name: 'pip',
  official: PIP_OFFICIAL,
  mirrors: PIP_MIRRORS,
  adapter: require('./tool-config').adapters.pip,
})

/** 探测可用的 pip 命令（pip / pip3），返回命令名或 null */
async function detectPip () {
  for (const cmd of ['pip', 'pip3']) {
    const r = await runCommand(cmd, ['--version'])
    if (r.ok) return cmd
  }
  return null
}

async function run (args) {
  const pipCmd = await detectPip()
  if (!pipCmd) {
    console.error('❌ 未检测到 pip / pip3 命令，请先安装 Python/pip')
    process.exit(1)
  }

  const action = args[0]
  if (action === 'mirror' || action === undefined) {
    return mirror(args[0] === 'mirror' ? args.slice(1) : args)
  }
  if (action === 'status') return mirrorStatus()
  if (action === 'off') {
    // dss pip off = 镜像恢复的快捷方式
    return mirrorOff()
  }
  help()
  process.exit(1)
}

async function mirror (args) {
  const action = args[0]
  if (!action || action === 'status') return mirrorStatus()
  if (action === 'off') return mirrorOff()

  const r = await mirrorEngine.switch(action)
  if (!r.ok) {
    if (r.error === 'unknown-mirror') {
      console.error(`未知镜像: ${action}`)
      console.error(`可选: ${r.available.join(' / ')}, off(恢复), status(查看)`)
    } else {
      console.error(`❌ ${r.error}`)
    }
    process.exit(1)
  }
  if (!r.changed) {
    console.log(`pip 源已经是 ${r.entryName} (${r.to})`)
    return
  }
  console.log(`✅ pip 源已切换: ${r.entryName}`)
  console.log(`   ${r.from || '(未设置)'}  →  ${r.to}`)
  console.log('')
  console.log('说明: 镜像同步有延迟，刚发布的包可能尚未同步；')
  console.log('      Ubuntu 23.04+/Debian 12 等系统的 pip 受 PEP 668 限制，')
  console.log('      镜像只加速下载，不解除安装限制（请使用 venv/pipx）')
  console.log('恢复: dss pip mirror off')
}

async function mirrorOff () {
  const r = await mirrorEngine.off()
  if (!r.ok) {
    console.error(`❌ 恢复 pip 源失败: ${r.error}`)
    process.exit(1)
  }
  if (r.saved) {
    console.log(`✅ pip 源已恢复: ${r.saved}（来自切换前快照）`)
  } else {
    console.log(`✅ pip 源已清除（将使用默认官方源 ${PIP_OFFICIAL}）`)
  }
}

async function mirrorStatus () {
  const r = await mirrorEngine.status()

  console.log('pip 镜像源:')
  console.log(`  当前: ${r.current || '(未设置，默认官方源)'}`)
  if (r.known) console.log(`        (${r.known})`)
  if (r.saved) {
    console.log(`  切换前原值: ${r.saved}（dss pip mirror off 可恢复）`)
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

module.exports = { run, help, PIP_MIRRORS, PIP_OFFICIAL }
