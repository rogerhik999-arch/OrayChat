// OrayChat Electron 主进程
// - 多实例：--profile=<名字> 决定独立的 userData（身份密钥、聊天记录互不干扰），
//   方便同一台机器上跑多个终端做 P2P 验证
// - 身份密钥以 JSON 存于 <userData>/identities/（0600 权限）
// - bot 模式：--bot 时无窗口自动化登录，日志经 IPC 转发到 stdout，供 e2e 测试驱动
// - 应用层配置：<userData>/oraychat-config.json 可覆盖 STUN/TURN/默认房间

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const argv = {}
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  if (m) argv[m[1]] = m[2] === undefined ? true : m[2]
}

const PROFILE = String(argv.profile || 'default')
const IS_BOT = !!argv.bot

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
  ipcMain.handle('app:quit', () => app.exit(0))
}

function createWindow() {
  // --render-icon=<输出.png>：以 1024×1024 透明窗口渲染产品图标（构建管线用）
  const isIconRenderer = !!argv['render-icon']
  const win = new BrowserWindow({
    width: isIconRenderer ? 1024 : 1120,
    height: isIconRenderer ? 1024 : 760,
    minWidth: isIconRenderer ? undefined : 860,
    minHeight: isIconRenderer ? undefined : 560,
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

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  app.exit(0)
})
