// 私有中继服务模式（v1.23.0 P0；v1.24.0 命名隧道全托管）：
// 主进程内嵌 Aedes MQTT broker（仅绑定 127.0.0.1），经 cloudflared 隧道向房间成员
// 开放 wss:// 接入地址作为第 3 条并联中继链路。中继永远只见密文（relay 层
// sealRoom E2EE）；私有链宕机自动回落公共双链——不新增故障模式（退化即现状）。
//
// 两种隧道：
//   - quick:  快速隧道（零配置，URL 每次启动变化）——app 托管 cloudflared
//   - named:  命名隧道（稳定域名）——app 全托管：login→create→route 三步向导
//             在设置页点按钮完成，run 随客户端后台运行、崩溃自动重启
// 本模块不依赖 electron（可独立冒烟测试）；URL 打开等 UI 动作由事件交给 main.js。
const { Aedes } = require('aedes')
const http = require('http')
const os = require('node:os')
const { WebSocketServer, WebSocket } = require('ws')
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const HUB_LOG_MAX = 200
const CERT_PATH = path.join(os.homedir(), '.cloudflared', 'cert.pem')

const state = {
  aedes: null, server: null, tunnelProc: null, namedProc: null,
  port: 0, tunnelUrl: '', clients: 0, startedAt: 0,
  mode: 'off', name: '', hostname: '', publicUrl: '', token: '',
  namedRestarts: 0, loginProc: null, registered: false,
  clientMap: new Map(), // clientId -> {fp, since}（身份指纹接入表）
  names: {}, // 指纹 -> 昵称（renderer 经 hub:set-names 推送）
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
  if (state.server) {
    // 已在运行：仅按需更新隧道形态（quick→named / 换域名）
    return applyTunnel(opts)
  }
  state.emitter = opts.emitter || state.emitter
  const port = Number(opts.port) || 48883
  const bind = String(opts.bind || '127.0.0.1') // 生产仅回环；e2e 用 0.0.0.0 验 token 准入
  // 准入 token：有则沿用（配置持久化），无则生成（8 组 4 字符 base32 风格，可抄写）
  state.token = String(opts.token || '') || Array.from({ length: 8 }, () => Math.random().toString(32).slice(2, 3).toUpperCase().replace(/[^A-Z2-7]/, () => 'ABCDEFGHJKMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)])).join('-').toLowerCase()
  try {
    // aedes 1.x：new Aedes() 已废弃（半初始化实例不回 CONNACK），必须用异步工厂
    const aedes = await Aedes.createBroker()
    aedes.on('client', (c) => {
      state.clients++
      const m = String(c.id || '').match(/^oc-([0-9a-f]{8})-/)
      if (m) state.clientMap.set(c.id, { fp: m[1], since: Date.now() })
      log(`client 连接 total=${state.clients} (${m ? '成员 ' + m[1] : c.req?.socket?.remoteAddress || 'local'})`)
      state.emitter?.emit('event', { type: 'clients', clients: state.clients })
    })
    aedes.on('clientDisconnect', (c) => {
      state.clients = Math.max(0, state.clients - 1)
      state.clientMap.delete(String(c?.id || ''))
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
    // token 准入（v1.25.0）：回环（本机客户端）免认证；外部连接必须携带 token。
    // 未启用认证（opts.noAuth，兼容旧成员过渡）时全放行
    if (!opts.noAuth) {
      aedes.authenticate = (client, username, password, cb) => {
        const remote = client.req?.socket?.remoteAddress || ''
        if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return cb(null, true)
        const got = Buffer.isBuffer(password) ? password.toString() : String(password || '')
        if (got && got === state.token) return cb(null, true)
        log(`拒绝未授权连接 (${remote || 'unknown'}${client.id ? ' ' + client.id : ''}）`)
        cb(null, false)
      }
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, bind, () => resolve())
    })
    Object.assign(state, { aedes, server, port, clients: 0, startedAt: Date.now() })
    log(`broker 监听 ws://${bind}:${port}${bind === '127.0.0.1' ? '（仅本机回环）' : ''}`)
    state.emitter?.emit('event', { type: 'started', port })

    state.publicUrl = String(opts.publicUrl || '')
    return applyTunnel(opts)
  } catch (e) {
    log(`启动失败: ${e.message}`)
    await stop()
    return { ok: false, err: e.message }
  }
}

// 按配置应用隧道形态（quick / named / off）
function applyTunnel(opts) {
  const mode = opts.tunnel || 'off'
  state.mode = mode
  if (mode === 'quick') {
    startQuickTunnel(opts.userDataDir)
    return { ok: true, ...snapshot() }
  }
  if (mode === 'named') {
    state.name = String(opts.name || '')
    state.hostname = String(opts.hostname || '')
    if (state.hostname) {
      state.tunnelUrl = `wss://${state.hostname}`
      state.emitter?.emit('event', { type: 'tunnel', url: state.tunnelUrl })
    }
    startNamedRun(opts.userDataDir)
    return { ok: true, ...snapshot() }
  }
  return { ok: true, ...snapshot() }
}

async function stop() {
  if (state.tunnelProc) { try { state.tunnelProc.kill('SIGTERM') } catch { /* 已死 */ } state.tunnelProc = null }
  if (state.namedProc) { try { state.namedProc.kill('SIGTERM') } catch { /* 已死 */ } state.namedProc = null }
  if (state.server) {
    await new Promise((r) => { try { state.aedes.close(() => r()) } catch { r() } ; try { state.server.close(() => {}) } catch { /* 已关 */ } })
    log('broker 已停止')
  }
  Object.assign(state, {
    aedes: null, server: null, tunnelUrl: '', port: 0, clients: 0, startedAt: 0,
    mode: 'off', namedRestarts: 0, registered: false,
  })
  // token 保留（属配置非运行态：停止后设置页仍可查看/复制；下次 start 沿用）
  state.emitter?.emit('event', { type: 'stopped' })
}

// ---------- cloudflared 快速隧道（零配置） ----------
function startQuickTunnel(userDataDir) {
  const bin = findCloudflared(userDataDir)
  if (!bin) {
    log('未找到 cloudflared：快速隧道不可用（见使用指南第四节安装；本机 ws:// 私有链不受影响）')
    return
  }
  log(`启动 cloudflared 快速隧道…`)
  const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${state.port}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  state.tunnelProc = proc
  const feed = (buf) => {
    for (const l of buf.toString().split('\n')) {
      const m = l.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i)
      if (m) {
        state.tunnelUrl = `wss://${m[1]}`
        state.publicUrl = state.tunnelUrl
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

// ---------- cloudflared 命名隧道（稳定域名；三步向导 + 全托管 run） ----------

// 步骤① 授权：spawn login（打印授权 URL 等浏览器回调），轮询 cert.pem 出现即完成
function loginTunnel(userDataDir) {
  if (fs.existsSync(CERT_PATH)) return Promise.resolve({ ok: true, already: true })
  const bin = findCloudflared(userDataDir)
  if (!bin) return Promise.resolve({ ok: false, err: '未找到 cloudflared（见使用指南第四节安装）' })
  if (state.loginProc) return Promise.resolve({ ok: false, err: '已有授权流程进行中' })
  return new Promise((resolve) => {
    log('开始 Cloudflare 授权：即将打开浏览器，请在页面中登录并选择域名完成授权…')
    const proc = spawn(bin, ['tunnel', 'login'], { stdio: ['ignore', 'pipe', 'pipe'] })
    state.loginProc = proc
    let urlSeen = false
    const feed = (buf) => {
      const m = buf.toString().match(/https:\/\/dash\.cloudflare\.com\/argotunnel[^\s]*/)
      if (m && !urlSeen) {
        urlSeen = true
        log('已获取授权链接，正在打开浏览器…')
        state.emitter?.emit('event', { type: 'login-url', url: m[0] })
      }
      if (/Successfully logged in|已成功登录/.test(buf.toString())) log('授权成功（证书已下载）')
    }
    proc.stdout.on('data', feed)
    proc.stderr.on('data', feed)
    const t0 = Date.now()
    const poll = setInterval(() => {
      if (fs.existsSync(CERT_PATH)) {
        clearInterval(poll)
        if (state.loginProc === proc) state.loginProc = null
        try { proc.kill('SIGTERM') } catch { /* 已退出 */ }
        log('授权完成（~/.cloudflared/cert.pem 就绪）')
        resolve({ ok: true })
      } else if (Date.now() - t0 > 15 * 60 * 1000) {
        clearInterval(poll)
        if (state.loginProc === proc) state.loginProc = null
        try { proc.kill('SIGTERM') } catch { /* 已退出 */ }
        resolve({ ok: false, err: '授权超时（15 分钟）：请重试' })
      }
    }, 1000)
    proc.on('exit', () => {
      setTimeout(() => { // 留给 cert 轮询先判定
        if (state.loginProc === proc) {
          state.loginProc = null
          clearInterval(poll)
          resolve(fs.existsSync(CERT_PATH) ? { ok: true } : { ok: false, err: '授权被取消或未完成' })
        }
      }, 1500)
    })
  })
}

// 运行外部命令并收集输出（create/route 都是无交互短命令）
function runCloudflared(bin, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const feed = (b) => { out += b.toString() }
    proc.stdout.on('data', feed)
    proc.stderr.on('data', feed)
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* 已死 */ } }, timeoutMs)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

// 步骤② 创建隧道（幂等：已存在视为成功）
async function createTunnel(name, userDataDir) {
  const bin = findCloudflared(userDataDir)
  if (!bin) return { ok: false, err: '未找到 cloudflared（见使用指南第四节安装）' }
  if (!fs.existsSync(CERT_PATH)) return { ok: false, err: '尚未完成第①步授权' }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,48}$/.test(String(name))) return { ok: false, err: '隧道名只能包含字母/数字/-/_' }
  const r = await runCloudflared(bin, ['tunnel', 'create', String(name)])
  if (/Created tunnel/.test(r.out)) { log(`隧道「${name}」创建成功`); return { ok: true } }
  if (/already exist/i.test(r.out)) { log(`隧道「${name}」已存在（继续）`); return { ok: true, already: true } }
  log(`隧道创建失败: ${r.out.trim().slice(0, 200)}`)
  return { ok: false, err: r.out.trim().slice(0, 300) || `exit ${r.code}` }
}

// 步骤③ 绑定域名（幂等：CNAME 已存在且指向同隧道视为成功）
async function routeDns(name, hostname, userDataDir) {
  const bin = findCloudflared(userDataDir)
  if (!bin) return { ok: false, err: '未找到 cloudflared（见使用指南第四节安装）' }
  if (!fs.existsSync(CERT_PATH)) return { ok: false, err: '尚未完成第①步授权' }
  const host = String(hostname || '').trim().toLowerCase()
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return { ok: false, err: '主机名格式不正确（如 mqtt.example.com）' }
  const r = await runCloudflared(bin, ['tunnel', 'route', 'dns', String(name), host])
  if (/Added|created|successfully/i.test(r.out)) { log(`域名 ${host} 已绑定到隧道「${name}」`); return { ok: true } }
  // 已绑定核验通过的三种实测措辞：CNAME 已存在（"record already exists"）、
  // 已指向本隧道（"is already configured to route to your tunnel tunnelID=..."）
  if (/already exist/i.test(r.out) || /is already configured to route/i.test(r.out)) {
    log(`域名 ${host} 已绑定到隧道「${name}」（核验通过，继续）`)
    return { ok: true, already: true }
  }
  log(`域名绑定失败: ${r.out.trim().slice(0, 200)}`)
  return { ok: false, err: r.out.trim().slice(0, 300) || `exit ${r.code}` }
}

// 步骤④ 托管运行命名隧道（崩溃自动重启，指数退避封顶 30s）。
// 凭据两种形态都支持：本地凭据 json（CLI 创建）默认 name run；若反复秒退，
// 自动尝试 token 模式（Dashboard 创建的 remotely-managed 隧道没有本地凭据文件）。
// cloudflared 的全部输出进 hub 日志——诊断"启动不成功"必须能看到真实错误。
function startNamedRun(userDataDir) {
  if (state.namedProc) return
  const bin = findCloudflared(userDataDir)
  if (!bin) { log('未找到 cloudflared：命名隧道无法运行（见使用指南第四节安装）'); return }
  if (!state.name || !state.hostname) { log('命名隧道信息不完整（需隧道名与域名）'); return }
  let useToken = false
  let token = ''
  const spawnRun = () => {
    // ⚠️ --no-autoupdate 是 app 层 flag：放在 `tunnel run` 子命令后不被识别，
    // cloudflared 会打印完整参数帮助然后 code=0 退出（v1.24.0-v1.24.1 秒退根因）
    // --protocol http2：强制 TCP 边缘连接。默认 quic（UDP）在劣化网络下反复
    // "timeout: no recent network activity" 断线重连（v1.24.3 用户日志），TCP 稳定；
    // quick tunnel 同款参数已实测稳定
    const args = useToken && token
      ? ['--no-autoupdate', 'tunnel', '--protocol', 'http2', 'run', '--token', token]
      : ['--no-autoupdate', 'tunnel', '--protocol', 'http2', 'run', '--url', `http://127.0.0.1:${state.port}`, state.name]
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    proc.__startedAt = Date.now()
    state.namedProc = proc
    let registered = false
    let usageLines = 0
    const feed = (buf) => {
      for (let l of buf.toString().split('\n')) {
        l = l.trim()
        if (!l) continue
        if (/Registered tunnel connection|Registered and connected/.test(l)) {
          if (!registered) { registered = true; log(`稳定服务已连接 ${state.tunnelUrl}`) }
          state.registered = true
          state.emitter?.emit('event', { type: 'tunnel', url: state.tunnelUrl })
          continue
        }
        // 参数帮助文本（usage）整屏刷不掉诊断重点：折叠为一条明确提示
        if (/^(--|SUBCOMMAND|GLOBAL|NAME:|USAGE:|VERSION:|AUTHOR|COPYRIGHT|COMMANDS:)/.test(l)) {
          usageLines++
          continue
        }
        if (usageLines > 0) {
          log(`cfd 打印了参数帮助（${usageLines} 行，已省略）——通常是 flag 不被识别或参数顺序错误`)
          usageLines = 0
        }
        // 其余全量进日志（截断）：秒退/失败的真实原因必须可见
        log(`cfd ${l.slice(0, 180)}`)
      }
    }
    proc.stdout.on('data', feed)
    proc.stderr.on('data', feed)
    proc.on('exit', async (code) => {
      if (state.namedProc !== proc) return // stop() 主动关闭
      state.namedProc = null
      state.registered = false
      state.namedRestarts++
      const lifeMs = Date.now() - proc.__startedAt
      // 本地凭据模式连续秒退：探测 token（Dashboard 管理的隧道无本地凭据文件，
      // name run 会报 credentials 缺失并退出——token 模式是它的正确启动方式）
      if (!useToken && lifeMs < 10000 && state.namedRestarts >= 2 && !token) {
        const probe = await runCloudflared(bin, ['tunnel', 'token', state.name], 15000)
        const m = probe.out.match(/eyJ[A-Za-z0-9=_-]{40,}/)
        if (m) {
          useToken = true
          token = m[0]
          state.namedRestarts = 0
          log('本地凭据启动失败：已切换为 token 模式（该隧道由 Cloudflare Dashboard 管理）')
        } else {
          log(`token 探测未命中（隧道可能为本地管理，凭据文件缺失）：${probe.out.trim().slice(0, 160)}`)
          log('请确认本机 ~/.cloudflared/ 下有该隧道的 <ID>.json 凭据（重新 create 或在其他机器导入）')
        }
      }
      const delay = Math.min(2000 * 2 ** Math.min(state.namedRestarts, 4), 30000)
      log(`命名隧道进程退出 code=${code}（存活 ${Math.round(lifeMs / 1000)}s），${Math.round(delay / 1000)}s 后自动重启`)
      setTimeout(() => {
        if (state.server && state.mode === 'named') spawnRun()
      }, delay)
    })
    log(`命名隧道「${state.name}」${useToken ? '(token 模式)' : ''}启动 → ${state.tunnelUrl}（随客户端后台运行，异常自动重启）`)
  }
  spawnRun()
}

// 成员视角接入测试：真实连接目标地址并完成发布/订阅往返。
// 目标优先级由调用方（设置页）决定：对外地址（验证全公网链路）> 本机回环（只验 Aedes）
function verify(target) {
  const url = String(target || '').trim()
  if (!url) return Promise.resolve({ ok: false, err: '无可用地址（未填对外地址且中继未运行）' })
  return new Promise((resolve) => {
    let done = false
    const finish = (r) => { if (done) return; done = true; try { c.end(true) } catch { /* 已断 */ } resolve(r) }
    let c
    try {
      const mqtt = require('mqtt')
      const t0 = Date.now()
      const topic = `hub-verify-${Date.now().toString(36)}`
      c = mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: 10000 })
      c.on('connect', () => { c.subscribe(topic); c.publish(topic, 'verify') })
      c.on('message', () => finish({ ok: true, ms: Date.now() - t0 }))
      c.on('error', (e) => finish({ ok: false, err: e.message }))
      setTimeout(() => finish({ ok: false, err: '连接/响应超时（15s）——检查地址、隧道状态或网络' }), 15000)
    } catch (e) { finish({ ok: false, err: e.message }) }
  })
}

function stopNamed() {
  if (state.namedProc) { try { state.namedProc.kill('SIGTERM') } catch { /* 已死 */ } state.namedProc = null }
  state.namedRestarts = 0
}

function snapshot() {
  return {
    running: !!state.server,
    port: state.port,
    tunnelUrl: state.tunnelUrl,
    publicUrl: state.publicUrl,
    clients: state.clients,
    mode: state.mode,
    name: state.name,
    hostname: state.hostname,
    certReady: fs.existsSync(CERT_PATH),
    tunnelProc: !!(state.tunnelProc || state.namedProc),
    registered: state.registered,
    token: state.token,
    // 按身份指纹聚合的成员接入列表（同名合并条数；名字由 renderer 映射）
    memberList: (() => {
      const byFp = new Map()
      for (const { fp } of state.clientMap.values()) byFp.set(fp, (byFp.get(fp) || 0) + 1)
      return [...byFp.entries()].map(([fp, links]) => ({ fp, links, name: state.names[fp] || '' }))
    })(),
    log: state.logs.slice(-40),
  }
}

function setNames(map) { state.names = map || {} }

module.exports = {
  start, stop, snapshot, log, loginTunnel, createTunnel, routeDns, stopNamed, verify, setNames,
  set emitter(v) { state.emitter = v },
}
