// 私有中继服务模式（v1.23.0，docs/private-relay-research.md P0）：
// 主进程内嵌 Aedes MQTT broker（仅绑定 127.0.0.1），可选经 cloudflared 快速隧道
// 暴露 wss:// 地址给房间成员作第 3 条并联中继链路。中继永远只见密文（relay 层
// sealRoom E2EE）；私有链宕机自动回落公共双链——不新增故障模式（退化即现状）。
//
// 模式：
//   - quick:   app 托管 cloudflared 快速隧道（零配置；URL 每次启动变化，trycloudflare.com）
//   - external: 用户自管隧道/已命名隧道，app 只显示"对外地址"供复制分享
//
// 稳定地址（命名隧道）= 一次性 `cloudflared tunnel login/create/route` 后在
// external 模式填入自定域名；或把 run 交给 app（custom args 留 v2）。
const { Aedes } = require('aedes')
const http = require('http')
const { WebSocketServer, WebSocket } = require('ws')
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const HUB_LOG_MAX = 200

const state = {
  aedes: null, server: null, tunnelProc: null,
  port: 0, tunnelUrl: '', clients: 0, startedAt: 0,
  logs: [], emitter: null, // main.js 注入 EventEmitter（转发 UI/日志事件）
}

function log(msg) {
  const line = `[HUB] ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${msg}`
  state.logs.push(line)
  if (state.logs.length > HUB_LOG_MAX) state.logs.shift()
  state.emitter?.emit('event', { type: 'log', line })
}

// cloudflared 二进制：PATH → 缓存（profile 目录与基础目录都查；profile 模式下
// userData 含 -<profile> 后缀，二进制常缓存在基础 OrayChat 目录）
function findCloudflared(userDataDir) {
  for (const p of ['cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) {
    try { execFileSync(p, ['--version'], { stdio: 'ignore' }); return p } catch { /* 不在 */ }
  }
  const bases = [userDataDir, path.dirname(userDataDir)]
  for (const base of bases) {
    const cached = path.join(base, 'cloudflared', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
    if (fs.existsSync(cached)) return cached
  }
  return null
}

async function start(opts = {}) {
  if (state.server) return { ok: true, already: true, ...snapshot() }
  state.emitter = opts.emitter || state.emitter
  const port = Number(opts.port) || 48883
  try {
    // aedes 1.x：new Aedes() 已废弃（半初始化实例不回 CONNACK），必须用异步工厂
    const aedes = await Aedes.createBroker()
    aedes.on('client', (c) => {
      state.clients++
      log(`client 连接 total=${state.clients} (${c.req?.socket?.remoteAddress || 'local'})`)
      state.emitter?.emit('event', { type: 'clients', clients: state.clients })
    })
    aedes.on('clientDisconnect', () => {
      state.clients = Math.max(0, state.clients - 1)
      state.emitter?.emit('event', { type: 'clients', clients: state.clients })
    })
    // 自建 http+ws 桥（不用 aedes-server-factory 的 ws 分支：它不处理 mqtt.js 的
    // `mqtt` 子协议握手，客户端会 connack timeout）。任一路径均可连（含 / 与 /mqtt）
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
    const wss = new WebSocketServer({
      server,
      handleProtocols: (protocols) => protocols.has('mqtt') ? 'mqtt' : false,
    })
    wss.on('connection', (conn, req) => {
      const stream = WebSocket.createWebSocketStream(conn)
      stream._socket = conn._socket
      stream.remoteAddress = req.socket?.remoteAddress
      aedes.handle(stream, req)
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
    Object.assign(state, { aedes, server, port, clients: 0, startedAt: Date.now() })
    log(`broker 监听 ws://127.0.0.1:${port}（仅本机回环）`)
    state.emitter?.emit('event', { type: 'started', port })

    if (opts.tunnel === 'quick') startQuickTunnel(opts.userDataDir)
    return { ok: true, ...snapshot() }
  } catch (e) {
    log(`启动失败: ${e.message}`)
    await stop()
    return { ok: false, err: e.message }
  }
}

async function stop() {
  if (state.tunnelProc) { try { state.tunnelProc.kill('SIGTERM') } catch { /* 已死 */ } state.tunnelProc = null }
  if (state.server) {
    await new Promise((r) => { try { state.aedes.close(() => r()) } catch { r() } ; try { state.server.close(() => {}) } catch { /* 已关 */ } })
    log('broker 已停止')
  }
  Object.assign(state, { aedes: null, server: null, tunnelUrl: '', port: 0, clients: 0, startedAt: 0 })
  state.emitter?.emit('event', { type: 'stopped' })
}

// cloudflared 快速隧道：出站连接 CF 边缘，解析 stdout 的 trycloudflare.com URL
function startQuickTunnel(userDataDir) {
  const bin = findCloudflared(userDataDir)
  if (!bin) {
    log('未找到 cloudflared：快速隧道不可用（brew install cloudflared，或在设置里改用外部隧道地址）；本机 ws:// 私有链不受影响')
    return
  }
  const args = [bin, 'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${state.port}`]
  log(`启动 cloudflared 快速隧道…`)
  const proc = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
  state.tunnelProc = proc
  const feed = (buf) => {
    const text = buf.toString()
    for (const l of text.split('\n')) {
      const m = l.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i)
      if (m) {
        state.tunnelUrl = `wss://${m[1]}`
        log(`隧道就绪 ${state.tunnelUrl}（成员可在设置页 broker 列表加入此地址）`)
        state.emitter?.emit('event', { type: 'tunnel', url: state.tunnelUrl })
      }
    }
  }
  proc.stdout.on('data', feed)
  proc.stderr.on('data', feed) // cloudflared 日志走 stderr
  proc.on('exit', (code) => {
    if (state.tunnelProc === proc) {
      state.tunnelProc = null
      state.tunnelUrl = ''
      log(`cloudflared 退出 code=${code}（私有链回落本机/公共链）`)
      state.emitter?.emit('event', { type: 'tunnel', url: '' })
    }
  })
}

function snapshot() {
  return {
    running: !!state.server,
    port: state.port,
    tunnelUrl: state.tunnelUrl,
    clients: state.clients,
    tunnelProc: !!state.tunnelProc,
    log: state.logs.slice(-40),
  }
}

module.exports = { start, stop, snapshot, log, set emitter(v) { state.emitter = v } }
