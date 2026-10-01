// oraychat MQTT 中继回退层（多 broker 并联版）
// 背景：经实测（tools/turn-hunt.mjs / Chromium ICE 探测），当前所有免注册的
// 公共 TURN（Open Relay 等）凭据已在服务端失效 —— "免费公共中继"是本项目
// 真正的难点。本模块给出可靠替代：
//
//   P2P 打洞失败时，同样的 E2EE 加密信封改经免费公共 MQTT broker 中继。
//   - 复用信令层已验证的公共 broker（broker-cn.emqx.io 等，WSS 加密）
//   - broker 只能看到收件人 topic 与密文，无法读到任何明文（应用层 E2EE 不变）
//   - 每 10s 在 presence topic 广播在线状态；每人在自己的 inbox topic 收信
//
// 并联架构（Nostr 生态同款思路，v1.11.0）：
//   - 同时维持最多 N（默认 2）条 broker 连接，各自订阅相同 topic
//   - 发送随机挑一条活链路；presence 广播发到所有活链路
//   - 接收按帧 txid 去重 —— 任一 broker 宕机/抖动对上层零感知
//   - 单链路独立指数退避自愈；全部链路死亡时整体退避重建
//
// 成员认知（presence 表）带 SWIM 式怀疑状态：
//   - TTL 到期不直接判死，先标 suspect 并回调 onPeerSuspect（由上层 ping 确认）
//   - 再收到 presence / 上层 markAlive 即复活；SUSPECT_MS 后仍无音讯才判死
//
// topic 布局（appId/room 隔离不同群组）：
//   oraychat-relay/{appId}/{room}/presence      — 在线广播 {id, name}
//   oraychat-relay/{appId}/{room}/inbox/{id}    — 定向投递 {from, txid, kind, data}

import mqtt from 'mqtt'
import { selfId } from '@trystero-p2p/mqtt'
import * as oc from './crypto.mjs'

const PRESENCE_INTERVAL_MS = 10000
const PRESENCE_TTL_MS = 30000
const TTL_MIN_MS = 15000
const TTL_MAX_MS = 90000
const ARRIVAL_HISTORY = 10

// 简化 φ-accrual：按各端 presence 实际到达节奏自适应判离线阈值
// ttl = clamp(avg*2 + 4*stddev, 15s, 90s)；样本不足时退回固定 30s
function adaptiveTtl(entry) {
  const h = entry.arrivals
  if (!h || h.length < 3) return PRESENCE_TTL_MS
  const avg = h.reduce((a, b) => a + b, 0) / h.length
  const varr = h.reduce((a, b) => a + (b - avg) ** 2, 0) / h.length
  return Math.max(TTL_MIN_MS, Math.min(TTL_MAX_MS, avg * 2 + 4 * Math.sqrt(varr)))
}
const SUSPECT_MS = 20000 // 怀疑 → 判死的宽限期（期间可被 ping/digest 复活）
const DEDUP_WINDOW_MS = 60000
const DEFAULT_PARALLEL = 2

export class RelayTransport {
  constructor({ appId, roomId, brokerUrls, myName, roomKey, instanceId, parallel, onAnnounce, onFrame, onPeerGone, onPeerSuspect, onLog }) {
    this.appId = appId
    this.roomId = roomId
    this.selfId = instanceId || selfId // 可注入实例 ID（便于同进程测试）
    this.roomKey = roomKey || null // 房间口令派生密钥：presence/inbox 帧加密 + 门禁
    this.myName = myName || '未知用户'
    this.onAnnounce = onAnnounce
    this.onFrame = onFrame
    this.onPeerGone = onPeerGone
    this.onPeerSuspect = onPeerSuspect
    this.onLog = onLog || (() => {})
    this.peers = new Map() // selfId -> {name, lastSeen, suspectSince}
    this.closed = false
    this.brokerUrls = brokerUrls?.length ? brokerUrls : ['wss://broker-cn.emqx.io:8084/mqtt']
    this.links = new Map() // url -> {client, alive, attempts}
    this.seenTx = new Map() // txid -> ts（多链路重复帧去重）
    // 并联数不超过 broker 数
    this.parallelN = Math.max(1, Math.min(parallel || DEFAULT_PARALLEL, this.brokerUrls.length))
    for (let i = 0; i < this.parallelN; i++) this.spawnLink(this.brokerUrls[i])
    // P2-5 抖动广播：10±2s 随机间隔（防多端同步广播的雷群效应）
    const scheduleAnnounce = () => {
      if (this.closed) return
      const jitter = PRESENCE_INTERVAL_MS + (Math.random() * 4000 - 2000)
      this.presenceTimer = setTimeout(() => { this.announce(); scheduleAnnounce() }, jitter)
    }
    scheduleAnnounce()
    this.pruneTimer = setInterval(() => this.prune(), 5000)
    this.dedupTimer = setInterval(() => {
      const now = Date.now()
      for (const [tx, ts] of this.seenTx) if (now - ts > DEDUP_WINDOW_MS) this.seenTx.delete(tx)
    }, 15000)
  }

  static topics(appId, roomId) {
    const base = `oraychat-relay/${appId}/${roomId}`
    return {
      presence: `${base}/presence`,
      inbox: (id) => `${base}/inbox/${id}`,
    }
  }

  aliveLinks() { return [...this.links.values()].filter((l) => l.alive) }

  spawnLink(url, retry) {
    if (this.closed) return
    if (!url) return
    const { presence, inbox } = RelayTransport.topics(this.appId, this.roomId)
    let client
    try {
      client = mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: 8000, keepalive: 30 })
    } catch { this.scheduleLinkRetry(url, retry); return }
    const link = { client, alive: false, attempts: 0 }
    this.links.set(url, link)
    client.on('connect', () => {
      link.alive = true
      link.attempts = 0
      this.onLog(`MQTT 中继链路已连接 ${url}（并联 ${this.aliveLinks().length} 条）`)
      client.subscribe([presence, inbox(this.selfId)], (err) => {
        if (err) { this.onLog(`中继订阅失败 ${url}: ${err.message}`, 'warn'); return }
        this.announce()
      })
    })
    client.on('message', (topic, payload) => this.onMessage(topic, payload))
    client.on('error', () => { /* close 会跟随触发 */ })
    client.on('close', () => {
      link.alive = false
      if (this.closed) return
      const alive = this.aliveLinks().length
      if (alive > 0) {
        this.onLog(`中继链路断开 ${url}（仍有 ${alive} 条并联存活）`, 'warn')
      } else {
        this.onLog(`中继链路断开 ${url}（全部并联已断）`, 'warn')
      }
      this.scheduleLinkRetry(url, retry)
    })
  }

  scheduleLinkRetry(url, retry) {
    if (this.closed) return
    const link = this.links.get(url)
    const attempts = (link?.attempts || 0) + 1
    if (link) link.attempts = attempts
    const delay = retry ?? Math.min(60000, 3000 * 2 ** Math.min(attempts - 1, 4))
    setTimeout(() => { if (!this.closed) this.spawnLink(url) }, delay)
  }

  onMessage(topic, payload) {
    // 有口令的房间：帧整体加密，口令不符（解密失败）即丢弃 —— 无口令者无法注入有效帧
    let msg
    try { msg = oc.openRoom(this.roomKey, JSON.parse(payload.toString())) } catch { return }
    if (!msg) return
    if (topic === RelayTransport.topics(this.appId, this.roomId).presence) {
      if (!msg?.id || msg.id === this.selfId) return
      const known = this.peers.has(msg.id)
      const prev = this.peers.get(msg.id)
      const now = Date.now()
      const arrivals = prev?.arrivals?.slice(-ARRIVAL_HISTORY + 1) || []
      if (prev?.lastSeen && now > prev.lastSeen) arrivals.push(now - prev.lastSeen)
      this.peers.set(msg.id, { name: String(msg.name || '未知用户'), lastSeen: now, suspectSince: null, arrivals })
      if (!known) this.onAnnounce?.(msg.id, this.peers.get(msg.id))
    } else if (topic === RelayTransport.topics(this.appId, this.roomId).inbox(this.selfId)) {
      if (!msg?.from || msg.from === this.selfId) return
      // 多链路去重：同一 txid 只处理一次（旧版本无 txid 的帧照常处理）
      if (msg.txid) {
        if (this.seenTx.has(msg.txid)) return
        this.seenTx.set(msg.txid, Date.now())
      }
      this.onFrame?.(msg.from, msg.kind, msg.data)
    }
  }

  announce() {
    const frame = oc.sealRoom(this.roomKey, { id: this.selfId, name: this.myName || '未知用户' })
    const body = JSON.stringify(frame)
    const { presence } = RelayTransport.topics(this.appId, this.roomId)
    for (const l of this.aliveLinks()) {
      try { l.client.publish(presence, body) } catch { /* 该链路随后自愈 */ }
    }
  }

  prune() {
    const now = Date.now()
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > adaptiveTtl(p) && !p.suspectSince) {
        p.suspectSince = now
        this.onPeerSuspect?.(id) // SWIM 怀疑标记：交上层 ping/digest 确认
      } else if (p.suspectSince && now - p.suspectSince > SUSPECT_MS) {
        this.peers.delete(id)
        this.onPeerGone?.(id)
      }
    }
  }

  // 上层确认存活（pong / 第三方摘要）：撤销怀疑
  markAlive(id) {
    const p = this.peers.get(id)
    if (p && p.suspectSince) {
      p.suspectSince = null
      p.lastSeen = Date.now()
      this.onLog(`成员 ${String(id).slice(0, 8)}… 确认存活（怀疑撤销）`)
    }
  }

  // 主动重连（App 从待机恢复、网络切换时调用）：全部链路推倒重来
  forceReconnect() {
    if (this.closed) return
    for (const [url, l] of this.links) {
      l.alive = false
      try { l.client?.end(true) } catch { /* 忽略 */ }
    }
    this.links.clear()
    for (let i = 0; i < this.parallelN; i++) this.spawnLink(this.brokerUrls[i], 500)
  }

  // 运行时并入新的 broker 链（v1.23.0 私有中继服务：主机接入本地 hub、或成员
  // 中途采纳房间内分享的私有链）。去重；并联数随链数增长（本地链零成本）
  addBroker(url) {
    if (!url || this.closed || this.brokerUrls.includes(url)) return false
    this.brokerUrls.push(url)
    this.parallelN = Math.min(this.parallelN + 1, this.brokerUrls.length)
    this.spawnLink(url)
    this.onLog(`并入中继链路 ${url}（并联 ${this.parallelN} 条）`)
    return true
  }

  get connected() { return this.aliveLinks().length > 0 }

  send(peerId, kind, data, opts = {}) {
    const alive = this.aliveLinks()
    if (!alive.length) throw new Error('MQTT 中继未连接（所有并联链路断开）')
    const link = alive[Math.floor(Math.random() * alive.length)] // 随机分流
    const { inbox } = RelayTransport.topics(this.appId, this.roomId)
    const frame = oc.sealRoom(this.roomKey, { from: this.selfId, txid: oc.newMid(), kind, data })
    // P2-3：QoS 可选（默认 0；文件帧可按配置走 QoS1 借 broker 重传兜丢帧，
    // 我们协议层的 txid 去重保证恰好一次语义）
    link.client.publish(inbox(peerId), JSON.stringify(frame), { qos: opts.qos || 0 })
  }

  setName(name) { this.myName = name; this.announce() }

  destroy() {
    this.closed = true
    clearInterval(this.presenceTimer)
    clearInterval(this.pruneTimer)
    clearInterval(this.dedupTimer)
    for (const [, l] of this.links) {
      l.alive = false
      try { l.client?.end(true) } catch { /* 忽略 */ }
    }
    this.links.clear()
  }
}
