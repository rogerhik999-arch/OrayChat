// OrayChat 渲染层入口：UI 编排 + bot 自动化模式（供 e2e 测试）
// 会话视图：大厅（房间内所有人可见的群聊）+ 私聊；共享日志由 net.store 驱动 ——
//   全体保存、任何成员可发起删除（单条/清空）并传播到所有人、上线全局同步、保留 30 天。
import { ChatNet, DEFAULT_CONFIG, buildRtcConfig, selfId } from './net.mjs'
import * as oc from './crypto.mjs'
import { dmConvKey } from './store.mjs'

const $ = (id) => document.getElementById(id)
const state = {
  cfg: null,
  args: {},
  ident: null,
  name: '',
  myIdPubHex: '',
  room: '',
  net: null,
  // 当前视图：{conv:'lobby'} 或 {conv:'dm', peerId}
  view: { conv: 'lobby' },
  names: new Map(), // idPubHex -> 显示名（含自己），本地文件持久化
  logData: null, // 登录时从主进程文件 KV 读入的共享日志
}

// ---------- 工具 ----------

function esc(s) {
  const d = document.createElement('div')
  d.textContent = String(s)
  return d.innerHTML
}
function fmtTime(t) {
  return new Date(t).toLocaleTimeString('zh-CN', { hour12: false })
}
function avatarColor(seed) {
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return `hsl(${h % 360} 45% 42%)`
}

// ---------- 名字映射（共享日志里的作者只存公钥，显示名本地解析） ----------
// 与共享日志一样走主进程文件 KV（可靠落盘），不走 localStorage

function loadNames() {
  return window.oray.kvGet(`oc-names:${state.room}`).then((obj) => {
    for (const [k, v] of Object.entries(obj || {})) state.names.set(k, v)
  })
}
function saveName(idPubHex, name) {
  if (!idPubHex || !name || state.names.get(idPubHex) === name) return
  state.names.set(idPubHex, name)
  window.oray.kvSet(`oc-names:${state.room}`, Object.fromEntries(state.names)).catch(() => {})
}
function authorName(idPubHex) {
  if (idPubHex === state.myIdPubHex) return state.name
  return state.names.get(idPubHex) || `${idPubHex.slice(0, 8)}…`
}

// ---------- 口令记忆（可选，默认关闭；明文存本机文件，仅建议磁盘加密设备使用） ----------

// ---------- 登录历史（按昵称记住房间+口令，可删除） ----------

const LOGIN_KEY = 'oc-login-history'
async function getLoginHistory() {
  return (await window.oray.kvGet(LOGIN_KEY)) || {}
}
// remember=false 时保留旧口令不清除（勾选状态由界面控制保存与否）
async function upsertLogin(name, room) {
  const h = await getLoginHistory()
  h[name] = { room }
  await window.oray.kvSet(LOGIN_KEY, h)
  renderSavedAccounts()
}
async function forgetLogin(name) {
  const h = await getLoginHistory()
  delete h[name]
  await window.oray.kvSet(LOGIN_KEY, h)
  renderSavedAccounts()
}
async function autofillByLogin(name) {
  if (!name) return
  const h = await getLoginHistory()
  const e = h[name]
  if (e?.room) $('roomInput').value = e.room
}
async function renderSavedAccounts() {
  const box = $('savedAccounts')
  if (!box) return
  const h = await getLoginHistory()
  const names = Object.keys(h)
  if (!names.length) { box.classList.add('hidden'); box.innerHTML = ''; return }
  box.classList.remove('hidden')
  box.innerHTML = '<div class="sa-head">本机保存的登录（点击填入，可删除）</div>'
  for (const n of names) {
    const row = document.createElement('div')
    row.className = 'sa-row'
    const info = document.createElement('span')
    info.className = 'sa-info'
    info.textContent = `${n} → ${h[n].room}`
    info.onclick = () => {
      $('nameInput').value = n
      $('roomInput').value = h[n].room
    }
    const del = document.createElement('a')
    del.className = 'sa-del'
    del.textContent = '删除'
    del.onclick = () => forgetLogin(n)
    row.appendChild(info)
    row.appendChild(del)
    box.appendChild(row)
  }
}

// ---------- 会话视图辅助 ----------

function viewKey(v = state.view) {
  if (v.conv === 'lobby') return 'lobby'
  const peer = state.net?.peers.get(v.peerId)
  const peerHex = peer?.idPubHex || v.peerId
  return dmConvKey(state.myIdPubHex, peerHex)
}
function viewWireConv(v = state.view) { return v.conv === 'lobby' ? 'lobby' : 'dm' }

// ---------- 渲染 ----------

function renderPeers() {
  const list = $('peerList')
  list.innerHTML = ''
  const peers = state.net ? [...state.net.peers.entries()] : []
  const readyCount = peers.filter(([, p]) => p.state === 'ready').length

  // 大厅入口（置顶）
  const lobby = document.createElement('li')
  lobby.className = 'peer-item' + (state.view.conv === 'lobby' ? ' active' : '')
  lobby.innerHTML = `
    <div class="avatar" style="background:#3b5b8f">🏛️</div>
    <div class="p-info">
      <div class="p-name">大厅 · ${esc(state.room)}</div>
      <div class="p-state"><span class="dot ${readyCount ? 'ok' : 'off'}"></span>${readyCount} 人在线 · 全员可见</div>
    </div>`
  lobby.onclick = () => selectView({ conv: 'lobby' })
  list.appendChild(lobby)

  for (const [peerId, p] of peers) {
    const li = document.createElement('li')
    li.className = 'peer-item' + (state.view.conv === 'dm' && state.view.peerId === peerId ? ' active' : '')
    const name = p.name || `${peerId.slice(0, 8)}…`
    let stateText = {
      connecting: '建立 P2P 连接…',
      handshaking: '协商端到端加密…',
      ready: p.via === 'mqtt' ? '已加密 · 公共MQTT中继'
        : p.path === 'relay' ? '已加密 · TURN中继' : '已加密 · P2P直连',
      failed: `握手失败：${p.lastError || '未知'}`,
    }[p.state] || p.state
    if (p.state === 'ready' && p.lastSeen) {
      const ago = Math.max(0, Math.round((Date.now() - p.lastSeen) / 1000))
      stateText += ago <= 20 ? ` · ${ago}s 前在线报告` : ` · ⚠ ${ago}s 未报告`
    }
    const dotCls = p.state === 'ready' ? (p.via === 'mqtt' || p.path === 'relay' ? 'warn' : 'ok')
      : p.state === 'failed' ? 'err' : 'off'
    li.innerHTML = `
      <div class="avatar" style="background:${avatarColor(peerId)}">${esc(name.slice(0, 1).toUpperCase())}</div>
      <div class="p-info">
        <div class="p-name">${esc(name)}</div>
        <div class="p-state"><span class="dot ${dotCls}"></span>${esc(stateText)}</div>
      </div>`
    li.onclick = () => selectView({ conv: 'dm', peerId })
    list.appendChild(li)
  }
  $('peerCount').textContent = String(readyCount)
  renderChatHead()
}

function renderChatHead() {
  const isLobby = state.view.conv === 'lobby'
  const readyCount = state.net ? [...state.net.peers.values()].filter((p) => p.state === 'ready').length : 0
  const activePeer = !isLobby ? state.net?.peers.get(state.view.peerId) : null
  const reconnectable = !isLobby && activePeer && (activePeer.state === 'failed' || activePeer.via === 'mqtt' || activePeer.path === 'unknown')
  if (isLobby) {
    $('chatTitle').textContent = `大厅 · ${state.room}`
    $('chatSub').textContent = '房间内所有人可见；记录全体保存、任何人可删除、上线自动同步、保留 30 天'
    const badges = [
      `<span class="badge ok">🔐 端到端加密（对每成员单独会话）</span>`,
      `<span class="badge">已同步成员 ${readyCount}</span>`,
      `<span class="badge">保留 30 天</span>`,
    ]
    if (reconnectable) badges.push(`<button id="reconnectBtn" class="ghost warn2">重新连接</button>`)
    $('chatBadges').innerHTML = badges.join('') +
      `<button id="clearBtn" class="ghost danger">清空全体记录</button>`
  } else {
    const p = state.net?.peers.get(state.view.peerId)
    const name = p?.name || '对方'
    $('chatTitle').textContent = name
    const badges = []
    if (p?.state === 'ready') {
      badges.push(`<span class="badge ok">🔐 端到端加密已建立</span>`)
      if (p.via === 'mqtt') badges.push(`<span class="badge warn">经公共 MQTT 中继转发（仍端到端加密）</span>`)
      else badges.push(`<span class="badge ${p.path === 'relay' ? 'warn' : 'ok'}">${p.path === 'relay' ? '经 TURN 中继转发（仍端到端加密）' : 'P2P 直连'}</span>`)
      if (p.safety) badges.push(`<span class="badge">安全码 <span class="mono">${esc(p.safety)}</span></span>`)
    } else if (p?.state === 'failed') {
      badges.push(`<span class="badge" style="color:var(--err)">握手失败：${esc(p.lastError || '')}</span>`)
    } else {
      badges.push(`<span class="badge">连接协商中…</span>`)
    }
    badges.push(`<span class="badge">保留 30 天</span>`)
    $('chatBadges').innerHTML = badges.join('') +
      `<button id="clearBtn" class="ghost danger">清空全体记录</button>`
    $('chatSub').textContent = p?.state === 'ready'
      ? '请线下核对上方安全码，一致即确认无中间人；任何一方删除记录，双方同时删除'
      : '正在通过信令交换 SDP 并协商加密'
  }
  const btn = $('clearBtn')
  if (btn) btn.onclick = confirmThenClear
  const rbtn = $('reconnectBtn')
  if (rbtn) rbtn.onclick = async () => {
    rbtn.disabled = true
    try { await state.net.reconnect(state.view.peerId) } catch (e) { appendSys(`重连失败：${e.message}`) }
    setTimeout(() => { if (rbtn.isConnected) rbtn.disabled = false }, 3000)
  }
  renderReconnectBar()
}

// 渲染整个消息区（共享日志驱动；mid 幂等，删除/清空/同步都会触发重绘）
function renderMessages() {
  const key = viewKey()
  const msgs = state.net ? state.net.store.visible(key) : []
  const box = $('msgs')
  box.innerHTML = ''
  if (!msgs.length) {
    const isLobby = state.view.conv === 'lobby'
    box.innerHTML = `<div class="placeholder" id="placeholder">
      <div class="ph-icon">${isLobby ? '🏛️' : '🔐'}</div>
      <p>${isLobby
        ? '大厅消息对房间内所有人可见，<br/>记录全体保存 · 任何人可删除 · 上线自动同步 · 保留 30 天'
        : '消息经端到端加密后通过 WebRTC 数据通道直发对方，<br/>只有你们二人能解密；任何一方删除记录，双方同时删除。'}</p>
    </div>`
    return
  }
  const frag = document.createDocumentFragment()
  let lastDay = ''
  for (const m of msgs) {
    const day = new Date(m.t).toLocaleDateString('zh-CN')
    if (day !== lastDay) {
      lastDay = day
      const sep = document.createElement('div')
      sep.className = 'day-sep'
      sep.textContent = day
      frag.appendChild(sep)
    }
    const mine = m.author === state.myIdPubHex
    const row = document.createElement('div')
    row.className = 'msg' + (mine ? ' me' : '')
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    if (!mine && state.view.conv === 'lobby') {
      const author = document.createElement('span')
      author.className = 'author'
      author.textContent = authorName(m.author)
      bubble.appendChild(author)
    }
    const text = document.createElement('span')
    text.className = 'btext'
    text.textContent = m.text
    bubble.appendChild(text)
    const meta = document.createElement('span')
    meta.className = 'meta'
    meta.append(`${mine ? '我' : authorName(m.author)} · ${fmtTime(m.t)} `)
    const del = document.createElement('a')
    del.className = 'del'
    del.textContent = '删除'
    del.title = '删除（对所有人生效）'
    meta.appendChild(del)
    bubble.appendChild(meta)
    row.appendChild(bubble)
    frag.appendChild(row)
  }
  box.appendChild(frag)
  box.scrollTop = box.scrollHeight
}

function renderReconnectBar() {
  let bar = $('reconnectBar')
  if (!bar) {
    bar = document.createElement('div')
    bar.id = 'reconnectBar'
    bar.className = 'reconnect-bar'
    $('chatHead').after(bar)
  }
  if (state.view.conv === 'dm') {
    const p = state.net?.peers.get(state.view.peerId)
    const dropped = p && (p.state === 'failed' || (p.lastConnectionLost && Date.now() - p.lastConnectionLost < 60000))
    if (dropped) {
      bar.innerHTML = ''
      const msg = document.createElement('span')
      msg.textContent = `⚠ ${p.name || '对方'}：${p.lastError || '网络拓扑变化，连接中断'}`
      const btn = document.createElement('button')
      btn.textContent = '重新连接'
      btn.onclick = async () => {
        btn.disabled = true
        try { await state.net.reconnect(state.view.peerId) } catch (e) { btn.textContent = `重连失败：${e.message}` }
      }
      bar.appendChild(msg)
      bar.appendChild(btn)
      bar.classList.remove('hidden')
      return
    }
  }
  bar.classList.add('hidden')
}

function renderConv() { renderChatHead(); renderReconnectBar(); renderMessages() }

function selectView(v) {
  state.view = v
  document.body.classList.remove('sidebar-open') // 手机上选中即收起侧栏
  renderConv()
  renderPeers()
  const canSend = v.conv === 'lobby' || state.net?.peers.get(v.peerId)?.state === 'ready'
  $('input').disabled = !canSend
  $('sendBtn').disabled = !canSend
}

// ---------- 删除操作 ----------

async function deleteMessage(mid) {
  try {
    await state.net.deleteMessage(viewWireConv(), mid, state.view.peerId)
  } catch (e) { appendSys(`删除失败：${e.message}`) }
}

async function confirmThenClear() {
  const btn = $('clearBtn')
  if (btn.dataset.confirm) {
    delete btn.dataset.confirm
    btn.textContent = '清空全体记录'
    try { await state.net.clearConv(viewWireConv(), state.view.peerId) }
    catch (e) { appendSys(`清空失败：${e.message}`) }
  } else {
    btn.dataset.confirm = '1'
    btn.textContent = '再次点击确认（对所有人生效）'
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.confirm; btn.textContent = '清空全体记录' } }, 3000)
  }
}

function appendSys(text) {
  const box = $('msgs')
  const div = document.createElement('div')
  div.className = 'msg'
  div.innerHTML = `<div class="bubble system">${esc(text)} · ${fmtTime(Date.now())}</div>`
  box.appendChild(div)
  box.scrollTop = box.scrollHeight
}

// ---------- 登录 ----------

async function doLogin(name, room) {
  $('loginErr').classList.add('hidden')
  const stored = await window.oray.loadIdentity(name)
  if (stored?.edSeed) {
    state.ident = oc.identityFromJson(stored)
    showExistingId('已加载本机保存的身份密钥', stored.createdAt)
  } else {
    state.ident = oc.createIdentity()
    await window.oray.saveIdentity(name, oc.identityToJson(state.ident))
    showExistingId('已为本机生成新的身份密钥', Date.now())
  }
  state.name = name
  state.myIdPubHex = oc.hex(state.ident.edPub)
  state.room = room
  await loadNames()
  saveName(state.myIdPubHex, name)
  state.logData = await window.oray.kvGet(`oc-log2:${room}`)
  // 登录历史：按昵称记住房间
  await upsertLogin(name, room)

  const cfg = state.cfg
  state.net = new ChatNet(state.ident, state.name, state.room, {
    ...cfg,
    rtcConfig: buildRtcConfig(cfg),
  }, netHooks(), { forceRelay: !!state.args['relay-only'] })

  $('selfName').textContent = name
  $('selfFp').textContent = oc.identityFingerprint(state.ident.edPub)
  $('selfRoom').textContent = room
  $('loginView').classList.add('hidden')
  $('mainView').classList.remove('hidden')
  selectView({ conv: 'lobby' })
}

function showExistingId(text, createdAt) {
  const el = $('existingId')
  el.classList.remove('hidden')
  el.textContent = `${text} · 创建于 ${new Date(createdAt).toLocaleString('zh-CN')}`
}

// ---------- 网络事件 ----------

function netHooks() {
  return {
    // 共享日志经主进程文件 KV 持久化（localStorage 在强杀/退出时不保证落盘）
    onStorePersist: (all) => {
      window.oray.kvSet(`oc-log2:${state.room}`, all).catch(() => {})
    },
    onStoreLoad: () => state.logData || null,
    onStoreChanged: (convKey) => {
      if (convKey === viewKey()) renderMessages()
      renderPeers()
    },
    onLog: (msg, level) => {
      if (state.args.bot) window.oray.botLog(`[BOT] LOG ${level || 'info'} ${msg}`)
    },
    onPeerAdded: () => renderPeers(),
    onPeerRemoved: (peerId, p) => {
      if (state.view.conv === 'dm' && state.view.peerId === peerId) $('input').disabled = true
      renderPeers()
    },
    onPeerReady: (peerId, p) => {
      saveName(p.idPubHex, p.name)
      if (state.view.conv === 'dm' && state.view.peerId === peerId) {
        $('input').disabled = false
        $('sendBtn').disabled = false
      }
      renderPeers()
      if (state.args.bot) window.oray.botLog(`[BOT] READY peer=${p.name} safety=${p.safety} path=${p.path} candidates=${JSON.stringify(p.candidates || {})}`)
      botOnReady(peerId, p)
    },
    onPeerFailed: () => renderPeers(),
    onPathDetected: (peerId, p) => {
      renderPeers()
      if (state.args.bot) window.oray.botLog(`[BOT] PATH peer=${p.name} path=${p.path} detail=${JSON.stringify(p.pathDetail || {})}`)
    },
    onMessage: (peerId, p, msg) => {
      if (state.args.bot) {
        if (msg.conv === 'lobby') window.oray.botLog(`[BOT] LOBBY-RECV from=${p.name} text=${JSON.stringify(msg.text)}`)
        else window.oray.botLog(`[BOT] RECV from=${p.name} text=${JSON.stringify(msg.text)}`)
      }
      botOnMessage(peerId, p, msg)
    },
    onWireSend: (peerId, envelope) => {
      if (state.args.bot) window.oray.botLog(`[BOT] WIRE ${JSON.stringify(envelope)}`)
    },
    onConnectionLost: (peerId, p, msg) => {
      p.lastConnectionLost = Date.now()
      appendSys(msg)
      if (state.args.bot) window.oray.botLog(`[BOT] CONN-LOST peer=${p.name} msg=${JSON.stringify(msg)}`)
      renderConv()
      renderPeers()
    },
    onConnectionRestored: (peerId, p) => {
      appendSys(`与 ${p.name || '对方'} 的连接已恢复`)
      renderConv()
      renderPeers()
    },
    onPresence: (peerId, p) => {
      if (state.args.bot) window.oray.botLog(`[BOT] PRESENCE from=${p.name}`)
      renderPeers()
    },
    onControl: (peerId, p, ctl) => {
      if (state.args.bot && ctl.wireConv === 'lobby') {
        window.oray.botLog(`[BOT] LOBBY-DEL-APPLIED op=${ctl.op} applied=${ctl.applied} visible=${state.net.store.visibleCount('lobby')} by=${p.name}`)
      }
    },
    onSyncApplied: (peerId, p, info) => {
      if (state.args.bot && info.wireConv === 'lobby') {
        const vis = state.net.store.visible('lobby')
        window.oray.botLog(`[BOT] SYNC conv=lobby changed=${info.changed} n=${vis.length} last=${JSON.stringify(vis.at(-1)?.text || '')}`)
      }
    },
  }
}

// ---------- bot 自动化 ----------

const bot = { sendTo: null, count: 3, sent: 0, echoes: 0, lobbySent: false }

function botInit(args) {
  if (!args.bot) return
  bot.sendTo = args['send-to'] || null
  bot.count = Number(args.count || 3)
  bot.textPrefix = args.text || 'hello'
  window.oray.botLog(`[BOT] START profile-mode bot name=${args.name} room=${args.room} sendTo=${bot.sendTo} autoReply=${!!args['auto-reply']} lobbyText=${args['lobby-text'] || ''} delLobby=${args['del-lobby'] || ''}`)
  // 大厅独立发送（--lobby-alone：不等对端上线，仅落自己的共享日志，等待同步扩散）
  if (args['lobby-text'] && args['lobby-alone']) {
    setTimeout(botSendLobby, Number(args['lobby-delay-ms'] || 1200))
  }
}

async function botSendLobby() {
  if (bot.lobbySent) return
  bot.lobbySent = true
  try {
    const { mid, count } = await state.net.sendMessage('all', state.args['lobby-text'], 'lobby')
    window.oray.botLog(`[BOT] LOBBY-SENT text=${JSON.stringify(state.args['lobby-text'])} mid=${mid} peers=${count}`)
  } catch (e) { window.oray.botLog(`[BOT] LOBBY-SEND-ERR ${e?.message || e}`) }
}

async function botOnReady(peerId, p) {
  if (!state.args.bot) return
  // 私聊回声测试（既有 e2e）
  if (bot.sendTo && p.name === bot.sendTo && bot.sent === 0) {
    for (let i = 1; i <= bot.count; i++) {
      const text = `${bot.textPrefix}-${i}`
      await state.net.send(peerId, text)
      bot.sent++
      window.oray.botLog(`[BOT] SENT n=${bot.sent} text=${JSON.stringify(text)}`)
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  // 大厅发送（--lobby-text：等首个对端就绪后发；--lobby-alone 已在登录后定时发送）
  if (state.args['lobby-text'] && !state.args['lobby-alone']) {
    setTimeout(botSendLobby, Number(state.args['lobby-delay-ms'] || 1200))
  }
  // 大厅删除（--del-lobby=<文本子串>）
  if (state.args['del-lobby'] && !bot.delInit) {
    bot.delInit = true
    setTimeout(async () => {
      const entry = state.net.store.findByText('lobby', state.args['del-lobby'])
      if (!entry) { window.oray.botLog(`[BOT] LOBBY-DEL-NOTFOUND substr=${JSON.stringify(state.args['del-lobby'])}`); return }
      await state.net.deleteMessage('lobby', entry.mid)
      window.oray.botLog(`[BOT] LOBBY-DEL-INIT mid=${entry.mid}`)
    }, 3000)
  }
}

async function botOnMessage(peerId, p, msg) {
  if (!state.args.bot) return
  if (state.args['auto-reply'] && msg.conv === 'dm') {
    setTimeout(() => state.net.send(peerId, `echo: ${msg.text}`)
      .catch((e) => window.oray.botLog(`[BOT] REPLY-ERR ${e?.message || e}`)), 80)
  }
  if (bot.sendTo && msg.conv === 'dm' && msg.text.startsWith(`echo: ${bot.textPrefix}-`)) {
    bot.echoes++
    window.oray.botLog(`[BOT] ECHO ${bot.echoes}/${bot.count}`)
    if (bot.echoes >= bot.count) {
      window.oray.botLog(`[TEST-OK] echoes=${bot.echoes} path=${p.path} peer=${p.name} safety=${p.safety}`)
      if (!state.args['no-exit']) window.oray.botExit(0)
    }
  }
}

// ---------- 事件绑定 ----------

function bindUi() {
  $('loginBtn').onclick = async () => {
    const name = $('nameInput').value.trim()
    if (!name) { $('loginErr').textContent = '请输入昵称'; $('loginErr').classList.remove('hidden'); return }
    const room = ($('roomInput').value.trim() || state.cfg.defaultRoom || DEFAULT_CONFIG.defaultRoom)
    try { await doLogin(name, room) } catch (e) {
      $('loginErr').textContent = `登录失败：${e.message}`
      $('loginErr').classList.remove('hidden')
    }
  }
  // 输入昵称时按本机登录历史自动回填房间
  $('nameInput').addEventListener('input', () => autofillByLogin($('nameInput').value.trim()))
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click() })
  $('roomInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click() })

  $('sendBtn').onclick = sendCurrent
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent() }
  })
  $('input').addEventListener('input', () => {
    const el = $('input')
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 130)}px`
  })
  $('logoutBtn').onclick = () => { state.net?.destroy(); window.oray.quit() }

  // 移动端抽屉：☰ 开、遮罩/Esc 关
  const closeDrawer = () => document.body.classList.remove('sidebar-open')
  $('menuBtn').onclick = () => document.body.classList.toggle('sidebar-open')
  $('backdrop').onclick = closeDrawer
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer() })
  window.addEventListener('resize', () => { if (window.innerWidth > 760) closeDrawer() })
}

async function sendCurrent() {
  const text = $('input').value.trim()
  if (!text || !state.net) return
  $('input').value = ''
  $('input').style.height = 'auto'
  try {
    await state.net.sendMessage(state.view.conv === 'lobby' ? 'all' : state.view.peerId, text, viewWireConv())
  } catch (e) {
    appendSys(`发送失败：${e.message}`)
  }
}

// ---------- ICE 探测（--ice-probe）：验证 STUN/TURN 公共服务在真实 WebRTC 栈下可用 ----------

async function iceProbe() {
  const { buildRtcConfig: brc } = await import('./net.mjs')
  const cfg = { ...DEFAULT_CONFIG, ...(await window.oray.getConfig()) }
  const pc = new RTCPeerConnection(brc(cfg))
  pc.createDataChannel('probe')
  const found = []
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      const typ = (e.candidate.candidate.match(/\btyp (\w+)/) || [])[1]
      found.push({ typ, addr: e.candidate.address, port: e.candidate.port, urls: e.candidate.url || '' })
      window.oray.botLog(`[ICE] ${typ} ${e.candidate.address}:${e.candidate.port} via ${e.candidate.url || ''}`)
    }
  }
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  pc.onicecandidateerror = (e) => {
    window.oray.botLog(`[ICE-ERR] code=${e.errorCode || e.errorText} url=${e.url} host=${e.host || ''} port=${e.port || ''} text=${e.errorText || ''}`)
  }
  await new Promise((r) => setTimeout(r, 12000))
  const counts = {}
  for (const f of found) counts[f.typ] = (counts[f.typ] || 0) + 1
  const relays = found.filter((f) => f.typ === 'relay')
  window.oray.botLog(`[ICE-RESULT] total=${found.length} counts=${JSON.stringify(counts)} relayAddrs=${JSON.stringify(relays.map((r) => `${r.addr}:${r.port} via ${r.urls}`))}`)
  window.oray.botExit(relays.length > 0 ? 0 : 2)
}

// ---------- 启动 ----------

async function main() {
  state.cfg = { ...DEFAULT_CONFIG, ...(await window.oray.getConfig()) }
  state.args = await window.oray.getLaunchArgs()
  bindUi()
  botInit(state.args)

  if (state.args['ice-probe']) {
    await iceProbe()
    return
  }

  if (state.args.bot) {
    // 自动化模式：直接登录
    await doLogin(String(state.args.name || 'bot'), String(state.args.room || state.cfg.defaultRoom))
    if (state.args['open-sidebar']) document.body.classList.add('sidebar-open')
    if (state.args['exit-after-ms']) {
      setTimeout(() => window.oray.botExit(0), Number(state.args['exit-after-ms']))
    }
    if (state.args['close-after-ms']) {
      setTimeout(() => window.oray.closeWindow(), Number(state.args['close-after-ms']))
    }
  } else {
    // 人类模式：显示登录界面，预填房间，聚焦昵称，显示版本与本机保存的登录
    $('loginView').classList.remove('hidden')
    if (window.innerWidth <= 760) $('input').placeholder = '输入消息…'
    $('roomInput').placeholder = state.cfg.defaultRoom
    $('nameInput').focus()
    renderSavedAccounts()
    try {
      const info = await (window.oray.appInfo ? window.oray.appInfo() : Promise.resolve({ version: '1.0.0' }))
      $('verLine').textContent = `v${info.version}`
    } catch { $('verLine').textContent = '' }
  }
}

setInterval(() => {
  if (state.net && !$('mainView').classList.contains('hidden')) renderPeers()
}, 5000)

main().catch((e) => {
  console.error('启动失败', e)
  if (state.args?.bot) window.oray.botExit(1)
})
