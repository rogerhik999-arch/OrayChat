// OrayChat Electron 主进程
// - 多实例：--profile=<名字> 决定独立的 userData（身份密钥、聊天记录互不干扰），
//   方便同一台机器上跑多个终端做 P2P 验证
// - 身份密钥以 JSON 存于 <userData>/identities/（0600 权限）
// - bot 模式：--bot 时无窗口自动化登录，日志经 IPC 转发到 stdout，供 e2e 测试驱动
// - 应用层配置：<userData>/oraychat-config.json 可覆盖 STUN/TURN/默认房间

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

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
  ipcMain.handle('config:get', () => loadConfig())
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

  ipcMain.on('bot:log', (_e, line) => { process.stdout.write(`${line}\n`) })
  ipcMain.on('bot:exit', (_e, code) => { setTimeout(() => app.exit(Number(code) || 0), 150) })
  ipcMain.handle('win:capture', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const img = await win.webContents.capturePage()
    return img.toPNG()
  })
  ipcMain.handle('app:quit', () => { isQuiting = true; app.quit() })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
}

function createWindow() {
  // --render-icon=<输出.png>：以 1024×1024 透明窗口渲染产品图标（构建管线用）
  const isIconRenderer = !!argv['render-icon']
  const [usrW, usrH] = String(argv['window-size'] || '').split('x').map(Number)
  const win = new BrowserWindow({
    width: isIconRenderer ? 1024 : (usrW || 1120),
    height: isIconRenderer ? 1024 : (usrH || 760),
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
    process.stdout.write(`[tray] close 事件触发 isQuiting=${isQuiting} IS_BOT=${IS_BOT}\n`)
    if (!isQuiting && !IS_BOT) {
      process.stdout.write('[tray] 隐藏窗口，驻留后台\n')
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
  if (argv.shot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage()
          fs.writeFileSync(String(argv.shot), img.toPNG())
          process.stdout.write(`[shot] saved ${argv.shot}\n`)
          if (argv['exit-after-shot']) app.exit(0)
        } catch (e) {
          process.stderr.write(`[shot] failed: ${e.message}\n`)
          app.exit(1)
        }
      }, Number(argv['shot-delay-ms'] || 3500))
    })
  }
  return win
}

function showMainWindow() {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } else createWindow()
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'))
    .resize({ width: process.platform === 'darwin' ? 22 : 32, height: process.platform === 'darwin' ? 22 : 32 })
  tray = new Tray(icon)
  tray.setToolTip('OrayChat — 私有 P2P 加密聊天（运行中）')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { type: 'separator' },
    { label: '退出 OrayChat', click: () => { isQuiting = true; app.quit() } },
  ]))
  tray.on('click', showMainWindow) // macOS 左键直接弹窗
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  if (!IS_BOT) createTray()
  app.on('activate', () => showMainWindow()) // macOS 点 Dock 图标恢复
})

// 关窗即隐藏，通常不会走到这里；bot 模式靠 botExit 退出
app.on('window-all-closed', () => { if (IS_BOT) app.exit(0) })
