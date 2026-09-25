// oraychat MQTT 中继回退层
// 背景：经实测（tools/turn-hunt.mjs / Chromium ICE 探测），当前所有免注册的
// 公共 TURN（Open Relay 等）凭据已在服务端失效 —— "免费公共中继"是本项目
// 真正的难点。本模块给出可靠替代：
//
//   P2P 打洞失败时，同样的 E2EE 加密信封改经免费公共 MQTT broker 中继。
//   - 复用信令层已验证的公共 broker（broker-cn.emqx.io 等，WSS 加密）
//   - broker 只能看到收件人 topic 与密文，无法读到任何明文（应用层 E2EE 不变）
//   - 每 10s 在 presence topic 广播在线状态；每人在自己的 inbox topic 收信
//
// topic 布局（appId/room 隔离不同群组）：
//   oraychat-relay/{appId}/{room}/presence      — 在线广播 {id, name}
//   oraychat-relay/{appId}/{room}/inbox/{id}    — 定向投递 {from, kind, data}

import mqtt from 'mqtt'
import { selfId } from '@trystero-p2p/mqtt'
import * as oc from './crypto.mjs'

const PRESENCE_INTERVAL_MS = 10000
const PRESENCE_TTL_MS = 30000

export class RelayTransport {
  constructor({ appId, roomId, brokerUrls, myName, roomKey, instanceId, onAnnounce, onFrame, onPeerGone, onLog }) {
    this.appId = appId
    this.roomId = roomId
    this.selfId = instanceId || selfId // 可注入实例 ID（便于同进程测试）
    this.roomKey = roomKey || null // 房间口令派生密钥：presence/inbox 帧加密 + 门禁
    this.myName = myName || '未知用户'
    this.onAnnounce = onAnnounce
    this.onFrame = onFrame
    this.onPeerGone = onPeerGone
    this.onLog = onLog || (() => {})
    this.peers = new Map() // selfId -> {name, lastSeen}
    this.presenceTimer = null
    this.pruneTimer = null
    this.client = null
    this.closed = false
    this.brokerUrls = brokerUrls?.length ? brokerUrls : ['wss://broker-cn.emqx.io:8084/mqtt']
    this.connect(0)
  }

  static topics(appId, roomId) {
    const base = `oraychat-relay/${appId}/${roomId}`
    return {
      presence: `${base}/presence`,
      inbox: (id) => `${base}/inbox/${id}`,
    }
  }

  connect(idx) {
    if (idx >= this.brokerUrls.length) {
      this.onLog('MQTT 中继：所有 broker 连接失败（中继不可用，仅 P2P）', 'warn')
      return
    }
    const url = this.brokerUrls[idx]
    const { presence, inbox } = RelayTransport.topics(this.appId, this.roomId)
    let client
    try {
      client = mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: 8000, keepalive: 30 })
    } catch (e) { this.connect(idx + 1); return }
    this.client = client
    client.on('connect', () => {
      this.onLog(`MQTT 中继已连接 ${url}`)
      client.subscribe([presence, inbox(this.selfId)], (err, granted) => {
        if (err) { this.onLog(`中继订阅失败: ${err.message}`, 'warn'); return }
        this.onLog(`中继订阅确认 granted=${JSON.stringify(granted)}`)
        this.announce()
        this.presenceTimer = setInterval(() => this.announce(), PRESENCE_INTERVAL_MS)
        this.pruneTimer = setInterval(() => this.prune(), 5000)
      })
    })
    client.on('message', (topic, payload) => {
      // 有口令的房间：帧整体加密，口令不符（解密失败）即丢弃 —— 无口令者无法注入有效帧
      let msg
      try { msg = oc.openRoom(this.roomKey, JSON.parse(payload.toString())) } catch { return }
      if (!msg) return
      if (topic === presence) {
        if (!msg?.id || msg.id === this.selfId) return
        const known = this.peers.has(msg.id)
        this.peers.set(msg.id, { name: String(msg.name || '未知用户'), lastSeen: Date.now() })
        if (!known) this.onAnnounce?.(msg.id, this.peers.get(msg.id))
      } else if (topic === inbox(this.selfId)) {
        this.onLog(`中继收到定向帧 kind=${msg?.kind} from=${String(msg?.from || '').slice(0, 8)}…`)
        if (!msg?.from || msg.from === this.selfId) return
        this.onFrame?.(msg.from, msg.kind, msg.data)
      }
    })
    client.on('error', () => { /* 换下一个 broker */ })
    client.on('close', () => {
      clearInterval(this.presenceTimer)
      clearInterval(this.pruneTimer)
      if (this.client === client && !this.closed) {
        this.onLog('MQTT 中继断开，尝试下一个 broker', 'warn')
        this.connect(idx + 1)
      }
    })
  }

  announce() {
    const frame = oc.sealRoom(this.roomKey, { id: this.selfId, name: this.myName || '未知用户' })
    this.client?.publish(RelayTransport.topics(this.appId, this.roomId).presence, JSON.stringify(frame))
  }

  prune() {
    const now = Date.now()
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > PRESENCE_TTL_MS) {
        this.peers.delete(id)
        this.onPeerGone?.(id)
      }
    }
  }

  send(peerId, kind, data) {
    if (!this.client?.connected) throw new Error('MQTT 中继未连接')
    const { inbox } = RelayTransport.topics(this.appId, this.roomId)
    const frame = oc.sealRoom(this.roomKey, { from: this.selfId, kind, data })
    this.client.publish(inbox(peerId), JSON.stringify(frame))
  }

  setName(name) { this.myName = name; this.announce() }

  destroy() {
    this.closed = true
    clearInterval(this.presenceTimer)
    clearInterval(this.pruneTimer)
    try { this.client?.end(true) } catch { /* 忽略 */ }
  }
}
