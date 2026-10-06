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
const { readPidInfo, daemonVersionDiffers, isProcessAlive, verifyProcessIdentity } = require('./process-mgmt')

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
  const verifyPid = deps.verifyProcessIdentity || verifyProcessIdentity
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
    // 必须 spawnSync: 本判定被同步调用, 异步 spawn 会在结果就绪前返回 undefined。
    // fail-closed(判定书 #18/#24): 检测机制失灵(PS 缺失/CIM 受限/超时)时按「疑似 WSL」处理 ——
    // 误拒一个原生 Windows 用户(提示换终端, 可重试)远好于在 WSL 里装出不可用的登录项
    const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 10000 })
    const detected = !r.error && r.status === 0 && /WSL/.test(r.stdout || '')
    interopMemo = detected || !!r.error || r.status !== 0
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

  /** 移除服务定义与辅助文件。
   *  返回真实结果(ok=false = 定义仍可能在管), 假成功在此被阻断 —— 调用方(uninstall)据此
   *  不打"已移除"、不做后续停止动作, 避免"✅ 已移除 + 代理复活"同屏 (判定书 #10/#21③) */
  async function removeDefinition () {
    const notes = []
    let ok = true
    if (platform === 'win32') {
      const del = await run('reg', ['delete', RUN_KEY_PATH, '/v', SERVICE_VALUE_NAME, '/f'])
      if (!del.ok) {
        notes.push('Run 键已不存在(跳过)') // 唯一可接受的失败: 本就没装
      }
      try { unlinkFile(paths.vbs) } catch { /* 已不存在 */ }
      // 以探测复核移除结果(不信任命令退出码的"已不存在"歧义)
      if (await detectSupervisor()) {
        ok = false
        notes.push(`Run 键移除失败, 登录项仍在管(请检查权限后重试)`)
      }
    } else if (platform === 'linux') {
      await run('sudo', ['systemctl', 'disable', '--now', SERVICE_UNIT_NAME])
      const rm = await sudoRemove([paths.unit, paths.wrapper])
      if (!rm.ok) {
        ok = false
        notes.push(`移除 unit/wrapper 失败: ${rm.error || 'sudo rm 未成功'}`)
      }
      await run('sudo', ['systemctl', 'daemon-reload'])
      if (await detectSupervisor()) {
        ok = false
        notes.push('unit 文件仍在, 服务定义仍在管(请检查权限后重试)')
      }
    } else {
      await run('launchctl', ['unload', '-w', paths.plist])
      try { unlinkFile(paths.plist) } catch { /* 已不存在 */ }
      try { unlinkFile(paths.wrapper) } catch { /* 已不存在 */ }
      if (await detectSupervisor()) {
        ok = false
        notes.push('plist 仍在, 服务定义仍在管(请检查权限后重试)')
      }
    }
    try { unlinkFile(manifestPath) } catch { /* 已不存在 */ }
    return { ok, notes }
  }

  /** 回滚本次已就位的定义文件(D7 基础件) */
  async function rollback (placed) {
    const direct = placed.filter((p) => !p.sudo).map((p) => p.dst)
    for (const p of direct) {
      try { unlinkFile(p) } catch { /* 已不存在 */ }
    }
    const sudoed = placed.filter((p) => p.sudo).map((p) => p.dst)
    if (sudoed.length > 0) await sudoRemove(sudoed)
  }

  function safeRead (p) {
    if (deps.readFile) {
      try { return deps.readFile(p, 'utf8') } catch { return null }
    }
    try { return fs.readFileSync(p, 'utf8') } catch { return null }
  }

  /** 是否 sudo 管辖路径(Linux 系统路径; 由平台判断而非字符串猜测) */
  function isSudoPath (p) {
    return platform === 'linux' && (p === paths.unit || p === paths.wrapper)
  }

  /**
   * 覆盖安装失败的双模恢复(判定书 #21④): 有旧定义快照 → 以快照为主遍历恢复装前状态
   * (旧定义在 removeDefinition 时已被删, 必须从快照复原); 无快照(首次安装) → 清掉本次已就位。
   * registry 条目例外: 无法内容级恢复, 旧条目数据与新版同构(同名同入口链),
   * 留存新条目即为最接近装前的可用状态。
   */
  async function restoreOrRollback (oldSnapshot, placed) {
    const registryPlaced = placed.filter((p) => p.registry)
    if (oldSnapshot.length > 0) {
      for (const o of oldSnapshot) {
        if (o.content == null) continue
        if (o.sudo) {
          const tmp = jp.join(os.tmpdir(), `dss-svc-rb-${Date.now()}-${jp.basename(o.dst)}`)
          try {
            writeFile(tmp, o.content)
            await sudoCopy(tmp, o.dst)
            try { unlinkFile(tmp) } catch { /* 忽略 */ }
          } catch { /* 恢复失败: 至少新文件仍完整就位 */ }
        } else {
          try { writeFile(o.dst, o.content) } catch { /* 同上 */ }
        }
      }
      // 快照之外本次新放置的文件(装前不存在的)清理掉
      for (const f of placed.filter((p) => !p.registry && !oldSnapshot.some((o) => o.dst === p.dst))) {
        try { unlinkFile(f.dst) } catch { /* 已不存在 */ }
      }
    } else {
      await rollback(placed.filter((p) => !p.registry))
    }
    void registryPlaced
  }

  /**
   * installDefinition: 覆盖旧定义(旧定义先快照, 新装失败恢复装前状态) → 写定义文件(失败回滚)
   * → 平台注册 → 写安装解析快照(失败降级为成功+警告, 不报假失败)。
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
    // 覆盖安装基线: 先快照旧定义文件, 新装任一步失败时回滚至「装前状态」而非仅清本次已就位
    // (否则覆盖失败会让用户从"有自启"变"无自启"且报错只字不提 —— 判定书 #21④)
    let oldSnapshot = []
    if (wasInstalled) {
      for (const p of Object.values(paths)) {
        if (existsFile(p)) oldSnapshot.push({ dst: p, content: safeRead(p), sudo: isSudoPath(p) })
      }
      await removeDefinition()
    }

    const def = createServiceDefinition(platform, ctx)

    // 写定义文件(系统路径经临时文件 + sudo cp; 任一失败回滚全部已就位文件, 不留半成品)
    const placed = []
    for (const f of def.auxFiles) {
      if (f.sudo) {
        const tmp = jp.join(os.tmpdir(), `dss-svc-${Date.now()}-${jp.basename(f.absPath)}`)
        try {
          writeFile(tmp, f.content, { mode: f.mode })
        } catch (e) {
          await restoreOrRollback(oldSnapshot, placed)
          return { ok: false, error: `写入临时文件失败: ${e.message}` }
        }
        const cp = await sudoCopy(tmp, f.absPath)
        try { unlinkFile(tmp) } catch { /* 忽略 */ }
        if (!cp.ok) {
          await restoreOrRollback(oldSnapshot, placed)
          return { ok: false, error: `写入 ${f.absPath} 失败(需要 sudo): ${cp.error || 'sudo 复制未成功'}` }
        }
        placed.push({ dst: f.absPath, sudo: true })
      } else {
        try {
          fs.mkdirSync(jp.dirname(f.absPath), { recursive: true })
          writeFile(f.absPath, f.content, { mode: f.mode })
        } catch (e) {
          await restoreOrRollback(oldSnapshot, placed)
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
        await restoreOrRollback(oldSnapshot, placed)
        return { ok: false, error: `注册 HKCU Run 登录项失败: ${add.stderr || add.error}` }
      }
      placed.push({ dst: RUN_KEY_PATH, sudo: false, registry: true })
    } else if (platform === 'linux') {
      const reload = await run('sudo', ['systemctl', 'daemon-reload'])
      if (!reload.ok) {
        await restoreOrRollback(oldSnapshot, placed)
        return { ok: false, error: `systemctl daemon-reload 失败: ${reload.stderr || reload.error}` }
      }
      const enable = await run('sudo', ['systemctl', 'enable', '--now', SERVICE_UNIT_NAME])
      if (!enable.ok) {
        await restoreOrRollback(oldSnapshot, placed)
        return { ok: false, error: `systemctl enable --now 失败: ${enable.stderr || enable.error}` }
      }
    } else {
      await run('launchctl', ['unload', '-w', paths.plist]) // 旧定义残留时先卸载, 未加载则失败属正常
      const load = await run('launchctl', ['load', '-w', paths.plist])
      if (!load.ok) {
        await restoreOrRollback(oldSnapshot, placed)
        return { ok: false, error: `launchctl load 失败: ${load.stderr || load.error}` }
      }
    }

    const defExists = await detectSupervisor()
    if (!defExists) {
      await restoreOrRollback(oldSnapshot, placed.filter((p) => !p.registry))
      return { ok: false, error: '安装后验证失败: 服务定义不存在' }
    }

    // 安装解析快照(不变式③: status 重放比对的基准)。
    // 写失败不构成假失败(定义已注册且 Linux/macOS 已拉起) —— 重试一次后降级为成功+警告:
    // 缺快照只损失漂移检测(status 重放静默跳过), 定义与代理本身完好 (判定书 #21①/#15/#17)
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
    let manifestWarning = null
    try {
      fs.mkdirSync(jp.dirname(manifestPath), { recursive: true })
      writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    } catch (e1) {
      try {
        writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
      } catch (e2) {
        manifestWarning = `安装快照写入失败(${e2.message})，漂移检测不可用(dss service status 不会做数据目录/入口比对)；可重跑 dss service install 重建快照`
      }
    }
    return { ok: true, installed: true, wasInstalled, definition: def, manifest, warning: manifestWarning }
  }

  /** 读取安装解析快照(无则 null —— 旧版本安装未产生快照, 重放跳过) */
  function readManifest () {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch {
      return null
    }
  }

  /** 重放比对(不变式③, 纯函数): 安装时快照 vs 当前解析。
   *  current: { devSidecarHome, npmPrefix, configPath, startEnv, addr }
   *  返回漂移列表(空 = 无漂移)。
   *  覆盖面: 数据目录分裂 / 入口 shim 失效 / 固化配置文件被删(服务将启动失败) ——
   *  startEnv/host/port 不参与比对: 服务按固化值运行, 当前 env 与其不同是预期而非漂移 */
  function replayDrifts (manifest, current) {
    if (!manifest) return []
    const drifts = []
    if ((manifest.devSidecarHome || null) !== (current.devSidecarHome || null)) {
      drifts.push(`数据目录漂移: 安装时 DEV_SIDECAR_HOME=${manifest.devSidecarHome || '(未设置)'} ≠ 当前 ${current.devSidecarHome || '(未设置)'}，服务与 CLI 将解析到不同数据目录，请重新 install`)
    }
    if (platform === 'win32' && manifest.npmPrefix && !existsFile(win32Path.join(manifest.npmPrefix, 'dss.cmd'))) {
      drifts.push(`入口失效: 安装时的 shim ${manifest.npmPrefix}\\dss.cmd 已不存在(Node 版本变更?)，请重新 install`)
    }
    if (manifest.configPath && !existsFile(manifest.configPath)) {
      drifts.push(`配置文件失效: 安装时固化的 ${manifest.configPath} 已不存在，服务启动将失败，请重新 install`)
    }
    return drifts
  }

  /** 面板统一地址(status.js 进程行/端口行与服务行同源, 消除同屏自相矛盾):
   *  manifest 存在时以固化地址为准 —— 服务按安装时配置运行, 当前 env 不影响它 */
  function effectiveAddr (addr) {
    const manifest = readManifest()
    return manifest
      ? { host: manifest.host, httpPort: manifest.httpPort, mitmPort: manifest.mitmPort }
      : addr
  }

  /** systemd 崩溃循环检测(Linux; 判定书 P1): Restart=always+RestartSec=5 永远达不到
   *  systemd 熔断阈值, 无此检测则循环静默。
   *  判定: ActiveState=failed(已放弃) 或 activating+重启计数≥2(auto-restart 退避窗内反复失败)。
   *  NRestarts 是自 unit 加载以来的累计值, active(正常)时不构成循环证据 */
  async function systemdCrashInfo () {
    if (platform !== 'linux') return null
    try {
      const r = await run('systemctl', ['show', SERVICE_UNIT_NAME, '-p', 'ActiveState', '-p', 'NRestarts', '-p', 'Result'])
      if (!r.ok) return null
      const get = (k) => {
        const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith(`${k}=`))
        return line ? line.slice(k.length + 1).trim() : null
      }
      return { activeState: get('ActiveState'), nRestarts: Number(get('NRestarts')) || 0, result: get('Result') }
    } catch {
      return null
    }
  }

  /** 服务状态四态: not-installed / installed-not-running / running / version-mismatch。
   *  探测地址优先取 manifest 固化值(启动配置固化后, 安装时 PORT/HOST 可能已不在当前环境)。
   *  版本僵比对仅在「PID 存活且身份验证通过」时进行 —— 死 PID 残留给活进程报假告警、
   *  无关进程复用 PID 撑出假绿, 两类失效均被身份门消除(判定书 P1 #24) */
  async function status (addr) {
    const manifest = readManifest()
    const effAddr = manifest
      ? { host: manifest.host, httpPort: manifest.httpPort, mitmPort: manifest.mitmPort }
      : addr
    const installed = await detectSupervisor()
    const info = readPid()
    let pidTrusted = false
    if (info && isProcessAlive(info.pid)) {
      try { pidTrusted = await verifyPid(info.pid) } catch { pidTrusted = false }
    }
    const portUp = await probe(effAddr.host, effAddr.httpPort)
    const running = portUp || pidTrusted
    // 崩溃循环检测在所有 installed 态下都要做 —— 循环的表象恰恰是 installed-not-running
    const crash = platform === 'linux' && installed ? await systemdCrashInfo() : null
    const crashLoop = !!(crash && (crash.activeState === 'failed' || (crash.activeState === 'activating' && crash.nRestarts >= 2)))
    if (!installed) return { installed: false, state: 'not-installed', running: false }
    if (!running) {
      return {
        installed: true,
        state: 'installed-not-running',
        running: false,
        crashLoop,
        crash,
      }
    }
    // 版本比对只在 PID 可信时进行; 运行证据仅来自端口(如前台实例)时守护版本未知, 静默跳过
    const versionMismatch = pidTrusted && daemonVersionDiffers(info, cliVersion)
    return {
      installed: true,
      state: versionMismatch ? 'version-mismatch' : 'running',
      running: true,
      versionMismatch,
      daemonVersion: pidTrusted ? info.version : null,
      crashLoop,
      crash,
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
    effectiveAddr,
  }
}

module.exports = { createServiceOps }
