// 服务编排 — 服务定义注册/移除/状态/监管器归属探测的平台命令执行
// 依赖注入面(deps)供单测: runCommand/existsFile/writeFile/unlinkFile/probePort/sudoCopy/sudoRemove/platform/isWSL/readPidInfo
// 错误契约: 返回结果对象, 不 throw 不 exit —— 退出码由命令壳层(service.js)决定
// 禁止: 在本层 spawn wscript(WSH 会因安装 shell 的畸形环境块弹出"内存资源不足"对话框)
const fs = require('node:fs')
const os = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const {
  createServiceDefinition,
  servicePaths,
  SERVICE_VALUE_NAME,
  SERVICE_UNIT_NAME,
  SERVICE_LABEL,
  RUN_KEY_PATH,
  MANIFEST_NAME,
} = require('./service-definitions')
const { runCommand, probePort } = require('./exec')
const { resolveCertPaths } = require('./paths')
const { readPidInfo, daemonVersionDiffers, isProcessAlive } = require('./process-mgmt')

// 与生成器同纪律: 路径语义跟随「注入的平台」而非宿主
const { posix: posixPath, win32: win32Path } = require('node:path')
const joinFor = (plat) => (plat === 'win32' ? win32Path : posixPath)

function createServiceOps (deps = {}) {
  const run = deps.runCommand || runCommand
  const probe = deps.probePort || probePort
  const existsFile = deps.existsFile || ((p) => fs.existsSync(p))
  const writeFile = deps.writeFile || ((p, c, opts) => fs.writeFileSync(p, c, { encoding: 'utf8', ...opts }))
  const unlinkFile = deps.unlinkFile || ((p) => fs.unlinkSync(p))
  const platform = deps.platform || process.platform
  const cliVersion = deps.cliVersion || require('../../../package.json').version
  const userBasePath = deps.userBasePath || resolveCertPaths().userBasePath
  const readPid = deps.readPidInfo || readPidInfo
  // WSL 判定(设计 D9): 环境变量在互操作场景不可靠(WSL 默认不传 Linux env 给 Windows 进程,
  // 实测 WSL_DISTRO_NAME 为 undefined), 因此 win32 采用「父进程链回溯」——互操作启动的进程
  // 其 Windows 父链上必有 wsl.exe。linux 平台以内核标识(microsoft)判定, 仅用于诊断提示。
  const envWslSignal = () => {
    if (platform === 'win32') return !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
    return /microsoft/i.test(os.release())
  }
  let interopMemo // 进程生命周期内不变, 判定一次后缓存
  const parentChainWsl = () => {
    if (interopMemo !== undefined) return interopMemo
    const script = [
      `$p=${process.pid};`,
      'for($i=0;$i -lt 10;$i++){',
      '  $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue;',
      '  if(-not $proc){break};',
      '  if($proc.Name -match "^(wsl|wslhost|wslservice)\\.exe$"){Write-Output WSL;exit};',
      '  $p=$proc.ParentProcessId;',
      '  if(-not $p){break};',
      '};',
      'Write-Output NO',
    ].join(' ')
    // 必须 spawnSync: 本判定被同步调用, 异步 spawn 会在结果就绪前返回 undefined
    const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
    interopMemo = !r.error && r.status === 0 && /WSL/.test(r.stdout || '')
    return interopMemo
  }
  const isWSL = deps.isWSL || (() => {
    if (platform === 'win32') return envWslSignal() || parentChainWsl()
    return /microsoft/i.test(os.release())
  })
  // sudo 写/删: 需要终端交互密码, stdio inherit(不能走管道); 测试可注入
  const sudoCopy = deps.sudoCopy || ((src, dst) => new Promise((resolve) => {
    const child = spawn('sudo', ['cp', src, dst], { stdio: 'inherit' })
    child.on('error', (e) => resolve({ ok: false, error: e.message }))
    child.on('close', (code) => resolve({ ok: code === 0 }))
  }))
  const sudoRemove = deps.sudoRemove || ((targets) => new Promise((resolve) => {
    const child = spawn('sudo', ['rm', '-f', ...targets], { stdio: 'inherit' })
    child.on('error', (e) => resolve({ ok: false, error: e.message }))
    child.on('close', (code) => resolve({ ok: code === 0 }))
  }))

  const jp = joinFor(platform)
  const paths = servicePaths(platform, userBasePath)
  // manifest 固定在「默认」主目录, 刻意不跟随 DEV_SIDECAR_HOME —— 它正是用来检测
  // 该环境变量漂移的基准; 若跟随 env 解析, 漂移发生时快照会被藏到另一个目录
  const manifestPath = jp.join(os.homedir(), '.dev-sidecar', MANIFEST_NAME)

  /** 服务定义是否已在管(归属探测) — 按平台查定义存在性, 不依赖本地化输出。
   *  Windows 探测对象是 HKCU Run 登录项(纯登录触发器, 无监管面, 见 CONTEXT.md) */
  async function detectSupervisor () {
    try {
      if (platform === 'win32') {
        return (await run('reg', ['query', RUN_KEY_PATH, '/v', SERVICE_VALUE_NAME])).ok
      }
      if (platform === 'linux') return existsFile(paths.unit)
      return existsFile(paths.plist)
    } catch {
      return false
    }
  }

  /** 管理器通道停止提示(按平台)。
   *  Windows HKCU Run 是纯登录触发器, 无监管面: 停止用 dss stop, 防下次登录拉起需 uninstall */
  function managerStopHint () {
    if (platform === 'win32') {
      return 'dss stop 停止本次运行；下次登录会再次自动拉起，移除自启请用 dss service uninstall'
    }
    if (platform === 'linux') return `sudo systemctl stop ${SERVICE_UNIT_NAME}`
    return `launchctl unload -w "${paths.plist}"`
  }

  /** 移除服务定义与辅助文件(幂等; 不存在时各动作自然失败但整体 ok) */
  async function removeDefinition () {
    const notes = []
    if (platform === 'win32') {
      const del = await run('reg', ['delete', RUN_KEY_PATH, '/v', SERVICE_VALUE_NAME, '/f'])
      if (!del.ok) notes.push('Run 键已不存在(跳过)')
      try { unlinkFile(paths.vbs) } catch { /* 已不存在 */ }
    } else if (platform === 'linux') {
      await run('sudo', ['systemctl', 'disable', '--now', SERVICE_UNIT_NAME])
      const rm = await sudoRemove([paths.unit, paths.wrapper])
      if (!rm.ok) notes.push(`移除 unit/wrapper 失败: ${rm.error}`)
      await run('sudo', ['systemctl', 'daemon-reload'])
    } else {
      await run('launchctl', ['unload', '-w', paths.plist])
      try { unlinkFile(paths.plist) } catch { /* 已不存在 */ }
      try { unlinkFile(paths.wrapper) } catch { /* 已不存在 */ }
    }
    try { unlinkFile(manifestPath) } catch { /* 已不存在 */ }
    return { ok: true, notes }
  }

  /** 回滚已就位的定义文件(设计 D7: 失败不留半成品) */
  async function rollback (placed) {
    const direct = placed.filter((p) => !p.sudo).map((p) => p.dst)
    for (const p of direct) {
      try { unlinkFile(p) } catch { /* 已不存在 */ }
    }
    const sudoed = placed.filter((p) => p.sudo).map((p) => p.dst)
    if (sudoed.length > 0) await sudoRemove(sudoed)
  }

  /**
   * installDefinition: 覆盖旧定义 → 写定义文件(失败回滚) → 平台注册 → 写安装解析快照。
   * 只做注册, 不负责拉起代理 —— 立即拉起由命令壳层走 startDaemon(Windows, node 直 spawn)
   * 或由 enable --now / launchctl load(Linux/macOS 注册动作自带拉起)。
   * ctx: { user, userBasePath, devSidecarHome, npmPrefix, startEnv, configPath, addr }
   */
  async function installDefinition (ctx) {
    if (platform === 'win32' && isWSL()) {
      return {
        ok: false,
        reason: 'wsl',
        error: '当前在 WSL 环境中运行 Windows 版 dss，无法安装 Windows 登录项；请在 WSL 内使用 Linux 流程 (sudo dss service install) 或在 Windows 原生终端执行',
      }
    }

    const wasInstalled = await detectSupervisor()
    if (wasInstalled) await removeDefinition()

    const def = createServiceDefinition(platform, ctx)

    // 写定义文件(系统路径经临时文件 + sudo cp; 任一失败回滚全部已就位文件, 不留半成品)
    const placed = []
    for (const f of def.auxFiles) {
      if (f.sudo) {
        const tmp = jp.join(os.tmpdir(), `dss-svc-${Date.now()}-${jp.basename(f.absPath)}`)
        try {
          writeFile(tmp, f.content, { mode: f.mode })
        } catch (e) {
          await rollback(placed)
          return { ok: false, error: `写入临时文件失败: ${e.message}` }
        }
        const cp = await sudoCopy(tmp, f.absPath)
        try { unlinkFile(tmp) } catch { /* 忽略 */ }
        if (!cp.ok) {
          await rollback(placed)
          return { ok: false, error: `写入 ${f.absPath} 失败(需要 sudo): ${cp.error || 'sudo 复制未成功'}` }
        }
        placed.push({ dst: f.absPath, sudo: true })
      } else {
        try {
          fs.mkdirSync(jp.dirname(f.absPath), { recursive: true })
          writeFile(f.absPath, f.content, { mode: f.mode })
        } catch (e) {
          await rollback(placed)
          return { ok: false, error: `写入 ${f.absPath} 失败: ${e.message}` }
        }
        placed.push({ dst: f.absPath, sudo: false })
      }
    }

    // 平台注册(Linux/macOS 的注册动作自带拉起)
    if (platform === 'win32') {
      // HKCU Run: 免管理员, 天然 per-user; 纯登录触发器 —— 拉起由命令壳层 startDaemon 完成
      const add = await run('reg', [
        'add', RUN_KEY_PATH, '/v', SERVICE_VALUE_NAME, '/t', 'REG_SZ', '/d', def.definition.data, '/f',
      ])
      if (!add.ok) {
        await rollback(placed)
        return { ok: false, error: `注册 HKCU Run 登录项失败: ${add.stderr || add.error}` }
      }
      placed.push({ dst: RUN_KEY_PATH, sudo: false, registry: true })
    } else if (platform === 'linux') {
      const reload = await run('sudo', ['systemctl', 'daemon-reload'])
      if (!reload.ok) {
        await rollback(placed)
        return { ok: false, error: `systemctl daemon-reload 失败: ${reload.stderr || reload.error}` }
      }
      const enable = await run('sudo', ['systemctl', 'enable', '--now', SERVICE_UNIT_NAME])
      if (!enable.ok) {
        await rollback(placed)
        return { ok: false, error: `systemctl enable --now 失败: ${enable.stderr || enable.error}` }
      }
    } else {
      await run('launchctl', ['unload', '-w', paths.plist]) // 旧定义残留时先卸载, 未加载则失败属正常
      const load = await run('launchctl', ['load', '-w', paths.plist])
      if (!load.ok) {
        await rollback(placed)
        return { ok: false, error: `launchctl load 失败: ${load.stderr || load.error}` }
      }
    }

    const defExists = await detectSupervisor()
    if (!defExists) {
      await rollback(placed.filter((p) => !p.registry))
      return { ok: false, error: '安装后验证失败: 服务定义不存在' }
    }

    // 安装解析快照(不变式③: status 重放比对的基准)
    const manifest = {
      platform,
      name: def.name,
      npmPrefix: ctx.npmPrefix || null,
      devSidecarHome: ctx.devSidecarHome || null,
      configPath: ctx.configPath || null,
      startEnv: ctx.startEnv || {},
      host: ctx.addr.host,
      mitmPort: ctx.addr.mitmPort,
      httpPort: ctx.addr.httpPort,
      installedVersion: cliVersion,
    }
    try {
      fs.mkdirSync(jp.dirname(manifestPath), { recursive: true })
      writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    } catch (e) {
      return { ok: false, error: `写入安装快照失败: ${e.message}`, installed: true }
    }
    return { ok: true, installed: true, wasInstalled, definition: def, manifest }
  }

  /** 读取安装解析快照(无则 null —— 旧版本安装未产生快照, 重放跳过) */
  function readManifest () {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * 重放比对(不变式③核心, 纯函数): 安装时快照 vs 当前解析。
   * current: { devSidecarHome, npmPrefix, configPath, startEnv, addr }
   * 返回漂移列表(空 = 无漂移); npmPrefix 仅在其存在为前提时校验 shim 存续
   */
  function replayDrifts (manifest, current) {
    if (!manifest) return []
    const drifts = []
    if ((manifest.devSidecarHome || null) !== (current.devSidecarHome || null)) {
      drifts.push(`数据目录漂移: 安装时 DEV_SIDECAR_HOME=${manifest.devSidecarHome || '(未设置)'} ≠ 当前 ${current.devSidecarHome || '(未设置)'}，服务与 CLI 将解析到不同数据目录，请重新 install`)
    }
    if (manifest.npmPrefix && !existsFile(win32Path.join(manifest.npmPrefix, 'dss.cmd'))) {
      drifts.push(`入口失效: 安装时的 shim ${manifest.npmPrefix}\\dss.cmd 已不存在(Node 版本变更?)，请重新 install`)
    }
    return drifts
  }

  /** 服务状态四态: not-installed / installed-not-running / running / version-mismatch。
   *  探测地址优先取 manifest 固化值(启动配置固化后, 安装时 PORT/HOST 可能已不在当前环境) */
  async function status (addr) {
    const manifest = readManifest()
    const effAddr = manifest
      ? { host: manifest.host, httpPort: manifest.httpPort, mitmPort: manifest.mitmPort }
      : addr
    const installed = await detectSupervisor()
    const info = readPid()
    const running = !!(info && isProcessAlive(info.pid)) || (await probe(effAddr.host, effAddr.httpPort))
    if (!installed) return { installed: false, state: 'not-installed', running: false }
    if (!running) return { installed: true, state: 'installed-not-running', running: false }
    const versionMismatch = daemonVersionDiffers(info, cliVersion)
    return {
      installed: true,
      state: versionMismatch ? 'version-mismatch' : 'running',
      running: true,
      versionMismatch,
      daemonVersion: info ? info.version : null,
    }
  }

  return {
    installDefinition,
    removeDefinition,
    detectSupervisor,
    managerStopHint,
    status,
    isWSL,
    readManifest,
    replayDrifts,
  }
}

module.exports = { createServiceOps }
