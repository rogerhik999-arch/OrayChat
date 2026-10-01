// oraychat P2P 网络层
// 双传输设计：
//   1. WebRTC 数据通道（首选）：Trystero + 公共 MQTT 信令初始化 + 公共 STUN 打洞
//      + 公共 TURN（若可用）→ 直连，延迟最低
//   2. MQTT 中继回退（renderer/src/relay.mjs）：打洞失败或直连断开时，同一套
//      E2EE 加密信封改经免费公共 MQTT broker 中继转发 —— broker 只见密文
// 两个传输共用一套 E2EE 握手/消息协议（crypto.mjs），会话密钥与传输无关；
// P2P 建立后自动从中继升级为直连。
//
// 共享消息日志（store.mjs）：大厅与私聊的可合并日志 ——
//   全体保存（每成员各存一份）、任何成员发起删除全体生效（墓碑/清空标记传播）、
//   上线即与对端交换状态全局同步、30 天保留期确定性过期。

import { joinRoom, selfId } from '@trystero-p2p/mqtt'
import * as oc from './crypto.mjs'
import { RelayTransport } from './relay.mjs'
import { LogStore, dmConvKey } from './store.mjs'

const APP_ID = 'oraychat-p2p-v1'
const HANDSHAKE_TIMEOUT_MS = 15000
const ANTI_ENTROPY_MS = 5 * 60 * 1000 // 周期性反熵全量对账
const ACK_TIMEOUT_MS = 3000
const ACK_MAX_RETRIES = 3
const SWEEP_INTERVAL_MS = 30 * 60 * 1000
const PRESENCE_HEARTBEAT_MS = 15000
// ---- 残身回收（v1.14.0）----
// peerId 是 Trystero 的 selfId，每次启动随机生成：对端重启/换网就会以新
// peerId 回来，旧条目若死亡路径未触发（崩溃时 WebRTC 没有 leave 事件、
// p2p 会话不走 onRelayGone）会永远挂在在线列表里。回收判据见 reapGhosts。
const REAP_INTERVAL_MS = 15000
const GHOST_GRACE_MS = 90000 // 已建立会话：视野里消失后至少再等这么久才回收（复活机会留给 ping/digest）
const GHOST_FAST_MS = 30000 // 未就绪条目（建联中/握手失败）：无进展 30s 即回收——握手超时才 15s，两倍足矣
const HS_FAIL_MAX = 3 // 连续握手失败次数上限：达到后进入冷却，不再自动建联（防在线列表被建联中残身刷屏）
const HS_FAIL_COOLDOWN_MS = 10 * 60000
const RELAY_VIEW_WARMUP_MS = 75000 // 我方中继刚连上时视野不完整：预热期内不回收
const REAP_COOLDOWN_MS = 5 * 60 * 1000 // 刚回收的 peerId 期间不再被摘要复种

// 免费公共基础设施默认清单（可在 userData/oraychat-config.json 覆盖）
export const DEFAULT_CONFIG = {
  // STUN：Google / Cloudflare / 小米（打洞用）
  stunUrls: [
    'stun:stun.l.google.com:19302',
    'stun:stun.cloudflare.com:3478',
    'stun:stun.miwifi.com:3478',
  ],
  // TURN：Open Relay Project（开源免费公共 TURN）。经实测其共享凭据目前已在
  // 服务端失效（400）；保留为默认并支持配置替换，中继兜底由 MQTT 回退承担。
  turnServers: [
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  // MQTT 中继/信令公共 broker（WSS）
  relayBrokers: [
    'wss://broker-cn.emqx.io:8084/mqtt',
    'wss://broker.emqx.io:8084/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
  ],
  // P2-3：文件帧中继 QoS（0=至多一次，1=至少一次+协议层去重=恰好一次）。
  // QoS1 借 broker 重传兜丢帧，代价是公共 broker 更易限流——实验开关（oraychat-config.json 覆盖）
  relayQos: 0,
  defaultRoom: 'oraychat-hall',
}

export const DEFAULT_ICE_CONFIG = {
  iceServers: [
    { urls: DEFAULT_CONFIG.stunUrls },
    ...DEFAULT_CONFIG.turnServers,
  ],
  iceCandidatePoolSize: 4,
}

export function buildRtcConfig(cfg) {
  const stun = cfg?.stunUrls?.length ? cfg.stunUrls : DEFAULT_CONFIG.stunUrls
  const turn = cfg?.turnServers?.length ? cfg.turnServers : DEFAULT_CONFIG.turnServers
  return {
    iceServers: [{ urls: stun }, ...turn],
    iceCandidatePoolSize: 4,
  }
}

// peers: Map<peerId(=对端 selfId), {
//   via: 'p2p'|'mqtt', state: 'connecting'|'handshaking'|'ready'|'failed',
//   pc?, name, idPubHex?, ctx, safety, path, candidates?, lastError }>
export class ChatNet {
  constructor(ident, myName, roomId, cfg, hooks, opts = {}) {
    this.ident = ident
    this.myName = myName
    this.roomId = roomId
    this.cfg = cfg
    this.hooks = hooks || {}
    this.opts = opts
    this.peers = new Map()
    this.destroyed = false
    this.myIdPubHex = oc.hex(ident.edPub)
    // 公钥 → 显示昵称。来源：直接握手（受身份签名保护）+ 对端同步帧传播
    // （仅显示用途；身份以公钥/安全码为准）。随同步帧 gossip，让未直接
    // 握手的成员（离线作者的历史消息）也能解析出名字。
    this.peerNames = new Map([[this.myIdPubHex, myName]])
    // 身份别名（重装/清数据换密钥的旧身份 → 当前活身份）：仅驱动「读时合并」
    // （名录归并 + 会话视图合并），原始分桶不动 —— 清掉 oc-id-aliases 即还原
    this.idAliases = new Map(Object.entries(opts.idAliases || {}))
    // 种入历史学到的 昵称 映射（本机 KV），启动即可归并"自己的旧身份"
    for (const [k, v] of Object.entries(opts.names || {})) {
      if (typeof v === 'string' && v && k !== this.myIdPubHex && !this.peerNames.has(k)) this.peerNames.set(k, v)
    }

    // 房间口令：Trystero 信令加密 + 门禁；并派生房间密钥加密中继回退层帧
    this.roomKey = oc.deriveRoomKey(opts.roomPassword, APP_ID, roomId)

    // 共享消息日志（大厅 + 私聊），持久化由 hooks 接到 localStorage
    this.store = new LogStore({
      persist: (all) => this.hooks.onStorePersist?.(all),
      load: () => this.hooks.onStoreLoad?.(),
    })
    this.store.onChange((convKey) => this.hooks.onStoreChanged?.(convKey))
    this.migrateAndScrubDmKeys() // 旧键迁移 + 混桶清洗（见 store.dmConvKey 注释；幂等）
    this.sweepTimer = setInterval(() => this.store.sweep(), SWEEP_INTERVAL_MS)
    // 在线状态心跳（15±3s 抖动，防雷群）：定期向所有就绪对端报告在线
    const scheduleHeartbeat = () => {
      if (this.destroyed) return
      const jitter = PRESENCE_HEARTBEAT_MS + (Math.random() * 6000 - 3000)
      this.heartbeatTimer = setTimeout(() => { this.sendPresenceHeartbeat(); scheduleHeartbeat() }, jitter)
    }
    scheduleHeartbeat()
    // 直连升级探测：中继会话每 45s 静默检查一次 Trystero 侧是否已打通/可重试
    this.directProbeTimer = setInterval(() => this.probeDirectUpgrades(), 45000)
    // 失败会话周期性重试（60s）：修复"一侧显示失败、另一侧看不到"的单向可见
    this.retryFailedTimer = setInterval(() => this.retryFailedSessions(), 60000)
    // 周期性反熵（5 分钟 + 抖动）：向随机就绪对端全量对账，保证长在线期间
    // 删除传播与离线消息也收敛（Dynamo 式 anti-entropy，CRDT 合并天然幂等）
    this.antiEntropyTimer = setInterval(() => this.runAntiEntropy(), ANTI_ENTROPY_MS + Math.floor(Math.random() * 30000))
    // 消息级 ACK 簿记：'peerId:seq' -> {envelope, via, tries, timer}
    this.pendingAcks = new Map()
    // 会话恢复票据（仅内存）：peerIdPubHex -> {key, epoch, sendSeq, recvSeqMax}
    this.resumable = new Map()
    this.sessionResume = opts.sessionResume !== false // 默认启用（设置页可关）
    // 残身回收簿记：peerId -> ts（冷却期内不被摘要复种）；digestTries：间接介绍次数上限
    this.recentlyReaped = new Map()
    this.hsCooldown = new Map() // peerId -> 冷却截止 ts（连续握手失败）
    this.digestTries = new Map()
    this.relayStableSince = 0
    this._relayWasConn = false
    this.reapTimer = setInterval(() => this.reapGhosts(), REAP_INTERVAL_MS)

    // ---- MQTT 中继层（始终启用；forceRelay 时它是唯一传输）----
    this.relay = new RelayTransport({
      appId: APP_ID,
      roomId,
      brokerUrls: cfg.relayBrokers || DEFAULT_CONFIG.relayBrokers,
      myName,
      roomKey: this.roomKey,
      onAnnounce: (id, info) => this.onRelayAnnounce(id, info),
      onFrame: (from, kind, data) => this.onRelayFrame(from, kind, data),
      onPeerGone: (id) => this.onRelayGone(id),
      onPeerSuspect: (id) => this.onRelaySuspect(id),
      onLog: (m, lv) => this.hooks.onLog?.(m, lv),
    })

    // ---- WebRTC 层 ----
    if (!opts.forceRelay) {
      this.room = joinRoom(
        {
          appId: APP_ID,
          rtcConfig: cfg.rtcConfig,
          password: opts.roomPassword || undefined, // 信令加密 + 门禁
        },
        roomId,
        { onJoinError: (e) => this.hooks.onLog?.(`加入房间失败: ${e?.message || e}`, 'error') },
      )
      this.hsAction = this.room.makeAction('hs')
      this.msgAction = this.room.makeAction('m')
      this.ctlAction = this.room.makeAction('ctl')
      this.syncAction = this.room.makeAction('sync')
      this.fxAction = this.room.makeAction('fx') // 文件传输数据块（filex 模块）
      this.hsAction.onMessage = (data, ctx) => this.onHandshakeFrame(ctx.peerId, data, 'p2p')
      this.msgAction.onMessage = (data, ctx) => this.onEnvelope(ctx.peerId, data, 'p2p')
      this.ctlAction.onMessage = (data, ctx) => this.onControlFrame(ctx.peerId, data, 'p2p')
      this.syncAction.onMessage = (data, ctx) => this.onSyncFrame(ctx.peerId, data, 'p2p')
      this.fxAction.onMessage = (data, ctx) => this.onFxFrame(ctx.peerId, data, 'p2p')
      this.room.onPeerJoin = (peerId) => this.onPeerJoin(peerId)
      this.room.onPeerLeave = (peerId) => this.onPeerLeave(peerId)
      for (const peerId of Object.keys(this.room.getPeers?.() || {})) this.onPeerJoin(peerId)
      this.hooks.onLog?.(`已加入房间 ${roomId}（信令经公共 MQTT，selfId=${selfId.slice(0, 8)}…${opts.roomPassword ? '，口令保护已启用' : ''}）`)
    } else {
      this.hooks.onLog?.(`以纯中继模式加入房间 ${roomId}（--relay-only）`)
    }
    // 启动即归并"自己的旧身份"（种入的名字映射已就绪；幂等）
    this.mergeSelfIdentities()
  }

  // ---------- 会话键 ----------

  // 旧版私聊键迁移 + 污染清洗（幂等，每次启动执行）：
  // 迁移：64-hex 裸键（单侧公钥）按条目作者拆分重组；我方全局最小时的混桶中
  //       我方消息无法归属 → dm-legacy:orphan 隔离不展示
  // 清洗：旧版本对端同步曾把"其与第三方"的消息推进我们的分桶（跨桶污染）——
  //       把每个 dm: 桶中非本对作者的条目搬回该作者自己的对桶；我方重复 mid 只留一份
  migrateAndScrubDmKeys() {
    let migrated = 0, orphaned = 0
    for (const [key, conv] of [...this.store.convs]) {
      if (key === 'lobby' || key.startsWith('dm:') || key.startsWith('dm-unknown:') || key.startsWith('dm-legacy:')) continue
      if (!/^[0-9a-f]{64}$/.test(key)) continue
      const byPeer = new Map() // peerHex -> entries[]
      for (const e of conv.entries.values()) {
        if (!e.author) continue
        if (e.author === this.myIdPubHex) continue // 归属不明，见下
        if (!byPeer.has(e.author)) byPeer.set(e.author, [])
        byPeer.get(e.author).push(e)
      }
      const myEntries = [...conv.entries.values()].filter((e) => e.author === this.myIdPubHex)
      if (byPeer.size === 1 && key !== this.myIdPubHex) {
        // 干净场景：桶 = 我与该对端（含双方消息）
        const peerHex = byPeer.keys().next().value
        const nk = dmConvKey(this.myIdPubHex, peerHex)
        const tgt = this.store.convs.get(nk) || { entries: new Map(), dels: new Map(), clearT: 0 }
        for (const e of [...byPeer.get(peerHex), ...myEntries]) if (!tgt.entries.has(e.mid)) tgt.entries.set(e.mid, e)
        for (const [mid, t] of conv.dels) if (!tgt.dels.has(mid)) tgt.dels.set(mid, t)
        tgt.clearT = Math.max(tgt.clearT, conv.clearT)
        this.store.convs.set(nk, tgt)
        migrated++
      } else {
        // 混桶（我的公钥全局最小）：按对端拆分；我的消息进孤儿桶
        for (const [peerHex, entries] of byPeer) {
          const nk = dmConvKey(this.myIdPubHex, peerHex)
          const tgt = this.store.convs.get(nk) || { entries: new Map(), dels: new Map(), clearT: 0 }
          for (const e of entries) if (!tgt.entries.has(e.mid)) tgt.entries.set(e.mid, e)
          tgt.clearT = Math.max(tgt.clearT, conv.clearT)
          this.store.convs.set(nk, tgt)
          migrated++
        }
        if (myEntries.length) {
          const ok = `dm-legacy:orphan:${key.slice(0, 8)}`
          const o = { entries: new Map(myEntries.map((e) => [e.mid, e])), dels: new Map(), clearT: conv.clearT }
          this.store.convs.set(ok, o)
          orphaned += myEntries.length
        }
      }
      this.store.convs.delete(key)
    }
    // ---- 清洗：dm: 桶中非本对作者归位 + 我方重复 mid 去重 ----
    let moved = 0, deduped = 0
    const myMids = new Map() // mid -> bucketKey（我方消息首见桶）
    for (let pass = 0; pass < 2; pass++) {
      for (const [key, conv] of [...this.store.convs]) {
        if (key === 'lobby' || !key.startsWith('dm:')) continue
        for (const [mid, e] of [...conv.entries]) {
          if (e.author && e.author !== this.myIdPubHex) {
            const homeKey = dmConvKey(this.myIdPubHex, e.author)
            if (homeKey !== key) {
              const home = this.store.convs.get(homeKey) || { entries: new Map(), dels: new Map(), clearT: 0 }
              if (!home.entries.has(mid)) home.entries.set(mid, e)
              this.store.convs.set(homeKey, home)
              conv.entries.delete(mid)
              moved++
            }
          } else if (e.author === this.myIdPubHex) {
            const first = myMids.get(mid)
            if (first && first !== key) {
              conv.entries.delete(mid) // 我方消息已在别的桶（污染复制）→ 去重
              deduped++
            } else myMids.set(mid, key)
          }
        }
      }
    }
    if (moved || deduped) migrated = migrated // 计数并入下方日志

    const notices = []
    if (migrated || orphaned) notices.push(`私聊记录迁移完成：重组 ${migrated} 组会话${orphaned ? `；${orphaned} 条我方旧消息无法归属对端（已隔离）` : ''}`)
    if (moved || deduped) notices.push(`私聊记录清洗完成：${moved} 条他人消息归位、${deduped} 条重复消息去除`)
    if (notices.length) {
      for (const n of notices) this.hooks.onLog?.(n)
      this.hooks.onStoreNotice?.(notices.join('；'))
      this.hooks.onStorePersist?.(this.store.exportAll())
    }
  }

  // wireConv: 'lobby' | 'dm'（线上帧用）；本地存储键：'lobby' | 双方联合哈希（两端一致）
  storeKey(wireConv, peerId) {
    if (wireConv === 'lobby') return 'lobby'
    const peer = this.peers.get(peerId)
    // 键必须派生自对端「身份公钥」（稳定）；peerId 是本次连接的临时 ID，绝不能进键
    const peerHex = peer?.idPubHex || (peer?.ctx?.peerIdPub ? oc.hex(peer.ctx.peerIdPub) : null)
    if (!peerHex) return `dm-unknown:${peerId}` // 理论不可达：消息只发给/来自 ready 会话
    return dmConvKey(this.myIdPubHex, peerHex)
  }

  iAmInitiator(peerId) { return selfId < peerId }

  // make-before-break：就绪会话期间，任意传输路径的帧都接收 —— 发送方各自
  // 选路（升级有先后），接收方就绪即全收；同一 ctx 密钥下两路皆可信，
  // 重复帧由信封序号/帧 txid 去重兜住。非就绪（重握手中）严格匹配当前
  // 路径，避免旧会话的滞留帧干扰新握手。
  // （v1.12.2 曾用"宽限期旧路径"实现，但升级竞态下对端先切直连发送、
  //  本侧未升级即拒收 → 整段消息丢失；改为就绪全收。）
  acceptsVia(peer, via) {
    if (via === peer.via) return true
    return peer.state === 'ready'
  }

  ensurePeer(peerId, via) {
    let peer = this.peers.get(peerId)
    if (!peer) {
      const now = Date.now()
      peer = {
        via, state: 'connecting', pc: null, name: null, ctx: null,
        safety: null, path: 'unknown', pending: null, hsTimer: null, lastError: null,
        bornAt: now, lastProgress: now,
      }
      this.peers.set(peerId, peer)
      this.hooks.onPeerAdded?.(peerId, peer)
    }
    return peer
  }

  // ---------- WebRTC 侧事件 ----------

  onPeerJoin(peerId) {
    if (this.destroyed) return
    const existing = this.peers.get(peerId)
    if (existing) {
      // 中继会话对端现在可以直连了 → 升级
      if (existing.via === 'mqtt' && existing.lockVia !== 'mqtt') {
        existing.via = 'p2p'
        existing.pc = this.room.getPeers()[peerId] || null
        this.attachConnectionWatch(peerId)
        if (existing.state === 'ready') {
          this.hooks.onLog?.(`与 ${existing.name || peerId.slice(0, 8)}… 的会话已从中继升级为 P2P 直连`)
          this.hooks.onPathDetected?.(peerId, existing)
          this.detectPath(peerId)
        } else {
          this.restartHandshake(peerId, 'p2p')
        }
      }
      return
    }
    const peer = this.ensurePeer(peerId, 'p2p')
    peer.pc = this.room.getPeers()[peerId] || null
    this.attachConnectionWatch(peerId)
    this.startHandshake(peerId)
  }

  onPeerLeave(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer) return
    // 对端从 WebRTC 房间离开：若中继层仍见到其 presence，则降级到中继续命
    if (peer.via === 'p2p' && this.relay?.peers?.has(peerId) && !this.opts.forceRelay) {
      peer.via = 'mqtt'
      peer.pc = null
      peer.state = 'connecting'
      this.hooks.onLog?.(`对端 ${peer.name || peerId.slice(0, 8)}… 直连断开，降级到 MQTT 中继`)
      this.restartHandshake(peerId, 'mqtt')
      return
    }
    this.dropPeer(peerId, peer)
  }

  clearHsRetries(peer) {
    if (peer.hs3Retry) { clearInterval(peer.hs3Retry); peer.hs3Retry = null }
    if (peer.hs3ackRetry) { clearInterval(peer.hs3ackRetry); peer.hs3ackRetry = null }
  }

  dropPeer(peerId, peer) {
    if (peer.hsTimer) clearTimeout(peer.hsTimer)
    this.clearAcksFor(peerId)
    this.clearRetransmit(peer)
    this.clearHsRetries(peer)
    this.peers.delete(peerId)
    this.hooks.onPeerRemoved?.(peerId, peer)
  }

  // ---------- MQTT 中继侧事件 ----------

  onRelayAnnounce(peerId, info) {
    if (this.destroyed) return
    const existing = this.peers.get(peerId)
    if (existing) {
      // 对端仍在线但其会话曾失败（单向可见的根因之一）：借 presence 时机重新握手
      existing.lastProgress = Date.now() // presence 即存活证据（reapGhosts 不回收）
      // 对端仍在线但其会话曾失败（单向可见的根因之一）：借 presence 时机重新握手。
      // ⚠️ 限频 30s：否则 presence 每 10-30s 到达一次就重启一轮握手，条目在
      // 「协商中/握手失败」间永久震荡（v1.21.7 用户实测 xtx2 残身的成形机制）
      if (existing.state === 'failed' && existing.via !== 'p2p' && Date.now() - (existing.lastHsRetryAt || 0) > 30000) {
        existing.retried = false
        existing.lastError = null
        existing.lastHsRetryAt = Date.now()
        this.hooks.onLog?.(`对端 ${info.name || peerId.slice(0, 8)}… 仍在线，重试握手`)
        this.restartHandshake(peerId, 'mqtt')
      }
      return // 其余已有会话不动（P2P 优先）
    }
    // 注：连续握手失败不再拦截自动建联（v1.21.3 冷却曾致抖动网络下双方互等、
    // 传输死锁）——presence 活跃 = 对端在线，必须保持可恢复；离线残身由
    // reapGhosts 的 30s 快速回收兜住
    const peer = this.ensurePeer(peerId, 'mqtt')
    peer.name = info.name
    this.startHandshake(peerId)
  }

  onRelayFrame(from, kind, data) {
    const peer = this.peers.get(from)
    if (!peer || !this.acceptsVia(peer, 'mqtt')) return // 升级后旧中继帧在宽限期内仍接收（MBB）
    if (kind === 'hs') this.onHandshakeFrame(from, data, 'mqtt')
    else if (kind === 'msg') this.onEnvelope(from, data, 'mqtt')
    else if (kind === 'ctl') this.onControlFrame(from, data, 'mqtt')
    else if (kind === 'sync') this.onSyncFrame(from, data, 'mqtt')
    else if (kind === 'fx') this.onFxFrame(from, data, 'mqtt')
  }

  // 文件数据块 → filex 模块（会话就绪才收；发送方法 sendFx）
  onFxFrame(peerId, data, via) {
    const peer = this.peers.get(peerId)
    if (!peer || peer.state !== 'ready' || !this.filex) return
    void via
    this.filex.onFrame(peerId, data)
  }

  async sendFx(peerId, data, forceRelay = false) {
    const peer = this.peers.get(peerId)
    if (!peer || peer.state !== 'ready') throw new Error('会话未就绪')
    // forceRelay：p2p 零进展的传输兜底改走中继（接收方就绪会话两路全收）；
    // P2-3：文件帧 QoS 按配置（relayQos:1 时借 broker PUBACK 重传兜丢帧）
    if (peer.via === 'mqtt' || forceRelay) this.relay.send(peerId, 'fx', data, { qos: this.cfg?.relayQos || 0 })
    else await this.fxAction?.send(data, { target: peerId })
  }

  attachFilex(filex) { this.filex = filex }

  onRelayGone(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer) return
    if (peer.via !== 'mqtt') {
      // 中继视野已判死，但直连会话不轻动：标记怀疑交 reapGhosts 裁决 ——
      // pc 仍 connected 的是真直连（中继看不到也保留）；否则宽限期后回收。
      // （对端崩溃/断网时 WebRTC 往往没有 leave 事件，这是残身的主来源）
      if (peer.state === 'ready' && !peer.suspect) {
        peer.suspect = true
        peer.suspectAt = Date.now()
      }
      return
    }
    this.dropPeer(peerId, peer)
  }

  // SWIM 怀疑：presence 超时 → 先 ping 直接确认（20s 宽限期内可被 pong/digest 复活）
  onRelaySuspect(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer || peer.state !== 'ready') return
    peer.suspect = true
    peer.suspectAt = Date.now()
    this.hooks.onLog?.(`${peer.name || peerId.slice(0, 8)}… presence 超时，ping 确认中`, 'warn')
    try {
      const ping = { op: 'ping', n: oc.newMid() }
      if (peer.via === 'mqtt') this.relay.send(peerId, 'ctl', ping)
      else this.ctlAction?.send(ping, { target: peerId }).catch(() => {})
    } catch { /* 宽限期后由 prune 判死 */ }
  }

  // 周期性反熵：向随机就绪对端推送大厅+私聊全量状态（CRDT 幂等合并）
  runAntiEntropy() {
    if (this.destroyed) return
    const ready = this.readyPeerIds()
    if (!ready.length) return
    const peerId = ready[Math.floor(Math.random() * ready.length)]
    const name = this.peers.get(peerId)?.name || peerId.slice(0, 8)
    this.hooks.onLog?.(`反熵对账 → ${name}（全量状态同步）`)
    this.pushSync(peerId, 'lobby')
    this.pushSync(peerId, 'dm')
  }

  // ---------- E2EE 握手状态机（传输无关） ----------

  startHandshake(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer) return
    peer.state = 'handshaking'
    peer.lastProgress = Date.now()
    if (this.iAmInitiator(peerId)) {
      // 会话恢复：对该身份持有票据且启用时，hs1 附带 epoch 证明（对端不认则自动回退全握手）
      const ticket = this.sessionResume && peer.idPubHex ? this.resumable.get(peer.idPubHex) : null
      const { msg, pend } = oc.makeHs1(this.ident, this.myName, this.roomId, ticket)
      peer.pending = pend
      peer.role = 'initiator'
      this.sendHs(peerId, msg)
      // QoS0 传输可能丢帧：周期性重发 hs1 直到进入下一阶段（hs2 到达即清除）。
      // p2p 也启用（首轮 hs3 丢失的场景证明 WebRTC 数据通道同样会丢首帧）
      this.clearRetransmit(peer)
      let hsRetries = 0
      peer.hsRetransmit = setInterval(() => {
        if (peer.state !== 'handshaking' || !peer.pending) { this.clearRetransmit(peer); return }
        if (peer.via === 'mqtt' || hsRetries < 5) {
          hsRetries++
          this.sendHs(peerId, msg)
        } else this.clearRetransmit(peer)
      }, peer.via === 'mqtt' ? 3000 : 4000)
      this.hooks.onLog?.(`→ 向 ${peerId.slice(0, 8)}…（${peer.via}）发起 E2EE 握手 (hs1)`)
    } else {
      peer.role = 'responder'
      this.hooks.onLog?.(`← 等待 ${peerId.slice(0, 8)}…（${peer.via}）发起 E2EE 握手`)
    }
    if (peer.hsTimer) clearTimeout(peer.hsTimer)
    // 超时退避：连续失败的循环里若对端 RTT ≈ 超时值，迟到的 hs2 永远落在
    // 超时之后（帧被忽略→白等满超时→再重启）形成共振死循环——逐轮放大超时
    // 窗口（≤60s），让慢链路的 hs2 有机会落进窗口内完成握手
    const hsTimeout = Math.min(HANDSHAKE_TIMEOUT_MS * Math.pow(1.5, Math.max(0, (peer.hsCycles || 1) - 1)), 60000)
    peer.hsTimer = setTimeout(() => {
      if (peer.state !== 'ready') this.handleHandshakeTimeout(peerId)
    }, hsTimeout)
  }

  clearRetransmit(peer) {
    if (peer.hsRetransmit) { clearInterval(peer.hsRetransmit); peer.hsRetransmit = null }
  }

  restartHandshake(peerId, via) {
    const peer = this.peers.get(peerId)
    if (!peer) return
    this.clearAcksFor(peerId) // 旧会话 seq 作废，簿记一并清除
    this.clearRetransmit(peer)
    // 旧一轮握手的重发定时器必须随旧 ctx 一起作废：否则闭包里的旧 hs3/hs3ack
    // 会持续砸向已换新密钥的对端，HMAC 必然失配（v1.21.5 实测曾连杀三轮会话）
    this.clearHsRetries(peer)
    peer.lastHs1Key = null
    peer.cachedHs2 = null
    peer.via = via
    peer.ctx = null
    peer.pending = null
    // 连续失败轮次计数（markReady 归零）：驱动超时退避与 UI 诚实显示——
    // 对端 presence 仍在广播而握手始终不成时，条目会在「协商中/握手失败」
    // 间永久震荡（v1.21.7 用户实测 xtx2 残身），必须可见、可数、有退避
    peer.hsCycles = (peer.hsCycles || 0) + 1
    this.startHandshake(peerId)
  }

  // 中继模式握手超时：整体重试一次（丢帧自愈），再失败才放弃
  handleHandshakeTimeout(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer) return
    if (peer.via === 'p2p' && !this.opts.forceRelay && this.relay?.connected) {
      this.hooks.onLog?.(`P2P 握手超时，切换到 MQTT 中继回退 (${peerId.slice(0, 8)}…)`, 'warn')
      this.restartHandshake(peerId, 'mqtt')
      return
    }
    if (peer.via === 'mqtt' && !peer.retried) {
      peer.retried = true
      this.hooks.onLog?.(`中继握手超时，重试 (${peerId.slice(0, 8)}…)`, 'warn')
      this.restartHandshake(peerId, 'mqtt')
      return
    }
    this.clearRetransmit(peer)
    this.failHandshake(peerId, peer, '握手超时')
  }

  // 握手失败簿记：仅计数与诊断日志。不设自动建联冷却——presence 活跃的对端
  // 必须保持可恢复（v1.21.3 的冷却在抖动网络下致双方互等、传输死锁）
  failHandshake(peerId, peer, why) {
    peer.state = 'failed'
    peer.lastError = why
    this.clearHsRetries(peer)
    peer.hsFails = (peer.hsFails || 0) + 1
    if (peer.hsFails === HS_FAIL_MAX) {
      this.hooks.onLog?.(`${peer.name || peerId.slice(0, 8)}… 已连续 ${peer.hsFails} 次握手失败（对端在线时仍会持续重试）`, 'warn')
    }
    this.hooks.onPeerFailed?.(peerId, peer)
  }

  async sendHs(peerId, msg) {
    const peer = this.peers.get(peerId)
    if (!peer) return
    try {
      if (peer.via === 'mqtt') this.relay.send(peerId, 'hs', msg)
      else await this.hsAction?.send(msg, { target: peerId })
    } catch (e) { this.hooks.onLog?.(`握手帧发送失败: ${e?.message || e}`, 'error') }
  }

  onHandshakeFrame(peerId, msg, via) {
    let peer = this.peers.get(peerId)
    if (!peer) {
      // 对端主动发起握手（hs1）= 明确的在线意图：无条目也接受（并解除冷却）——
      // 否则冷却期会连"对方真正想连"的请求一起挡掉
      if (msg?.t !== 'OC-HS1-v1' || this.iAmInitiator(peerId)) return
      peer = this.ensurePeer(peerId, via)
    }
    if (peer.lockVia === 'mqtt' && via === 'p2p' && peer.state !== 'ready') return // goOnline 恢复期：p2p 帧不可信
    if (!this.acceptsVia(peer, via)) return
    peer.lastProgress = Date.now() // 握手有来有回 = 双方都活着（reapGhosts 不回收）
    try {
      if (msg.t === 'OC-HS1-v1') {
        if (this.iAmInitiator(peerId)) return // 双方角色规则一致，不应收到 hs1；忽略竞态帧
        // 重传幂等：同一 hs1（同签名）到达多次时，重发缓存的 hs2 ——
        // 否则每次都换新临时密钥，会与发起方已接受的 hs2 错位导致 HMAC 不匹配
        const hs1Key = `${msg.eph}|${msg.sig}`
        if (peer.lastHs1Key === hs1Key && peer.cachedHs2) {
          this.sendHs(peerId, peer.cachedHs2)
          return
        }
        const { msg: hs2, ctx, resumed } = oc.acceptHs1(this.ident, this.myName, this.roomId, msg, this.sessionResume ? this.resumable : null)
        peer.lastHs1Key = hs1Key
        peer.cachedHs2 = hs2
        peer.ctx = ctx
        peer.name = ctx.peerName
        // 身份公钥在握手验证通过（acceptHs1）时即学到，不必等 markReady：
        // 失败/超时的会话也要能按身份归组（UI 名录、去重、别名都以身份为键）
        peer.idPubHex = oc.hex(ctx.peerIdPub)
        if (resumed && this.resumable.get(oc.hex(ctx.peerIdPub))) {
          const tk = this.resumable.get(oc.hex(ctx.peerIdPub))
          ctx.sendSeq = tk.sendSeq || 0
          ctx.recvSeqMax = tk.recvSeqMax || 0 // 序号续接：ACK/去重窗口无缝
          peer.resumed = true
        }
        this.sendHs(peerId, hs2)
        this.hooks.onLog?.(`收到 hs1，已回 hs2（对端=${ctx.peerName}，${via}）`)
      } else if (msg.t === 'OC-HS2-v1') {
        if (peer.role !== 'initiator' || !peer.pending) return // 迟到/重复的 hs2：静默忽略
        this.clearRetransmit(peer) // hs2 已到，停止重传 hs1
        const { msg: hs3, ctx, resumed } = oc.acceptHs2(this.ident, peer.pending, msg)
        const pendTicket = peer.pending?.resumeTicket
        peer.pending = null
        peer.ctx = ctx
        peer.name = ctx.peerName
        peer.idPubHex = oc.hex(ctx.peerIdPub) // 同上：握手验证通过即学到身份
        if (resumed && pendTicket) {
          ctx.sendSeq = pendTicket.sendSeq || 0
          ctx.recvSeqMax = pendTicket.recvSeqMax || 0
          peer.resumed = true
        }
        this.sendHs(peerId, hs3)
        // hs3 丢了响应方不会就绪并重发 hs1：发起方在就绪前重发 hs3
        if (!peer.hs3Retry) {
          peer.hs3Retry = setInterval(() => {
            if (this.peers.get(peerId)?.state === 'ready') { clearInterval(peer.hs3Retry); peer.hs3Retry = null; return }
            this.sendHs(peerId, hs3)
          }, 2500)
        }
        this.hooks.onLog?.(`收到 hs2，已回 hs3（对端=${ctx.peerName}，${via}）`)
      } else if (msg.t === 'OC-HS3-v1') {
        const { msg: hs3ack } = oc.acceptHs3(peer.ctx, msg)
        this.sendHs(peerId, hs3ack)
        this.markReady(peerId) // 响应方在回完 hs3ack 后同样进入就绪
        // hs3ack 丢了发起方不会就绪并重发 hs3：响应方在就绪前短暂重发 hs3ack
        if (peer.via === 'mqtt' && !peer.hs3ackRetry) {
          peer.hs3ackRetry = setInterval(() => {
            if (this.peers.get(peerId)?.state === 'ready') { clearInterval(peer.hs3ackRetry); peer.hs3ackRetry = null; return }
            this.sendHs(peerId, hs3ack)
          }, 2500)
        }
      } else if (msg.t === 'OC-HS3ACK-v1') {
        oc.acceptHs3ack(peer.ctx, msg)
        this.markReady(peerId)
      } else {
        throw new Error(`未知握手帧 ${msg?.t}`)
      }
    } catch (e) {
      // 握手帧校验失败 ≠ 会话失败：帧可能来自已被 restartHandshake 作废的旧轮次
      // （传输抖动换路时必有在途旧帧），也可能只是重复帧。failHandshake 在这里会
      // 误杀已经 ready 的活会话（v1.21.5 实测：DM 发送循环被炸、删除传播停摆）。
      // 握手成败只由 hsTimer 超时裁决，这里一律警告并保持现状。
      const st = peer.state === 'ready' ? '会话保持' : '等待超时裁决'
      this.hooks.onLog?.(`忽略无效握手帧 (${peerId.slice(0, 8)}…, ${st}): ${e?.message || e}`, 'warn')
    }
  }

  markReady(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer || !peer.ctx) return
    if (peer.state === 'ready') return // 重复 hs3/hs3ack 幂等
    peer.state = 'ready'
    peer.suspect = false
    peer.suspectAt = 0
    peer.hsFails = 0
    peer.hsCycles = 0 // 握手完成：连续失败轮次与退避一并归零
    peer.lastHsRetryAt = 0
    peer.idPubHex = oc.hex(peer.ctx.peerIdPub)
    // 传输改绑：发送中的事务绑定的是旧 peerId——对端重启后以同身份、新 peerId
    // 回来，事务若不改绑就成了孤儿（块发给死会话、offer 走死通道被静默丢弃）
    if (this.filex?.tx?.size) {
      for (const tx of this.filex.tx.values()) {
        if (tx.state === 'active' && tx.peerPub && tx.peerPub === peer.idPubHex && tx.peerId !== peerId) {
          this.hooks.onLog?.(`传输 ${tx.name}：对端以同身份重连，改绑到新会话继续`, 'warn')
          tx.peerId = peerId
          tx.inflight?.clear()
        }
      }
    }
    peer.lastSeen = Date.now()
    peer.lastProgress = Date.now()
    this.digestTries.delete(peerId) // 会话已建立：间接介绍计数清零
    this.dedupeIdentity(peerId, peer)
    this.mergeOldIdentities(peer)
    if (peer.ctx.peerName) this.peerNames.set(peer.idPubHex, peer.ctx.peerName)
    // 会话恢复票据：当前密钥/epoch/序号（仅内存；重连时免 X25519 且序号续接）
    if (this.sessionResume) {
      const prevEpoch = this.resumable.get(peer.idPubHex)?.epoch || 0
      this.resumable.set(peer.idPubHex, {
        key: peer.ctx.key,
        epoch: peer.resumed ? (prevEpoch + 1) : 1,
        sendSeq: peer.ctx.sendSeq,
        recvSeqMax: peer.ctx.recvSeqMax,
      })
      if (this.resumable.size > 64) this.resumable.delete(this.resumable.keys().next().value)
    }
    if (peer.resumed) {
      this.hooks.onLog?.(`与 ${peer.name || peerId.slice(0, 8)}… 会话恢复成功（epoch ${this.resumable.get(peer.idPubHex)?.epoch}，序号续接）`)
      if (this.hooks.onSessionResumed) this.hooks.onSessionResumed(peerId, peer)
      peer.resumed = false
    }
    peer.safety = oc.safetyNumber(this.ident.edPub, peer.ctx.peerIdPub)
    if (peer.hsTimer) clearTimeout(peer.hsTimer)
    this.clearRetransmit(peer)
    this.clearHsRetries(peer)
    peer.lockVia = null
    if (peer.via === 'p2p') {
      peer.candidates = this.candidateSummary(peer)
      this.detectPath(peerId)
    } else {
      peer.path = 'relay-mqtt'
      peer.candidates = null
    }
    this.hooks.onPeerReady?.(peerId, peer)
    this.filex?.onSessionReady?.(peerId) // 文件传输：接收方重广播位图（断线自动续传）
    // 上线全局同步：就绪即向对端推送大厅与私聊状态（对端同样推给我，双向合并收敛）
    this.pushSync(peerId, 'lobby')
    this.pushSync(peerId, 'dm')
  }

  // 从本地 SDP 统计已收集的候选类型（host=局域网 srflx=STUN打洞 relay=TURN中继）
  candidateSummary(peer) {
    const counts = { host: 0, srflx: 0, prflx: 0, relay: 0 }
    try {
      const sdp = peer.pc?.localDescription?.sdp || ''
      for (const m of sdp.matchAll(/a=candidate:.*\btyp (\w+)/g)) {
        if (m[1] in counts) counts[m[1]]++
      }
    } catch { /* 忽略 */ }
    return counts
  }

  // 检测当前通路：host/srflx = 直连 P2P；relay = TURN 中继
  async detectPath(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer?.pc) return
    const report = async (attempt) => {
      try {
        const stats = await peer.pc.getStats()
        let pair = null
        const cands = new Map()
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && (r.selected || r.state === 'succeeded' || r.nominated)) pair = r
          if (r.type === 'local-candidate') cands.set(r.id, r)
        })
        if (pair) {
          const local = cands.get(pair.localCandidateId)
          const via = local?.candidateType === 'relay' ? 'relay' : 'direct'
          peer.path = via
          peer.pathDetail = { localType: local?.candidateType, proto: local?.protocol || local?.mediaType }
          this.hooks.onPathDetected?.(peerId, peer)
        } else if (attempt < 6 && this.peers.get(peerId) === peer) {
          setTimeout(() => report(attempt + 1), 2000)
        }
      } catch { /* 统计失败不影响聊天 */ }
    }
    setTimeout(() => report(0), 500)
  }

  // ---------- 消息收发（大厅 / 私聊） ----------

  onEnvelope(peerId, envelope, via) {
    const peer = this.peers.get(peerId)
    if (!peer?.ctx || !this.acceptsVia(peer, via)) {
      this.hooks.onLog?.(`收到未握手对端 ${peerId.slice(0, 8)}… 的消息，已丢弃`, 'warn')
      return
    }
    // 重复帧（多链路并联/发送端 ACK 重传）按序号识别：静默补 ACK 让对端停止重传
    try {
      const { text, t, mid, conv } = oc.open(peer.ctx, envelope)
      peer.lastSeen = Date.now()
      peer.lastProgress = Date.now()
      this.relay?.markAlive(peerId) // 消息到达 = 存活证据（撤销 SWIM 怀疑）
      if (mid) {
        this.store.addMsg(this.storeKey(conv, peerId), {
          mid, author: peer.idPubHex || oc.hex(peer.ctx.peerIdPub), text, t,
        })
      }
      this.sendAckBack(peerId, envelope.s, via)
      this.hooks.onMessage?.(peerId, peer, { conv, text, mid, t })
    } catch (e) {
      if (/序号/.test(String(e?.message))) {
        this.sendAckBack(peerId, envelope.s, via) // 重复帧：补 ACK，不告警
        return
      }
      this.hooks.onLog?.(`解密失败（密文被篡改或密钥不一致）：${e?.message || e}`, 'error')
    }
  }

  // ---------- 消息级 ACK（QoS0 之上的应用层送达保证） ----------

  sendAckBack(peerId, seq, via) {
    const peer = this.peers.get(peerId)
    if (!peer || peer.state !== 'ready' || !seq) return
    try {
      const frame = { op: 'ack', k: seq }
      if (via === 'mqtt') this.relay.send(peerId, 'ctl', frame)
      else this.ctlAction?.send(frame, { target: peerId }).catch(() => {})
    } catch { /* ACK 失败无妨，发送端超时重传 */ }
  }

  trackAck(peerId, envelope, via) {
    const key = `${peerId}:${envelope.s}`
    const entry = { envelope, via, tries: 0, timer: null }
    const fire = () => {
      const cur = this.pendingAcks.get(key)
      if (!cur) return
      if (cur.tries >= ACK_MAX_RETRIES) {
        this.pendingAcks.delete(key)
        this.hooks.onLog?.(`消息未收到确认（已重试 ${ACK_MAX_RETRIES} 次）：可能未送达 ${this.peers.get(peerId)?.name || peerId.slice(0, 8)}…`, 'warn')
        return
      }
      cur.tries++
      try {
        if (cur.via === 'mqtt') this.relay.send(peerId, 'msg', cur.envelope)
        else this.msgAction?.send(cur.envelope, { target: peerId }).catch(() => {})
      } catch { /* 链路断开：保留簿记，链路恢复后对端上线同步兜底 */ }
      cur.timer = setTimeout(fire, ACK_TIMEOUT_MS)
    }
    entry.timer = setTimeout(fire, ACK_TIMEOUT_MS)
    this.pendingAcks.set(key, entry)
  }

  clearAcksFor(peerId) {
    for (const [key, a] of this.pendingAcks) {
      if (key.startsWith(`${peerId}:`)) {
        clearTimeout(a.timer)
        this.pendingAcks.delete(key)
      }
    }
  }

  // 发送消息。onWireSend 收到的是加密后的线上信封（明文不出现在其中）
  async sendMessage(target, text, wireConv = 'dm') {
    const targets = target === 'all'
      ? this.readyPeerIds()
      : (this.peers.get(target)?.state === 'ready' ? [target] : [])
    if (target !== 'all' && targets.length === 0) throw new Error('对端尚未建立加密会话')
    const mid = oc.newMid()
    const t = Date.now()
    // 先落自己的共享日志（大厅即使暂无在线成员也全体保存，待对端上线经同步扩散）
    this.store.addMsg(this.storeKey(wireConv, target), {
      mid, author: this.myIdPubHex, text, t,
    })
    for (const peerId of targets) {
      const peer = this.peers.get(peerId)
      const envelope = oc.seal(peer.ctx, text, wireConv, mid, t)
      this.hooks.onWireSend?.(peerId, envelope)
      if (peer.via === 'mqtt') this.relay.send(peerId, 'msg', envelope)
      else await this.msgAction.send(envelope, { target: peerId })
      this.trackAck(peerId, envelope, peer.via) // 未确认则 3s 重传（最多 3 次）
    }
    return { mid, count: targets.length }
  }

  // 兼容旧接口：send = 私聊（1:1）
  async send(peerId, text) { return this.sendMessage(peerId, text, 'dm') }

  // ---------- 群体删除 / 清空（任何成员可发起，全体生效） ----------

  async sendCtl(peerId, frame) {
    const peer = this.peers.get(peerId)
    if (!peer || peer.state !== 'ready') return
    if (peer.via === 'mqtt') this.relay.send(peerId, 'ctl', frame)
    else await this.ctlAction?.send(frame, { target: peerId })
  }

  // wireConv='lobby' → 广播给所有就绪成员；'dm' → 仅发给该对端。
  // del/clear 幂等且必须送达：三重发送（QoS0 丢帧兜底，间隔 400ms）
  async propagateCtl(wireConv, frame, onlyPeer) {
    const targets = wireConv === 'lobby' ? this.readyPeerIds() : [onlyPeer]
    const important = frame?.op === 'del' || frame?.op === 'clear'
    for (const peerId of targets) {
      for (let i = 0; i < (important ? 3 : 1); i++) {
        try { await this.sendCtl(peerId, frame) } catch (e) {
          this.hooks.onLog?.(`删除指令发送失败: ${e?.message || e}`, 'warn')
        }
        if (important && i < 2) await new Promise((r) => setTimeout(r, 400))
      }
      // 状态兜底推送（ctl 丢失也能靠同步收敛）
      this.pushSync(peerId, wireConv)
    }
  }

  // 删除单条消息（发起方调用）：本地先生效 + 全体传播。
  // 私聊在合并视图下可能来自旧身份分桶：按 mid 对全部相关桶生效（mid 全局唯一）
  async deleteMessage(wireConv, mid, onlyPeer) {
    if (wireConv === 'dm') {
      const pub = this.peers.get(onlyPeer)?.idPubHex
      if (pub) { for (const k of this.dmMergedBucketKeys(pub)) this.store.applyDel(k, mid) }
      else this.store.applyDel(this.storeKey(wireConv, onlyPeer), mid)
    } else {
      this.store.applyDel(this.storeKey(wireConv, onlyPeer), mid)
    }
    await this.propagateCtl(wireConv, { conv: wireConv, op: 'del', mid }, onlyPeer)
  }

  // 清空整个会话（发起方调用）：私聊清空需覆盖合并视图的全部相关桶
  async clearConv(wireConv, onlyPeer) {
    const clearT = Date.now()
    if (wireConv === 'dm') {
      const pub = this.peers.get(onlyPeer)?.idPubHex
      if (pub) { for (const k of this.dmMergedBucketKeys(pub)) this.store.applyClear(k, clearT) }
      else this.store.applyClear(this.storeKey(wireConv, onlyPeer), clearT)
    } else {
      this.store.applyClear(this.storeKey(wireConv, onlyPeer), clearT)
    }
    await this.propagateCtl(wireConv, { conv: wireConv, op: 'clear', t: clearT }, onlyPeer)
  }

  onControlFrame(peerId, frame, via) {
    const peer = this.peers.get(peerId)
    if (!peer || !this.acceptsVia(peer, via) || peer.state !== 'ready') return
    if (frame?.op?.startsWith?.('fx-')) { this.filex?.onCtl(peerId, frame); return } // 文件传输控制
    if (frame?.op === 'presence') { // 在线报告（含 SWIM 摘要）
      peer.lastSeen = Date.now()
      peer.lastProgress = Date.now()
      this.relay?.markAlive(peerId) // 心跳即存活证据（SWIM：任意消息撤销怀疑）
      this.hooks.onPresence?.(peerId, peer)
      this.absorbDigest(peerId, frame.digest)
      return
    }
    if (frame?.op === 'ping') { // SWIM 直接探测：立即回 pong
      try {
        const pong = { op: 'pong', n: frame.n }
        if (via === 'mqtt') this.relay.send(peerId, 'ctl', pong)
        else this.ctlAction?.send(pong, { target: peerId }).catch(() => {})
      } catch { /* 忽略 */ }
      return
    }
    if (frame?.op === 'pong') { // 被怀疑方回声：撤销怀疑
      peer.suspect = false
      this.relay?.markAlive(peerId)
      this.hooks.onLog?.(`${peer.name || peerId.slice(0, 8)}… ping 确认存活`)
      return
    }
    if (frame?.op === 'ack' && frame.k !== undefined) { // 消息送达确认
      const key = `${peerId}:${frame.k}`
      const a = this.pendingAcks.get(key)
      if (a) {
        clearTimeout(a.timer)
        this.pendingAcks.delete(key)
        this.hooks.onAck?.(peerId, frame.k)
      }
      return
    }
    if (frame?.op === 'rehandshake') { // 对端请求重新握手（其为本房间握手发起方）
      this.hooks.onLog?.(`对端请求重新握手 (${peerId.slice(0, 8)}…)`)
      this.restartHandshake(peerId, via)
      return
    }
    const wireConv = frame?.conv === 'lobby' ? 'lobby' : 'dm'
    const key = this.storeKey(wireConv, peerId)
    let applied = false
    if (frame.op === 'del' && frame.mid) applied = this.store.applyDel(key, frame.mid)
    else if (frame.op === 'clear' && frame.t) applied = this.store.applyClear(key, Number(frame.t))
    this.hooks.onControl?.(peerId, peer, { ...frame, wireConv, applied })
  }

  // ---------- 上线全局同步 ----------

  async pushSync(peerId, wireConv) {
    const peer = this.peers.get(peerId)
    if (!peer || peer.state !== 'ready') return
    const state = this.store.exportConv(this.storeKey(wireConv, peerId))
    // 附带作者昵称映射：接收端无需与作者直接握手即可解析历史消息的显示名
    const names = {}
    for (const e of state.entries) {
      const n = this.peerNames.get(e.author)
      if (n) names[e.author] = n
    }
    const frame = { conv: wireConv, state, names }
    try {
      if (peer.via === 'mqtt') this.relay.send(peerId, 'sync', frame)
      else await this.syncAction?.send(frame, { target: peerId })
    } catch (e) { this.hooks.onLog?.(`同步帧发送失败: ${e?.message || e}`, 'warn') }
  }

  onSyncFrame(peerId, frame, via) {
    const peer = this.peers.get(peerId)
    if (!peer || !this.acceptsVia(peer, via) || peer.state !== 'ready') return
    const wireConv = frame?.conv === 'lobby' ? 'lobby' : 'dm'
    const key = this.storeKey(wireConv, peerId)
    let state = frame.state
    if (wireConv === 'dm' && state?.entries?.length) {
      // 私聊会话只接受"我 ↔ 本对端"两方的条目：旧版本对端的混桶可能携带
      // 其与第三方的消息（旧键碰撞时代的遗留），混入即污染本对端会话
      const me = this.myIdPubHex
      const peerHex = peer.idPubHex
      const filtered = state.entries.filter((e) => !e?.author || e.author === me || e.author === peerHex)
      if (filtered.length !== state.entries.length) {
        this.hooks.onLog?.(`忽略 dm 同步中 ${state.entries.length - filtered.length} 条第三方消息（旧版混桶污染）`, 'warn')
        state = { ...state, entries: filtered }
      }
    }
    const changed = this.store.applyState(key, state)
    // 合并对端传播的昵称映射（gossip；仅显示用途）
    if (frame.names && typeof frame.names === 'object') {
      for (const [id, n] of Object.entries(frame.names)) {
        if (typeof n !== 'string' || !n) continue
        if (this.peerNames.get(id) !== n) this.peerNames.set(id, n)
        this.hooks.onPeerName?.(peerId, peer, id, n)
      }
      this.mergeSelfIdentities() // 名字认知更新后重扫"自己的旧身份"（幂等）
    }
    this.hooks.onSyncApplied?.(peerId, peer, { wireConv, changed, state: frame.state })
  }

  // ---------- 连接监测 / 在线心跳 / 重连 ----------

  // 监听 WebRTC 连接状态：网络拓扑变化（断网、切换 Wi-Fi、NAT 重映射）时触发
  attachConnectionWatch(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer?.pc || peer.pc.__orayWatch) return
    peer.pc.__orayWatch = true
    peer.pc.addEventListener?.('connectionstatechange', () => {
      const cur = this.peers.get(peerId)
      if (!cur || cur !== peer) return
      const st = peer.pc.connectionState
      if (st === 'connected') {
        if (cur.state === 'ready') this.hooks.onConnectionRestored?.(peerId, cur)
      } else if (st === 'disconnected' || st === 'failed' || st === 'closed') {
        if (cur.state === 'ready') this.handleConnectionDrop(peerId, st)
      }
    })
  }

  // 直连掉线：优先自动降级到 MQTT 中继继续聊天，同时通知 UI 提示重连
  handleConnectionDrop(peerId, st) {
    const peer = this.peers.get(peerId)
    if (!peer) return
    if (peer.via === 'p2p' && !this.opts.forceRelay && this.relay?.connected) {
      this.hooks.onLog?.(`直连 ${st}，自动切换中继 (${peerId.slice(0, 8)}…)`, 'warn')
      this.restartHandshake(peerId, 'mqtt')
      this.hooks.onConnectionLost?.(peerId, peer, '直连已断开（网络变化？），正在经中继自动重连…')
      return
    }
    // 中继也不可用（网络拓扑变化会同时切断两者）：主动上线自愈 ——
    // 重建中继连接并恢复所有会话；窗口开着的桌面端此前没有任何触发源
    if (!this.opts.forceRelay && !this.relay?.connected && !this.goOnlineInflight) {
      this.goOnlineInflight = true
      this.hooks.onConnectionLost?.(peerId, peer, '网络已变化，正在自动重新上线…')
      this.goOnline(`连接断开（${st}）且中继离线`)
      setTimeout(() => { this.goOnlineInflight = false }, 30000) // 限频 30s
      return
    }
    peer.state = 'failed'
    peer.lastError = `连接断开（${st}）`
    this.hooks.onConnectionLost?.(peerId, peer, '连接已断开，请点击“重新连接”')
    this.hooks.onPeerFailed?.(peerId, peer)
  }

  // 手动重连：发起方直接重新握手；响应方发 rehandshake 指令请对方发起
  async reconnect(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer) return
    if (peer.state === 'ready' && peer.via === 'p2p') {
      peer.pc?.restartIce?.() // 已就绪：只做 ICE 重启尝试升级/修复路径
      this.detectPath(peerId)
      return
    }
    this.reconnectBanner = true
    if (this.iAmInitiator(peerId)) {
      this.restartHandshake(peerId, peer.via)
    } else {
      await this.sendCtl(peerId, { op: 'rehandshake' })
    }
  }

  // 定期在线报告
  sendPresenceHeartbeat() {
    if (this.destroyed) return
    const now = Date.now()
    // SWIM 风格 gossip：心跳捎带「我看到的在线成员摘要」（selfId+名字），
    // 接收端 diff 后对缺失成员主动发起连接 —— 解决"部分机器看不到某些人"的
    // 收敛问题（A、B 都连着 C 却互相不知晓时，由 C 的摘要完成间接介绍）。
    const digest = [...this.peers.entries()]
      .filter(([, p]) => p.state === 'ready')
      .map(([pid, p]) => `${pid}|${encodeURIComponent(p.name || '')}`)
    digest.push(`${selfId}|${encodeURIComponent(this.myName)}`) // 含自己
    for (const [peerId, peer] of this.peers) {
      if (peer.state !== 'ready') continue
      try {
        const frame = { conv: 'dm', op: 'presence', t: now, digest }
        if (peer.via === 'mqtt') this.relay.send(peerId, 'ctl', frame)
        else this.ctlAction?.send(frame, { target: peerId }).catch(() => {})
      } catch { /* 心跳失败静默，下轮再报 */ }
    }
    this.hooks.onPresenceSent?.([...this.peers.values()].filter((p) => p.state === 'ready').length)
  }

  // 收到对端心跳摘要：发现"对方看到在线、我却没有会话"的成员 → 主动握手
  absorbDigest(fromPeerId, digest) {
    if (!Array.isArray(digest)) return
    for (const entry of digest) {
      const [pid, encName] = String(entry).split('|')
      if (!pid || pid === selfId) continue
      // SWIM 复活：第三方仍看到他在线 → 撤销我方怀疑（ping-req 的等价实现）
      const known = this.relay?.peers?.get(pid)
      if (known?.suspectSince) this.relay.markAlive(pid)
      if (this.recentlyReaped.has(pid)) continue // 刚回收的残身：冷却期内不被摘要复种
      const name = decodeURIComponent(encName || '')
      const existing = this.peers.get(pid)
      if (!existing) {
        if ((this.digestTries.get(pid) || 0) >= 2) continue // 多次间接介绍未果：不再复种
        this.digestTries.set(pid, (this.digestTries.get(pid) || 0) + 1)
        // 间接发现（第三方的介绍）：与该成员建立中继握手
        this.hooks.onLog?.(`经 ${this.peers.get(fromPeerId)?.name || fromPeerId.slice(0, 8)}… 的摘要发现 ${name || pid.slice(0, 8)}… 在线，主动连接`)
        const peer = this.ensurePeer(pid, 'mqtt')
        if (name) peer.name = name
        this.startHandshake(pid)
      } else if (existing.state === 'failed') {
        // 与 presence 触发同款限频：第三方摘要只证明对端对别人 ready，不证明
        // 握手能成——不设限频会 15s 一轮永久重启（震荡残身）
        if (Date.now() - (existing.lastHsRetryAt || 0) > 30000) {
          existing.retried = false
          existing.lastError = null
          existing.lastHsRetryAt = Date.now()
          this.restartHandshake(pid, 'mqtt')
        }
      }
    }
  }

  // 失败会话重试：仍在对端 presence 认知里的才值得重试（TTL 30s 内见过）
  retryFailedSessions() {
    if (this.destroyed) return
    for (const [peerId, peer] of this.peers) {
      if (peer.state !== 'failed') continue
      // presence（TTL 过期即清除）是在线权威证据；Trystero 的 room 条目在对端
      // 崩溃/断网后长期滞留，若据此重试会把 lastProgress 无限刷新——回收器
      // 永不触发（"建联中"残身的根源）
      if (!this.relay?.peers?.has(peerId)) continue
      peer.retried = false
      peer.lastError = null
      this.hooks.onLog?.(`周期重试失败会话 (${peer.name || peerId.slice(0, 8)}…)`)
      this.restartHandshake(peerId, peer.via === 'p2p' && this.room?.getPeers?.()?.[peerId] ? 'p2p' : 'mqtt')
    }
  }

  // ---- 残身回收（v1.14.0）----

  // 同一身份重新上线：peerId 每次启动随机，握手学到 idPubHex 即可确认
  // 「新旧条目是同一个人」→ 立即清理旧 peerId 条目（对端重启场景，残身秒清）。
  // 同名接管：本产品昵称即登录账号；同名的 failed/handshaking 旧条目（重装换
  // 身份密钥、握手早断）且中继视野里已无 presence → 一并清理。两台设备同名
  // 且都 ready 的合法场景不受影响。
  dedupeIdentity(peerId, peer) {
    for (const [pid, p] of [...this.peers.entries()]) {
      if (pid === peerId || p === peer) continue
      const sameIdentity = p.idPubHex && p.idPubHex === peer.idPubHex
      const knownName = p.name || (p.idPubHex ? this.peerNames.get(p.idPubHex) : null)
      const sameName = peer.name && knownName === peer.name && p.state !== 'ready'
      // 同名接管不再要求"中继视野无 presence"（v1.22.2）：设备重启后旧连接
      // 条目的 presence 残留在 TTL 内，会把清理挡住 → 用户看到同名双条目
      // （旧条目握手早期失败时连身份公钥都没学到，sameIdentity 也救不了）。
      // 昵称即账号：我刚与这个名字完成全新加密握手，旧的非 ready 条目即视为
      // 旧连接清理；真有两台同名活设备，被清的那台会经 presence 重启握手自愈
      if (sameIdentity || sameName) {
        this.hooks.onLog?.(`同一${sameIdentity ? '身份' : '昵称'}经新连接上线，清理旧会话条目（${knownName || pid.slice(0, 8)}…）`)
        this.dropPeer(pid, p)
      }
    }
  }

  // ---- 旧身份归并（v1.15.0）----
  // 重装/清数据会生成新身份密钥：同一昵称（本产品昵称即账号）的旧公钥在
  // 名录里变成多条"历史联系人"、聊天记录被拆进不同分桶。这里建立
  // 旧身份 → 当前活身份的别名，驱动「读时合并」：名录只显示当前身份、
  // 会话视图把所有相关分桶合并成一条时间线。原始桶不动、可回退
  // （清 oc-id-aliases 即还原）。
  //
  // 别名只在两个可信时机建立：
  //   - mergeOldIdentities：E2EE 握手就绪（名字受签名保护）——同昵称的
  //     非活跃身份即此人的旧身份；当前另有就绪会话的除外（同名另一台活设备）
  //   - mergeSelfIdentities：与我同名的其他身份即我自己的旧身份（否则
  //     自己的残身会出现在名录里）；当前有就绪会话的除外（同名好友防误并）

  resolveId(pub) {
    let cur = String(pub || '')
    for (let hops = 0; hops < 8 && this.idAliases.has(cur); hops++) cur = this.idAliases.get(cur)
    return cur
  }

  // 会话视图键：以解析后的「当前身份」计算（旧身份的新消息也归到同一视图键 → 未读/渲染一致）
  dmViewKey(peerPub) { return dmConvKey(this.myIdPubHex, this.resolveId(peerPub)) }

  // 归并到该会话的全部存储桶键：{我 ∪ 我的旧身份} × {对端 ∪ 对端的旧身份}
  dmMergedBucketKeys(peerPub) {
    const P = this.resolveId(peerPub)
    const side = (canon) => [canon, ...[...this.idAliases].filter(([, c]) => this.resolveId(c) === canon).map(([o]) => o)]
    const keys = new Set()
    for (const a of side(this.myIdPubHex)) for (const b of side(P)) keys.add(dmConvKey(a, b))
    return keys
  }

  hasReadySession(idPubHex) {
    for (const p of this.peers.values()) if (p.state === 'ready' && p.idPubHex === idPubHex) return true
    return false
  }

  mergeOldIdentities(peer) {
    const name = this.peerNames.get(peer.idPubHex) || peer.name
    if (!name) return
    let merged = 0
    for (const [pub, n] of this.peerNames) {
      if (n !== name || pub === peer.idPubHex || pub === this.myIdPubHex) continue
      if (this.resolveId(pub) === peer.idPubHex) continue // 已归并
      // 同名（昵称即账号）一律并入刚完成握手的新身份：多设备/重装都是同一个人，
      // 记录合并为一条时间线正是预期；名录侧仍对"当前有就绪会话"的旧身份保留单列
      this.idAliases.set(pub, peer.idPubHex)
      merged++
    }
    if (merged) this.commitAliases(`${name} 的 ${merged} 个旧身份已并入当前会话（重装/换设备的记录合并显示）`)
  }

  mergeSelfIdentities() {
    let merged = 0
    for (const [pub, n] of this.peerNames) {
      if (n !== this.myName || pub === this.myIdPubHex) continue
      if (this.resolveId(pub) === this.myIdPubHex) continue
      if (this.hasReadySession(pub)) continue // 同名好友当前在线：不误并
      this.idAliases.set(pub, this.myIdPubHex)
      merged++
    }
    if (merged) this.commitAliases(`检测到自己的 ${merged} 个旧身份（本机重装/换密钥），已并入当前身份`)
  }

  // 拍平别名链（old→中间 → old→最终）并通知持久化 + 界面横条
  commitAliases(notice) {
    for (const old of [...this.idAliases.keys()]) {
      this.idAliases.set(old, this.resolveId(this.idAliases.get(old)))
    }
    this.hooks.onLog?.(notice)
    this.hooks.onStoreNotice?.(notice)
    this.hooks.onIdAliases?.(Object.fromEntries(this.idAliases))
  }

  // 回收判据（两条可靠证据链须同时成立）：
  //   1) 中继视野（我方 relay 稳定在线 ≥ 预热期）里已无他的 presence ——
  //      presence TTL + 怀疑宽限早已过，他确实不在了；
  //   2) 直连通道也不是 connected。
  // 真直连（中继看不到但 pc connected）与仍在广播 presence 的一律保留。
  // 回收的 peerId 进冷却名单，digest 摘要在冷却期内不再据此复种新条目。
  reapGhosts() {
    if (this.destroyed) return
    const now = Date.now()
    const conn = !!this.relay?.connected
    if (conn && !this._relayWasConn) this.relayStableSince = now
    if (!conn) this.relayStableSince = 0
    this._relayWasConn = conn
    for (const [pid, ts] of this.recentlyReaped) if (now - ts > REAP_COOLDOWN_MS) this.recentlyReaped.delete(pid)
    // 我方中继不在线/刚连上：视野不可信，本轮不回收
    if (!conn || !this.relayStableSince || now - this.relayStableSince < RELAY_VIEW_WARMUP_MS) return
    for (const [peerId, peer] of [...this.peers.entries()]) {
      // 传输保护：文件传输中大块帧会把心跳挤到延迟（QoS0 拥堵），看似"未报告"
      // 实则忙 —— 此时判死拆会话会让 ACK 断流、传输卡死在半路
      if (this.filex?.hasActiveTransfer?.(peerId)) continue
      const pcAlive = !!peer.pc && peer.pc.connectionState === 'connected'
      // pcAlive 免死只适用于 ready 会话：对端 app 已关时 WebRTC 通道可能长时间
      // 僵尸 connected（ICE 保活未超时），非就绪条目没有可保护的数据流，却被它
      // 挡住回收、同时握手超时不断重启——「协商中（第 N 次尝试）」永生（用户实测 xfold6 手机离线）
      if (peer.state === 'ready' && pcAlive) continue
      if (this.relay?.peers?.has(peerId)) continue // 仍在广播 presence：真在线（哪怕握手失败）
      if (peer.state === 'ready') {
        // 已建立会话：我方中继视野需稳定（预热门）+ 怀疑宽限期，才判死
        if (!conn || !this.relayStableSince || now - this.relayStableSince < RELAY_VIEW_WARMUP_MS) continue
        const since = peer.suspectAt || 0
        if (since) {
          if (now - since > GHOST_GRACE_MS) this.dropGhost(peerId, peer, '对端已下线（中继视野消失且直连断开）')
        } else {
          peer.suspect = true // 未经过怀疑流程（如纯 p2p 会话）：观察一个宽限期，UI 同步显示怀疑态
          peer.suspectAt = now
        }
      } else if (now - (peer.lastProgress || peer.bornAt || now) > GHOST_FAST_MS) {
        // 未就绪条目（建联中/握手失败）：本就无数据流动，30s 无进展即回收——
        // presence 过期与否都不影响（presence 过期另有 onRelayGone 快速路径）
        this.dropGhost(peerId, peer, peer.state === 'failed' ? '会话失败且对端已离线' : '握手无进展且对端已离线')
      }
    }
  }

  dropGhost(peerId, peer, why) {
    this.recentlyReaped.set(peerId, Date.now())
    this.hooks.onLog?.(`清理残身：${peer.name || peerId.slice(0, 8)}…（${why}）→ 移入历史联系人`, 'warn')
    this.dropPeer(peerId, peer)
  }

  // ---------- 直连升级（自动 + 手动） ----------

  // 中继就绪会话的直连升级探测：
  //   - Trystero 侧已打通 → 立即升级为直连
  //   - Trystero 侧存在但未连上 → restartIce 重试（限频，每对端 ≥3 分钟一次）
  probeDirectUpgrades() {
    if (this.destroyed || !this.room) return
    const now = Date.now()
    for (const [peerId, peer] of this.peers) {
      if (peer.state !== 'ready' || peer.via !== 'mqtt') continue
      const tPeer = this.room.getPeers?.()[peerId]
      const pc = tPeer?.pc || tPeer
      if (!pc) continue
      if (pc.connectionState === 'connected') {
        this.onPeerJoin(peerId) // 触发升级分支（幂等）
      } else if (now - (peer.lastDirectProbe || 0) > 180000) {
        peer.lastDirectProbe = now
        pc.restartIce?.()
        this.hooks.onLog?.(`直连升级探测：ICE 重启 (${peerId.slice(0, 8)}…)`)
      }
    }
  }

  // 手动触发直连升级，返回 {ok, detail}；成功后会话原密钥无缝切到直连
  async tryDirect(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer || peer.state !== 'ready') throw new Error('对端尚未建立加密会话')
    if (this.opts.forceRelay) throw new Error('当前为纯中继模式（--relay-only），无法直连')

    if (peer.via === 'p2p') {
      peer.pc?.restartIce?.()
      await this.waitForIceResult(peerId, 10000)
      this.detectPath(peerId)
      const ok = peer.path === 'direct'
      return { ok, detail: ok ? '已重新协商为直连' : `ICE 重启完成，当前路径：${peer.path === 'relay' ? '中继' : peer.path}` }
    }

    const tPeer = this.room?.getPeers?.()[peerId]
    const pc = tPeer?.pc || tPeer
    if (!pc) {
      throw new Error('信令尚未互见（双方会继续自动重试）；若跨网络且无法打洞，只能走中继')
    }
    pc.restartIce?.()
    const connected = await this.waitForIceResult(peerId, 15000, pc)
    if (!connected) {
      const detail = 'ICE 重启后仍未打通（可能为对称 NAT 且无可用 TURN）'
      this.hooks.onLog?.(detail, 'warn')
      return { ok: false, detail }
    }
    // 打通了：走与自动升级相同的分支
    this.onPeerJoin(peerId)
    await this.waitForIceResult(peerId, 5000)
    this.detectPath(peerId)
    return { ok: true, detail: '已升级为 P2P 直连' }
  }

  // 等待指定 peer 的通路达到 connected，最多 timeoutMs；pcOverride 指定监测对象
  async waitForIceResult(peerId, timeoutMs, pcOverride) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const pc = pcOverride || this.peers.get(peerId)?.pc
      if (pc?.connectionState === 'connected') return true
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  // ---------- 主动上线（移动端待机恢复 / 网络切换） ----------

  // 统一上线入口：强制重建中继连接 + 全部会话按中继重新握手 + 重同步。
  // 直连（p2p）会话若 WebRTC 仍存活则只补同步；否则切中继（直连后续自动升级回来）。
  goOnline(reason = 'manual') {
    this.hooks.onGoOnline?.(reason)
    this.hooks.onLog?.(`主动上线（${reason}）：重建中继连接并重新握手`, 'warn')
    const wasRelayConnected = this.relay?.connected
    this.relay.forceReconnect()
    // 中继重建瞬间连接不稳定：等连上后再发起重握手（否则新 hs1 首帧易丢）
    const kickoff = () => {
      for (const [peerId, peer] of [...this.peers.entries()]) {
        const pcAlive = peer.pc && peer.pc.connectionState === 'connected'
        if (pcAlive) {
          // 直连仍存活：会话密钥有效，只补同步错过的消息
          this.pushSync(peerId, 'lobby')
          this.pushSync(peerId, 'dm')
          continue
        }
        this.restartHandshake(peerId, 'mqtt') // 先走中继恢复会话，直连恢复后自动升级
      }
    }
    if (wasRelayConnected && this.relay?.connected) {
      this.hooks.onLog?.(`goOnline kickoff：${this.peers.size} 个会话待恢复`)
      for (const peerId of this.peers.keys()) this.peers.get(peerId).lockVia = 'mqtt'
      kickoff()
    } else {
      // 等中继真正连上（forceReconnect 已重置连接），最多 30s
      const start = Date.now()
      const t = setInterval(() => {
        if (this.relay?.connected || Date.now() - start > 30000) {
          clearInterval(t)
          this.hooks.onLog?.(`goOnline kickoff（等待分支，${Math.round((Date.now() - start) / 1000)}s）：${this.peers.size} 个会话待恢复`)
          for (const peerId of this.peers.keys()) this.peers.get(peerId).lockVia = 'mqtt'
          kickoff()
        }
      }, 500)
    }
  }

  // 回到前台：中继掉线即主动上线
  onVisible() {
    if (this.destroyed) return
    if (!this.relay?.connected && !this.opts.forceRelay) this.goOnline('回到前台且中继离线')
    else if (!this.relay?.connected) this.goOnline('回到前台且中继离线')
  }

  readyPeerIds() {
    return [...this.peers.entries()].filter(([, p]) => p.state === 'ready').map(([id]) => id)
  }

  destroy() {
    this.destroyed = true
    clearInterval(this.sweepTimer)
    clearInterval(this.heartbeatTimer)
    clearInterval(this.retryFailedTimer)
    clearInterval(this.antiEntropyTimer)
    clearInterval(this.reapTimer)
    for (const [, a] of this.pendingAcks) clearTimeout(a.timer)
    this.pendingAcks.clear()
    clearInterval(this.directProbeTimer)
    try { this.room?.leave() } catch { /* 忽略 */ }
    this.relay?.destroy()
  }
}

export { selfId }
