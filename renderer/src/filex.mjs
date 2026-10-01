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
const WINDOW_P2P = 16 // 自适应前的初始窗口（就绪后按 BDP 自适应，见 windowFor）
const WINDOW_MQTT = 4
const MQTTPace_MS = 25
const HAVE_INTERVAL_MS = 2000 // 接收方位图广播节奏（兼作重传请求）
const WINDOW_MIN = 4
const WINDOW_MAX = 64
const WINDOW_ENDGAME_MAX = 128
const INFLIGHT_TIMEOUT_MS = 1500 // 发送块未确认超时 → 重发
const INFLIGHT_ENDGAME_MS = 750 // endgame（最后 2%）重发阈值减半（BitTorrent endgame 模式）
const OFFER_RETRY_MS = 3000 // offer 未获首个 ACK 前的周期重发（offer 只发一次会因丢帧永久卡死）
const RELAY_FALLBACK_MS = 12000 // p2p 发送零进展超时 → 后续块改走 MQTT 中继（接收方两路全收）
const RELAY_REBUILD_MS = 20000 // 任意路径无新 ACK 超时 → 重建中继连接 + 重发 offer（防大块帧把心跳挤死后的死锁）
const RELAY_REBUILD_COOLDOWN_MS = 30000
// 速率预算（P0-2，LEDBAT 让路思想）：文件传输给交互流量让出余量——
// v1.17.2 的"心跳被文件块挤死"的根治。令牌桶全局共享（所有传输合计）。
const MAX_RATE_DM = 4 * 1024 * 1024 // p2p 总预算 4MB/s
const MAX_RATE_RELAY = 1 * 1024 * 1024 // 中继总预算 1MB/s（公共 broker 礼让）
const PACE_BUCKET_S = 1 // 令牌桶容量 = 1 秒预算（允许一个窗口的突发）
// 传输活性：净来判死线（net.reapGhosts 的传输保护只在此窗口内生效 ——
// 否则彻底卡死的传输会让保护永续，造出新的残体）与停滞暂停线（超线转
// stalled 停泵，对端上线 onSessionReady 自动复活续传）
const TRANSFER_PROTECT_MS = 90000
const TX_STALL_MS = 5 * 60000
// FEC（P1-1）：8+1 XOR 组——每 8 个数据块广播 1 个奇偶块（组内明文按块长补零异或），
// 组内任丢 1 块由接收方本地恢复（免一次 RTT 重传）。奇偶块索引 = n + 组号，
// 旧版接收方按 i>=tx.n 丢弃，天然向后兼容；丢奇偶块只是失去优化，数据重传兜底。
export const FEC_GROUP = 8
// 语音/视频消息的随路元数据（进 offer、本地日志、接收方日志；体积以字节计）
export const FX_EXTRA_KEYS = ['duration', 'waveform', 'rate']

// ---------- deflate 助手（CompressionStream 全局可用：Electron/现代 WebView/Node 18+） ----------

export async function maybeDeflate(u8) {
  if (u8.length < 512) return { data: u8, z: 0 }
  try {
    const out = await deflateBytes(u8)
    if (out.length < u8.length * 0.97) return { data: out, z: 1 } // 收益 ≥3% 才值得
  } catch { /* 环境不支持：原样发 */ }
  return { data: u8, z: 0 }
}

// 无阈值 deflate（P2-1 流式整文件压缩用）
export async function deflateBytes(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
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
  constructor({ net, io, compress, offerRetryMs, relayFallbackMs, relayRebuildMs, transferProtectMs, maxRateDm, maxRateRelay, hooks = {} }) {
    this.net = net
    this.io = io
    this.compress = compress
    this.offerRetryMs = offerRetryMs || OFFER_RETRY_MS
    this.relayFallbackMs = relayFallbackMs || RELAY_FALLBACK_MS
    this.relayRebuildMs = relayRebuildMs || RELAY_REBUILD_MS
    this.transferProtectMs = transferProtectMs || TRANSFER_PROTECT_MS
    this.maxRateDm = maxRateDm || MAX_RATE_DM
    this.maxRateRelay = maxRateRelay || MAX_RATE_RELAY
    this.hooks = hooks
    this.tx = new Map() // fid -> 传输状态（收发同表）
    this.peerCaps = new Map() // peerId -> {s:1} 接收方能力（流压缩），probe 学习
    // P0-2 令牌桶：所有传输共享一个字节预算（LEDBAT 式让路——预算随是否有
    // 中继路径传输切换，交互消息/心跳天然获得余量）
    this.pace = { tokens: this.maxRateDm * PACE_BUCKET_S, at: Date.now() }
    // 接收方保活：即使发端停滞也周期广播位图（对端重连后立刻拿到续传起点）；
    // 顺带做双向停滞检测 —— 超时转 stalled（停泵、退出传输保护），对端重新
    // 上线（onSessionReady）自动复活续传。不转态的话，死传输会让 reaper
    // 的传输保护永续，反而造出新的残体。
    this.tickTimer = setInterval(() => {
      const now = Date.now()
      for (const tx of this.tx.values()) {
        if (tx.state === 'active' && now - (tx.lastLifeAt || tx.startedAt || 0) > TX_STALL_MS) {
          tx.state = 'stalled'
          if (tx.pumpTimer) { clearInterval(tx.pumpTimer); tx.pumpTimer = null }
          this.log(`传输 ${tx.name} 长时间无进展，已暂停（对端上线后会自动续传）`, 'warn')
          this.emit({ fid: tx.fid, dir: tx.dir, state: 'stalled', done: bitmapCount(tx.have), total: tx.n, name: tx.name })
          continue
        }
        if (tx.state !== 'active') continue
        if (tx.dir === 'recv' && now - tx.lastHaveAt > HAVE_INTERVAL_MS) {
          this.sendHave(tx.peerId, tx.fid).catch(() => {})
        } else if (tx.dir === 'pull') {
          this.requestMissing(tx) // 拉取事务：周期请求缺失块
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
  async sendFile(peerId, file, { kind = 'file', orig = false, caption = '', extra = {} } = {}) {
    const peer = this.peer(peerId)
    if (!peer || peer.state !== 'ready') throw new Error('对端尚未建立加密会话')
    if (file.size > FX_MAX_SIZE) throw new Error(`文件超过 ${Math.round(FX_MAX_SIZE / 1048576)}MB 上限`)
    if (this.tx.size > 8) throw new Error('传输任务过多，请稍后再试')
    const extraClean = {}
    for (const k of FX_EXTRA_KEYS) if (extra[k] !== undefined) extraClean[k] = extra[k]

    const rawSha = await sha256Hex(file.bytes) // 原始内容指纹（兼探测 id 与流压缩终检）
    let bytes = file.bytes, w, h, mime = file.mime || 'application/octet-stream', mode = 'raw', alg = ''
    if (kind === 'image' && !orig && this.compress) {
      try {
        const c = await this.compress(file)
        if (c) { bytes = c.bytes; w = c.w; h = c.h; mime = c.mime; mode = c.mode }
      } catch (e) { this.log(`图片压缩失败，按原图发送：${e?.message || e}`, 'warn') }
    }

    // P2-1 能力探测：流式整文件压缩需要接收方支持解压 finalize（caps.s）。
    // 探针 offer 只交换能力不建事务（旧版收到 probe 也回 have 但无 caps → legacy 模式）。
    // 仅在该对端「无能力缓存」时探测一次；缓存 {s:0}（已知 legacy）不再重复探测。
    // 图片已经格式压缩（webp/jpeg），整文件 deflate 无收益 → 仅普通文件启用。
    let stream = false
    if (kind === 'file' && !this.peerCaps.has(peerId)) {
      const caps = await this.probeCaps(peerId, rawSha.slice(0, 24))
      this.peerCaps.set(peerId, caps)
    }
    if (kind === 'file' && this.peerCaps.get(peerId)?.s) {
      try {
        const packed = await deflateBytes(file.bytes) // P2-1：整文件流式压缩（全局字典，压缩率优于逐块）
        if (packed.length < file.bytes.length * 0.97) { bytes = packed; alg = 'deflate'; stream = true }
      } catch { /* 环境不支持：legacy 逐块 */ }
    }

    const sha = await sha256Hex(bytes)
    const fid = sha.slice(0, 24) // 内容寻址：同内容 = 同 fid = 天然续传键
    if (this.tx.has(fid)) throw new Error('相同文件正在传输中')
    const cs = FX_CHUNK_SIZE
    const n = chunkCount(bytes.length, cs)
    // P2-2 扁平块哈希清单（BitTorrent piece hash 简化版）：每块 8 hex 截断哈希随
    // offer 下发，接收方边收边验——坏块即时丢弃重传，完整性不再"全有全无"
    let hashes = null
    if (n <= 8192) {
      hashes = []
      for (let i = 0; i < n; i++) hashes.push((await sha256Hex(bytes.subarray(i * cs, Math.min((i + 1) * cs, bytes.length)))).slice(0, 8))
    }
    const tx = {
      fid, dir: 'send', peerId, peerPub: peer.idPubHex, state: 'active', bytes, sha, cs, n, hashes,
      name: file.name, size: bytes.length, mime, kind, w, h, mode, orig, alg,
      rawSha, rawSize: file.bytes.length,
      have: new Uint8Array(Math.ceil(n / 8)), // 对端确认位图
      acked: 0, inflight: new Map(), // i -> {ts, relay}（1.5s 未确认即重发；relay=本块走中继）
      offers: 0, // offer 发送次数（首个 ACK 前周期重发）
      forceRelay: false, // 分路仍无进展后的最终兜底：全部走中继
      split: false, // P2-4 双路径拆分：p2p 零进展时部分块经中继、部分留直连
      lastP2pAckAt: 0, // 最近一次归属直连路径的 ACK（分路回收判据）
      lastAckAt: 0, // 最近一次收到对端位图/确认的时刻（自愈 3 判据）
      lastLifeAt: Date.now(), // 最近活性时刻（收到 ACK / 实际发块）——传输保护窗口判据
      lastProgressAt: Date.now(), startedAt: Date.now(),
      sentHist: [], // [ts, ackedTotal] 速率采样
      caption: caption || file.name, thumb: file.thumb || '',
      ...extraClean,
    }
    this.tx.set(fid, tx)

    // 落本地日志（type/fid/缩略图随条目同步给对端）。mid 同时放进 offer：
    // 接收方落库复用同一 mid——否则同一条图片/语音在两端是两个 mid，反熵
    // 同步一对账就以两条不同 mid 各落一次库，双方都显示重复（v1.21.8 用户实测）
    const msgMid = oc.newMid()
    this.hooks.onOutgoing?.({
      mid: msgMid, text: tx.caption, t: Date.now(),
      type: kind, fid, name: file.name, size: stream ? file.bytes.length : bytes.length, mime, w, h, thumb: tx.thumb, mode,
      ...extraClean,
      peerId,
    })

    const offer = {
      op: 'fx-offer', fid, kind, name: file.name, size: bytes.length, mime, sha,
      cs, n, mode, w: w || 0, h: h || 0, orig: orig ? 1 : 0, thumb: tx.thumb,
      mid: msgMid, // 幂等键：接收方日志与发送方日志同一条目
      osize: stream ? file.bytes.length : bytes.length, // UX 尺寸（流压缩时=原始大小）
      ...extraClean,
      fec: 1, // P1-1：8+1 XOR 奇偶块广播（旧版接收方按 i>=n 丢弃，向后兼容）
      hashes, // P2-2：逐块哈希清单（n>8192 时为 null 跳过）
    }
    if (stream) { offer.alg = 'deflate'; offer.raw = file.bytes.length; offer.rsha = rawSha }
    tx.offer = offer
    // 发送方同样落盘：自己可回放/另存、成为多源持有者、重启后可续发。
    // 流压缩时存原始字节（finalize 按原始 sha 校验，fxRead 得到可播放内容）
    try {
      const own = stream ? file.bytes : bytes
      for (let i = 0; i < n; i++) {
        await this.io.write(fid, i, cs, own.subarray(i * cs, Math.min((i + 1) * cs, own.length)))
      }
      await this.io.finalize(fid, stream ? rawSha : sha, file.name)
    } catch { /* 落盘失败不影响发送（仅失去本地回放/持有） */ }
    await this.sendOffer(peerId, offer, tx)
    this.log(`发送${kind === 'image' ? '图片' : kind === 'voice' ? '语音' : '文件'} ${file.name}（${fmtSize(bytes.length)}${mode === 'img' ? '，已压缩' : ''}${orig ? '，原图' : ''}${stream ? '，流压缩' : ''}）`)
    this.emit({ fid, dir: 'send', state: 'active', done: 0, total: n, name: tx.name })
    this.startPump(fid)
    return fid
  }

  // P2-1 能力探测：probe offer → 带 caps 的 have；1.2s 超时按无能力处理（legacy 兼容）
  probeCaps(peerId, probeFid) {
    return new Promise((resolve) => {
      if (!this.capsWaiters) this.capsWaiters = new Map()
      const done = (caps) => { if (!this.capsWaiters.has(probeFid)) return; this.capsWaiters.delete(probeFid); clearTimeout(timer); resolve(caps) }
      this.capsWaiters.set(probeFid, done)
      const timer = setTimeout(() => done({}), 1200)
      this.net.sendCtl(peerId, { op: 'fx-offer', probe: 1, fid: probeFid }).catch(() => done({}))
    })
  }

  // offer 重发（首个 ACK 前每 3s 一次）：ctl 帧只发一次会因丢帧/对端初始化
  // 失败而永久卡死 —— 这是"发送进度 0%"的根因（接收方无事务，块全部丢弃）
  async sendOffer(peerId, offer, tx) {
    tx.offers++
    try { await this.net.sendCtl(peerId, { ...offer }) } catch { /* 下轮重发 */ }
  }

  // ---------- P0 拥塞控制：令牌桶 + 自适应窗口 ----------

  // 当前全局字节预算：有任何传输走中继（或被迫中继）时切中继档（公共 broker 礼让）
  paceLimit() {
    for (const tx of this.tx.values()) {
      if (tx.state !== 'active' || tx.dir !== 'send') continue
      const via = this.peer(tx.peerId)?.via
      if (via === 'mqtt' || tx.forceRelay) return this.maxRateRelay
    }
    return this.maxRateDm
  }

  // 取 cost 字节的发送权；返回需要等待的毫秒（0 = 立即）
  paceTake(cost) {
    const now = Date.now()
    const limit = this.paceLimit()
    const cap = limit * PACE_BUCKET_S
    this.pace.limit = limit
    this.pace.tokens = Math.min(cap, this.pace.tokens + ((now - this.pace.at) / 1000) * limit)
    this.pace.at = now
    if (this.pace.tokens >= cost) { this.pace.tokens -= cost; return 0 }
    const need = cost - this.pace.tokens
    this.pace.tokens = 0
    return Math.ceil((need / limit) * 1000)
  }

  // P0-1 自适应窗口：窗口 ≈ 1.5 × ACK 字节速率 × RTT（BDP，BBR 思想极简版），
  // 限幅 [WINDOW_MIN, WINDOW_MAX]；尚无采样时用路径默认值
  windowFor(tx, base) {
    let w = base
    if (tx.rttEma > 0 && tx.rateEma > 0) {
      const bdpBlocks = (tx.rateEma * tx.rttEma) / 1000 / tx.cs
      w = Math.max(WINDOW_MIN, Math.min(WINDOW_MAX, Math.ceil(bdpBlocks * 1.5)))
    }
    // P1-2 endgame：最后 ≤max(2, 2%) 块是重传 RTT 主导的长尾 → 窗口加倍 + 重发阈值减半
    const remaining = tx.n - bitmapCount(tx.have)
    if (remaining <= Math.max(2, Math.ceil(tx.n * 0.02))) w = Math.min(WINDOW_ENDGAME_MAX, w * 2)
    return w
  }

  inflightTimeoutFor(tx) {
    const remaining = tx.n - bitmapCount(tx.have)
    return remaining <= Math.max(2, Math.ceil(tx.n * 0.02)) ? INFLIGHT_ENDGAME_MS : INFLIGHT_TIMEOUT_MS
  }

  // ---------- P1-1 FEC：8+1 XOR ----------

  // 组 g 的奇偶块 = 组内明文块按位异或（短块补零）。明文直接来自文件字节，
  // 无压缩干扰、接收方可从已落盘块读回参与异或。
  parityFor(tx, g) {
    const out = new Uint8Array(tx.cs)
    const start = g * FEC_GROUP
    const end = Math.min(start + FEC_GROUP, tx.n)
    for (let j = start; j < end; j++) {
      const from = j * tx.cs
      const chunk = tx.bytes.subarray(from, Math.min(from + tx.cs, tx.bytes.length))
      for (let k = 0; k < chunk.length; k++) out[k] ^= chunk[k]
    }
    return out
  }

  plainLen(tx, j) { return j === tx.n - 1 ? tx.size - (tx.n - 1) * tx.cs : tx.cs }

  // 组 g 内缺失（未确认）的数据块下标
  groupMissing(tx, g) {
    const start = g * FEC_GROUP
    const end = Math.min(start + FEC_GROUP, tx.n)
    const miss = []
    for (let j = start; j < end; j++) if (!bitmapHas(tx.have, j)) miss.push(j)
    return miss
  }

  // 接收方：用奇偶块恢复组内唯一缺失块（其余块从本机 .part 读回参与异或）
  async recoverWithParity(tx, g) {
    if (!tx.parity?.has(g) || tx.recovering?.has(g)) return
    const miss = this.groupMissing(tx, g)
    if (miss.length !== 1) return
    const missing = miss[0]
    tx.recovering = tx.recovering || new Map()
    tx.recovering.set(g, true)
    try {
      const acc = Uint8Array.from(tx.parity.get(g))
      const start = g * FEC_GROUP
      const end = Math.min(start + FEC_GROUP, tx.n)
      for (let j = start; j < end; j++) {
        if (j === missing) continue
        const part = await this.io.readChunk(tx.fid, j, tx.cs, this.plainLen(tx, j))
        if (!part || part.length !== this.plainLen(tx, j)) { tx.recovering.delete(g); return }
        for (let k = 0; k < part.length; k++) acc[k] ^= part[k]
      }
      const plain = acc.slice(0, this.plainLen(tx, missing))
      // P2-2 块哈希校验（有清单时）：恢复出的块同样必须过验
      if (tx.hashes && tx.hashes[missing] !== undefined) {
        const h = (await sha256Hex(plain)).slice(0, 8)
        if (h !== tx.hashes[missing]) { tx.recovering.delete(g); return }
      }
      await this.io.write(tx.fid, missing, tx.cs, plain)
      bitmapSet(tx.have, missing)
      tx.lastProgressAt = Date.now()
      tx.lastLifeAt = Date.now()
      this.log(`FEC 恢复：${tx.name} 第 ${missing} 块已由奇偶块重建（免重传）`)
      const done = bitmapCount(tx.have)
      this.emit({ fid: tx.fid, dir: 'recv', state: 'active', done, total: tx.n, name: tx.name })
      if (done >= tx.n) await this.sendHave(tx.peerId, tx.fid)
    } catch { /* 恢复失败：数据重传兜底 */ }
    finally { tx.recovering?.delete(g) }
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
      // 自愈 2 升级（P2-4 双路径拆分）：p2p 零进展先"分路"——部分块留直连、
      // 部分改走中继；直连恢复（有归属 ACK）自动回收分路；分路仍无进展才整体转中继
      if (!tx.forceRelay && !tx.split && peer.via === 'p2p' && now - lastLife > this.relayFallbackMs) {
        tx.split = true
        this.log(`传输 ${tx.name}：直连无响应，启用双路径分路（部分块改走中继）`, 'warn')
      }
      if (tx.split && !tx.forceRelay && tx.lastP2pAckAt && now - tx.lastP2pAckAt < 8000) {
        tx.split = false
        this.log(`传输 ${tx.name}：直连已恢复，回收分路`)
      }
      if (tx.split && !tx.forceRelay && now - lastLife > this.relayFallbackMs * 2) {
        tx.forceRelay = true
        this.log(`传输 ${tx.name}：分路仍无进展，全部改经 MQTT 中继`, 'warn')
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
      const base = (peer.via === 'mqtt' || tx.forceRelay) ? WINDOW_MQTT : WINDOW_P2P
      const window = this.windowFor(tx, base)
      const infTimeout = this.inflightTimeoutFor(tx)
      for (const [i, fl] of tx.inflight) {
        if (bitmapHas(tx.have, i) || now - fl.ts > infTimeout) {
          if (bitmapHas(tx.have, i) && tx.inflight.has(i)) {
            // P0-1：RTT 采样（以最近一次发送为起点）；P2-4：直连归属信用
            const sample = now - fl.ts
            if (sample > 0 && sample < 10000) tx.rttEma = tx.rttEma ? Math.round(tx.rttEma * 0.7 + sample * 0.3) : sample
            if (!fl.relay) tx.lastP2pAckAt = now
          }
          tx.inflight.delete(i)
        }
      }
      if (tx.inflight.size >= window) return
      void (async () => {
        let toggle = 0
        for (let k = 0; k < tx.n && tx.inflight.size < window && tx.state === 'active'; k++) {
          if (bitmapHas(tx.have, k) || tx.inflight.has(k)) continue
          const viaMqtt = peer.via === 'mqtt'
          const useRelay = tx.forceRelay || viaMqtt || (tx.split && toggle++ % 2 === 1)
          tx.inflight.set(k, { ts: Date.now(), relay: useRelay })
          await this.sendChunk(tx, k, useRelay)
        }
        const done = bitmapCount(tx.have)
        this.emit({ fid: tx.fid, dir: 'send', state: 'active', done, total: tx.n, name: tx.name, speed: recentSpeed(tx) })
      })()
    }, 200)
  }

  async sendChunk(tx, i, useRelay = false) {
    const peer = this.peer(tx.peerId)
    if (!peer || peer.state !== 'ready') return
    const from = i * tx.cs
    const raw = tx.bytes.slice(from, Math.min(from + tx.cs, tx.bytes.length))
    const { data, z } = await maybeDeflate(raw)
    // P0-2：字节级 pacing（令牌桶，所有传输共享预算）——按预算匀速发送，
    // 而不是窗口突发灌爆（bufferbloat 的根源）
    const wait = this.paceTake(data.length + 64)
    if (wait > 0) await sleep(Math.min(wait, 1000))
    const e = oc.sealBin(peer.ctx, data, 'fx', tx.fid, i, z)
    try {
      await this.net.sendFx(tx.peerId, { fid: tx.fid, i, z, e }, useRelay || tx.forceRelay)
      tx.lastLifeAt = Date.now() // 实际发出即活性（对端可能活着只是 ACK 被挤）
    } catch { /* 会话抖动：超时后自动重发 */ }
    // P1-1：组边界跟随奇偶块广播（组内任丢 1 块，接收方本地恢复免重传）
    if (i % FEC_GROUP === FEC_GROUP - 1 || i === tx.n - 1) {
      await this.sendParity(tx, Math.floor(i / FEC_GROUP), useRelay)
    }
    if (peer.via === 'mqtt' || useRelay || tx.forceRelay) await sleep(MQTTPace_MS) // 公共 broker 节流
  }

  async sendParity(tx, g, useRelay = false) {
    const peer = this.peer(tx.peerId)
    if (!peer || peer.state !== 'ready') return
    const parity = this.parityFor(tx, g)
    const wait = this.paceTake(parity.length + 64)
    if (wait > 0) await sleep(Math.min(wait, 1000))
    const e = oc.sealBin(peer.ctx, parity, 'fx', tx.fid, tx.n + g, 2) // flags=2：奇偶块命名空间
    try {
      await this.net.sendFx(tx.peerId, { fid: tx.fid, i: tx.n + g, z: 0, p: 1, e }, useRelay || tx.forceRelay)
    } catch { /* 奇偶块丢失只是失去优化 */ }
  }

  // ---------- 接收方 ----------

  async onOffer(peerId, o) {
    // P2-1 能力探测：probe offer 无 n/cs（不建事务），须在字段校验前处理，
    // 只回能力位（流式压缩需新 finalize）
    if (o?.probe) {
      this.net.sendCtl(peerId, { op: 'fx-have', fid: o.fid, have: [], probe: 1, caps: { s: 1 } }).catch(() => {})
      return
    }
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
        kind: o.kind === 'image' || o.kind === 'voice' ? o.kind : 'file', sha: o.sha, mode: o.mode,
        w: o.w, h: o.h, orig: !!o.orig, thumb: o.thumb || '',
        hashes: Array.isArray(o.hashes) ? o.hashes : null, // P2-2 逐块哈希清单
        alg: o.alg === 'deflate' ? 'deflate' : '', rawSha: o.rsha || '', rawSize: o.raw || 0, // P2-1 流压缩
        have: st.have, caption: o.thumb ? (o.name || '图片') : (o.name || o.fid),
        sentHist: [], // 接收速率采样 [ts, doneBlocks]（与发送侧 recentSpeed 共用）
        parity: new Map(), // FEC：组号 -> 奇偶块（内存态，丢失只失去优化）
        lastHaveAt: 0, lastLifeAt: Date.now(), lastProgressAt: Date.now(), startedAt: Date.now(),
      }
      this.tx.set(o.fid, tx)
      // 落本地日志（含缩略图，随共享日志同步；字节不进日志）。
      // mid 复用发送方的（offer.mid）：两端日志同一条目，反熵同步按 mid 幂等；
      // 旧版发送方不带 mid 时退回新生成（行为同前版，同步后会重复——升级即愈）
      this.hooks.onIncoming?.({
        mid: (typeof o.mid === 'string' && o.mid.length >= 8 && o.mid.length <= 64) ? o.mid : oc.newMid(),
        text: tx.caption, t: Date.now(), author: peer.idPubHex,
        type: tx.kind, fid: o.fid, name: tx.name, size: o.osize || o.size, mime: tx.mime,
        w: o.w, h: o.h, thumb: tx.thumb, mode: o.mode,
        duration: o.duration, waveform: o.waveform, rate: o.rate,
        peerId,
      })
      this.log(`接收${tx.kind === 'image' ? '图片' : tx.kind === 'voice' ? '语音' : '文件'} ${tx.name}（${fmtSize(o.size)}${bitmapCount(st.have) ? `，续传 ${bitmapCount(st.have)}/${o.n}` : ''}）`)
    }
    // 已完成的事务收到重复 offer（发送方丢了最终 ACK）：直接回 fx-done，不重激活
    if (tx.state === 'done') {
      this.net.sendCtl(peerId, { op: 'fx-done', fid: o.fid, sha: tx.sha }).catch(() => {})
      return
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
      // 防重入：FEC 恢复与重发块到达可能同时触发完成——并发 finalize 会因
      // 第一个成功后 part 已 rename 而误报"校验失败"，把 done 覆盖成 error
      if (tx.finalizing) return
      tx.finalizing = true
      try {
        // P2-1 流压缩：finalize 时解压并终检原始内容哈希
        const r = await this.io.finalize(fid, tx.sha, tx.name, tx.alg ? { alg: tx.alg, rawSha: tx.rawSha, rawSize: tx.rawSize } : null)
        if (r.ok) {
          tx.state = 'done'
          this.net.sendCtl(peerId, { op: 'fx-done', fid, sha: tx.sha }).catch(() => {})
          this.log(`${tx.kind === 'image' ? '图片' : '文件'} ${tx.name} 接收完成（SHA-256 校验一致${tx.alg ? '，已解压' : ''}）`)
          this.emit({ fid, dir: 'recv', state: 'done', done: tx.n, total: tx.n, name: tx.name })
        } else {
          tx.state = 'error'
          this.net.sendCtl(peerId, { op: 'fx-cancel', fid, why: 'sha-mismatch' }).catch(() => {})
          this.log(`文件 ${tx.name} 校验失败（内容与清单不符），已丢弃`, 'warn')
          this.emit({ fid, dir: 'recv', state: 'error', done, total: tx.n, name: tx.name })
        }
      } finally { tx.finalizing = false }
      return
    }
    this.net.sendCtl(peerId, { op: 'fx-have', fid, have: [...tx.have], caps: { s: 1 } }).catch(() => {})
    this.emit({ fid, dir: 'recv', state: 'active', done, total: tx.n, name: tx.name })
  }

  // ---------- 共同 ----------

  // 发送方收到对端位图：合并确认、驱动窗口前进
  onHave(peerId, f) {
    // 能力位学习（P2-1）：任何 have 都携带 caps，接收方升级后即时生效
    if (f?.caps && this.peerCaps.get(peerId)?.s !== f.caps.s) this.peerCaps.set(peerId, f.caps)
    const tx = this.tx.get(f?.fid)
    if (!tx || tx.dir !== 'send' || !Array.isArray(f.have)) return
    // done 的事务收到缺失报告（对端重启后位图不完整）→ 重新激活续传：
    // 字节仍在内存（tx.bytes），重发缺失块即可，无需重传整文件
    if (tx.state === 'done') {
      const bm = Uint8Array.from(f.have)
      const missing = []
      for (let k = 0; k < tx.n && missing.length < 8; k++) if (!bitmapHas(bm, k)) missing.push(k)
      if (missing.length === 0) return // 对端确有完整文件：忽略
      // 对端缺块（重启后位图不完整）：重新激活，并以对端报告**重建**确认位图
      //（本地 have 是"我曾经发完"的旧账，不能继续用——否则泵认为无事可做）
      tx.have = bm
      tx.acked = bitmapCount(bm)
      tx.state = 'active'
      tx.startedAt = Date.now()
      tx.lastProgressAt = Date.now()
      this.log(`传输 ${tx.name}：对端重启后缺失 ${missing.length} 块，重新激活续传`, 'warn')
      this.startPump(tx.fid)
    } else if (tx.state !== 'active') {
      return
    }
    tx.lastAckAt = Date.now()
    tx.lastLifeAt = tx.lastAckAt
    const bm = Uint8Array.from(f.have)
    let gained = 0
    for (let k = 0; k < tx.n && k < bm.length * 8; k++) {
      if (bitmapHas(bm, k) && !bitmapHas(tx.have, k)) {
        bitmapSet(tx.have, k); tx.acked++; gained++
        // P2-4 路径归属：该块最近一次从直连发出 → 直连有信用（分路回收判据）
        const fl = tx.inflight.get(k)
        if (fl && !fl.relay) tx.lastP2pAckAt = Date.now()
      }
    }
    const done = bitmapCount(tx.have)
    // P0-1 速率 EMA（自适应窗口输入）：相邻两次位图间的瞬时速率
    const now = Date.now()
    if (tx.lastHaveTs && now > tx.lastHaveTs && gained > 0) {
      const inst = Math.min((gained * tx.cs * 1000) / (now - tx.lastHaveTs), 100 * 1024 * 1024)
      tx.rateEma = tx.rateEma ? Math.round(tx.rateEma * 0.6 + inst * 0.4) : Math.round(inst)
    }
    tx.lastHaveTs = now
    tx.lastHaveDone = done
    tx.lastProgressAt = now
    tx.sentHist.push([now, done])
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

  // 会话就绪：接收方重广播位图（断线重连后自动续传）；发送方恢复泵；
  // 停滞中的传输一并复活
  onSessionReady(peerId) {
    for (const tx of this.tx.values()) {
      if (tx.peerId !== peerId) continue
      // 已完成的接收事务：补发 fx-done——若最终 ACK 丢失，发送方会卡在"发送中 0%"
      if (tx.dir === 'recv' && tx.state === 'done') {
        this.net.sendCtl(peerId, { op: 'fx-done', fid: tx.fid, sha: tx.sha }).catch(() => {})
        continue
      }
      if (tx.state !== 'active' && tx.state !== 'stalled') continue
      tx.state = 'active'
      tx.lastLifeAt = Date.now()
      if (tx.dir === 'recv') this.sendHave(peerId, tx.fid)
      else this.startPump(tx.fid)
    }
  }

  // 该对端是否有「活着」的传输（net.reapGhosts 用：传输中心跳可能被大帧挤死，
  // 不能据此判死拆会话 —— 拆了 ACK 断流，发送端会卡在半路）。
  // 保护必须限时：活性窗口（收到 ACK / 实际收发块）内的才算数，否则彻底卡死
  // 的传输会让保护永续，反过来造出新的残体。
  hasActiveTransfer(peerId) {
    const now = Date.now()
    for (const tx of this.tx.values()) {
      if (tx.peerId !== peerId || tx.state !== 'active') continue
      if (now - (tx.lastLifeAt || tx.startedAt || 0) < this.transferProtectMs) return true
    }
    return false
  }

  // 数据块入口（net 层双传输汇入）
  async onFrame(peerId, f) {
    const tx = this.tx.get(f?.fid)
    if (!tx || (tx.dir !== 'recv' && tx.dir !== 'pull') || tx.state !== 'active') return
    const peer = this.peer(peerId)
    if (!peer || !peer.ctx) return
    const i = f.i
    if (!Number.isInteger(i) || i < 0) return
    // P1-1 FEC：奇偶块（索引 ≥ n，flags=2）——入组缓存并尝试恢复组内唯一缺失块
    if (i >= tx.n) {
      if (!f.p) return
      const g = i - tx.n
      const gStart = g * FEC_GROUP
      if (gStart >= tx.n) return
      try {
        const parity = oc.openBin(peer.ctx, f.e, 'fx', tx.fid, i, 2)
        if (parity.length !== tx.cs) return
        tx.parity.set(g, parity)
        await this.recoverWithParity(tx, g)
      } catch { /* 奇偶块解密失败：忽略，数据重传兜底 */ }
      return
    }
    if (bitmapHas(tx.have, i)) return
    try {
      let pt = oc.openBin(peer.ctx, f.e, 'fx', tx.fid, i, f.z ? 1 : 0)
      if (f.z) pt = await inflate(pt)
      if (i === tx.n - 1) {
        const expectLast = tx.size - (tx.n - 1) * tx.cs
        if (pt.length !== expectLast) throw new Error('末块长度不符')
      } else if (pt.length !== tx.cs) throw new Error('块长度不符')
      // P2-2 逐块哈希：不符即终止（AEAD 已保证传输无损，不符=清单/内容级问题，
      // 重传无意义；宁可中止也不静默写坏文件）
      if (tx.hashes && tx.hashes[i] !== undefined) {
        const h = (await sha256Hex(pt)).slice(0, 8)
        if (h !== tx.hashes[i]) {
          this.log(`块 ${i} 哈希与清单不符，终止传输（内容级异常）`, 'error')
          tx.state = 'error'
          this.emit({ fid: tx.fid, dir: 'recv', state: 'error', done: bitmapCount(tx.have), total: tx.n, name: tx.name })
          this.io.abort(tx.fid).catch(() => {})
          this.net.sendCtl(peerId, { op: 'fx-cancel', fid: tx.fid, why: 'hash-mismatch' }).catch(() => {})
          return
        }
      }
      await this.io.write(tx.fid, i, tx.cs, pt)
      bitmapSet(tx.have, i)
      tx.lastProgressAt = Date.now()
      tx.lastLifeAt = tx.lastProgressAt // 收到块 = 活性
      // 接收速率采样（500ms 节流）：UI 显示 "接收 N% · X/s"。
      // pull 事务不经 onOffer 创建，sentHist 可能缺省——就地初始化
      {
        const now = Date.now()
        if (!tx.sentHist) tx.sentHist = []
        if (!tx.sentHist.length || now - tx.sentHist[tx.sentHist.length - 1][0] >= 500) {
          tx.sentHist.push([now, bitmapCount(tx.have)])
          if (tx.sentHist.length > 30) tx.sentHist.shift()
        }
      }
      // 组内有奇偶块且现在只剩唯一缺失 → 本地恢复
      const g = Math.floor(i / FEC_GROUP)
      if (tx.parity?.has(g)) void this.recoverWithParity(tx, g)
      const done = bitmapCount(tx.have)
      this.emit({ fid: tx.fid, dir: 'recv', state: 'active', done, total: tx.n, name: tx.name, speed: recentSpeed(tx, done) })
      // 水位前进 8 块或有节奏地回报位图（pull 事务完成走本地 finalize）
      if (tx.dir === 'pull') {
        if (done >= tx.n) await this.finishPull(tx)
        else this.emit({ fid: tx.fid, dir: 'recv', state: 'active', done, total: tx.n, name: tx.name })
      } else if (done >= tx.n || Date.now() - tx.lastHaveAt > HAVE_INTERVAL_MS) await this.sendHave(peerId, tx.fid)
      else if (i % 8 === 0) await this.sendHave(peerId, tx.fid)
    } catch (e) {
      this.log(`文件块解密失败（${e?.message || e}）`, 'warn') // 篡改/密钥错位：丢弃，等重发
    }
  }

  // 控制帧入口
  onCtl(peerId, f) {
    if (!f?.op) return
    if (f.op === 'fx-offer') this.onOffer(peerId, f).catch((e) => this.log(`接收初始化失败：${e?.message || e}`, 'error'))
    else if (f.op === 'fx-have') {
      // P2-1 能力探测回包（接收方无此 fid 的事务）
      if (f.probe && this.capsWaiters?.has(f.fid)) { this.capsWaiters.get(f.fid)(f.caps || {}); return }
      this.onHave(peerId, f)
    }
    else if (f.op === 'fx-done') this.onDone(peerId, f)
    else if (f.op === 'fx-cancel') this.onCancel(peerId, f).catch(() => {})
    // ---- P3-1 多源种子协议 ----
    else if (f.op === 'fx-want') this.onWant(peerId, f).catch(() => {})
    else if (f.op === 'fx-hold') this.onHold(peerId, f)
    else if (f.op === 'fx-req') this.onReq(peerId, f).catch(() => {})
  }

  // ---------- P3-1 多源获取（持有者广播 want → 持有者报 hold → 定向 req 拉块） ----------
  // 完整性：fx-hold 携带完整 SHA-256，其 24hex 前缀必须等于 fid（内容寻址绑定，
  // 伪造等价于 SHA 原像攻击）；finalize 再验全量哈希。持有者对 req 无状态应答
  // （读盘→切块→限速发送），不维护种子会话。

  // 本机是否持有该文件（完成态），带缓存
  async holding(fid) {
    if (this.holdingCache?.has(fid)) return this.holdingCache.get(fid)
    if (!this.holdingCache) this.holdingCache = new Map()
    let ok = false
    try { ok = !!(await this.io.read(fid)) } catch { ok = false }
    this.holdingCache.set(fid, ok)
    return ok
  }

  async onWant(peerId, f) {
    if (!f?.fid || this.tx.has(f.fid)) return
    if (!(await this.holding(f.fid))) return
    let meta = this.completed?.get(f.fid)
    try {
      const bytes = await this.io.read(f.fid)
      if (!bytes) return
      const sha = await sha256Hex(bytes)
      if (sha.slice(0, 24) !== f.fid) return // 内容与 fid 不符：不 serving
      meta = { sha, size: bytes.length, n: chunkCount(bytes.length, FX_CHUNK_SIZE), cs: FX_CHUNK_SIZE }
      if (!this.completed) this.completed = new Map()
      this.completed.set(f.fid, meta)
    } catch { return }
    this.net.sendCtl(peerId, { op: 'fx-hold', fid: f.fid, ...meta }).catch(() => {})
  }

  // 收集在线成员的 fx-hold 应答（want 广播后 2.5s 窗口）
  onHold(peerId, f) {
    if (!this.holdWaiters?.has(f?.fid)) return
    const w = this.holdWaiters.get(f.fid)
    // 完整 sha 的 24hex 前缀必须等于 fid（内容寻址绑定）
    if (!f.sha || f.sha.slice(0, 24) !== f.fid || !Number.isInteger(f.n)) return
    if (!w.holders.some((h) => h.peerId === peerId)) w.holders.push({ peerId, sha: f.sha, size: f.size, cs: f.cs || FX_CHUNK_SIZE, n: f.n })
  }

  queryHolders(fid) {
    return new Promise((resolve) => {
      if (!this.holdWaiters) this.holdWaiters = new Map()
      const w = { holders: [] }
      this.holdWaiters.set(fid, w)
      const timer = setTimeout(() => { this.holdWaiters.delete(fid); resolve(w.holders) }, 2500)
      void timer
      for (const pid of this.net.readyPeerIds()) this.net.sendCtl(pid, { op: 'fx-want', fid }).catch(() => {})
    })
  }

  // 从在线持有者拉取文件（入口：气泡上的"从成员获取"）。
  // meta 来自日志条目（name/size/mime/kind/w/h/thumb）；完整 sha 由 fx-hold 提供
  // （fid 前缀绑定防伪造），完成时全量终检。
  async pullFromPeers(fid, meta = {}) {
    if (this.tx.has(fid)) throw new Error('该文件已在传输队列中')
    const holders = await this.queryHolders(fid)
    if (!holders.length) throw new Error('在线成员都没有这个文件')
    const h = holders[0]
    const tx = {
      fid, dir: 'pull', peerId: h.peerId, state: 'active', cs: h.cs, n: h.n, size: h.size,
      sha: h.sha, name: meta.name || String(fid), mime: meta.mime || 'application/octet-stream',
      kind: meta.type === 'image' ? 'image' : 'file', mode: meta.mode || '',
      w: meta.w, h: meta.h, thumb: meta.thumb || '',
      have: (await this.io.state(fid, { size: h.size, cs: h.cs, n: h.n })).have,
      sentHist: [], // 接收速率采样（与 recv 事务共用 onFrame 处理路径）
      parity: new Map(), // 与 recv 事务共用 onFrame 处理路径
      holders: holders.map((x) => x.peerId), // 备选持有者（主选停滞可切换）
      lastLifeAt: Date.now(), lastProgressAt: Date.now(), startedAt: Date.now(),
      lastReqAt: 0,
    }
    this.tx.set(fid, tx)
    this.log(`从 ${this.peer(h.peerId)?.name || h.peerId.slice(0, 8)}… 获取 ${tx.name}（${fmtSize(h.size)}，多源可续传）`)
    this.emit({ fid, dir: 'recv', state: 'active', done: bitmapCount(tx.have), total: tx.n, name: tx.name })
    this.requestMissing(tx)
    return fid
  }

  // 拉取事务：周期向持有者请求缺失块（接收方驱动，与断点续传共用位图）
  requestMissing(tx) {
    const now = Date.now()
    if (tx.state !== 'active' || now - tx.lastReqAt < HAVE_INTERVAL_MS) return
    tx.lastReqAt = now
    const miss = []
    for (let k = 0; k < tx.n && miss.length < 16; k++) if (!bitmapHas(tx.have, k)) miss.push(k)
    if (!miss.length) return
    this.net.sendCtl(tx.peerId, { op: 'fx-req', fid: tx.fid, i: miss }).catch(() => {})
    this.emit({ fid: tx.fid, dir: 'recv', state: 'active', done: bitmapCount(tx.have), total: tx.n, name: tx.name })
  }

  // 拉取完成：全量终检（fid 前缀绑定 + hold 提供的完整 sha）
  async finishPull(tx) {
    if (tx.finalizing) return
    tx.finalizing = true
    try {
      const r = await this.io.finalize(tx.fid, tx.sha, tx.name)
      if (r.ok) {
        tx.state = 'done'
        if (!this.completed) this.completed = new Map()
        this.completed.set(tx.fid, { sha: tx.sha, size: tx.size, n: tx.n, cs: tx.cs })
        this.holdingCache?.set(tx.fid, true)
        this.log(`已从成员获取 ${tx.name}（${fmtSize(tx.size)}，SHA-256 校验一致）`)
        this.emit({ fid: tx.fid, dir: 'recv', state: 'done', done: tx.n, total: tx.n, name: tx.name })
      } else {
        tx.state = 'error'
        this.log(`获取 ${tx.name} 校验失败（${r.why || 'io'}），已丢弃`, 'warn')
        this.emit({ fid: tx.fid, dir: 'recv', state: 'error', done: 0, total: tx.n, name: tx.name })
      }
    } finally { tx.finalizing = false }
  }

  // 持有者服务：按请求读盘切块限速应答（无状态；会话就绪才服务）
  async onReq(peerId, f) {    if (!f?.fid || !Array.isArray(f.i) || !f.i.length) return
    if (!(await this.holding(f.fid))) return
    const bytes = await this.io.read(f.fid)
    if (!bytes) return
    if (String((await sha256Hex(bytes)).slice(0, 24)) !== f.fid) return
    const peer = this.peer(peerId)
    if (!peer || peer.state !== 'ready') return
    const n = chunkCount(bytes.length, FX_CHUNK_SIZE)
    for (const i of f.i.slice(0, 16)) {
      if (!Number.isInteger(i) || i < 0 || i >= n) continue
      const raw = bytes.subarray(i * FX_CHUNK_SIZE, Math.min((i + 1) * FX_CHUNK_SIZE, bytes.length))
      const { data, z } = await maybeDeflate(raw)
      const wait = this.paceTake(data.length + 64)
      if (wait > 0) await sleep(Math.min(wait, 1000))
      const e = oc.sealBin(peer.ctx, data, 'fx', f.fid, i, z)
      try { await this.net.sendFx(peerId, { fid: f.fid, i, z, e }) } catch { break }
      if (peer.via === 'mqtt') await sleep(MQTTPace_MS)
    }
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
