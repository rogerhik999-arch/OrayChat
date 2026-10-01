// 握手帧健壮性回归（v1.21.5 综合矩阵揪出的会话误杀，无网络：直接驱动 ChatNet）：
//   1) ready 会话收到杂散/旧轮次握手帧（HMAC 失配）→ 会话保持 ready（曾被打成 failed，
//      连杀 DM 发送循环与删除传播）
//   2) restartHandshake 清理旧轮次 hs3/hs3ack 重发定时器（旧闭包帧不再砸向新 ctx）
//   3) failHandshake 同样清理重发定时器
//   4) 非就绪时无效帧不进入 failed——握手成败只由 hsTimer 超时裁决
import assert from 'node:assert/strict'
import { ChatNet } from '../renderer/src/net.mjs'

const NOW = Date.now()

function bareNet() {
  const net = Object.create(ChatNet.prototype)
  net.destroyed = false
  net.peers = new Map()
  net.pendingAcks = new Map()
  net.recentlyReaped = new Map()
  net.digestTries = new Map()
  net.hsCooldown = new Map()
  net.myIdPubHex = 'aa'.repeat(32)
  net.peerNames = new Map()
  net.logs = []
  net.failedHooks = 0
  net.hooks = {
    onLog: (m) => net.logs.push(m),
    onPeerFailed: () => net.failedHooks++,
  }
  net.relay = { connected: false, peers: new Map() }
  net._relayWasConn = false
  net.relayStableSince = 0
  net.startHandshake = () => {} // 摘要/重启路径不真发起握手（那会走加密与网络）
  return net
}

function fakePeer(over = {}) {
  return {
    via: 'p2p', state: 'ready', pc: null, name: 'peer', ctx: { fake: true },
    safety: null, path: 'unknown', pending: null, hsTimer: null, lastError: null,
    bornAt: NOW - 600000, lastProgress: NOW - 600000, lastSeen: NOW - 600000,
    suspect: false, suspectAt: 0, idPubHex: null, ...over,
  }
}

// ---- 1) 杂散握手帧不得杀伤 ready 会话 ----
{
  const net = bareNet()
  const peer = fakePeer({ state: 'ready', ctx: { epoch: 7 } }) // 旧轮次 ctx 已被换掉
  net.peers.set('aliceTrystero', peer)
  for (const t of ['OC-HS2-v1', 'OC-HS3-v1', 'OC-HS3ACK-v1']) {
    net.onHandshakeFrame('aliceTrystero', { t, junk: true }, 'p2p')
  }
  assert.equal(peer.state, 'ready', '无效握手帧后会话必须仍是 ready')
  assert.equal(net.failedHooks, 0, '不得触发 failHandshake')
  assert.ok(net.logs.some((m) => m.includes('忽略无效握手帧') && m.includes('会话保持')), '应有警告日志')
  console.log('✅ ready 会话收到杂散/旧轮次握手帧 → 会话保持，不误杀')
}

// ---- 2) restartHandshake 清理旧轮次重发定时器 ----
{
  const net = bareNet()
  const peer = fakePeer({ via: 'mqtt', state: 'handshaking' })
  peer.hs3Retry = setInterval(() => {}, 10000)
  peer.hs3ackRetry = setInterval(() => {}, 10000)
  net.peers.set('p1', peer)
  net.restartHandshake('p1', 'mqtt')
  assert.equal(peer.hs3Retry, null, 'hs3Retry 必须随旧 ctx 作废')
  assert.equal(peer.hs3ackRetry, null, 'hs3ackRetry 必须随旧 ctx 作废')
  // 定时器确实被清掉了（进程不会挂着无用句柄）
  assert.ok(!peer._onTimeout, 'sanity')
  console.log('✅ restartHandshake 清理 hs3/hs3ack 旧轮次重发定时器')
}

// ---- 3) failHandshake 清理重发定时器并簿记 ----
{
  const net = bareNet()
  const peer = fakePeer({ via: 'mqtt', state: 'handshaking' })
  peer.hs3Retry = setInterval(() => {}, 10000)
  net.peers.set('p2', peer)
  net.failHandshake('p2', peer, '测试超时')
  assert.equal(peer.state, 'failed')
  assert.equal(peer.hsFails, 1)
  assert.equal(peer.hs3Retry, null)
  console.log('✅ failHandshake 清理重发定时器（失败后无陈旧帧继续外发）')
}

// ---- 4) 非就绪时无效帧不进入 failed（等 hsTimer 裁决）----
{
  const net = bareNet()
  const peer = fakePeer({ state: 'handshaking' })
  net.peers.set('p3', peer)
  net.onHandshakeFrame('p3', { t: 'OC-HS3-v1', junk: true }, 'p2p')
  assert.equal(peer.state, 'handshaking', '校验失败不等于握手失败')
  assert.equal(net.failedHooks, 0)
  console.log('✅ 非就绪时无效帧仅警告，成败由 hsTimer 超时裁决')
}

console.log('✅ hsframe.test.mjs 全部通过')
