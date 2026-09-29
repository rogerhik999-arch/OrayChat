// oraychat 文件/图片传输（filex，v1.17.0）
//
// 跑在 DM 加密会话之上，复用既有双传输（WebRTC p2p / MQTT 中继）与 E2EE 密钥：
//   - 控制帧走 ctl 通道：fx-offer / fx-have / fx-ack / fx-done / fx-cancel
//   - 数据块走 'fx' 通道：{fid, i, z, e:{n,c}}，每块独立 XChaCha20-Poly1305，
//     AAD 绑定 fid+块号+压缩标志（乱序收/重传均安全，跨块/跨文件重放无效）
//
// 协议级压缩（黑盒）：每块 deflate-raw 透明压缩，收益 <3% 自动放弃（z=0）。
// 图片/视频/压缩包等已压缩内容自然跳过 —— 用户无感知。
//
// 断点续传（接收方驱动）：fid = 传输内容的 sha256 前 24 hex（内容寻址）。
// 接收方把已收分片位图持久化在本机；重发同一文件 → offer → 接收方回
// fx-have 位图 → 只传缺失块。会话断开重连后同样自动续（onSessionReady）。
//
// 图片格式压缩（可选）：默认 WebP 重编码（长边 ≤2048、q0.85，压完更大则
// 回退原样）；指定"原图"则跳过格式压缩只走协议级压缩。日志只存 96px 缩略图。
//
// 大文件内存策略：发送方整体读入（v1 上限 200MB）；接收方按块 pwrite 落盘。

import * as oc from './crypto.mjs'

export const FX_CHUNK_SIZE = 32 * 1024 // 32KB：中继帧（b64 后 ~43KB）更小，与心跳/presence 交错更好、重传代价低
export const FX_MAX_SIZE = 200 * 1024 * 1024
const WINDOW_P2P = 16
const WINDOW_MQTT = 4
const MQTTPace_MS = 25
const HAVE_INTERVAL_MS = 2000 // 接收方位图广播节奏（兼作重传请求）
const INFLIGHT_TIMEOUT_MS = 1500 // 发送块未确认超时 → 重发
const OFFER_RETRY_MS = 3000 // offer 未获首个 ACK 前的周期重发（offer 只发一次会因丢帧永久卡死）
const RELAY_FALLBACK_MS = 12000 // p2p 发送零进展超时 → 后续块改走 MQTT 中继（接收方两路全收）
const RELAY_REBUILD_MS = 20000 // 任意路径无新 ACK 超时 → 重建中继连接 + 重发 offer（防大块帧把心跳挤死后的死锁）
const RELAY_REBUILD_COOLDOWN_MS = 30000
const STALL_TIMEOUT_MS = 120000 // 传输整体无进展超时

// ---------- deflate 助手（CompressionStream 全局可用：Electron/现代 WebView/Node 18+） ----------

export async function maybeDeflate(u8) {
  if (u8.length < 512) return { data: u8, z: 0 }
  try {
    const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    const out = new Uint8Array(await new Response(stream).arrayBuffer())
    if (out.length < u8.length * 0.97) return { data: out, z: 1 } // 收益 ≥3% 才值得
  } catch { /* 环境不支持：原样发 */ }
  return { data: u8, z: 0 }
}

export async function inflate(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// ---------- 位图助手 ----------

export function bitmapSet(bm, i) { bm[i >> 3] |= 1 << (i & 7) }
export function bitmapHas(bm, i) { return !!(bm[i >> 3] & (1 << (i & 7))) }
export function bitmapCount(bm) { let n = 0; for (const b of bm) n += popcount(b); return n }
function popcount(b) { let n = 0; while (b) { b &= b - 1; n++ } return n }

export function chunkCount(size, cs) { return Math.max(1, Math.ceil(size / cs)) }

export async function sha256Hex(u8) {
  const digest = await crypto.subtle.digest('SHA-256', u8)
  return oc.hex(new Uint8Array(digest))
}

// ---------- 传输管理器 ----------

export class FileX {
  // opts: { net, io, compress?, offerRetryMs?, relayFallbackMs?, hooks: {onEvent, onIncoming, onLog} }
  // io 适配器（Electron=主进程文件 / Web=内存）：state/write/finalize/read/abort
  // compress(file) → {bytes, w, h, mime, mode}（图片格式压缩；注入便于测试）
  constructor({ net, io, compress, offerRetryMs, relayFallbackMs, relayRebuildMs, hooks = {} }) {
    this.net = net
    this.io = io
    this.compress = compress
    this.offerRetryMs = offerRetryMs || OFFER_RETRY_MS
    this.relayFallbackMs = relayFallbackMs || RELAY_FALLBACK_MS
    this.relayRebuildMs = relayRebuildMs || RELAY_REBUILD_MS
    this.hooks = hooks
    this.tx = new Map() // fid -> 传输状态（收发同表）
    // 接收方保活：即使发端停滞也周期广播位图（对端重连后立刻拿到续传起点）
    this.tickTimer = setInterval(() => {
      for (const tx of this.tx.values()) {
        if (tx.state !== 'active') continue
        if (tx.dir === 'recv' && Date.now() - tx.lastHaveAt > HAVE_INTERVAL_MS) {
          this.sendHave(tx.peerId, tx.fid).catch(() => {})
        }
      }
    }, HAVE_INTERVAL_MS)
  }

  peer(peerId) { return this.net?.peers.get(peerId) }

  emit(ev) { try { this.hooks.onEvent?.(ev) } catch { /* UI 异常不阻断传输 */ } }
  log(msg, lv) { this.hooks.onLog?.(msg, lv) }

  // ---------- 发送方 ----------

  // file: {bytes:Uint8Array, name, size, mime, lastModified}（bytes 为"实际传输内容"，
  // 图片默认已格式压缩；orig 模式即原始文件字节）
  async sendFile(peerId, file, { kind = 'file', orig = false, caption = '' } = {}) {
    const peer = this.peer(peerId)
    if (!peer || peer.state !== 'ready') throw new Error('对端尚未建立加密会话')
    if (file.size > FX_MAX_SIZE) throw new Error(`文件超过 ${Math.round(FX_MAX_SIZE / 1048576)}MB 上限`)
    if (this.tx.size > 8) throw new Error('传输任务过多，请稍后再试')

    let bytes = file.bytes, w, h, mime = file.mime || 'application/octet-stream', mode = 'raw'
    if (kind === 'image' && !orig && this.compress) {
      try {
        const c = await this.compress(file)
        if (c) { bytes = c.bytes; w = c.w; h = c.h; mime = c.mime; mode = c.mode }
      } catch (e) { this.log(`图片压缩失败，按原图发送：${e?.message || e}`, 'warn') }
    }

    const sha = await sha256Hex(bytes)
    const fid = sha.slice(0, 24) // 内容寻址：同内容 = 同 fid = 天然续传键
    if (this.tx.has(fid)) throw new Error('相同文件正在传输中')
    const cs = FX_CHUNK_SIZE
    const n = chunkCount(bytes.length, cs)
    const tx = {
      fid, dir: 'send', peerId, state: 'active', bytes, sha, cs, n,
      name: file.name, size: bytes.length, mime, kind, w, h, mode, orig,
      have: new Uint8Array(Math.ceil(n / 8)), // 对端确认位图
      acked: 0, inflight: new Map(), // i -> 发送时刻（1.5s 未确认即重发）
      offers: 0, // offer 发送次数（首个 ACK 前周期重发）
      forceRelay: false, // p2p 零进展自动切换：后续块改走 MQTT 中继
      lastAckAt: 0, // 最近一次收到对端位图/确认的时刻（自愈 3 判据）
      lastProgressAt: Date.now(), startedAt: Date.now(),
      sentHist: [], // [ts, ackedTotal] 速率采样
      caption: caption || file.name, thumb: file.thumb || '',
    }
    this.tx.set(fid, tx)

    // 落本地日志（type/fid/缩略图随条目同步给对端）
    this.hooks.onOutgoing?.({
      mid: oc.newMid(), text: tx.caption, t: Date.now(),
      type: kind, fid, name: file.name, size: bytes.length, mime, w, h, thumb: tx.thumb, mode,
      peerId,
    })

    const offer = {
      op: 'fx-offer', fid, kind, name: file.name, size: bytes.length, mime, sha,
      cs, n, mode, w: w || 0, h: h || 0, orig: orig ? 1 : 0, thumb: tx.thumb,
    }
    tx.offer = offer
    await this.sendOffer(peerId, offer, tx)
    this.log(`发送${kind === 'image' ? '图片' : '文件'} ${file.name}（${fmtSize(bytes.length)}${mode === 'img' ? '，已压缩' : ''}${orig ? '，原图' : ''}）`)
    this.emit({ fid, dir: 'send', state: 'active', done: 0, total: n, name: tx.name })
    this.startPump(fid)
    return fid
  }

  // offer 重发（首个 ACK 前每 3s 一次）：ctl 帧只发一次会因丢帧/对端初始化
  // 失败而永久卡死 —— 这是"发送进度 0%"的根因（接收方无事务，块全部丢弃）
  async sendOffer(peerId, offer, tx) {
    tx.offers++
    try { await this.net.sendCtl(peerId, { ...offer }) } catch { /* 下轮重发 */ }
  }

  // 滑动窗口泵：每 200ms 扫一遍 —— 对端缺失的块里，未发过或 1.5s 未确认的
  // （丢块/会话抖动自动重发），补足窗口；接收方 fx-have 位图是唯一确认源。
  // 附带三条自愈：offer 未获 ACK 周期重发；p2p 零进展切中继；无新 ACK 重建中继。
  startPump(fid) {
    const tx = this.tx.get(fid)
    if (!tx || tx.pumpTimer) return
    tx.pumpTimer = setInterval(() => {
      if (tx.state !== 'active') { clearInterval(tx.pumpTimer); tx.pumpTimer = null; return }
      const peer = this.peer(tx.peerId)
      if (!peer || peer.state !== 'ready') return // 会话断开：等 onSessionReady 恢复
      const now = Date.now()
      const lastLife = Math.max(tx.startedAt, tx.lastAckAt)
      // 自愈 1：首个 ACK 迟迟不到 → 重发 offer（接收方才能建事务、回位图）
      if (tx.acked === 0 && now - tx.startedAt > this.offerRetryMs && now - tx.startedAt < 600000) {
        if (!tx.lastOfferAt || now - tx.lastOfferAt >= this.offerRetryMs) {
          tx.lastOfferAt = now
          void this.sendOffer(tx.peerId, tx.offer, tx)
          if (tx.offers === 3) this.log(`传输 ${tx.name}：对端迟迟未响应，正在重发传输请求（若持续失败请检查连接）`, 'warn')
        }
      }
      // 自愈 2：p2p 零进展 → 后续块改走 MQTT 中继（接收方 make-before-break 两路全收）
      if (!tx.forceRelay && peer.via === 'p2p' && tx.acked === 0 && now - tx.startedAt > this.relayFallbackMs) {
        tx.forceRelay = true
        this.log(`传输 ${tx.name}：直连通道无响应，改经 MQTT 中继`, 'warn')
      }
      // 自愈 3：任意路径 20s 无新 ACK → 大概率是文件块把心跳/位图帧挤死（QoS0
      // 拥堵）或会话被对端回收 → 重建中继连接（限频）+ 重发 offer 唤醒接收方
      if (tx.acked > 0 && tx.acked < tx.n && now - lastLife > this.relayRebuildMs) {
        if (!tx.lastRebuildAt || now - tx.lastRebuildAt > RELAY_REBUILD_COOLDOWN_MS) {
          tx.lastRebuildAt = now
          this.log(`传输 ${tx.name}：通道无响应，重建中继连接并重发传输请求`, 'warn')
          try { this.net.relay?.forceReconnect?.() } catch { /* 忽略 */ }
          setTimeout(() => { if (tx.state === 'active') void this.sendOffer(tx.peerId, tx.offer, tx) }, 2500)
        }
      }
      const window = (peer.via === 'mqtt' || tx.forceRelay) ? WINDOW_MQTT : WINDOW_P2P
      for (const [i, ts] of tx.inflight) {
        if (bitmapHas(tx.have, i) || now - ts > INFLIGHT_TIMEOUT_MS) tx.inflight.delete(i)
      }
      if (tx.inflight.size >= window) return
      void (async () => {
        for (let k = 0; k < tx.n && tx.inflight.size < window && tx.state === 'active'; k++) {
          if (bitmapHas(tx.have, k) || tx.inflight.has(k)) continue
          tx.inflight.set(k, Date.now())
          await this.sendChunk(tx, k)
        }
        const done = bitmapCount(tx.have)
        this.emit({ fid: tx.fid, dir: 'send', state: 'active', done, total: tx.n, name: tx.name, speed: recentSpeed(tx) })
      })()
    }, 200)
  }

  async sendChunk(tx, i) {
    const peer = this.peer(tx.peerId)
    if (!peer || peer.state !== 'ready') return
    const from = i * tx.cs
    const raw = tx.bytes.slice(from, Math.min(from + tx.cs, tx.bytes.length))
    const { data, z } = await maybeDeflate(raw)
    const e = oc.sealBin(peer.ctx, data, 'fx', tx.fid, i, z)
    try {
      await this.net.sendFx(tx.peerId, { fid: tx.fid, i, z, e }, tx.forceRelay)
    } catch { /* 会话抖动：超时后自动重发 */ }
    if (peer.via === 'mqtt' || tx.forceRelay) await sleep(MQTTPace_MS) // 公共 broker 节流
  }

  // ---------- 接收方 ----------

  async onOffer(peerId, o) {
    if (!o?.fid || !Number.isInteger(o.n) || o.n <= 0 || !o.cs) return
    if (o.size > FX_MAX_SIZE) { this.net.sendCtl(peerId, { op: 'fx-cancel', fid: o.fid, why: 'too-large' }).catch(() => {}); return }
    const peer = this.peer(peerId)
    if (!peer?.idPubHex) return
    let tx = this.tx.get(o.fid)
    if (!tx) {
      const st = await this.io.state(o.fid, { size: o.size, cs: o.cs, n: o.n })
      tx = {
        fid: o.fid, dir: 'recv', peerId, state: 'active', cs: o.cs, n: o.n, size: o.size,
        name: String(o.name || o.fid), mime: o.mime || 'application/octet-stream',
        kind: o.kind === 'image' ? 'image' : 'file', sha: o.sha, mode: o.mode,
        w: o.w, h: o.h, orig: !!o.orig, thumb: o.thumb || '',
        have: st.have, caption: o.thumb ? (o.name || '图片') : (o.name || o.fid),
        lastHaveAt: 0, lastProgressAt: Date.now(), startedAt: Date.now(),
      }
      this.tx.set(o.fid, tx)
      // 落本地日志（含缩略图，随共享日志同步；字节不进日志）
      this.hooks.onIncoming?.({
        mid: oc.newMid(), text: tx.caption, t: Date.now(), author: peer.idPubHex,
        type: tx.kind, fid: o.fid, name: tx.name, size: o.size, mime: tx.mime,
        w: o.w, h: o.h, thumb: tx.thumb, mode: o.mode, peerId,
      })
      this.log(`接收${tx.kind === 'image' ? '图片' : '文件'} ${tx.name}（${fmtSize(o.size)}${bitmapCount(st.have) ? `，续传 ${bitmapCount(st.have)}/${o.n}` : ''}）`)
    }
    tx.state = 'active'
    await this.sendHave(peerId, o.fid) // 告知已有位图（断点续传起点）
  }

  // 接收方 → 发送方：广播当前位图（断点续传 + 缺块重传请求 + 速率反馈）
  async sendHave(peerId, fid) {
    const tx = this.tx.get(fid)
    if (!tx || tx.dir !== 'recv' || tx.state !== 'active') return
    tx.lastHaveAt = Date.now()
    const done = bitmapCount(tx.have)
    if (done >= tx.n) {
      const r = await this.io.finalize(fid, tx.sha, tx.name)
      if (r.ok) {
        tx.state = 'done'
        this.net.sendCtl(peerId, { op: 'fx-done', fid, sha: tx.sha }).catch(() => {})
        this.log(`${tx.kind === 'image' ? '图片' : '文件'} ${tx.name} 接收完成（SHA-256 校验一致）`)
        this.emit({ fid, dir: 'recv', state: 'done', done: tx.n, total: tx.n, name: tx.name })
      } else {
        tx.state = 'error'
        this.net.sendCtl(peerId, { op: 'fx-cancel', fid, why: 'sha-mismatch' }).catch(() => {})
        this.log(`文件 ${tx.name} 校验失败（内容与清单不符），已丢弃`, 'warn')
        this.emit({ fid, dir: 'recv', state: 'error', done, total: tx.n, name: tx.name })
      }
      return
    }
    this.net.sendCtl(peerId, { op: 'fx-have', fid, have: [...tx.have] }).catch(() => {})
    this.emit({ fid, dir: 'recv', state: 'active', done, total: tx.n, name: tx.name })
  }

  // ---------- 共同 ----------

  // 发送方收到对端位图：合并确认、驱动窗口前进
  onHave(peerId, f) {
    const tx = this.tx.get(f?.fid)
    if (!tx || tx.dir !== 'send' || tx.state !== 'active' || !Array.isArray(f.have)) return
    tx.lastAckAt = Date.now()
    const bm = Uint8Array.from(f.have)
    for (let k = 0; k < tx.n && k < bm.length * 8; k++) {
      if (bitmapHas(bm, k) && !bitmapHas(tx.have, k)) { bitmapSet(tx.have, k); tx.acked++ }
    }
    const done = bitmapCount(tx.have)
    tx.lastProgressAt = Date.now()
    tx.sentHist.push([Date.now(), done])
    if (tx.sentHist.length > 30) tx.sentHist.shift()
    this.emit({
      fid: tx.fid, dir: 'send', state: done >= tx.n ? 'done' : 'active',
      done, total: tx.n, name: tx.name, speed: recentSpeed(tx),
    })
    if (done >= tx.n) {
      tx.state = 'done'
      if (tx.pumpTimer) { clearInterval(tx.pumpTimer); tx.pumpTimer = null }
      this.log(`${tx.kind === 'image' ? '图片' : '文件'} ${tx.name} 发送完成`)
      return
    }
    this.startPump(tx.fid)
  }

  onDone(peerId, f) {
    const tx = this.tx.get(f?.fid)
    if (!tx || tx.dir !== 'send') return
    tx.state = 'done'
    this.emit({ fid: tx.fid, dir: 'send', state: 'done', done: tx.n, total: tx.n, name: tx.name })
  }

  async onCancel(peerId, f) {
    const tx = this.tx.get(f?.fid)
    if (!tx) return
    tx.state = 'cancel'
    if (tx.dir === 'recv') await this.io.abort(tx.fid).catch(() => {})
    this.log(`传输取消：${tx.name}${f.why === 'sha-mismatch' ? '（校验不一致）' : ''}`, 'warn')
    this.emit({ fid: tx.fid, dir: tx.dir, state: 'cancel', done: 0, total: tx.n, name: tx.name })
  }

  cancel(fid) {
    const tx = this.tx.get(fid)
    if (!tx || tx.state !== 'active') return
    tx.state = 'cancel'
    this.net.sendCtl(tx.peerId, { op: 'fx-cancel', fid }).catch(() => {})
    if (tx.dir === 'recv') this.io.abort(fid).catch(() => {})
    this.emit({ fid, dir: tx.dir, state: 'cancel', done: 0, total: tx.n, name: tx.name })
  }

  // 会话就绪：接收方重广播位图（断线重连后自动续传）；发送方恢复泵
  onSessionReady(peerId) {
    for (const tx of this.tx.values()) {
      if (tx.peerId !== peerId || tx.state !== 'active') continue
      if (tx.dir === 'recv') this.sendHave(peerId, tx.fid)
      else this.startPump(tx.fid)
    }
  }

  // 该对端是否有进行中的传输（net.reapGhosts 用：传输中心跳可能被大帧挤死，
  // 不能据此判死拆会话 —— 拆了 ACK 断流，发送端会卡在半路）
  hasActiveTransfer(peerId) {
    for (const tx of this.tx.values()) {
      if (tx.peerId === peerId && tx.state === 'active') return true
    }
    return false
  }

  // 数据块入口（net 层双传输汇入）
  async onFrame(peerId, f) {
    const tx = this.tx.get(f?.fid)
    if (!tx || tx.dir !== 'recv' || tx.state !== 'active') return
    const peer = this.peer(peerId)
    if (!peer || !peer.ctx) return
    const i = f.i
    if (!Number.isInteger(i) || i < 0 || i >= tx.n) return
    if (bitmapHas(tx.have, i)) return
    try {
      let pt = oc.openBin(peer.ctx, f.e, 'fx', tx.fid, i, f.z ? 1 : 0)
      if (f.z) pt = await inflate(pt)
      if (i === tx.n - 1) {
        const expectLast = tx.size - (tx.n - 1) * tx.cs
        if (pt.length !== expectLast) throw new Error('末块长度不符')
      } else if (pt.length !== tx.cs) throw new Error('块长度不符')
      await this.io.write(tx.fid, i, tx.cs, pt)
      bitmapSet(tx.have, i)
      tx.lastProgressAt = Date.now()
      const done = bitmapCount(tx.have)
      this.emit({ fid: tx.fid, dir: 'recv', state: 'active', done, total: tx.n, name: tx.name, speed: recentSpeed(tx, done) })
      // 水位前进 8 块或有节奏地回报位图
      if (done >= tx.n || Date.now() - tx.lastHaveAt > HAVE_INTERVAL_MS) await this.sendHave(peerId, tx.fid)
      else if (i % 8 === 0) await this.sendHave(peerId, tx.fid)
    } catch (e) {
      this.log(`文件块解密失败（${e?.message || e}）`, 'warn') // 篡改/密钥错位：丢弃，等重发
    }
  }

  // 控制帧入口
  onCtl(peerId, f) {
    if (!f?.op) return
    if (f.op === 'fx-offer') this.onOffer(peerId, f).catch((e) => this.log(`接收初始化失败：${e?.message || e}`, 'error'))
    else if (f.op === 'fx-have') this.onHave(peerId, f)
    else if (f.op === 'fx-done') this.onDone(peerId, f)
    else if (f.op === 'fx-cancel') this.onCancel(peerId, f).catch(() => {})
  }

  // UI 查询：气泡渲染用
  status(fid) {
    for (const tx of this.tx.values()) {
      if (tx.fid !== fid) continue
      const done = tx.dir === 'send' ? bitmapCount(tx.have) : bitmapCount(tx.have)
      return { dir: tx.dir, state: tx.state, done, total: tx.n, speed: recentSpeed(tx) }
    }
    return null
  }
}

// ---------- 内部助手 ----------

function recentSpeed(tx, doneNow) {
  const hist = tx.sentHist || []
  if (hist.length < 2) return 0
  const [t0, d0] = hist[0]
  const [t1, d1] = hist[hist.length - 1]
  if (t1 <= t0) return 0
  return Math.max(0, Math.round(((d1 - d0) * tx.cs) / ((t1 - t0) / 1000)))
}

function schedule(fn, ms) { setTimeout(fn, ms) }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

export function fmtSize(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n}B`
}
