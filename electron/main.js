// OrayChat Electron 主进程
// - 多实例：--profile=<名字> 决定独立的 userData（身份密钥、聊天记录互不干扰），
//   方便同一台机器上跑多个终端做 P2P 验证
// - 身份密钥以 JSON 存于 <userData>/identities/（0600 权限）
// - bot 模式：--bot 时无窗口自动化登录，日志经 IPC 转发到 stdout，供 e2e 测试驱动
// - 应用层配置：<userData>/oraychat-config.json 可覆盖 STUN/TURN/默认房间

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const crypto2 = require('node:crypto')
const zlib = require('node:zlib')
const hub = require('./hub')

const argv = {}
for (const a of process.argv.slice(2)) {
  // [\s\S] 支持参数值含换行（如多行消息）
  const m = a.match(/^--([^=]+)(?:=([\s\S]*))?$/)
  if (m) argv[m[1]] = m[2] === undefined ? true : m[2]
}

const PROFILE = String(argv.profile || 'default')
const IS_BOT = !!argv.bot

let tray = null
let isQuiting = false // 区分“关窗隐藏到托盘”与“真正退出”
let unreadCount = 0
const notifyThrottle = new Map() // peerKey -> lastTs（每对端 10s 一条通知）

function updateBadges() {
  // macOS：Dock 角标 + 托盘标题（模板图旁的数字）
  try {
    if (process.platform === 'darwin') {
      if (app.dock) app.dock.setBadge(unreadCount > 0 ? String(unreadCount) : '')
      tray?.setTitle(unreadCount > 0 ? String(unreadCount) : '')
    }
  } catch { /* 忽略 */ }
  try { tray?.setToolTip(`OrayChat — 私有 P2P 加密聊天${unreadCount > 0 ? `（${unreadCount} 条未读）` : '（运行中）'}`) } catch { /* 忽略 */ }
}

function showMessageNotification({ title, body, peerKey }) {
  const now = Date.now()
  if (notifyThrottle.get(peerKey) && now - notifyThrottle.get(peerKey) < 10000) return
  notifyThrottle.set(peerKey, now)
  try {
    const n = new Notification({ title: title || 'OrayChat', body: body || '新消息' })
    n.on('click', showMainWindow)
    n.show()
  } catch { /* 通知不可用时退化为仅角标 */ }
}

app.setName('OrayChat')
app.setPath('userData', path.join(app.getPath('appData'), 'OrayChat', PROFILE))

const DEFAULT_CONFIG = {
  defaultRoom: 'oraychat-hall',
  stunUrls: [
    'stun:stun.l.google.com:19302',
    'stun:stun.cloudflare.com:3478',
    'stun:stun.miwifi.com:3478',
  ],
  turnServers: [
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
}

function configPath() { return path.join(app.getPath('userData'), 'oraychat-config.json') }
function identitiesDir() { return path.join(app.getPath('userData'), 'identities') }

function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').slice(0, 64)
}

function loadConfig() {
  let user = {}
  try { user = JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch { /* 无自定义配置 */ }
  return { ...DEFAULT_CONFIG, ...user }
}

function registerIpc() {
  // 设置页把用户覆盖项写进 local-state['oc-config']；读取时与内置默认+配置文件合并
  // （否则设置页保存的配置永远不生效 —— "重启生效"承诺的兑现）
  ipcMain.handle('config:get', () => {
    const merged = loadConfig()
    try {
      const st = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'local-state.json'), 'utf8'))
      return { ...merged, ...(st['oc-config'] || {}) }
    } catch { return merged }
  })
  ipcMain.handle('launch-args:get', () => argv)
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, profile: PROFILE }))

  // 本地 KV 状态（记住的房间口令、共享聊天日志、名字映射）：
  // 必须走主进程文件而不是 localStorage —— localStorage 在 app.exit()/SIGKILL 下不保证落盘
  const statePath = () => path.join(app.getPath('userData'), 'local-state.json')
  let localState = null
  const loadLocalState = () => {
    if (!localState) {
      try { localState = JSON.parse(fs.readFileSync(statePath(), 'utf8')) } catch { localState = {} }
    }
    return localState
  }
  ipcMain.handle('kv:get', (_e, key) => {
    const s = loadLocalState()
    return key in s ? s[key] : null
  })
  ipcMain.handle('kv:set', (_e, key, val) => {
    const s = loadLocalState()
    if (val === null || val === undefined) delete s[key]
    else s[key] = val
    fs.writeFileSync(statePath(), JSON.stringify(s), { mode: 0o600 })
    return true
  })

  ipcMain.handle('identity:load', (_e, username) => {
    try {
      const p = path.join(identitiesDir(), `${safeName(username)}.json`)
      return JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch { return null }
  })

  ipcMain.handle('identity:save', (_e, username, json) => {
    const dir = identitiesDir()
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(identitiesDir(), `${safeName(username)}.json`)
    fs.writeFileSync(p, JSON.stringify(json, null, 2), { mode: 0o600 })
    return true
  })

  ipcMain.handle('identity:list', () => {
    try {
      return fs.readdirSync(identitiesDir())
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
    } catch { return [] }
  })

  // ---------- 文件传输（filex）存储层 ----------
  // 分片 pwrite 到 <fid>.part；位图/元信息持久化 <fid>.json（断点续传跨重启）；
  // 完成时整文件 SHA-256 校验通过才改名为 <fid>（内容寻址，不可信输入不落地）。
  const filesDir = () => path.join(app.getPath('userData'), 'files')
  const fxSafe = (fid) => String(fid).replace(/[^0-9a-f]/g, '').slice(0, 24)
  const fxPart = (fid) => path.join(filesDir(), `${fxSafe(fid)}.part`)
  const fxMeta = (fid) => path.join(filesDir(), `${fxSafe(fid)}.json`)
  // 完成文件按 <fid><原始扩展名> 落盘（finalize 改名时附扩展名）——查找须兼容两种
  const fxFind = (id) => {
    const dir = filesDir()
    const exact = path.join(dir, id)
    if (fs.existsSync(exact)) return exact
    try {
      const hit = fs.readdirSync(dir).find((f) => f.startsWith(id + '.') && !f.endsWith('.part') && !f.endsWith('.json'))
      return hit ? path.join(dir, hit) : exact
    } catch { return exact }
  }
  const fxDone = (fid) => fxFind(fxSafe(fid))

  ipcMain.handle('fx:state', (_e, fid, { size, cs, n }) => {
    fs.mkdirSync(filesDir(), { recursive: true })
    const id = fxSafe(fid)
    if (!id) return { have: [] }
    let meta = null
    try { meta = JSON.parse(fs.readFileSync(fxMeta(id), 'utf8')) } catch { /* 新传输 */ }
    if (meta && meta.size === size && meta.cs === cs && meta.n === n && Array.isArray(meta.have)) {
      return { have: meta.have }
    }
    // 新事务：落一份元数据（size/cs/n + 空位图）——fx:write 只合并位图，
    // 元数据必须在此写入，否则重启后校验永远失败、断点续传形同虚设
    const fresh = { size, cs, n, have: new Array(Math.ceil(n / 8)).fill(0) }
    fs.writeFileSync(fxMeta(id), JSON.stringify(fresh), { mode: 0o600 })
    return { have: fresh.have }
  })

  ipcMain.handle('fx:write', (_e, fid, i, cs, bytes) => {
    const id = fxSafe(fid)
    if (!id || !Buffer.isBuffer(Buffer.from(bytes))) return false
    fs.mkdirSync(filesDir(), { recursive: true })
    const fd = fs.openSync(fxPart(id), fs.existsSync(fxPart(id)) ? 'r+' : 'w')
    try {
      fs.writeSync(fd, Buffer.from(bytes), 0, bytes.length, i * cs)
    } finally { fs.closeSync(fd) }
    let meta = {}
    try { meta = JSON.parse(fs.readFileSync(fxMeta(id), 'utf8')) } catch { /* 首 块 */ }
    const bm = meta.have || []
    const bi = i >> 3
    while (bm.length <= bi) bm.push(0)
    bm[bi] |= 1 << (i & 7)
    fs.writeFileSync(fxMeta(id), JSON.stringify({ ...meta, have: bm }), { mode: 0o600 })
    return true
  })

  ipcMain.handle('fx:finalize', async (_e, fid, shaHex, name, fin) => {
    const id = fxSafe(fid)
    const part = fxPart(id)
    try {
      const hash = crypto2.createHash('sha256')
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(part)
        rs.on('data', (d) => hash.update(d))
        rs.on('end', resolve)
        rs.on('error', reject)
      })
      if (hash.digest('hex') !== String(shaHex)) return { ok: false, why: 'sha-mismatch' }
      const ext = path.extname(String(name || '')).slice(0, 16)
      const dest = fxDone(id) + ext
      // P2-1 流压缩：.part 是整文件 deflate 流——解压后终检原始哈希再落盘
      if (fin?.alg === 'deflate') {
        const chunks = []
        const rawHash = crypto2.createHash('sha256')
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(part)
          const inf = zlib.createInflateRaw()
          inf.on('data', (d) => { chunks.push(d); rawHash.update(d) })
          inf.on('end', resolve)
          inf.on('error', reject)
          rs.pipe(inf)
        })
        const raw = Buffer.concat(chunks)
        if (rawHash.digest('hex') !== String(fin.rawSha)) return { ok: false, why: 'raw-sha-mismatch' }
        fs.writeFileSync(dest, raw, { mode: 0o600 })
        try { fs.unlinkSync(part) } catch { /* 忽略 */ }
        try { fs.unlinkSync(fxMeta(id)) } catch { /* 忽略 */ }
        return { ok: true, path: dest }
      }
      // 完整性通过：改名为内容寻址文件，附带原始扩展名便于识别
      fs.renameSync(part, dest)
      try { fs.unlinkSync(fxMeta(id)) } catch { /* 忽略 */ }
      return { ok: true, path: dest }
    } catch (e) {
      return { ok: false, why: e?.message || 'io' }
    }
  })

  ipcMain.handle('fx:read', (_e, fid) => {
    try {
      return new Uint8Array(fs.readFileSync(fxDone(fid)))
    } catch { return null }
  })

  // FEC 恢复用：从 .part（接收中）或完成文件读第 i 块
  ipcMain.handle('fx:read-range', (_e, fid, i, cs, len) => {
    try {
      const id = fxSafe(fid)
      let p = fxPart(id)
      if (!fs.existsSync(p)) p = fxDone(id)
      const fd = fs.openSync(p, 'r')
      try {
        const buf = Buffer.alloc(len)
        const read = fs.readSync(fd, buf, 0, len, i * cs)
        return new Uint8Array(buf.subarray(0, read))
      } finally { fs.closeSync(fd) }
    } catch { return null }
  })

  ipcMain.handle('fx:save', async (_e, fid, name) => {
    try {
      const src = fxDone(fxSafe(fid))
      if (!fs.existsSync(src)) return { ok: false, why: 'not-found' }
      const dir = app.getPath('downloads')
      let dest = path.join(dir, path.basename(String(name || id2name(src))))
      const base = dest
      let k = 1
      while (fs.existsSync(dest)) dest = base.replace(/(\.[^.]*)?$/, (m) => ` (${k++})${m}`)
      fs.copyFileSync(src, dest)
      return { ok: true, path: dest }
    } catch (e) { return { ok: false, why: e?.message || 'io' } }
  })

  const id2name = (p) => path.basename(p)

  ipcMain.handle('fx:open', (_e, fid) => {
    try { shell.openPath(fxDone(fxSafe(fid))); return true } catch { return false }
  })

  ipcMain.handle('fx:abort', (_e, fid) => {
    const id = fxSafe(fid)
    for (const p of [fxPart(id), fxMeta(id)]) { try { fs.unlinkSync(p) } catch { /* 忽略 */ } }
    return true
  })

  // bot 注入：读取任意路径文件（发送方；接收方无需）
  ipcMain.handle('fx:readPath', (_e, p) => {
    try {
      const buf = fs.readFileSync(p)
      const st = fs.statSync(p)
      return { bytes: new Uint8Array(buf), name: path.basename(p), size: st.size, mtimeMs: st.mtimeMs }
    } catch { return null }
  })

  ipcMain.on('bot:log', (_e, line) => { process.stdout.write(`${line}\n`) })
  ipcMain.on('bot:exit', (_e, code) => { setTimeout(() => app.exit(Number(code) || 0), 150) })
  ipcMain.handle('win:capture', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const img = await win.webContents.capturePage()
    return img.toPNG()
  })
  ipcMain.handle('app:quit', () => { isQuiting = true; app.quit() })

  // ---------- 设置窗口 ----------
  // config 存 local-state.json 的 'oc-config' 键（用户覆盖项），与内置 DEFAULT_CONFIG 合并
  ipcMain.handle('settings:get', () => {
    const s = loadLocalState()
    return {
      userConfig: s['oc-config'] || {},
      trayEnabled: s['oc-tray-enabled'] !== false, // 默认开
      version: app.getVersion(),
      profile: PROFILE,
      identities: (() => {
        try {
          return fs.readdirSync(identitiesDir()).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
        } catch { return [] }
      })(),
    }
  })
  ipcMain.handle('settings:set-user-config', (_e, userConfig) => {
    const s2 = loadLocalState()
    const prev = s2['oc-config'] || {}
    // 中继服务向导配置（hub）由 hub:persist 独立写入，设置页整体保存时必须保留
    const merged = { ...(userConfig || {}) }
    if (!merged.hub && prev.hub) merged.hub = prev.hub
    s2['oc-config'] = merged
    fs.writeFileSync(statePath(), JSON.stringify(s2), { mode: 0o600 })
    return true
  })
  // ---------- 中继服务模式 ----------
  ipcMain.handle('hub:start', (_e, opts = {}) => hub.start({ ...opts, userDataDir: app.getPath('userData') }))
  ipcMain.handle('hub:stop', () => hub.stop())
  ipcMain.handle('hub:status', () => hub.snapshot())
  // 命名隧道三步向导（稳定域名）：授权 → 创建 → 绑域名；run 由 app 全托管
  ipcMain.handle('hub:login', () => hub.loginTunnel(app.getPath('userData')))
  ipcMain.handle('hub:create-tunnel', (_e, name) => hub.createTunnel(name, app.getPath('userData')))
  ipcMain.handle('hub:route-dns', (_e, name, hostname) => hub.routeDns(name, hostname, app.getPath('userData')))
  ipcMain.handle('hub:verify', (_e, target) => hub.verify(target))
  ipcMain.handle('hub:tunnel-stop', () => hub.stopTunnel())
  ipcMain.handle('hub:set-names', (_e, map) => { hub.setNames(map || {}); return true })
  ipcMain.handle('hub:start-named', (_e, { name, hostname, port }) => {
    // 先确保 broker 本体在跑（用户可能只完成了向导没点过"立即启动"），再挂命名隧道
    if (!hub.snapshot().running) {
      const r0 = hub.start({ port: Number(port) || 48883, userDataDir: app.getPath('userData') })
      if (!r0.ok) return r0
    }
    return hub.start({ tunnel: 'named', name, hostname, userDataDir: app.getPath('userData') })
  })
  ipcMain.handle('hub:persist', (_e, hubCfg) => {
    const cfg = hubCfg || {}
    if (!cfg.token && hub.snapshot().token) cfg.token = hub.snapshot().token // token 沿用（不因保存轮换）
    try {
      const sp = path.join(app.getPath('userData'), 'local-state.json')
      const st = JSON.parse(fs.readFileSync(sp, 'utf8'))
      st['oc-config'] = { ...(st['oc-config'] || {}), hub: cfg }
      fs.writeFileSync(sp, JSON.stringify(st), { mode: 0o600 })
      return true
    } catch (err) { return { err: err.message } }
  })

  ipcMain.handle('settings:set-tray-enabled', (_e, enabled) => {
    const s3 = loadLocalState()
    s3['oc-tray-enabled'] = !!enabled
    fs.writeFileSync(statePath(), JSON.stringify(s3), { mode: 0o600 })
    return true
  })
  ipcMain.handle('settings:clear-data', (_e, kind, room) => {
    const s4 = loadLocalState()
    let cleared = 0
    if (kind === 'login-history') {
      cleared = Object.keys(s4['oc-login-history'] || {}).length
      delete s4['oc-login-history']
    } else if (kind === 'room-log' && room) {
      const key = `oc-log2:${room}`
      cleared = 1
      delete s4[key]
      const nameKey = `oc-names:${room}`
      delete s4[nameKey]
    }
    fs.writeFileSync(statePath(), JSON.stringify(s4), { mode: 0o600 })
    return cleared
  })
  ipcMain.handle('settings:list-rooms', () => {
    const s5 = loadLocalState()
    return Object.keys(s5).filter((k) => k.startsWith('oc-log2:')).map((k) => k.replace('oc-log2:', ''))
  })
  ipcMain.handle('settings:open-main', () => { showMainWindow() })
  ipcMain.handle('settings:open', () => { createSettingsWindow() })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('unread:update', (_e, n) => {
    unreadCount = Math.max(0, Number(n) || 0)
    updateBadges()
  })
  ipcMain.on('notify:msg', (_e, { title, body, peerKey }) => {
    showMessageNotification({ title, body, peerKey })
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('unread:update', (_e, n) => {
    unreadCount = Math.max(0, Number(n) || 0)
    updateBadges()
  })
  ipcMain.on('notify:msg', (_e, { title, body, peerKey }) => {
    showMessageNotification({ title, body, peerKey })
  })
}

function createWindow() {
  // --render-icon=<输出.png>：渲染产品图标（构建管线用；托盘图为 44×44，其余 1024×1024）
  const isIconRenderer = !!argv['render-icon']
  const [usrW, usrH] = String(argv['window-size'] || '').split('x').map(Number)
  const isTrayRender = isIconRenderer && String(argv['icon-page'] || '').startsWith('tray')
  const rSize = isIconRenderer ? (isTrayRender ? 44 : 1024) : (usrW || 1120)
  const win = new BrowserWindow({
    width: rSize,
    height: isIconRenderer ? rSize : (usrH || 760),
    minWidth: isIconRenderer || usrW ? undefined : 860,
    minHeight: isIconRenderer || usrH ? undefined : 560,
    show: isIconRenderer ? false : !IS_BOT,
    transparent: isIconRenderer,
    frame: !isIconRenderer,
    title: `OrayChat — 私有 P2P 加密聊天（${PROFILE}）`,
    backgroundColor: isIconRenderer ? '#00000000' : '#101418',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  win.loadFile(isIconRenderer
    ? path.join(__dirname, '..', 'tools', `icon-${argv['icon-page'] || 'app'}.svg.html`)
    : path.join(__dirname, '..', 'renderer', 'index.html'))

  // 关闭窗口 = 隐藏窗口、应用驻留系统托盘后台继续运行；退出必须经托盘菜单
  win.on('close', (e) => {
    if (!isQuiting && !IS_BOT) {
      // 托盘驻留被停用时：关窗即退出
      let trayEnabled = true
      try {
        trayEnabled = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'local-state.json'), 'utf8'))['oc-tray-enabled'] !== false
      } catch { /* 默认开 */ }
      if (!trayEnabled) { isQuiting = true; app.quit(); return }
      e.preventDefault()
      win.hide()
      if (process.platform === 'win32' && tray) tray.displayBalloon?.({
        icon: nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png')),
        title: 'OrayChat 仍在运行',
        content: '已最小化到系统托盘，消息会继续接收；右键托盘图标可退出。',
      })
    }
  })
  if (IS_BOT) win.webContents.on('console-message', (_e, level, message) => {
    process.stdout.write(`[renderer:${level}] ${message}\n`)
  })

  // --shot=<路径>：渲染完成后自动截窗口 PNG（用于无头验证 UI）
  // --shot-when=<JS 条件>：条件为真才截（如 !!document.querySelector('.fx-progress')），
  // 配 --shot-when-timeout-ms 兜底（超时也截，用于看"到没到该到的状态"）
  if (argv.shot || argv['shot-when']) {
    const captureAndDump = async () => {
      try {
        if (argv['dom-dump']) {
          const info = await win.webContents.executeJavaScript(
            `JSON.stringify({
              imgs: [...document.querySelectorAll('img.fx-img')].map(i => ({src: (i.currentSrc || i.src || '').slice(0, 40), complete: i.complete, nw: i.naturalWidth, broken: i.complete && i.naturalWidth === 0})),
              cards: [...document.querySelectorAll('.fx-card')].map(c => c.textContent.trim().slice(0, 80)),
              progress: [...document.querySelectorAll('.fx-progress')].map(p => ({ pct: p.querySelector('.fx-fill')?.style.width, text: p.textContent.trim().slice(0, 80) })),
              imgPh: [...document.querySelectorAll('.fx-img-ph')].map(p => p.textContent.trim().slice(0, 80)),
              hubPill: document.getElementById('hubPill')?.textContent || null,
              hubPanel: (document.getElementById('hubPanel')?.textContent || '').slice(0, 160),
              hubBadges: document.querySelectorAll('.hub-badge').length,
              roster: [...document.querySelectorAll('#peerList .peer-item')].map(el => (el.querySelector('.p-name')?.textContent || '').trim().slice(0, 40)),
              peerCount: document.getElementById('peerCount')?.textContent || null,
              title: document.title
            })`
          ).catch((e) => 'eval-err: ' + e.message)
          process.stdout.write(`[dom-dump] ${info}\n`)
        }
        const img = await win.webContents.capturePage()
        fs.writeFileSync(String(argv.shot), img.toPNG())
        process.stdout.write(`[shot] saved ${argv.shot}\n`)
        if (argv['exit-after-shot']) app.exit(0)
      } catch (e) {
        process.stderr.write(`[shot] failed: ${e.message}\n`)
        app.exit(1)
      }
    }
    win.webContents.once('did-finish-load', () => {
      if (argv['shot-when']) {
        const cond = String(argv['shot-when'])
        const t0 = Date.now()
        const poll = async () => {
          let hit = false
          try { hit = await win.webContents.executeJavaScript(cond) } catch { hit = false }
          if (hit || Date.now() - t0 > Number(argv['shot-when-timeout-ms'] || 120000)) {
            if (!hit) process.stdout.write(`[shot-when] timeout, capturing anyway\n`)
            await captureAndDump()
          } else setTimeout(poll, 700)
        }
        setTimeout(poll, 1500)
      } else {
        setTimeout(captureAndDump, Number(argv['shot-delay-ms'] || 3500))
      }
    })
  }
  return win
}

let settingsWin = null
function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return }
  settingsWin = new BrowserWindow({
    width: 720,
    height: 640,
    minWidth: 560,
    minHeight: 480,
    title: 'OrayChat 设置',
    backgroundColor: '#101418',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'settingsPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'))
  settingsWin.on('closed', () => { settingsWin = null })
}

function showMainWindow() {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    // Windows 任务栏闪烁提醒（窗口曾隐藏时）
    if (process.platform === 'win32') win.flashFrame(false)
  } else createWindow()
}

function createTray() {
  // 模板图（macOS，自动适配深浅色菜单栏）/ 彩色图（Windows/Linux）
  // 注意：setTemplateImage 必须放在任何 resize 之后 —— resize 返回新图像会丢失模板标记
  const p = process.platform === 'darwin'
    ? path.join(__dirname, 'assets', 'trayTemplate.png')   // 22px，另有 @2x 44px 自动适配视网膜屏
    : path.join(__dirname, 'assets', 'tray-win.png')        // 32px 满幅加粗版（Windows 小尺寸醒目）
  let icon = nativeImage.createFromPath(p)
  if (icon.isEmpty()) {
    process.stdout.write(`[tray] 警告：托盘图标资源缺失 ${p}\n`)
    icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'))
  }
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  process.stdout.write(`[tray] 图标加载 ${icon.isEmpty() ? '失败(空图像)' : '成功'} template=${icon.isTemplateImage()} source=${p}\n`)
  tray = new Tray(icon)
  tray.setToolTip('OrayChat — 私有 P2P 加密聊天（运行中）')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { label: '设置…', click: () => createSettingsWindow() },
    { type: 'separator' },
    { label: '退出 OrayChat', click: () => { isQuiting = true; app.quit() } },
  ]))
  tray.on('click', showMainWindow) // macOS 左键直接弹窗
}

// 单实例锁（按 profile 隔离）：同一 profile 二次启动时，唤起已有窗口而非开新进程 ——
// 避免双开导致同一身份在房间里出现两次、消息分叉与本地记录互相覆盖
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.exit(0)
} else {
  app.on('second-instance', () => showMainWindow())
}

// 捆绑的 cloudflared 就位（v1.25.1 方案 A）：安装包自带官方二进制 → 复制到
// userData/cloudflared/（可执行），随装随用零外部安装；系统 PATH 已有则优先
// 用用户的（findCloudflared 顺序：PATH → userData → 基础目录）
try {
  const bundledName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const bundled = path.join(process.resourcesPath || '', 'cloudflared', bundledName)
  if (fs.existsSync(bundled)) {
    const destDir = path.join(app.getPath('userData'), 'cloudflared')
    const dest = path.join(destDir, bundledName)
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(destDir, { recursive: true })
      fs.copyFileSync(bundled, dest)
      try { fs.chmodSync(dest, 0o755) } catch { /* win 无需 */ }
      process.stdout.write('[cloudflared] 内嵌二进制已就位\n')
    }
  }
} catch { /* 开发模式无捆绑资源，跳过 */ }

// hub 事件扇出到设置窗口与主窗口（状态灯/URL/连接数/日志）
function broadcastHubEvent(ev) {
  for (const w of [settingsWin, mainWindow()].filter(Boolean)) {
    try { w.webContents.send('hub:event', ev) } catch { /* 窗口未就绪 */ }
  }
  if (ev.type === 'login-url') { try { shell.openExternal(ev.url) } catch { /* 无默认浏览器 */ } }
  process.stdout.write(`${JSON.stringify(ev)}\n`) // bot 断言用（[HUB] 行在 hub.js 日志里，经 hub:log 也打 stdout）
}
function mainWindow() { return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('index.html')) }

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  // 托盘驻留开关（设置页可改；默认开）。读取 local-state（尚未迁移前的轻量读取）
  try {
    const st = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'local-state.json'), 'utf8'))
    if (st['oc-tray-enabled'] === false) {
      process.stdout.write('[tray] 已在设置中停用系统托盘驻留\n')
    } else if (!IS_BOT) createTray()
  } catch { if (!IS_BOT) createTray() }
  app.on('activate', () => showMainWindow()) // macOS 点 Dock 图标恢复

  // 中继服务模式：bot 参数直启，或设置页曾启用则自动恢复（重启自愈）
  hub.emitter = { emit: (_t, ev) => broadcastHubEvent(ev) }
  const hubAuto = argv['relay-hub']
    ? {
        port: Number(argv['hub-port']) || 48883,
        tunnel: argv['hub-tunnel'] ? 'quick' : 'off',
        publicUrl: argv['hub-public-url'] || '',
      }
    : null
  if (!hubAuto) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'local-state.json'), 'utf8'))
      const cfg = st['oc-config'] || {}
      if (cfg.hub?.enabled) hubAuto0(cfg.hub) // {enabled,port,mode:'quick'|'named',name,hostname}
    } catch { /* 无配置 */ }
  } else { hubAuto0(hubAuto) }
  function hubAuto0(o) {
    const opts = { ...o, userDataDir: app.getPath('userData') }
    if (opts.mode === 'named' && !opts.tunnel) opts.tunnel = 'named' // 向导持久化的字段名
    opts.noAuth = opts.noAuth ?? false // token 准入默认启用
    hub.start(opts).then((r) => {
      process.stdout.write(`[HUB] autostart ${JSON.stringify(r)}\n`)
    })
  }
})

// 关窗即隐藏，通常不会走到这里；bot 模式靠 botExit 退出
app.on('window-all-closed', () => { if (IS_BOT) app.exit(0) })
