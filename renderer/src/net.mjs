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
const SWEEP_INTERVAL_MS = 30 * 60 * 1000
const PRESENCE_HEARTBEAT_MS = 15000

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

    // 房间口令：Trystero 信令加密 + 门禁；并派生房间密钥加密中继回退层帧
    this.roomKey = oc.deriveRoomKey(opts.roomPassword, APP_ID, roomId)

    // 共享消息日志（大厅 + 私聊），持久化由 hooks 接到 localStorage
    this.store = new LogStore({
      persist: (all) => this.hooks.onStorePersist?.(all),
      load: () => this.hooks.onStoreLoad?.(),
    })
    this.store.onChange((convKey) => this.hooks.onStoreChanged?.(convKey))
    this.sweepTimer = setInterval(() => this.store.sweep(), SWEEP_INTERVAL_MS)
    // 在线状态心跳：定期向所有就绪对端报告（对端据此显示在线状态与断线）
    this.heartbeatTimer = setInterval(() => this.sendPresenceHeartbeat(), PRESENCE_HEARTBEAT_MS)
    // 直连升级探测：中继会话每 45s 静默检查一次 Trystero 侧是否已打通/可重试
    this.directProbeTimer = setInterval(() => this.probeDirectUpgrades(), 45000)

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
      this.hsAction.onMessage = (data, ctx) => this.onHandshakeFrame(ctx.peerId, data, 'p2p')
      this.msgAction.onMessage = (data, ctx) => this.onEnvelope(ctx.peerId, data, 'p2p')
      this.ctlAction.onMessage = (data, ctx) => this.onControlFrame(ctx.peerId, data, 'p2p')
      this.syncAction.onMessage = (data, ctx) => this.onSyncFrame(ctx.peerId, data, 'p2p')
      this.room.onPeerJoin = (peerId) => this.onPeerJoin(peerId)
      this.room.onPeerLeave = (peerId) => this.onPeerLeave(peerId)
      for (const peerId of Object.keys(this.room.getPeers?.() || {})) this.onPeerJoin(peerId)
      this.hooks.onLog?.(`已加入房间 ${roomId}（信令经公共 MQTT，selfId=${selfId.slice(0, 8)}…${opts.roomPassword ? '，口令保护已启用' : ''}）`)
    } else {
      this.hooks.onLog?.(`以纯中继模式加入房间 ${roomId}（--relay-only）`)
    }
  }

  // ---------- 会话键 ----------

  // wireConv: 'lobby' | 'dm'（线上帧用）；本地存储键：'lobby' | 双方公钥字典序较小者（两端一致）
  storeKey(wireConv, peerId) {
    if (wireConv === 'lobby') return 'lobby'
    const peer = this.peers.get(peerId)
    const peerHex = peer?.idPubHex || (peer?.ctx?.peerIdPub ? oc.hex(peer.ctx.peerIdPub) : peerId)
    return dmConvKey(this.myIdPubHex, peerHex)
  }

  iAmInitiator(peerId) { return selfId < peerId }

  ensurePeer(peerId, via) {
    let peer = this.peers.get(peerId)
    if (!peer) {
      peer = {
        via, state: 'connecting', pc: null, name: null, ctx: null,
        safety: null, path: 'unknown', pending: null, hsTimer: null, lastError: null,
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
      if (existing.via === 'mqtt') {
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

  dropPeer(peerId, peer) {
    if (peer.hsTimer) clearTimeout(peer.hsTimer)
    this.clearRetransmit(peer)
    this.peers.delete(peerId)
    this.hooks.onPeerRemoved?.(peerId, peer)
  }

  // ---------- MQTT 中继侧事件 ----------

  onRelayAnnounce(peerId, info) {
    if (this.destroyed) return
    const existing = this.peers.get(peerId)
    if (existing) return // 已有会话（P2P 优先）
    const peer = this.ensurePeer(peerId, 'mqtt')
    peer.name = info.name
    this.startHandshake(peerId)
  }

  onRelayFrame(from, kind, data) {
    const peer = this.peers.get(from)
    if (!peer || peer.via !== 'mqtt') return // 会话已升级/切换到 P2P：丢弃过期帧
    if (kind === 'hs') this.onHandshakeFrame(from, data, 'mqtt')
    else if (kind === 'msg') this.onEnvelope(from, data, 'mqtt')
    else if (kind === 'ctl') this.onControlFrame(from, data, 'mqtt')
    else if (kind === 'sync') this.onSyncFrame(from, data, 'mqtt')
  }

  onRelayGone(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer || peer.via !== 'mqtt') return
    this.dropPeer(peerId, peer)
  }

  // ---------- E2EE 握手状态机（传输无关） ----------

  startHandshake(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer) return
    peer.state = 'handshaking'
    if (this.iAmInitiator(peerId)) {
      const { msg, pend } = oc.makeHs1(this.ident, this.myName, this.roomId)
      peer.pending = pend
      peer.role = 'initiator'
      this.sendHs(peerId, msg)
      // QoS0 传输可能丢帧：周期性重发 hs1 直到进入下一阶段（hs2 到达即清除）
      if (peer.via === 'mqtt') {
        this.clearRetransmit(peer)
        peer.hsRetransmit = setInterval(() => {
          if (peer.state === 'handshaking' && peer.pending) this.sendHs(peerId, msg)
        }, 3000)
      }
      this.hooks.onLog?.(`→ 向 ${peerId.slice(0, 8)}…（${peer.via}）发起 E2EE 握手 (hs1)`)
    } else {
      peer.role = 'responder'
      this.hooks.onLog?.(`← 等待 ${peerId.slice(0, 8)}…（${peer.via}）发起 E2EE 握手`)
    }
    if (peer.hsTimer) clearTimeout(peer.hsTimer)
    peer.hsTimer = setTimeout(() => {
      if (peer.state !== 'ready') this.handleHandshakeTimeout(peerId)
    }, HANDSHAKE_TIMEOUT_MS)
  }

  clearRetransmit(peer) {
    if (peer.hsRetransmit) { clearInterval(peer.hsRetransmit); peer.hsRetransmit = null }
  }

  restartHandshake(peerId, via) {
    const peer = this.peers.get(peerId)
    if (!peer) return
    this.clearRetransmit(peer)
    peer.lastHs1Key = null
    peer.cachedHs2 = null
    peer.via = via
    peer.ctx = null
    peer.pending = null
    this.startHandshake(peerId)
  }

  // 中继模式握手超时：整体重试一次（丢帧自愈），再失败才放弃
  handleHandshakeTimeout(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer) return
    if (peer.via === 'p2p' && !this.opts.forceRelay && this.relay?.client?.connected) {
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
    peer.state = 'failed'
    peer.lastError = '握手超时'
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
    const peer = this.peers.get(peerId)
    if (!peer || peer.via !== via) return
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
        const { msg: hs2, ctx } = oc.acceptHs1(this.ident, this.myName, this.roomId, msg)
        peer.lastHs1Key = hs1Key
        peer.cachedHs2 = hs2
        peer.ctx = ctx
        peer.name = ctx.peerName
        this.sendHs(peerId, hs2)
        this.hooks.onLog?.(`收到 hs1，已回 hs2（对端=${ctx.peerName}，${via}）`)
      } else if (msg.t === 'OC-HS2-v1') {
        if (peer.role !== 'initiator' || !peer.pending) return // 迟到/重复的 hs2：静默忽略
        this.clearRetransmit(peer) // hs2 已到，停止重传 hs1
        const { msg: hs3, ctx } = oc.acceptHs2(this.ident, peer.pending, msg)
        peer.pending = null
        peer.ctx = ctx
        peer.name = ctx.peerName
        this.sendHs(peerId, hs3)
        this.hooks.onLog?.(`收到 hs2，已回 hs3（对端=${ctx.peerName}，${via}）`)
      } else if (msg.t === 'OC-HS3-v1') {
        const { msg: hs3ack } = oc.acceptHs3(peer.ctx, msg)
        this.sendHs(peerId, hs3ack)
        this.markReady(peerId) // 响应方在回完 hs3ack 后同样进入就绪
      } else if (msg.t === 'OC-HS3ACK-v1') {
        oc.acceptHs3ack(peer.ctx, msg)
        this.markReady(peerId)
      } else {
        throw new Error(`未知握手帧 ${msg?.t}`)
      }
    } catch (e) {
      peer.state = 'failed'
      peer.lastError = e?.message || String(e)
      this.hooks.onLog?.(`握手失败 (${peerId.slice(0, 8)}…): ${peer.lastError}`, 'error')
      this.hooks.onPeerFailed?.(peerId, peer)
    }
  }

  markReady(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer || !peer.ctx) return
    if (peer.state === 'ready') return // 重复 hs3/hs3ack 幂等
    peer.state = 'ready'
    peer.idPubHex = oc.hex(peer.ctx.peerIdPub)
    peer.lastSeen = Date.now()
    if (peer.ctx.peerName) this.peerNames.set(peer.idPubHex, peer.ctx.peerName)
    peer.safety = oc.safetyNumber(this.ident.edPub, peer.ctx.peerIdPub)
    if (peer.hsTimer) clearTimeout(peer.hsTimer)
    this.clearRetransmit(peer)
    if (peer.via === 'p2p') {
      peer.candidates = this.candidateSummary(peer)
      this.detectPath(peerId)
    } else {
      peer.path = 'relay-mqtt'
      peer.candidates = null
    }
    this.hooks.onPeerReady?.(peerId, peer)
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
    if (!peer?.ctx || peer.via !== via) {
      this.hooks.onLog?.(`收到未握手对端 ${peerId.slice(0, 8)}… 的消息，已丢弃`, 'warn')
      return
    }
    try {
      const { text, t, mid, conv } = oc.open(peer.ctx, envelope)
      peer.lastSeen = Date.now()
      if (mid) {
        this.store.addMsg(this.storeKey(conv, peerId), {
          mid, author: peer.idPubHex || oc.hex(peer.ctx.peerIdPub), text, t,
        })
      }
      this.hooks.onMessage?.(peerId, peer, { conv, text, mid, t })
    } catch (e) {
      this.hooks.onLog?.(`解密失败（密文被篡改或密钥不一致）：${e?.message || e}`, 'error')
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

  // wireConv='lobby' → 广播给所有就绪成员；'dm' → 仅发给该对端
  async propagateCtl(wireConv, frame, onlyPeer) {
    const targets = wireConv === 'lobby' ? this.readyPeerIds() : [onlyPeer]
    for (const peerId of targets) {
      try { await this.sendCtl(peerId, frame) } catch (e) {
        this.hooks.onLog?.(`删除指令发送失败: ${e?.message || e}`, 'warn')
      }
      // 状态兜底推送（ctl 丢失也能靠同步收敛）
      this.pushSync(peerId, wireConv)
    }
  }

  // 删除单条消息（发起方调用）：本地先生效 + 全体传播
  async deleteMessage(wireConv, mid, onlyPeer) {
    this.store.applyDel(this.storeKey(wireConv, onlyPeer), mid)
    await this.propagateCtl(wireConv, { conv: wireConv, op: 'del', mid }, onlyPeer)
  }

  // 清空整个会话（发起方调用）
  async clearConv(wireConv, onlyPeer) {
    const clearT = Date.now()
    this.store.applyClear(this.storeKey(wireConv, onlyPeer), clearT)
    await this.propagateCtl(wireConv, { conv: wireConv, op: 'clear', t: clearT }, onlyPeer)
  }

  onControlFrame(peerId, frame, via) {
    const peer = this.peers.get(peerId)
    if (!peer || peer.via !== via || peer.state !== 'ready') return
    if (frame?.op === 'presence') { // 在线报告
      peer.lastSeen = Date.now()
      this.hooks.onPresence?.(peerId, peer)
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
    if (!peer || peer.via !== via || peer.state !== 'ready') return
    const wireConv = frame?.conv === 'lobby' ? 'lobby' : 'dm'
    const key = this.storeKey(wireConv, peerId)
    const changed = this.store.applyState(key, frame.state)
    // 合并对端传播的昵称映射（gossip；仅显示用途）
    if (frame.names && typeof frame.names === 'object') {
      for (const [id, n] of Object.entries(frame.names)) {
        if (typeof n !== 'string' || !n) continue
        if (this.peerNames.get(id) !== n) this.peerNames.set(id, n)
        this.hooks.onPeerName?.(peerId, peer, id, n)
      }
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
    if (peer.via === 'p2p' && !this.opts.forceRelay && this.relay?.client?.connected) {
      this.hooks.onLog?.(`直连 ${st}，自动切换中继 (${peerId.slice(0, 8)}…)`, 'warn')
      this.restartHandshake(peerId, 'mqtt')
      this.hooks.onConnectionLost?.(peerId, peer, '直连已断开（网络变化？），正在经中继自动重连…')
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
    for (const [peerId, peer] of this.peers) {
      if (peer.state !== 'ready') continue
      try {
        if (peer.via === 'mqtt') this.relay.send(peerId, 'ctl', { conv: 'dm', op: 'presence', t: now })
        else this.ctlAction?.send({ op: 'presence', t: now }, { target: peerId }).catch(() => {})
      } catch { /* 心跳失败静默，下轮再报 */ }
    }
    this.hooks.onPresenceSent?.([...this.peers.values()].filter((p) => p.state === 'ready').length)
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

  readyPeerIds() {
    return [...this.peers.entries()].filter(([, p]) => p.state === 'ready').map(([id]) => id)
  }

  destroy() {
    this.destroyed = true
    clearInterval(this.sweepTimer)
    clearInterval(this.heartbeatTimer)
    clearInterval(this.directProbeTimer)
    try { this.room?.leave() } catch { /* 忽略 */ }
    this.relay?.destroy()
  }
}

export { selfId }
