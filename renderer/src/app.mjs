// OrayChat 渲染层入口：UI 编排 + bot 自动化模式（供 e2e 测试）
// 会话视图：大厅（房间内所有人可见的群聊）+ 私聊；共享日志由 net.store 驱动 ——
//   全体保存、任何成员可发起删除（单条/清空）并传播到所有人、上线全局同步、保留 30 天。
import { ChatNet, DEFAULT_CONFIG, buildRtcConfig, selfId } from './net.mjs'
import * as oc from './crypto.mjs'
import { dmConvKey } from './store.mjs'
import { FileX, fmtSize } from './filex.mjs'

// P1-3 unordered 通道：已回退（v1.21.1）。Trystero 把 >16KB 的载荷切成 wire 分片
// 并按「到达序」重组（无片序号排序）——ordered:false 下乱序到达即拼接错乱，
// 大图片/语音（32KB 块 × 2-3 分片）在丢帧抖动下会被 AEAD 拒收、退化为反复重传
// （用户实测"图片碎片"）。HOL 阻塞已由 32KB 块 + pacing + 速率预算缓解；
// 恢复 unordered 需上游支持分片排序（file-transfer-research.md P1-3 已标注）。

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
  ignoredIds: new Set(), // 已删除的联系人（本机不再出现在历史名录；对方上线互联即自动恢复）
  logData: null, // 登录时从主进程文件 KV 读入的共享日志
  unread: new Map(), // 会话键(viewKey) -> 未读数
  filex: null, // 文件/图片传输（dm 会话）
  pendingFiles: [], // 待发送附件 [{file:File, kind, orig}]
  imgUrls: new Map(), // fid -> blob URL（本机已有字节的消息图片显示缓存）
  fxRenderTimer: null, // 传输进度 → 消息区重渲染节流（leading+trailing，窗口尾必补一次）
}

// ---------- 文件/图片：格式压缩与缩略图 ----------
// 默认（非原图）：WebP 重编码 q0.85、长边 ≤2048 —— "格式的压缩传输"；
// 压完反而更大（本已高度压缩）或编码失败（HEIC 等）→ 回退原样只走协议级压缩。
// GIF 含动画，重编码会丢帧 → 一律原样。thumb：96px WebP（日志条目随同步传播）。
async function compressImageForSend(file) {
  const src = new Blob([file.bytes], { type: file.mime || 'image/png' })
  if (/gif$/i.test(file.mime || '')) return null
  const bmp = await createImageBitmap(src)
  try {
    const maxEdge = 2048
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h)
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.85))
    if (!blob || blob.size >= file.bytes.length) {
      return { bytes: file.bytes, w: bmp.width, h: bmp.height, mime: file.mime, mode: 'raw' }
    }
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h, mime: 'image/webp', mode: 'img' }
  } finally { bmp.close?.() }
}

async function makeThumb(bytes, mime) {
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime || 'image/png' }))
    try {
      const scale = Math.min(1, 96 / Math.max(bmp.width, bmp.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bmp.width * scale))
      canvas.height = Math.max(1, Math.round(bmp.height * scale))
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height)
      const url = canvas.toDataURL('image/webp', 0.6)
      return url.length < 6144 ? url : '' // 缩略图超过 6KB 放弃（日志体积优先）
    } finally { bmp.close?.() }
  } catch { return '' }
}

// ---------- 语音消息：录音状态机（点击开始/停止发送；❌取消） ----------
// 格式探测：Chromium 系 webm/opus，iOS WKWebView 仅 mp4/AAC（voice-video-research §2.3）
// ——「录什么存什么」，mime 随消息走，播放端原生解码
function pickVoiceMime() {
  // audio/mp4(AAC) 优先：桌面 Chromium/Android WebView/iOS WKWebView 三端
  // MediaRecorder 都支持且都能解码（webm/opus 在 iOS 无法解码——用户实测
  // "no supported source"）；webm/opus 仅作 mp4 不可用时的兜底
  for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) {
    try { if (MediaRecorder.isTypeSupported?.(m)) return m } catch { /* ignore */ }
  }
  return ''
}

async function startRecording() {
  if (state.recording) return
  if (state.view.conv !== 'dm') { appendSys('语音仅支持私聊发送'); return }
  const peer = state.net?.peers.get(state.view.peerId)
  if (peer?.state !== 'ready') { appendSys('对端尚未建立加密会话，无法发送语音'); return }
  if (!navigator.mediaDevices?.getUserMedia) { appendSys('当前环境不支持录音'); return }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch (e) {
    appendSys('无法访问麦克风：请在系统/应用设置中允许录音权限')
    return
  }
  const mime = pickVoiceMime()
  let recorder
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined)
  } catch (e) {
    for (const t of stream.getTracks()) t.stop()
    appendSys('录音初始化失败：' + (e.message || e))
    return
  }
  const rec = {
    stream, recorder, mime: recorder.mimeType || mime || 'audio/webm',
    chunks: [], startTs: Date.now(), waveform: [], meterTimer: null, ac: null, analyser: null,
  }
  state.recording = rec
  recorder.ondataavailable = (e) => { if (e.data?.size) rec.chunks.push(e.data) }
  // 波形：AnalyserNode 每 100ms 采一次 RMS，映射 0-9（48 点封顶）
  try {
    const ac = new AudioContext()
    const src = ac.createMediaStreamSource(stream)
    const analyser = ac.createAnalyser()
    analyser.fftSize = 512
    src.connect(analyser)
    rec.ac = ac; rec.analyser = analyser
    const buf = new Uint8Array(analyser.fftSize)
    rec.meterTimer = setInterval(() => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d }
      const rms = Math.sqrt(sum / buf.length)
      rec.waveform.push(Math.max(1, Math.min(9, Math.round(rms * 14))))
      if (rec.waveform.length >= 96) rec.waveform.shift() // 长录音只留最后 96 个采样窗
      renderRecordingBar()
    }, 100)
  } catch { /* AudioContext 不可用：无波形也能发 */ }
  recorder.start(250) // 250ms 分片：停止时最多丢最后半秒的尾部
  renderRecordingBar()
}

function stopRecording(send) {
  const rec = state.recording
  if (!rec) return
  state.recording = null
  clearInterval(rec.meterTimer)
  try { rec.ac?.close?.() } catch { /* ignore */ }
  const stopped = new Promise((res) => {
    rec.recorder.onstop = res
    try { rec.recorder.stop() } catch { res() }
  })
  for (const t of rec.stream.getTracks()) t.stop()
  const duration = Date.now() - rec.startTs
  stopped.then(async () => {
    renderRecordingBar()
    if (!send) return // 取消：丢弃
    if (duration < 500) { appendSys('录音太短（<0.5s），已丢弃'); return }
    const blob = new Blob(rec.chunks, { type: rec.mime })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const fid = await state.filex.sendFile(state.view.peerId, {
      bytes, name: `voice-${Date.now()}.${rec.mime.includes('mp4') ? 'm4a' : 'webm'}`,
      size: bytes.length, mime: rec.mime.split(';')[0], lastModified: Date.now(),
    }, { kind: 'voice', extra: { duration, waveform: compressWaveform(rec.waveform) } })
    void fid
  }).catch((e) => appendSys(`语音发送失败：${e.message || e}`))
}

// 波形压缩：固定 48 桶（采样窗平均池化），值域 0-9 → 48 字符串
function compressWaveform(samples) {
  const out = []
  const N = 48
  for (let i = 0; i < N; i++) {
    const s = samples.length ? Math.round((i * samples.length) / N) : 0
    const e = Math.max(s + 1, Math.round(((i + 1) * samples.length) / N))
    let peak = 0
    for (let j = s; j < Math.min(e, samples.length); j++) peak = Math.max(peak, samples[j])
    out.push(String(peak % 10))
  }
  return out.join('')
}

function renderRecordingBar() {
  const strip = $('recStrip')
  if (!strip) return
  const rec = state.recording
  if (!rec) { strip.classList.add('hidden'); strip.innerHTML = ''; return }
  strip.classList.remove('hidden')
  const secs = Math.floor((Date.now() - rec.startTs) / 1000)
  const bars = rec.waveform.slice(-32).map((v) => `<i style="height:${2 + v * 2}px"></i>`).join('')
  strip.innerHTML = `<span class="rec-dot"></span><span class="mono">${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}</span>
    <span class="rec-bars">${bars}</span>
    <a class="del" id="recCancel">取消</a><span class="attach-hint">点击 🎤 结束并发送</span>`
  const c = $('recCancel')
  if (c) c.onclick = () => stopRecording(false)
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
  if (!idPubHex || !name || state.names.get(idPubHex) === name) return false
  state.names.set(idPubHex, name)
  window.oray.kvSet(`oc-names:${state.room}`, Object.fromEntries(state.names)).catch(() => {})
  return true
}
function authorName(idPubHex) {
  if (idPubHex === state.myIdPubHex) return state.name
  return state.names.get(idPubHex) || `${idPubHex.slice(0, 8)}…`
}

// 当前私聊对端的显示名（lobby 视图返回 null）
function currentPeerName() {
  if (state.view.conv !== 'dm') return null
  return state.net?.peers.get(state.view.peerId)?.name || null
}

// ---------- 口令记忆（可选，默认关闭；明文存本机文件，仅建议磁盘加密设备使用） ----------

// ---------- 登录历史（按昵称记住房间+口令，可删除） ----------

const LOGIN_KEY = 'oc-login-history'
async function getLoginHistory() {
  // 自愈：历史数据可能是损坏的（字符串/数组/含非法条目），统一规整为
  // { 昵称: { room: string } } 形状；无法规整则重置为空
  const raw = await window.oray.kvGet(LOGIN_KEY)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [name, e] of Object.entries(raw)) {
    if (!name.trim() || !e || typeof e !== 'object' || typeof e.room !== 'string' || !e.room.trim()) continue
    out[name.trim()] = { room: e.room.trim() }
  }
  return out
}
// remember=false 时保留旧口令不清除（勾选状态由界面控制保存与否）
async function upsertLogin(name, room) {
  const h = await getLoginHistory()
  h[name] = { room }
  await window.oray.kvSet(LOGIN_KEY, h) // getLoginHistory 已规整，写回即清洗旧垃圾
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
  if (v.conv === 'dm-offline') return state.net ? state.net.dmViewKey(v.idPubHex) : dmConvKey(state.myIdPubHex, v.idPubHex)
  const peer = state.net?.peers.get(v.peerId)
  const peerHex = peer?.idPubHex || v.peerId
  return state.net ? state.net.dmViewKey(peerHex) : dmConvKey(state.myIdPubHex, peerHex)
}
function viewWireConv(v = state.view) { return v.conv === 'lobby' ? 'lobby' : 'dm' }

// ---------- 未读提醒 ----------

function unreadBadge(convKey) {
  const n = state.unread.get(convKey) || 0
  return n > 0 ? ` <span class="unread-badge">${n > 99 ? '99+' : n}</span>` : ''
}

function bumpUnread(convKey, n = 1) {
  state.unread.set(convKey, (state.unread.get(convKey) || 0) + n)
  const total = [...state.unread.values()].reduce((a, b) => a + b, 0)
  window.oray.setUnread?.(total)
  renderPeers()
}

function clearUnread(convKey) {
  if (state.unread.delete(convKey)) {
    const total = [...state.unread.values()].reduce((a, b) => a + b, 0)
    window.oray.setUnread?.(total)
    renderPeers()
  }
}

// 窗口获得焦点：清除当前会话未读（其余会话保留）
window.addEventListener('focus', () => { if (state.net) clearUnread(viewKey()) })

// ---------- 名录（roster）：房间出现过的所有人 ----------
// 来源：oc-names 映射（握手 + 同步帧学习）∪ 共享日志里的作者公钥。
// 在线状态：有就绪会话 = 在线；否则离线（仍可点开查看历史）。

// 身份公钥 → 会话条目的 peerId。ready 优先；**任何状态**（握手失败/协商中）
// 都算"会话中"——否则该身份会同时出现在在线成员（会话条目）与历史联系人
// （无 ready 会话 → 判离线）两个分组里，同名两条造成"残身"观感（用户实测 Ace）
function onlinePeerIdByPub(idPubHex) {
  let any = null
  for (const [peerId, p] of state.net?.peers || []) {
    if (p.idPubHex !== idPubHex) continue
    if (p.state === 'ready') return peerId
    if (!any) any = peerId
  }
  return any
}

function buildRoster() {
  const seen = new Map() // idPubHex -> {name}
  // a) 名字映射（含自己）；已删除的联系人（ignoredIds）不再出现在历史名录
  for (const [id, n] of state.names) {
    if (id === state.myIdPubHex || state.ignoredIds.has(id)) continue
    seen.set(id, { name: n })
  }
  // b) 大厅 + 所有 DM 日志里出现过的作者
  for (const c of state.net?.store?.convs?.values() || []) {
    for (const e of c.entries.values()) {
      if (e.author && e.author !== state.myIdPubHex && !state.ignoredIds.has(e.author) && !seen.has(e.author)) {
        seen.set(e.author, { name: authorName(e.author) })
      }
    }
  }
  // 已归并的旧身份（重装换密钥 → 别名指向当前身份）不再单列：
  // 其记录已合并显示在当前身份的会话里；当前另有就绪会话的除外（同名活设备）
  // ⚠️ 必须遍历键本身：写成 for (const [id] of [...keys]) 是对字符串解构，
  // id 只会拿到首字符，resolveId(首字符)===首字符 恒不删除——别名建立后名录
  // 却从不掉旧条目（v1.15.0 起潜伏，用户"历史联系人残身总在"的根因）
  for (const id of [...seen.keys()]) {
    if (state.net && state.net.resolveId(id) !== id && !state.net.hasReadySession(id)) seen.delete(id)
  }
  // 附加在线状态与显示名兜底
  for (const [id, info] of seen) {
    const pid = onlinePeerIdByPub(id)
    info.online = !!pid
    info.peerId = pid || null
    if (!info.name) info.name = `${id.slice(0, 8)}…`
  }
  // 视图正在查看一个不在名录的在线成员（无历史无名字的极端情况）也纳入
  if (state.view.conv === 'dm') {
    const p = state.net?.peers.get(state.view.peerId)
    if (p?.state === 'ready' && p.idPubHex && !seen.has(p.idPubHex)) {
      seen.set(p.idPubHex, { name: p.name || `${p.idPubHex.slice(0, 8)}…`, online: true, peerId: state.view.peerId })
    }
  }
  return [...seen.entries()]
    .map(([id, info]) => ({ id, ...info }))
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name))
}

// 同名历史身份组（仅展示层合并）：手机重装换钥后，names 表里同一昵称会积累
// 多个旧身份（用户截图 xfold6×2 / 3070 新旧并存）——离线区合成一行、时间线
// 读时合并，消除"残身"观感。不动别名表与握手信任：别名/同名接管在握手就绪
// 时照常生效，届时旧身份自然退出本组；有会话条目的同名身份（两台活设备）不并入
function nameGroupIds(pub) {
  const name = state.names.get(pub)
  if (!name) return [pub]
  const ids = []
  for (const [id, n] of state.names) {
    if (n !== name || id === state.myIdPubHex || state.ignoredIds.has(id)) continue
    if (onlinePeerIdByPub(id)) continue
    ids.push(id)
  }
  return ids.length ? ids : [pub]
}

// 组内全部身份的合并读桶（别名桶 ∪ 同名组各身份的桶，去重）
function groupBucketKeys(pub) {
  const keys = new Set()
  for (const id of nameGroupIds(pub)) {
    for (const k of state.net.dmMergedBucketKeys(id)) keys.add(k)
  }
  return [...keys]
}

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
      <div class="p-name">大厅 · ${esc(state.room)}${unreadBadge('lobby')}</div>
      <div class="p-state"><span class="dot ${readyCount ? 'ok' : 'off'}"></span>${readyCount} 人加密在线 · 全员可见</div>
    </div>`
  lobby.onclick = () => selectView({ conv: 'lobby' })
  list.appendChild(lobby)

  for (const [peerId, p] of peers) {
    // 单行渲染失败只跳过该行——否则循环中断后 peerCount（循环之后才赋值）保持
    // 旧值而列表只剩前几行，出现"计数 5 实际 3 行"的自相矛盾界面
    const li = document.createElement('li')
    try {
    li.className = 'peer-item' + (state.view.conv === 'dm' && state.view.peerId === peerId ? ' active' : '')
    const name = p.name || `${peerId.slice(0, 8)}…`
    let stateText = {
      connecting: '建立 P2P 连接…',
      handshaking: (p.hsCycles || 0) >= 2 ? `协商端到端加密…（第 ${(p.hsCycles || 0) + 1} 次尝试）` : '协商端到端加密…',
      ready: p.via === 'mqtt' ? (state.hubMemberFps?.has((p.idPubHex || '').slice(0, 8)) ? '已加密 · 中继转发（已接入我的中继）' : '已加密 · 中继转发')
        : p.path === 'relay' ? '已加密 · TURN中继' : '已加密 · P2P直连',
      failed: `握手失败：${p.lastError || '未知'}${(p.hsCycles || 0) >= 2 ? `（已重试 ${p.hsCycles} 轮，持续自动重试）` : ''}`,
    }[p.state] || p.state
    // 非就绪条目附带对端 presence 新鲜度：有信号=对端活着、是握手受阻；
    // 无信号=对端已消失，回收器 30s 内清理——用户可自查"残身"真伪
    if (p.state !== 'ready') {
      const seen = state.net.relay?.peers?.get?.(peerId)?.lastSeen
      if (seen) {
        const ago = Math.max(0, Math.round((Date.now() - seen) / 1000))
        stateText += ago <= 90 ? ` · 对端 ${ago}s 前有在线信号` : ' · 对端无在线信号，即将清理'
      }
    }
    // 握手阶段诊断：长期协商中/反复失败时看出卡在哪个阶段——
    // "停在 →hs1 12s 前"= 反复发 hs1 对端一直无回应（收不到或不处理，多为
    // 对端版本过旧/坏包，更新对端即愈）；"停在 ←hs2(校验失败)"= 有回应但不兼容
    if (p.state === 'handshaking' || p.state === 'failed') {
      const evt = p.hsLastEvt
      if (evt) {
        const ago = Math.max(0, Math.round((Date.now() - evt.at) / 1000))
        stateText += ` · 停在 ${ago <= 3 ? evt.t : `${evt.t} ${ago}s 前`}`
      }
    }
    if (p.state === 'ready' && p.suspect) stateText += ' · 疑似离线，确认中…'
    if (p.state === 'ready' && p.hubPub) stateText += ` · 📡 私有中继${p.hubInfo?.mode === 'named' ? '（稳定）' : p.hubInfo?.mode === 'quick' ? '（临时）' : ''}`
    if (p.state === 'ready' && p.lastSeen) {
      const ago = Math.max(0, Math.round((Date.now() - p.lastSeen) / 1000))
      stateText += ago <= 20 ? ` · ${ago}s 前在线报告` : ` · ⚠ ${ago}s 未报告`
    }
    const dotCls = p.state === 'ready' ? (p.via === 'mqtt' || p.path === 'relay' ? 'warn' : 'ok')
      : p.state === 'failed' ? 'err' : 'off'
    li.innerHTML = `
      <div class="avatar" style="background:${avatarColor(peerId)}">${esc(name.slice(0, 1).toUpperCase())}</div>
      <div class="p-info">
        <div class="p-name">${esc(name)}${p.hubPub ? `<span class="hub-badge" title="私有中继服务主机（${p.hubInfo?.mode === 'named' ? '稳定地址' : '临时地址'}）">📡</span>` : ''}${unreadBadge(state.net.dmViewKey(p.idPubHex || peerId))}</div>
        <div class="p-state"><span class="dot ${dotCls}"></span>${esc(stateText)}</div>
      </div>`
    li.onclick = () => selectView({ conv: 'dm', peerId })
    } catch (e) {
      // 占位行：行数与计数保持一致，且异常可见而非无声黑洞
      li.className = 'peer-item'
      li.innerHTML = `<div class="p-info"><div class="p-name">${esc(p.name || peerId.slice(0, 8))}</div><div class="p-state">渲染异常：${esc(String(e?.message || e))}</div></div>`
    }
    list.appendChild(li)
  }

  // 历史联系人（房间出现过的所有人，离线可点开看聊天记录）；同名身份合并一行
  const roster = buildRoster().filter((r) => !r.online)
  const byName = new Map()
  for (const r of roster) {
    if (!byName.has(r.name)) byName.set(r.name, [])
    byName.get(r.name).push(r)
  }
  if (byName.size) {
    const head = document.createElement('li')
    head.className = 'roster-head'
    head.textContent = `历史联系人 ${byName.size}`
    list.appendChild(head)
    for (const [name, g] of byName) {
      // 组代表取最近学到的身份（重装后的新钥最可能在 names 表尾部）
      const primary = g[g.length - 1]
      const li = document.createElement('li')
      li.className = 'peer-item offline'
      li.innerHTML = `
        <div class="avatar" style="background:${avatarColor(primary.id)}; opacity:.55">${esc(name.slice(0, 1).toUpperCase())}</div>
        <div class="p-info">
          <div class="p-name">${esc(name)}${unreadBadge(dmConvKey(state.myIdPubHex, primary.id))}</div>
          <div class="p-state"><span class="dot off"></span>离线 · 点开查看聊天记录${g.length > 1 ? ` · ${g.length} 个历史身份（重装换钥已合并显示）` : ''}</div>
        </div>`
      li.onclick = () => selectView({ conv: 'dm-offline', idPubHex: primary.id, name })
      list.appendChild(li)
    }
  }
  // 计数 = 列出的条目数（含连接中/失败：presence 层面仍在线）；
  // 大厅行的"N 人在线"仍用就绪数（能实际收发消息的人）
  $('peerCount').textContent = String(peers.length)
  renderChatHead()
}

function renderChatHead() {
  const isLobby = state.view.conv === 'lobby'
  if (state.view.conv === 'dm-offline') {
    $('chatTitle').textContent = state.view.name || '历史联系人'
    $('chatSub').textContent = '该成员当前离线 · 以下为本机保存的聊天记录（30 天内）；对方上线互连后可继续聊天'
    $('chatBadges').innerHTML = `<span class="badge">📴 离线</span><span class="badge">保留 30 天</span>` +
      `<button id="delContactBtn" class="ghost danger">删除联系人</button>`
    const dbtn = $('delContactBtn')
    if (dbtn) dbtn.onclick = () => confirmThenDeleteContact(state.view.idPubHex, state.view.name)
    return
  }
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
    if (p?.state === 'ready' && p.via === 'mqtt') badges.push(`<button id="tryDirectBtn" class="ghost warn2">尝试直连</button>`)
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
  const tbtn = $('tryDirectBtn')
  if (tbtn) tbtn.onclick = async () => {
    tbtn.disabled = true
    tbtn.textContent = '尝试中…'
    try {
      const r = await state.net.tryDirect(state.view.peerId)
      appendSys(`尝试直连：${r.ok ? '✅ ' : '❌ '}${r.detail}`)
      renderPeers()
    } catch (e) {
      appendSys(`尝试直连失败：${e.message}`)
    }
    if (tbtn.isConnected) { tbtn.disabled = false; tbtn.textContent = '尝试直连' }
  }
  renderReconnectBar()
}

// 渲染整个消息区（共享日志驱动；mid 幂等，删除/清空/同步都会触发重绘）
// 当前视图的消息列表：大厅读单桶；私聊读时合并「我∪我的旧身份 × 对端∪对端的旧身份」
// 的全部相关分桶（重装换密钥的历史记录归成一条时间线），各桶自带的清空标记独立生效
function viewMessages() {
  const v = state.view
  if (!state.net) return []
  if (v.conv === 'lobby') return state.net.store.visible('lobby')
  const pub = v.conv === 'dm-offline' ? v.idPubHex : state.net.peers.get(v.peerId)?.idPubHex
  if (!pub) return []
  // dm-offline 视图读同名历史身份组的全部桶（重装换钥的旧记录一并显示）；
  // 在线会话维持原别名合并（组函数对会话中的身份自然退化为单身份）
  const keys = v.conv === 'dm-offline' ? groupBucketKeys(pub) : state.net.dmMergedBucketKeys(pub)
  const merged = []
  const seenMids = new Set()
  for (const k of keys) {
    if (!state.net.store.convs.has(k)) continue
    for (const e of state.net.store.visible(k)) {
      if (seenMids.has(e.mid)) continue
      seenMids.add(e.mid)
      merged.push(e)
    }
  }
  merged.sort((a, b) => a.t - b.t || (a.mid < b.mid ? -1 : 1))
  return merged
}

function renderMessages() {
  const msgs = viewMessages()
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
    // 单条渲染失败只跳过该条，绝不清空整个会话（此前一处气泡异常会让
    // box.innerHTML='' 后循环中断——界面全黑且异常被 filex.emit 吞掉，极难排查）
    try {
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
    // 版本偏差自愈：旧版接收端曾把 voice/image 的 offer 降级存成 type:'file'——
    // 渲染时按 mime 矫正（不改持久化数据），升级后历史记录也恢复正常显示
    const fxType = m.type === 'file' && /^audio\//.test(m.mime || '') ? 'voice'
      : m.type === 'file' && /^image\//.test(m.mime || '') ? 'image' : m.type
    if (fxType === 'voice') {
      buildVoiceBubble(bubble, m, mine)
    } else if (fxType === 'image' || fxType === 'file') {
      buildFileBubble(bubble, m, mine)
    } else {
      if (!mine && (state.view.conv === 'lobby' || state.view.conv === 'dm-offline')) {
        const author = document.createElement('span')
        author.className = 'author'
        author.textContent = authorName(m.author)
        bubble.appendChild(author)
      }
      const text = document.createElement('span')
      text.className = 'btext'
      text.textContent = m.text
      bubble.appendChild(text)
    }
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
    } catch (e) { console.warn(`[render] 消息渲染失败已跳过 mid=${m.mid}: ${e?.message || e}`) }
  }
  box.appendChild(frag)
  box.scrollTop = box.scrollHeight
}

// 数据迁移/清洗结果横条（自动消失）
function flushNotices() {
  if (!state.pendingNotice) return
  const msg = state.pendingNotice
  state.pendingNotice = null
  let bar = $('noticeBar')
  if (!bar) {
    bar = document.createElement('div')
    bar.id = 'noticeBar'
    bar.className = 'reconnect-bar'
    $('chatHead').after(bar)
  }
  bar.textContent = `🧹 ${msg}`
  bar.classList.remove('hidden')
  setTimeout(() => bar.classList.add('hidden'), 10000)
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

function updateComposerPlaceholder() {
  const el = $('input')
  if (!el) return
  if (state.view.conv === 'lobby') el.placeholder = '📢 群发给房间内所有人（大厅）…'
  else if (state.view.conv === 'dm-offline') el.placeholder = '📴 对方离线，仅可查看历史记录…'
  else el.placeholder = `🔒 私密发给 ${currentPeerName() || '对方'}（仅对方可见）…`
}

// ---------- 文件/图片气泡 ----------

function buildFileBubble(bubble, m, mine) {
  const st = state.filex?.status(m.fid)
  let act = null // 文件卡片的下载/打开按钮（图片气泡没有；进度块里按需禁用）
  if (m.type === 'image') {
    const cached = state.imgUrls.get(m.fid)
    // 无本机字节且无缩略图：渲染占位（裸 <img> 无 src 会呈现"损坏文件"观感）
    if (!cached && !m.thumb) {
      const ph = document.createElement('div')
      ph.className = 'fx-img-ph'
      const active = st?.state === 'active'
      ph.textContent = active
        ? `🖼️ ${m.name || '图片'}（${fmtSize(m.size || 0)}）· ${m.author === state.myIdPubHex ? '发送' : '接收'}中 ${Math.round(((st?.done || 0) / Math.max(1, st?.total || 1)) * 100)}%`
        : `🖼️ ${m.name || '图片'}（${fmtSize(m.size || 0)}）· 未完成接收，重新发送可续传`
      bubble.appendChild(ph)
      // P3-1：对方离线时代发的历史图片，可从当前在线成员多源获取
      if (!active && !mine && state.filex && !state.filex.tx.has(m.fid)) {
        const get = document.createElement('a')
        get.className = 'fx-action'
        get.textContent = '⤓ 从成员获取'
        get.onclick = async () => {
          try {
            await state.filex.pullFromPeers(m.fid, m)
            renderMessages()
          } catch (e) { appendSys(`获取失败：${e.message}`) }
        }
        bubble.appendChild(get)
      }
    } else {
      const img = document.createElement('img')
      img.className = 'fx-img'
      img.alt = m.name || '图片'
      if (cached) img.src = cached
      else { img.src = m.thumb; img.classList.add('thumb') }
      img.onclick = () => { if (cached) window.oray.fxOpen?.(m.fid) }
      bubble.appendChild(img)
      if (!cached) hydrateFxImage(m, img)
    }
  } else {
    const card = document.createElement('div')
    card.className = 'fx-card'
    const info = document.createElement('div')
    info.className = 'fx-info'
    const nm = document.createElement('div')
    nm.className = 'fx-name'
    nm.textContent = m.name || '文件'
    const sub = document.createElement('div')
    sub.className = 'fx-sub mono'
    sub.textContent = `${fmtSize(m.size || 0)}${m.mode === 'img' ? ' · 已压缩' : m.orig ? ' · 原图' : ''}`
    info.append(nm, sub)
    act = document.createElement('a')
    act.className = 'fx-action'
    if (mine) { act.textContent = '打开'; act.onclick = () => window.oray.fxOpen?.(m.fid) }
    else {
      act.textContent = '下载'
      act.onclick = async () => {
        let r = await window.oray.fxSave(m.fid, m.name)
        if (!r?.ok && r?.why === 'not-found' && state.filex) {
          // P3-1 多源获取：本机没有字节，向在线成员拉取后自动重试保存
          appendSys(`本机没有 ${m.name} 的字节，正在向在线成员获取…`)
          try {
            await state.filex.pullFromPeers(m.fid, m)
            r = await window.oray.fxSave(m.fid, m.name)
          } catch (e) { appendSys(`获取失败：${e.message}`); return }
        }
        if (!r?.ok) appendSys(`保存失败：${r?.why || '未知'}`)
        else appendSys(`已保存到 ${r.path}`)
      }
    }
    card.append('📄', info, act)
    bubble.appendChild(card)
  }
  // 传输进度 / 异常态
  if (st) {
    if (st.state === 'active') {
      const pct = Math.round((st.done / Math.max(1, st.total)) * 100)
      const bar = document.createElement('div')
      bar.className = 'fx-progress'
      // 轨道 .fx-bar 必须包裹填充 .fx-fill：直接把 fill 放进 flex 行时
      // height:100% 对自动高度行算出 0px，进度条隐形（只剩小字，v1.21.8 实测）
      const track = document.createElement('div')
      track.className = 'fx-bar'
      const fill = document.createElement('div')
      fill.className = 'fx-fill'
      fill.style.width = `${pct}%`
      track.appendChild(fill)
      const label = document.createElement('span')
      label.className = 'fx-sub mono'
      label.textContent = `${st.dir === 'send' ? '发送' : '接收'} ${pct}%${st.speed ? ` · ${fmtSize(st.speed)}/s` : ''} · 断点续传`
      const cancel = document.createElement('a')
      cancel.className = 'del'
      cancel.textContent = '取消'
      cancel.onclick = () => state.filex.cancel(m.fid)
      bar.append(track, label, cancel)
      bubble.appendChild(bar)
      // 接收中"下载"不可用：禁用显示，避免点了落空（本机字节尚未完整）。
      // act 仅文件卡片分支赋值（图片气泡无此按钮）
      if (act && st.dir !== 'send') {
        act.textContent = '接收中…'
        act.classList.add('disabled')
      }
    } else if (st.state === 'stalled') {
      const note = document.createElement('div')
      note.className = 'fx-sub'
      note.textContent = '⏸ 传输已暂停（对端暂不可达）· 对方上线后自动续传'
      bubble.appendChild(note)
    } else if (st.state === 'cancel') {
      const note = document.createElement('div')
      note.className = 'fx-sub'
      note.textContent = '传输已取消（重新发送同一文件将自动续传）'
      bubble.appendChild(note)
    } else if (st.state === 'error') {
      const note = document.createElement('div')
      note.className = 'fx-sub'
      note.textContent = '传输校验失败'
      bubble.appendChild(note)
    }
  }
  // 说明文字（caption 与文件名不同才显示，避免重复）
  if (m.text && m.text !== m.name) {
    const cap = document.createElement('span')
    cap.className = 'btext'
    cap.textContent = m.text
    bubble.appendChild(cap)
  }
}

// 图片字节异步加载（本机有完成的文件才显示原图，否则停留在缩略图/占位）
async function hydrateFxImage(m, img) {
  try {
    const bytes = await window.oray.fxRead(m.fid)
    if (state.args?.bot) window.oray.botLog(`[BOT] HYDRATE fid=${m.fid} bytes=${bytes ? bytes.length : 'null'} mime=${m.mime}`)
    if (!bytes) {
      if (!img.isConnected) return
      if (!m.thumb) {
        const ph = document.createElement('div')
        ph.className = 'fx-img-ph'
        ph.textContent = `🖼️ ${m.name || '图片'}（${fmtSize(m.size || 0)}）· 文件已不在本机`
        img.replaceWith(ph)
      }
      return
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: m.mime || 'image/png' }))
    state.imgUrls.set(m.fid, url)
    if (img.isConnected) { img.src = url; img.classList.remove('thumb') }
  } catch { /* WebView 环境：停留缩略图 */ }
}

// ---------- 语音气泡播放器 ----------
// 互斥：全局同时只放一条；进度以波形填充呈现；倍速 1x→1.5x→2x
function buildVoiceBubble(bubble, m, mine) {
  const bubbleWrap = document.createElement('div')
  bubbleWrap.className = 'fx-voice'
  const play = document.createElement('button')
  play.className = 'fx-voice-play'
  play.textContent = '▶'
  const wave = document.createElement('span')
  wave.className = 'fx-voice-wave'
  const wf = String(m.waveform || '')
  const bars = []
  for (let i = 0; i < 24; i++) {
    const v = Number(wf[i] || 5) || 1
    bars.push(`<i style="height:${3 + v * 2.2}px"></i>`)
  }
  wave.innerHTML = bars.join('')
  const dur = document.createElement('span')
  dur.className = 'fx-voice-dur mono'
  dur.textContent = fmtVoiceDur(m.duration)
  const speed = document.createElement('button')
  speed.className = 'fx-voice-speed mono'
  speed.textContent = '1x'
  speed.title = '倍速'
  bubbleWrap.append(play, wave, dur, speed)
  bubble.appendChild(bubbleWrap)

  if (!m.duration && !m.waveform && m.text && m.text !== m.name) {
    const cap = document.createElement('span')
    cap.className = 'btext'
    cap.textContent = m.text
    bubble.appendChild(cap)
  }

  const st = state.filex?.status(m.fid)
  if (st && st.state === 'active') {
    const note = document.createElement('div')
    note.className = 'fx-sub'
    note.textContent = `${mine ? '发送' : '接收'}中 ${Math.round((st.done / Math.max(1, st.total)) * 100)}%`
    bubble.appendChild(note)
  }

  const audio = new Audio()
  let loaded = false
  audio.onloadedmetadata = () => {
    if (!m.duration && audio.duration && isFinite(audio.duration)) {
      dur.textContent = fmtVoiceDur(audio.duration * 1000)
    }
  }
  const setIcon = (playing) => { play.textContent = playing ? '⏸' : '▶' }
  play.onclick = async () => {
    // 互斥：停掉别的
    if (state.voiceAudio && state.voiceAudio !== audio) {
      try { state.voiceAudio.pause() } catch { /* ignore */ }
      state.voicePlaying?.setIcon?.(false)
    }
    if (state.voiceAudio === audio && !audio.paused) { audio.pause(); setIcon(false); return }
    if (!loaded) {
      const bytes = await window.oray.fxRead(m.fid)
      if (!bytes) { appendSys('语音字节不在本机：等接收完成后播放，或让对方重发'); return }
      audio.src = URL.createObjectURL(new Blob([bytes], { type: m.mime || 'audio/webm' }))
      loaded = true
    }
    audio.playbackRate = Number(speed.dataset.rate || 1)
    audio.play().then(() => {
      state.voiceAudio = audio
      state.voicePlaying = { setIcon }
      setIcon(true)
    }).catch((e) => appendSys(`播放失败：${e.message || e}`))
  }
  audio.onpause = () => setIcon(false)
  audio.onended = () => { setIcon(false); paint(0) }
  audio.ontimeupdate = () => {
    if (audio.duration > 0) paint(audio.currentTime / audio.duration)
  }
  const paint = (p) => {
    const total = wave.children.length
    const lit = Math.round(p * total)
    for (let i = 0; i < total; i++) wave.children[i].classList.toggle('on', i < lit)
  }
  speed.onclick = () => {
    const next = { 1: 1.5, 1.5: 2, 2: 1 }[Number(speed.dataset.rate || 1)] || 1
    speed.dataset.rate = String(next)
    speed.textContent = `${next}x`
    audio.playbackRate = next
  }
}

function fmtVoiceDur(ms) {
  const s = Math.max(1, Math.round((Number(ms) || 0) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function renderConv() { renderChatHead(); renderReconnectBar(); renderMessages(); updateComposerPlaceholder() }

function selectView(v) {
  if (state.recording) stopRecording(false) // 离开会话：丢弃录音
  state.view = v
  document.body.classList.remove('sidebar-open') // 手机上选中即收起侧栏
  clearUnread(viewKey(v))
  renderConv()
  renderPeers()
  const canSend = v.conv !== 'dm-offline' && (v.conv === 'lobby' || state.net?.peers.get(v.peerId)?.state === 'ready')
  $('input').disabled = !canSend
  $('sendBtn').disabled = !canSend
}

// ---------- 删除操作 ----------

async function deleteMessage(mid) {
  if (state.view.conv === 'dm-offline') { appendSys('对方离线，暂无法同步删除（上线后会看到本机已删）'); return }
  try {
    await state.net.deleteMessage(viewWireConv(), mid, state.view.peerId)
  } catch (e) { appendSys(`删除失败：${e.message}`) }
}

// ---------- 删除联系人（僵尸历史条目清理） ----------
// 本机删除：私聊分桶（含旧身份合并桶）+ 名字映射 + 未读一并清除；该身份进
// ignoredIds 不再出现在历史名录。对方真上线互联或发来私聊即自动恢复显示 ——
// 删除只是"不再保留这个人的痕迹"，不是拉黑；大厅公共记录不受影响（那是全员日志）。
function persistIgnoredIds() {
  window.oray.kvSet(`oc-ignored-ids:${state.room}`, [...state.ignoredIds]).catch(() => {})
}

function reviveIgnored(pub) {
  if (pub && state.ignoredIds.delete(pub)) persistIgnoredIds()
}

function confirmThenDeleteContact(idPubHex, name) {
  const btn = $('delContactBtn')
  if (!btn) return
  if (btn.dataset.confirm) {
    delete btn.dataset.confirm
    btn.textContent = '删除联系人'
    doDeleteContact(idPubHex, name)
    if (state.view.conv === 'dm-offline') selectView({ conv: 'lobby' })
  } else {
    btn.dataset.confirm = '1'
    btn.textContent = '再次点击确认删除（含聊天记录）'
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.confirm; btn.textContent = '删除联系人' } }, 3000)
  }
}

function doDeleteContact(idPubHex, name) {
  const who = name || `${idPubHex.slice(0, 8)}…`
  // 同名历史身份组一并删除（用户删的是"这个人"，不是某一个旧钥）
  const ids = nameGroupIds(idPubHex)
  for (const id of ids) {
    for (const k of state.net.dmMergedBucketKeys(id)) state.net.store.dropConv(k)
    state.names.delete(id)
    state.ignoredIds.add(id)
    clearUnread(dmConvKey(state.myIdPubHex, id))
  }
  window.oray.kvSet(`oc-names:${state.room}`, Object.fromEntries(state.names)).catch(() => {})
  persistIgnoredIds()
  appendSys(`已删除联系人 ${who}${ids.length > 1 ? `（含 ${ids.length} 个历史身份）` : ''}：本机私聊记录一并清除；对方上线互联会重新出现在在线列表`)
  if (state.args.bot) {
    window.oray.botLog(`[BOT] CONTACT-DELETED pub=${idPubHex}`)
    window.oray.botLog(`[BOT] ROSTER ${buildRoster().map((r) => r.id.slice(0, 8)).join(',') || '(empty)'}`)
  }
}

async function confirmThenClear() {
  const btn = $('clearBtn')
  if (btn.dataset.confirm) {
    delete btn.dataset.confirm
    btn.textContent = '清空全体记录'
    if (state.view.conv === 'dm-offline') {
      appendSys('对方离线，本机记录将在下次同步时按删除标记收敛')
      const t = Date.now()
      for (const k of groupBucketKeys(state.view.idPubHex)) await state.net.store.applyClear(k, t)
      renderMessages()
      return
    }
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

// 公共 broker 白名单（模块级：成员条目文案与中继排序共用）
const PUBLIC_BROKERS = [
  'wss://broker-cn.emqx.io:8084/mqtt', 'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt', 'ws://broker-cn.emqx.io:8084/mqtt', 'ws://broker.emqx.io:8084/mqtt',
]
async function doLogin(name, room) {
  // 中继服务模式（v1.23.0）：本机 hub 运行中 → 把 ws://127.0.0.1:port 并入为
  // 私有链（主机自己走本地回环，零外网依赖）；hub 中途启停同样跟随

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
  state.idAliases = await window.oray.kvGet(`oc-id-aliases:${room}`).catch(() => null) || {}
  state.ignoredIds = new Set(await window.oray.kvGet(`oc-ignored-ids:${room}`).catch(() => []) || [])
  state.logData = await window.oray.kvGet(`oc-log2:${room}`)
  // 登录历史：按昵称记住房间
  await upsertLogin(name, room)

  const cfg = state.cfg
  state.net = new ChatNet(state.ident, state.name, state.room, {
    ...cfg,
    rtcConfig: buildRtcConfig(cfg),
  }, netHooks(), {
    forceRelay: !!state.args['relay-only'],
    sessionResume: state.cfg.sessionResume !== false, // 设置页可关（前向保密权衡）
    idAliases: state.idAliases || {}, // 旧身份→当前身份 别名（读时合并；清此 KV 即还原）
    names: Object.fromEntries(state.names), // 历史学到的 昵称 映射（启动即可归并自己的旧身份）
  })

  $('selfName').textContent = name
  $('selfFp').textContent = oc.identityFingerprint(state.ident.edPub)
  $('selfRoom').textContent = room
  $('loginView').classList.add('hidden')
  $('mainView').classList.remove('hidden')

  // 文件/图片传输（dm 会话）：字节不进共享日志，日志只存元数据+缩略图
  state.filex = new FileX({
    net: state.net,
    // io 适配器：electron preload / web-shim 均以 fx* 命名暴露
    io: {
      state: (fid, meta) => window.oray.fxState(fid, meta),
      write: (fid, i, cs, bytes) => window.oray.fxWrite(fid, i, cs, bytes),
      finalize: (fid, sha, name, fin) => window.oray.fxFinalize(fid, sha, name, fin),
      read: (fid) => window.oray.fxRead(fid),
      readChunk: (fid, i, cs, len) => window.oray.fxReadRange(fid, i, cs, len),
      abort: (fid) => window.oray.fxAbort(fid),
    },
    compress: compressImageForSend,
    hooks: {
      onLog: (msg, level) => {
        if (state.args.bot) window.oray.botLog(`[BOT] LOG ${level || 'info'} ${msg}`)
        // 传输异常对人类用户可见（此前只进 bot 日志，出问题时两边都无提示）
        if (level === 'warn' || level === 'error') appendSys(`📤 ${msg}`)
      },
      onOutgoing: (e) => {
        state.net.store.addMsg(state.net.storeKey('dm', e.peerId), {
          mid: e.mid, author: state.myIdPubHex, text: e.text, t: e.t,
          type: e.type, fid: e.fid, name: e.name, size: e.size, mime: e.mime,
          w: e.w, h: e.h, thumb: e.thumb, mode: e.mode,
          duration: e.duration, waveform: e.waveform, rate: e.rate,
        })
        if (state.args.bot && e.type === 'voice') {
          window.oray.botLog(`[BOT] VOICE-OUT fid=${e.fid} size=${e.size} duration=${e.duration} waveform=${JSON.stringify(e.waveform || '')}`)
        }
      },
      onIncoming: (e) => {
        state.net.store.addMsg(state.net.storeKey('dm', e.peerId), {
          mid: e.mid, author: e.author, text: e.text, t: e.t,
          type: e.type, fid: e.fid, name: e.name, size: e.size, mime: e.mime,
          w: e.w, h: e.h, thumb: e.thumb, mode: e.mode,
          duration: e.duration, waveform: e.waveform, rate: e.rate,
        })
        if (state.args.bot && e.type === 'voice') {
          window.oray.botLog(`[BOT] VOICE-IN fid=${e.fid} size=${e.size} duration=${e.duration} waveform=${JSON.stringify(e.waveform || '')}`)
          // 播放验证（解码级）：轮询等落盘，再用 <Audio> 真实解码，canplay 即成功
          ;(async () => {
            let bytes = null
            for (let i = 0; i < 30 && !bytes; i++) { bytes = await window.oray.fxRead(e.fid); if (!bytes) await new Promise((r) => setTimeout(r, 2000)) }
            if (!bytes) { window.oray.botLog(`[BOT] PLAYBACK-ERR fid=${e.fid} no-bytes`); return }
            const audio = new Audio()
            audio.src = URL.createObjectURL(new Blob([bytes], { type: e.mime || 'audio/webm' }))
            audio.oncanplay = () => window.oray.botLog(`[BOT] PLAYBACK-OK fid=${e.fid} dur=${audio.duration ? audio.duration.toFixed(1) : '?'}`)
            audio.onerror = () => window.oray.botLog(`[BOT] PLAYBACK-ERR fid=${e.fid} decode code=${audio.error?.code} msg=${audio.error?.message || ''} bytes=${bytes.length} ctor=${bytes.constructor?.name} mime=${e.mime}`)
            audio.load()
            setTimeout(() => { if (!audio.duration) window.oray.botLog(`[BOT] PLAYBACK-ERR fid=${e.fid} timeout`) }, 10000)
          })()
        }
      },
      onEvent: (e) => {
        if (state.args.bot && e.state !== 'active') {
          window.oray.botLog(`[BOT] FILE-${e.state.toUpperCase()} dir=${e.dir} fid=${e.fid} name=${JSON.stringify(e.name || '')} done=${e.done}/${e.total}`)
        }
        if (state.args.bot && e.dir === 'recv' && e.state === 'active') {
          bot.lastRecvProgress = bot.lastRecvProgress || {}
          if (e.done >= (bot.lastRecvProgress[e.fid] || 0) + 50) {
            bot.lastRecvProgress[e.fid] = e.done
            window.oray.botLog(`[BOT] RPROGRESS fid=${e.fid} done=${e.done}/${e.total}`)
          }
        }
        if (state.args.bot && e.dir === 'send' && e.state === 'active') {
          bot.lastProgress = bot.lastProgress || {}
          if (e.done >= (bot.lastProgress[e.fid] || 0) + 50) {
            bot.lastProgress[e.fid] = e.done
            window.oray.botLog(`[BOT] PROGRESS fid=${e.fid} done=${e.done}/${e.total}`)
          }
        }
        // 进度渲染节流（leading + trailing）。原实现直接丢弃窗口内事件：
        // 小文件（语音/压缩图）整个传输 <300ms，连 done 一起被吞——气泡永远
        // 停在「接收中 0%」、图片不变清晰，直到下一条消息触发重绘（用户实测）
        if (!state.fxRenderTimer) {
          if (!$('mainView').classList.contains('hidden')) renderMessages()
          state.fxRenderTimer = setTimeout(() => {
            state.fxRenderTimer = null
            if (!$('mainView').classList.contains('hidden')) renderMessages()
          }, 300)
        }
      },
    },
  })
  state.net.attachFilex(state.filex)

  if (window.oray.hubStatus) {
    window.oray.hubStatus().then(hubAdopt).catch(() => {})
    window.oray.onHubEvent?.((ev) => { if (['started', 'stopped', 'tunnel'].includes(ev.type)) window.oray.hubStatus().then(hubAdopt).catch(() => {}) })
    // 事件竞态兜底：hub 自启动可能早于本函数的 onHubEvent 注册（started 已错过）
    // ——周期拉取，hubAdopt 全程幂等（addBroker 去重/hubPub 设置无害）
    let hubPolls = 0
    const hubPoll = setInterval(() => {
      hubPolls++
      window.oray.hubStatus().then(hubAdopt).catch(() => {})
      if (hubPolls >= 30) clearInterval(hubPoll) // 5 分钟后停（正常早已稳定）
    }, 10000)
    window.oray.hubSetNames?.({}); // 占位：映射推送在 doLogin 后（state.net 就绪时）
    // 指纹→昵称映射：中继设置页的「已接入成员」按昵称显示（而非公钥指纹）
    const pushHubNames = () => {
      if (!state.net || !window.oray.hubSetNames) return
      const map = { [state.myIdPubHex.slice(0, 8)]: state.name }
      for (const [, p] of state.net.peers) {
        if (p.idPubHex && p.name) map[p.idPubHex.slice(0, 8)] = p.name
      }
      for (const [pub, n] of state.net.peerNames || []) map[pub.slice(0, 8)] = n
      window.oray.hubSetNames(map)
    }
    pushHubNames()
    setInterval(pushHubNames, 30000)
    const renderPillSafe = (st) => { try { renderHubPill(st) } catch (e) { if (state.args?.bot) window.oray.botLog(`PILL-ERR ${e?.stack || e}`) } }
    window.oray.hubStatus().then(renderPillSafe).catch((e) => { if (state.args?.bot) window.oray.botLog(`PILL-IPC-ERR ${e?.message || e}`) })
    window.oray.onHubEvent?.((ev) => { if (['started', 'stopped', 'tunnel', 'clients'].includes(ev.type)) window.oray.hubStatus().then(renderPillSafe).catch(() => {}) })
    const hubPillPoll = setInterval(() => { window.oray.hubStatus().then(renderPillSafe).catch(() => {}) }, 15000)
    window.addEventListener('beforeunload', () => clearInterval(hubPillPoll))
  }

  setTimeout(flushNotices, 600)
  // 默认进入第一个在线成员的私聊（避免误以为输入框是私聊却群发）；无人在线才落大厅
  const firstReady = [...state.net.peers.entries()].find(([, p]) => p.state === 'ready')
  if (firstReady) selectView({ conv: 'dm', peerId: firstReady[0] })
  else selectView({ conv: 'lobby' })
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
    onStoreNotice: (msg) => {
      state.pendingNotice = msg // doLogin 完成后由 flushNotices 显示（net 构造时 DOM 未就绪定位）
      if (state.args.bot) window.oray.botLog(`[BOT] STORE-NOTICE ${JSON.stringify(msg)}`)
    },
    onStorePersist: (all) => {
      window.oray.kvSet(`oc-log2:${state.room}`, all).catch(() => {})
    },
    // 旧身份→当前身份 别名变更（重装换密钥归并）：持久化 + 界面刷新
    onIdAliases: (obj) => {
      state.idAliases = obj
      window.oray.kvSet(`oc-id-aliases:${state.room}`, obj).catch(() => {})
      renderPeers()
      if (state.view.conv !== 'lobby') renderConv()
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
      reviveIgnored(p.idPubHex) // 已删除的联系人上线互联：自动恢复显示
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
      // 未读与通知：不在当前会话或窗口失焦时计数；失焦时弹系统通知（主进程按对端 10s 节流）
      // 会话键走身份解析（dmViewKey）：对端若换了身份密钥，旧会话/新会话的未读都落在同一视图键
      reviveIgnored(p.idPubHex) // 已删除的联系人发来消息：自动恢复显示
      const convKey = msg.conv === 'lobby' ? 'lobby'
        : (p.idPubHex ? state.net.dmViewKey(p.idPubHex) : state.net.storeKey('dm', peerId))
      const isCurrent = convKey === viewKey()
      const focused = document.hasFocus() && !document.hidden
      if (!isCurrent || !focused) {
        bumpUnread(convKey)
        if (!focused) {
          window.oray.notifyMsg?.({
            title: msg.conv === 'lobby' ? `${p.name || '成员'} · 大厅` : (p.name || '新消息'),
            body: String(msg.text || '').slice(0, 60),
            peerKey: convKey,
          })
        }
        if (state.args.bot) window.oray.botLog(`[BOT] UNREAD total=${[...state.unread.values()].reduce((a, b) => a + b, 0)}`)
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
    onGoOnline: (reason) => {
      appendSys(`📶 主动上线：${reason}`)
      if (state.args.bot) window.oray.botLog(`[BOT] GO-ONLINE reason=${JSON.stringify(reason)}`)
      renderPeers()
    },
    onAck: (peerId, k) => {
      if (state.args.bot) window.oray.botLog(`[BOT] ACK from=${state.net?.peers.get(peerId)?.name || peerId.slice(0, 8)} k=${k}`)
    },
    onPresence: (peerId, p) => {
      if (state.args.bot) window.oray.botLog(`[BOT] PRESENCE from=${p.name}`)
      renderPeers()
    },
    onHubAdvertised: (peerId, peer, info) => { void adoptAdvertisedHub(peerId, peer, info) },
    onLinkState: (url, ok) => noteBroker(url, ok),
    onPeerName: (peerId, p, idPubHex, name) => {
      reviveIgnored(idPubHex) // 对端同步传播来的名字：视为主动恢复
      if (saveName(idPubHex, name)) { renderConv(); renderPeers() }
      if (state.args.bot) window.oray.botLog(`[BOT] NAME name=${JSON.stringify(name)} id=${idPubHex.slice(0, 8)}…`)
    },
    onControl: (peerId, p, ctl) => {
      if (state.args.bot && state.args['ctl-log']) window.oray.botLog(`[BOT] CTL from=${p.name} op=${ctl?.op} conv=${ctl?.wireConv || ctl?.conv || '-'}`)
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
  // 私聊回声测试（既有 e2e）。文件/语音传输场景不跑文本回环（纯干扰流量）；
  // 单条失败不终止整轮：会话抖动（换路重建窗口）下 send 可能瞬时抛
  // "对端尚未建立加密会话"，重试即可，绝不能让未捕获异常炸掉整个注入器
  const fileMode = state.args['send-file'] || state.args['send-file2'] || state.args['send-file3'] || state.args['send-voice-after-ms']
  if (bot.sendTo && !fileMode && p.name === bot.sendTo && bot.sent === 0) {
    for (let i = 1; i <= bot.count; i++) {
      const text = `${bot.textPrefix}-${i}`
      let err = null
      for (let a = 0; a < 4; a++) {
        try { await state.net.send(peerId, text); err = null; break } catch (e) { err = e; await new Promise((r) => setTimeout(r, 1500)) }
      }
      if (err) { window.oray.botLog(`[BOT] SEND-ERR n=${i} ${err?.message || err}`); continue }
      bot.sent++
      window.oray.botLog(`[BOT] SENT n=${bot.sent} text=${JSON.stringify(text)}`)
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  // 大厅发送（--lobby-text：等首个对端就绪后发；--lobby-alone 已在登录后定时发送）
  if (state.args['lobby-text'] && !state.args['lobby-alone']) {
    setTimeout(botSendLobby, Number(state.args['lobby-delay-ms'] || 1200))
  }
  // 大厅删除（--del-lobby=<文本子串>）：轮询等消息同步到本店（≤60s）后删除
  if (state.args['del-lobby'] && !bot.delInit) {
    bot.delInit = true
    const t0 = Date.now()
    const t = setInterval(async () => {
      const entry = state.net.store.findByText('lobby', String(state.args['del-lobby']))
      if (!entry) { if (Date.now() - t0 > 60000) { clearInterval(t); window.oray.botLog(`[BOT] LOBBY-DEL-NOTFOUND substr=${JSON.stringify(state.args['del-lobby'])}`) } return }
      clearInterval(t)
      await state.net.deleteMessage('lobby', entry.mid)
      window.oray.botLog(`[BOT] LOBBY-DEL-INIT mid=${entry.mid}`)
    }, 2000)
  }
}

async function botOnMessage(peerId, p, msg) {
  if (!state.args.bot) return
  // 防回声风暴：两个 auto-reply 实例同房间时，echo 的 echo 会无限循环刷爆
  // 有序数据通道（文件块被饿死）——echo 的 echo 不再回显
  if (state.args['auto-reply'] && msg.conv === 'dm' && !String(msg.text).startsWith('echo: ')) {
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

  // ---------- 附件（文件/图片，仅私聊） ----------
  $('attachBtn').onclick = () => {
    if (state.view.conv !== 'dm') { appendSys('文件/图片仅支持私聊发送（1:1 直传）'); return }
    const peer = state.net?.peers.get(state.view.peerId)
    if (peer?.state !== 'ready') { appendSys('对端尚未建立加密会话，无法发送文件'); return }
    $('fileInput').click()
  }
  $('fileInput').addEventListener('change', () => {
    for (const f of $('fileInput').files || []) {
      const isImg = /^image\//.test(f.type)
      state.pendingFiles.push({ file: f, kind: isImg ? 'image' : 'file', orig: false })
    }
    $('fileInput').value = ''
    renderAttachStrip()
  })
  renderAttachStrip() // 初始隐藏

  // ---------- 语音（仅私聊） ----------
  $('micBtn').onclick = () => {
    if (state.recording) { stopRecording(true); return } // 再点 = 结束并发送
    startRecording()
  }
  renderRecordingBar()
  $('input').addEventListener('input', () => {
    const el = $('input')
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 130)}px`
  })
  $('logoutBtn').onclick = () => { state.net?.destroy(); window.oray.quit() }

  // 设置窗口（修改网络/托盘等配置需重启应用生效）；web 版隐藏入口
  const openSettingsIfAvailable = () => {
    if (window.oray.openSettings) window.oray.openSettings()
    else appendSys('当前平台暂无设置界面（Web 版）')
  }
  const sideBtn = $('sideSettingsBtn')
  if (sideBtn) sideBtn.onclick = openSettingsIfAvailable

  // 移动端抽屉：☰ 开、遮罩/Esc 关
  const closeDrawer = () => document.body.classList.remove('sidebar-open')
  $('menuBtn').onclick = () => document.body.classList.toggle('sidebar-open')
  $('backdrop').onclick = closeDrawer
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer() })
  window.addEventListener('resize', () => { if (window.innerWidth > 760) closeDrawer() })
}

async function sendCurrent() {
  const text = $('input').value.trim()
  const hasFiles = state.pendingFiles.length > 0
  if ((!text && !hasFiles) || !state.net) return
  if (hasFiles) await sendPendingFiles()
  if (!text) return
  $('input').value = ''
  $('input').style.height = 'auto'
  try {
    await state.net.sendMessage(state.view.conv === 'lobby' ? 'all' : state.view.peerId, text, viewWireConv())
  } catch (e) {
    appendSys(`发送失败：${e.message}`)
  }
}

// ---------- 附件发送 ----------

// 合成 WAV（bot 测试用）：正弦+幅度的语音样形；波形串与采样峰值一致
function synthVoiceWav(durationMs) {
  const rate = 16000
  const n = Math.floor((durationMs / 1000) * rate)
  const pcm = new Uint8Array(44 + n * 2)
  const dv = new DataView(pcm.buffer)
  const wstr = (off, str) => { for (let i = 0; i < str.length; i++) pcm[off + i] = str.charCodeAt(i) }
  wstr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); wstr(8, 'WAVE')
  wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true); dv.setUint32(24, rate, true)
  dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  wstr(36, 'data'); dv.setUint32(40, n * 2, true)
  const samples = []
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const env = 0.4 + 0.6 * Math.abs(Math.sin(t * 2 * Math.PI * 1.7)) // 语音样包络
    const v = Math.round(Math.sin(t * 2 * Math.PI * 220) * env * 12000)
    dv.setInt16(44 + i * 2, v, true)
    samples.push(v)
  }
  // 160ms 窗取峰值 → 48 桶 0-9
  const win = Math.floor(rate * 0.16)
  const peaks = []
  for (let b = 0; b < 48; b++) {
    const s = Math.round((b * n) / 48), e = Math.max(s + 1, Math.round(((b + 1) * n) / 48))
    let peak = 0
    for (let j = s; j < Math.min(e, n); j++) peak = Math.max(peak, Math.abs(samples[j]))
    peaks.push(Math.min(9, Math.round((peak / 12000) * 9)))
  }
  return { bytes: pcm, waveform: peaks.join('') }
}


function renderAttachStrip() {
  const strip = $('attachStrip')
  if (!state.pendingFiles.length) { strip.classList.add('hidden'); strip.innerHTML = ''; return }
  strip.classList.remove('hidden')
  strip.innerHTML = state.pendingFiles.map((p, idx) => `
    <span class="attach-item">
      ${p.kind === 'image' ? '🖼️' : '📄'} ${esc(p.file.name.slice(0, 24))} <span class="mono">${fmtSize(p.file.size)}</span>
      <label class="orig-toggle" title="默认传输格式压缩版（WebP）；勾选发送原始文件（仍走协议级压缩）">
        <input type="checkbox" data-orig-idx="${idx}" ${p.orig ? 'checked' : ''}/> 原图
      </label>
      <a class="del" data-rm-idx="${idx}">✕</a>
    </span>`).join('') + `<span class="attach-hint">将发送给当前私聊对象</span>`
  for (const el of strip.querySelectorAll('[data-rm-idx]')) {
    el.onclick = () => { state.pendingFiles.splice(Number(el.dataset.rmIdx), 1); renderAttachStrip() }
  }
  for (const el of strip.querySelectorAll('[data-orig-idx]')) {
    el.onchange = () => { state.pendingFiles[Number(el.dataset.origIdx)].orig = el.checked }
  }
}

async function sendPendingFiles() {
  const peerId = state.view.peerId
  const items = state.pendingFiles.splice(0)
  renderAttachStrip()
  for (const item of items) {
    try {
      const f = item.file
      const bytes = new Uint8Array(await f.arrayBuffer())
      const isImg = item.kind === 'image'
      const thumb = isImg ? await makeThumb(bytes, f.type) : ''
      await state.filex.sendFile(peerId, {
        bytes, name: f.name, size: f.size, mime: f.type || 'application/octet-stream',
        lastModified: f.lastModified, thumb,
      }, { kind: item.kind, orig: item.orig })
    } catch (e) {
      appendSys(`发送「${item.file.name}」失败：${e.message}`)
    }
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

  // 中继稳定度统计：url -> {lastOkAt, fails}（relay 链路事件驱动；参与 broker 排序）
const relayStats = new Map()
const noteBroker = (url, ok) => {
  if (!url) return
  const st = relayStats.get(url) || { lastOkAt: 0, fails: 0 }
  if (ok) { st.lastOkAt = Date.now(); st.fails = 0 } else st.fails++
  relayStats.set(url, st)
}
// 排序：固定(named 域名) > 临时(quick) > 公共；同类按稳定度（最近连通新者优先，失败计数低者优先）
const sortRelayBrokers = (urls) => {
  const rank = (u) => {
    if (PUBLIC_BROKERS.includes(u)) return 3
    if (/trycloudflare\.com/.test(u)) return 2
    return 1 // 命名隧道/自定义稳定域名
  }
  const stOf = (u) => relayStats.get(u) || { lastOkAt: 0, fails: 0 }
  return [...urls].sort((a, b) => rank(a) - rank(b)
    || (stOf(b).fails - stOf(a).fails)
    || (stOf(b).lastOkAt - stOf(a).lastOkAt))
}
const persistRelayBrokers = async (urls, credsPatch) => {
  try {
    const info = await window.oray.getConfig()
    const prev = info.userConfig || {}
    const userConfig = { ...prev, relayBrokers: urls }
    if (credsPatch) userConfig.relayCreds = { ...(prev.relayCreds || {}), ...credsPatch } // 私有中继凭据随采纳持久化
    if (window.oray.saveUserConfig) await window.oray.saveUserConfig(userConfig)
    state.cfg = { ...(state.cfg || {}), relayBrokers: urls, ...(credsPatch ? { relayCreds: userConfig.relayCreds } : {}) }
  } catch { /* 持久化失败不阻断（本次会话仍可用） */ }
}
// 采纳对端广播的私有中继：去重（已有/自己广播的）→ 带凭据并链 → 持久化（排序重写）
const adoptAdvertisedHub = async (peerId, peer, info) => {
  const dbg = (m) => { if (state.args?.bot) window.oray.botLog(`ADOPT ${m}`) }
  try {
    dbg(`收到广播 url=${info?.url}`)
    if (!state.net?.relay || !info?.url) return
    if (state.net.hubPub === info.url) { dbg('跳过：自己广播的'); return }
    if (state.net.relay.brokerUrls.includes(info.url)) { state.net.relay.setCredentials(info.url, { username: 'member', password: info.token }); dbg('已存在：更新凭据'); return }
    const creds = info.token ? { username: 'member', password: info.token } : null
    if (state.net.relay.addBroker(info.url, creds)) {
      appendSys(`已接入 ${peer.name || '成员'} 提供的私有中继（${info.mode === 'named' ? '稳定地址' : '临时地址'}）：${info.url}`)
      dbg(`并链成功`)
      const urls = sortRelayBrokers(state.net.relay.brokerUrls)
      await persistRelayBrokers(urls, creds ? { [info.url]: creds } : null)
      dbg(`持久化完成 urls=${urls.length}`)
    } else dbg('addBroker 返回 false')
  } catch (e) {
    if (state.args?.bot) window.oray.botLog(`ADOPT-ERR ${e?.message || e}`)
    try { appendSys(`私有中继采纳失败：${e?.message || e}`) } catch { /* UI 不可用 */ }
  }
}
const hubAdopt = (st) => {
  if (!state.net) return
  // 对外地址随 presence 广播（成员列表 📡 标识）；运行时并入本机回环私有链
  const mode = window.__hubMode === 'named' || st?.mode === 'named' ? 'named' : (st?.mode === 'quick' ? 'quick' : (st?.tunnelUrl?.includes('trycloudflare') ? 'quick' : ''))
  if (state.net) {
    // 回环地址不广播（远程成员无法接入；本机接入走下方 addBroker 回环链）
    const pub = (st?.running && (st.tunnelUrl || st.publicUrl)) || ''
    const exposed = pub && !/ws(s?):\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/i.test(pub)
    state.net.hubPub = exposed ? pub : ''
    state.net.hubMode = exposed ? mode : ''
    state.net.hubToken = exposed ? (st?.token || '') : ''
  }
  if (!st?.running || !state.net?.relay) return
  const url = `ws://127.0.0.1:${st.port}/mqtt`
  if (state.net.relay.addBroker(url)) appendSys('中继服务：已并入本机私有中继链路（127.0.0.1 回环）')
}


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
    if (state.args['hb-log']) {
      setInterval(() => window.oray.botLog(`[BOT] TICK view=${state.view.conv} peers=${state.net?.peers.size} ready=${state.net?.readyPeerIds().length}`), 5000)
    }
    if (state.args['mute-presence']) {
      // 测试注入：停发本端 relay presence 广播（模拟广播丢失/不可达），仅剩心跳摘要通道
      setTimeout(() => {
        clearInterval(state.net.relay.presenceTimer)
        window.oray.botLog('[BOT] MUTE-PRESENCE 已停发 presence 广播（仅剩心跳摘要）')
      }, 8000)
    }
    if (state.args['topology-change-after-ms']) {
      // 模拟网络拓扑变化：中继与 WebRTC 同时被切断（等价 Wi-Fi 切换）
      setTimeout(() => {
        window.oray.botLog('[BOT] TOPO-CHANGE 注入：杀 relay + 全部 pc')
        try { state.net.relay.forceReconnect() } catch { /* 忽略 */ }
        for (const [, pp] of state.net.peers) { try { pp.pc?.close() } catch { /* 忽略 */ } }
        // 触发一次 connectionstatechange（pc.close 会发，但保险起见手动）
        setTimeout(() => state.net.goOnline('拓扑变化注入'), 1000)
      }, Number(state.args['topology-change-after-ms']))
    }
    if (state.args['go-online-after-ms']) {
      setTimeout(() => {
        // --kill-pc：模拟待机冻结（WebRTC 连接被系统切断）后再主动上线
        if (state.args['kill-pc']) {
          for (const [, p] of state.net.peers) {
            try { p.pc.close() } catch { /* 忽略 */ }
            p.pc = null
          }
          window.oray.botLog('[BOT] KILL-PC 已模拟待机（pc 全部关闭）')
        }
        state.net.goOnline('bot 注入测试')
      }, Number(state.args['go-online-after-ms']))
    }
    if (state.args['switch-seq']) {
      // 视图切换序列：name1:text1,name2:text2,... 模拟用户在两个会话间来回切换发消息
      const steps = String(state.args['switch-seq']).split(',').map((x) => x.split(':'))
      ;(async () => {
        for (let i = 0; i < steps.length; i++) {
          const [peerName, text] = steps[i]
          // 等待目标对端就绪（公共信令延迟大，最长 120s）
          const start = Date.now()
          let entry = null
          while (Date.now() - start < 120000) {
            entry = [...state.net.peers.entries()].find(([, p]) => p.state === 'ready' && p.name === peerName)
            if (entry) break
            await new Promise((r) => setTimeout(r, 1000))
          }
          if (!entry) { window.oray.botLog(`[BOT] SWITCH skip=${peerName} 120s 未就绪`); continue }
          selectView({ conv: 'dm', peerId: entry[0] })
          await new Promise((r) => setTimeout(r, 300))
          const title = document.querySelector('.chat-title')?.textContent
          const last = [...document.querySelectorAll('.msgs .bubble .btext')].pop()?.textContent
          await state.net.sendMessage(entry[0], text, 'dm')
          window.oray.botLog(`[BOT] SWITCH step=${i} view=${peerName} title=${JSON.stringify(title)} lastVisible=${JSON.stringify(last || '')} sent=${JSON.stringify(text)}`)
          await new Promise((r) => setTimeout(r, 800))
        }
        if (state.args['dump-store']) {
          for (const [key, c] of Object.entries(state.net.store.exportAll())) {
            const texts = (c.entries || []).map((e) => `${(e.author || '').slice(0, 6)}:${e.text}`).join(' | ')
            window.oray.botLog(`[BOT] STORE conv=${key} n=${(c.entries || []).length} [${texts}]`)
          }
          window.oray.botLog('[BOT] STORE-DONE')
          if (state.args['exit-after-dump']) window.oray.botExit(0)
        }
      })().catch((e) => window.oray.botLog(`[BOT] SWITCH-ERR ${e?.message || e}`))
    }
    if (state.args['try-direct-after-ms']) {
      setTimeout(async () => {
        const ready = [...state.net.peers.entries()].find(([, p]) => p.state === 'ready')
        if (!ready) { window.oray.botLog('[BOT] TRY-DIRECT no-ready-peer'); return }
        try {
          const r = await state.net.tryDirect(ready[0])
          window.oray.botLog(`[BOT] TRY-DIRECT ok=${r.ok} detail=${JSON.stringify(r.detail)} path=${ready[1].path}`)
        } catch (e) { window.oray.botLog(`[BOT] TRY-DIRECT error=${e.message}`) }
      }, Number(state.args['try-direct-after-ms']))
    }
    if (state.args['open-dm']) {
      // 注入器：等指定昵称的就绪会话并切到该私聊（UI 截图验证用）
      const want = String(state.args['open-dm'])
      const t = setInterval(() => {
        const hit = [...state.net.peers.entries()].find(([, p]) => p.state === 'ready' && p.name === want)
        if (hit) { clearInterval(t); selectView({ conv: 'dm', peerId: hit[0] }) }
      }, 1000)
    }
    if (state.args['roster-log']) {
      // 在线状态观测：每 5s 采样，仅名单变化时打点（状态变更即事件，断言不漏）
      let last = ''
      setInterval(() => {
        if (!state.net) return
        const online = [...state.net.peers.values()].filter((p) => p.state === 'ready').map((p) => p.name).sort()
        const hist = buildRoster().filter((r) => !r.online).map((r) => r.name).sort()
        const line = `online=[${online.join(',')}] history=[${hist.join(',')}]`
        if (line !== last) { last = line; window.oray.botLog(`[BOT] ROSTER ${line}`) }
      }, 5000)
    }
    if (state.args.bot) {
      // 实机测试的内部状态探针（shot-when 条件里可读）：名录/名字表/别名表
      window.__ocDebug = {
        get names() { return [...state.names].map(([k, v]) => `${k.slice(0, 8)}=${v}`) },
        get aliases() { return [...(state.net?.idAliases || [])].map(([k, v]) => `${k.slice(0, 8)}→${v.slice(0, 8)}`) },
        get roster() { return buildRoster().map((r) => ({ id: r.id.slice(0, 8), name: r.name, online: !!r.online })) },
        get myId() { return state.myIdPubHex?.slice(0, 8) },
        get resolve() {
          const net = state.net
          if (!net) return null
          const probe = {}
          for (const id of state.names.keys()) {
            if (id === state.myIdPubHex) continue
            probe[id.slice(0, 8)] = `${net.resolveId(id).slice(0, 8)}/ready=${net.hasReadySession(id)}`
          }
          return probe
        },
      }
    }
    if (state.args['save-latest'] !== undefined && state.args['save-latest'] !== false) {
      // 下载验证：轮询收到的 file/image/voice 条目，逐个 fxSave；未完成（not-found）
      // 时下轮重试（≤10 次），成功才标记——传输完成先后不定
      const savedOk = new Set()
      const attempts = new Map()
      const poll = setInterval(() => {
        if (!state.net) return
        if (savedOk.size >= 3) { clearInterval(poll); return }
        for (const c of Object.values(state.net.store.exportAll())) {
          for (const e of c.entries || []) {
            if (!e.fid || savedOk.has(e.fid)) continue
            if (e.type !== 'file' && e.type !== 'image' && e.type !== 'voice') continue
            if (e.author === state.myIdPubHex) continue // 只保存收到的
            const n = (attempts.get(e.fid) || 0) + 1
            attempts.set(e.fid, n)
            if (n > 10) continue
            window.oray.fxSave(e.fid, e.name).then((r) => {
              if (r && r.ok) { savedOk.add(e.fid); window.oray.botLog(`[BOT] SAVED fid=${e.fid} name=${JSON.stringify(e.name)} path=${JSON.stringify(r.path)}`) }
            }).catch(() => { /* 下轮重试 */ })
          }
        }
      }, 3000)
    }

    if (state.args['dump-store-alone']) {
      // 独立存储转储（switch-seq 之外）：dump-after-ms 后打印全部会话条目
      setTimeout(() => {
        for (const [key, c] of Object.entries(state.net.store.exportAll())) {
          const texts = (c.entries || []).map((e) => `${(e.author || '').slice(0, 6)}:${e.text}`).join(' | ')
          window.oray.botLog(`[BOT] STORE conv=${key} n=${(c.entries || []).length} [${texts}]`)
        }
        window.oray.botLog('[BOT] STORE-DONE')
        if (state.args['exit-after-dump']) window.oray.botExit(0)
      }, Number(state.args['dump-after-ms']) || 8000)
    }
    if (state.args['send-lobby-when-absent']) {
      // 离线信息：指定昵称持续缺席 15s（吸收对端重启的秒级间隙）后，才发大厅消息
      const absent = String(state.args['send-lobby-when-absent'])
      const text = String(state.args['lobby-text'] || 'offline-msg')
      let absentSince = 0
      const t = setInterval(async () => {
        const still = [...(state.net?.peers?.values() || [])].some((p) => p.state === 'ready' && p.name === absent)
        if (still) { absentSince = 0; return }
        if (!absentSince) { absentSince = Date.now(); return }
        if (Date.now() - absentSince < 15000) return
        clearInterval(t)
        try {
          const r = await state.net.sendMessage('all', text, 'lobby')
          window.oray.botLog(`[BOT] LOBBY-SENT-ABSENT text=${JSON.stringify(text)} peers=${r.count}`)
        } catch (e) { window.oray.botLog(`[BOT] LOBBY-ABSENT-ERR ${e?.message || e}`) }
      }, 2000)
    }
    if (state.args['send-voice-after-ms'] !== undefined && state.args['send-voice-after-ms'] !== false) {
      setTimeout(async () => {
        try {
          let ready = null
          const wantPeerV = state.args['send-to'] ? String(state.args['send-to']) : ''
          for (let i = 0; i < 60 && !ready; i++) {
            ready = [...state.net.peers.entries()].find(([, p]) => p.state === 'ready' && (!wantPeerV || p.name === wantPeerV))
              || [...state.net.peers.entries()].find(([, p]) => p.state === 'ready' && !wantPeerV)
            if (!ready) await new Promise((r) => setTimeout(r, 2000))
          }
          if (!ready) { window.oray.botLog('[BOT] SEND-VOICE-NO-PEER'); return }
          const duration = Number(state.args['voice-duration-ms']) || 1500
          const { bytes, waveform } = synthVoiceWav(duration)
          await state.filex.sendFile(ready[0], {
            bytes, name: `voice-${Date.now()}.wav`, size: bytes.length,
            mime: 'audio/wav', lastModified: Date.now(),
          }, { kind: 'voice', extra: { duration, waveform } })
        } catch (e) { window.oray.botLog(`[BOT] SEND-VOICE-ERR ${e?.message || e}`) }
      }, Number(state.args['send-voice-after-ms']))
    }
    if (state.args['del-contact']) {
      // 注入器：按昵称删除联系人（实机验证名录抑制/桶清除/上线恢复）
      const delay = Number(state.args['del-contact-after-ms']) || 8000
      setTimeout(() => {
        const target = [...state.names.entries()].find(([, n]) => n === state.args['del-contact'])
        if (!target) { window.oray.botLog(`[BOT] CONTACT-NOTFOUND name=${state.args['del-contact']}`); return }
        doDeleteContact(target[0], target[1])
      }, delay)
    }
    if (state.args['send-file']) {
      // 注入器：向第一个就绪对端发送文件（实机验证文件传输/续传/图片压缩）
      const delay = Number(state.args['send-file-after-ms']) || 6000
      setTimeout(async () => {
        try {
          // 轮询等就绪对端（对端可能后启动）
          let ready = null
          const wantPeer = state.args['send-to'] ? String(state.args['send-to']) : ''
          for (let i = 0; i < 60 && !ready; i++) {
            ready = [...state.net.peers.entries()].find(([, p]) => p.state === 'ready' && (!wantPeer || p.name === wantPeer))
              || [...state.net.peers.entries()].find(([, p]) => p.state === 'ready' && !wantPeer)
            if (!ready) await new Promise((r) => setTimeout(r, 2000))
          }
          if (!ready) { window.oray.botLog('[BOT] SEND-FILE-NO-PEER'); return }
          const paths = [state.args['send-file'], state.args['send-file2'], state.args['send-file3']].filter(Boolean)
          for (const p of paths) {
            const info = await window.oray.fxReadPath(p)
            if (!info) { window.oray.botLog(`[BOT] SEND-FILE-NOTFOUND ${p}`); continue }
            const isImg = /\.(png|jpe?g|webp|gif|bmp)$/i.test(info.name)
            const bytes = new Uint8Array(info.bytes)
            const thumb = isImg ? await makeThumb(bytes, info.name) : ''
            await state.filex.sendFile(ready[0], {
              bytes, name: info.name, size: info.size,
              mime: isImg ? (/\.(png)$/i.test(info.name) ? 'image/png' : 'image/jpeg') : 'application/octet-stream',
              lastModified: info.mtimeMs, thumb,
            }, { kind: isImg ? 'image' : 'file', orig: !!state.args['send-file-orig'] })
            window.oray.botLog(`[BOT] SEND-FILE-START name=${JSON.stringify(info.name)} size=${info.size} to=${ready[1].name}`)
          }
        } catch (e) { window.oray.botLog(`[BOT] SEND-FILE-ERR ${e?.message || e}`) }
      }, delay)
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

// 中继状态胶囊（v1.25.2）：本机是中继主机时右上常驻——状态 + 链路数，点开
// 查看已接入成员明细（名字/链路数）与接入地址，一键复制
function renderHubPill(st) {
  // 胶囊与面板是 self-card（左上本用户区域）内的静态元素（index.html），此处只填充
  const pill = $('hubPill')
  const panel = $('hubPanel')
  if (!pill || !panel) return
  if (!pill.onclick) {
    pill.onclick = () => panel.classList.toggle('hidden')
    document.addEventListener('click', (e) => {
      if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== pill) panel.classList.add('hidden')
    })
  }
  const links = relayLinksInfo()
  const alive = links.filter((l) => l.alive).length

  // —— 成员视角（非中继主机）：当前中继链路清单（连着哪几条/存活情况）——
  if (!st?.running) {
    pill.classList.remove('hidden')
    pill.textContent = `🔗 中继链路 · 🟢 ${alive}/${links.length}`
    panel.innerHTML = `
      <div class="hub-panel-title">当前中继链路（${alive}/${links.length} 存活）</div>
      ${links.map((l) => `<div class="hub-member">${l.alive ? '🟢' : '⚪'} ${esc(l.type)}中继 · ${esc(l.url)}${l.fails ? ` · 断线${l.fails}次` : ''}</div>`).join('') || '<div class="hub-member">（无）</div>'}
      <div class="hub-panel-row" style="margin-top:4px">消息经全部存活链路并发发送、接收端去重；增删可在 设置 → 网络 → MQTT broker</div>`
    return
  }

  // —— 主机视角：📡 私有中继运行中 ——
  pill.classList.remove('hidden') // 主机胶囊常驻（index.html 初始带 hidden）
  let reg
  if (st.mode === 'named') reg = st.registered ? '✓ 已连边缘' : '⏳ 连接中'
  else if (st.tunnelUrl) reg = '✓ 隧道就绪'
  else reg = '本机模式（未暴露公网）'
  pill.textContent = `📡 私有中继 · ${reg} · 链路 ${st.clients ?? 0}`
  const members = st.memberList || []
  const list = members.length
    ? members.map((m) => `<div class="hub-member">· ${esc(m.name || '指纹 ' + m.fp)}${m.links > 1 ? `（${m.links} 条链路）` : ''}</div>`).join('')
    : '<div class="hub-member">· 暂无成员接入</div>'
  const exposed = !!(st.tunnelUrl || st.publicUrl)
  const url = st.tunnelUrl || st.publicUrl || `ws://127.0.0.1:${st.port}/mqtt`
  const exposeNote = exposed ? '' : '<div class="hub-panel-row" style="color:#e8b64c">⚠ 本机模式：未暴露公网，远程成员无法接入（启动快速隧道或配置稳定地址后自动广播）</div>'
  panel.innerHTML = `
    <div class="hub-panel-title">📡 私有中继运行中</div>
    <div class="hub-panel-row">接入地址：${esc(url)}</div>
    ${exposeNote}
    <div class="hub-panel-row">${st.mode === 'named' ? '稳定地址' : '临时地址'}${st.token ? ' · 准入 token 已启用' : ''}</div>
    <div class="hub-panel-title" style="margin-top:6px">已接入成员（${members.length}）</div>
    ${list}
    <div class="hub-panel-title" style="margin-top:6px">中继链路（${links.length}，按优先级排序）</div>
    ${links.map((l) => `<div class="hub-member">${l.alive ? '🟢' : '⚪'} ${esc(l.type)}中继 · ${esc(l.url)}${l.fails ? ` · 断线${l.fails}次` : ''}</div>`).join('')}
    <button class="ghost" id="hubPanelCopy" style="margin-top:6px; padding:4px 10px">复制接入地址</button>`
  const cp = $('hubPanelCopy')
  if (cp) cp.onclick = () => { try { navigator.clipboard.writeText(url) } catch { /* 剪贴板不可用 */ } }
}

// 已采纳中继链路清单：按排序规则（固定>临时>公共，同类按稳定度）输出类型/状态/统计
function relayLinksInfo() {
  const relay = state.net?.relay
  if (!relay) return []
  return sortRelayBrokers([...relay.brokerUrls]).map((url) => {
    const link = relay.links.get(url)
    const st = relayStats.get(url) || { lastOkAt: 0, fails: 0 }
    const type = /trycloudflare\.com/.test(url) ? '临时' : (PUBLIC_BROKERS.includes(url) ? '公共' : '固定')
    return { url, type, alive: !!link?.alive, fails: st.fails, lastOkAt: st.lastOkAt }
  })
}

// 待机/恢复检测：每次 tick 记录时间；若相邻 tick 间隔剧增（>30s）说明系统冻结过
let lastTick = Date.now()
setInterval(() => {
  const now = Date.now()
  if (now - lastTick > 30000 && state.net) {
    state.net.goOnline(`检测到待机约 ${Math.round((now - lastTick) / 1000)}s 后恢复`)
  }
  lastTick = now
}, 5000)
setInterval(() => {
  if (state.net && !$('mainView').classList.contains('hidden')) renderPeers()
}, 5000)
// 回到前台：主动检查上线状态
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.net) state.net.onVisible()
})

main().catch((e) => {
  console.error('启动失败', e)
  window.oray?.botLog?.(`BOOT-STACK ${e?.stack || e?.message || e}`)
  if (state.args?.bot) window.oray.botExit(1)
})
