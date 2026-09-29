// 残身回收 / 身份去重 / 摘要复种防护 单元测试（无网络：直接驱动 ChatNet 原型状态机）
// 背景：peerId（Trystero selfId）每次启动随机生成，对端重启即以新 peerId 回来；
// 旧条目若死亡路径未触发会永远挂在在线列表。v1.14.0 的修复点全部在此覆盖。
// 用法：node test/ghosts.test.mjs
import assert from 'node:assert/strict'
import { ChatNet } from '../renderer/src/net.mjs'

const NOW = Date.now()

function bareNet(relayPeers = [], { connected = true, stableFor = 80000 } = {}) {
  const events = { logs: [], removed: [], added: 0 }
  const net = Object.create(ChatNet.prototype)
  net.destroyed = false
  net.peers = new Map()
  net.pendingAcks = new Map()
  net.recentlyReaped = new Map()
  net.digestTries = new Map()
  net.myIdPubHex = 'aa'.repeat(32)
  net.peerNames = new Map()
  net.hooks = {
    onLog: (m) => events.logs.push(m),
    onPeerRemoved: (pid, p) => events.removed.push({ pid, name: p?.name }),
    onPeerAdded: () => events.added++,
  }
  net.relay = {
    connected,
    peers: new Map(relayPeers.map((pid) => [pid, { name: 'x', lastSeen: NOW }]), ),
  }
  net._relayWasConn = connected
  net.relayStableSince = connected ? NOW - stableFor : 0
  // 摘要测试里避免真发起握手（那会走加密与网络）
  net.startHandshake = (pid) => { const p = net.peers.get(pid); if (p) { p.state = 'handshaking'; p.lastProgress = Date.now() } }
  return { net, events }
}

function fakePeer(over = {}) {
  return {
    via: 'mqtt', state: 'ready', pc: null, name: 'peer', ctx: null,
    safety: null, path: 'unknown', pending: null, hsTimer: null, lastError: null,
    bornAt: NOW - 600000, lastProgress: NOW - 600000, lastSeen: NOW - 600000,
    suspect: false, suspectAt: 0, idPubHex: null, ...over,
  }
}

// ---- 1) dedupeIdentity：同一身份经新 peerId 上线 → 旧条目秒清 ----
{
  const { net, events } = bareNet()
  const X = '11'.repeat(32)
  net.peers.set('oldA', fakePeer({ name: 'xfold', state: 'ready', idPubHex: X, suspect: true }))
  net.peers.set('newA', fakePeer({ name: 'xfold', state: 'ready', idPubHex: X }))
  net.dedupeIdentity('newA', net.peers.get('newA'))
  assert.ok(!net.peers.has('oldA'), '同 idPubHex 的旧 peerId 条目应被清理')
  assert.ok(net.peers.has('newA'), '新条目应保留')
  assert.equal(events.removed.filter((r) => r.pid === 'oldA').length, 1)
}

// ---- 2) dedupeIdentity：同名接管只清非 ready 且中继视野里没有的 ----
{
  const { net } = bareNet()
  net.peers.set('ghostFailed', fakePeer({ name: 'xfold', state: 'failed', idPubHex: '22'.repeat(32) }))
  net.peers.set('otherDevice', fakePeer({ name: 'xfold', state: 'ready', idPubHex: '33'.repeat(32) }))
  net.peers.set('liveSameName', fakePeer({ name: 'xfold', state: 'failed', idPubHex: '44'.repeat(32) }))
  net.relay.peers.set('liveSameName', { lastSeen: NOW }) // 中继仍看到他
  net.peers.set('newA', fakePeer({ name: 'xfold', state: 'ready', idPubHex: '55'.repeat(32) }))
  net.dedupeIdentity('newA', net.peers.get('newA'))
  assert.ok(!net.peers.has('ghostFailed'), '同名 failed 残身应被清理')
  assert.ok(net.peers.has('otherDevice'), '同名但 ready（另一台真设备）应保留')
  assert.ok(net.peers.has('liveSameName'), '同名 failed 但中继仍见 presence 的应保留')
}

// ---- 3) reapGhosts：四类该清 / 四类不该清 ----
{
  const { net } = bareNet([]) // 中继视野：谁都没有
  // 该清：ready + 怀疑期满
  net.peers.set('g1', fakePeer({ state: 'ready', suspect: true, suspectAt: NOW - 100000 }))
  // 该清：failed 且 90s 无进展
  net.peers.set('g2', fakePeer({ state: 'failed', lastProgress: NOW - 100000 }))
  // 该清：handshaking 卡死（对端消失）
  net.peers.set('g3', fakePeer({ state: 'handshaking', lastProgress: NOW - 100000 }))
  // 不该清：ready + 怀疑未满宽限
  net.peers.set('k1', fakePeer({ state: 'ready', suspect: true, suspectAt: NOW - 10000 }))
  // 不该清：真直连（pc connected，中继看不到也在）
  net.peers.set('k2', fakePeer({ state: 'ready', suspect: true, suspectAt: NOW - 100000, via: 'p2p', pc: { connectionState: 'connected' } }))
  // 不该清：中继 presence 仍在（人在线，只是握手失败）
  net.peers.set('k3', fakePeer({ state: 'failed', lastProgress: NOW - 100000 }))
  net.relay.peers.set('k3', { lastSeen: NOW })
  // 不该清：刚进入视野盲区（还没走怀疑流程，先观察一个宽限期）
  net.peers.set('k4', fakePeer({ state: 'ready' }))
  net.reapGhosts()
  assert.ok(!net.peers.has('g1') && !net.peers.has('g2') && !net.peers.has('g3'), '三类残身应被回收')
  assert.ok(net.peers.has('k1') && net.peers.has('k2') && net.peers.has('k3') && net.peers.has('k4'), '四类活会话应保留')
  assert.ok(net.peers.get('k4').suspectAt > 0, '未走怀疑流程的 ready 会话应开始观察计时')
  assert.ok(net.recentlyReaped.has('g1') && net.recentlyReaped.has('g2') && net.recentlyReaped.has('g3'))
}

// ---- 4) reapGhosts：我方中继视野不可信时不回收 ----
{
  const a = bareNet([], { connected: false })
  a.net.peers.set('g', fakePeer({ state: 'ready', suspect: true, suspectAt: NOW - 100000 }))
  a.net.reapGhosts()
  assert.ok(a.net.peers.has('g'), '我方中继离线：不回收')

  const b = bareNet([], { stableFor: 10000 }) // 刚连上 10s（预热期 75s 内）
  b.net.peers.set('g', fakePeer({ state: 'ready', suspect: true, suspectAt: NOW - 100000 }))
  b.net.reapGhosts()
  assert.ok(b.net.peers.has('g'), '中继刚连上（预热期内）：不回收')
}

// ---- 5) onRelayGone：p2p 会话标记怀疑而非直接删；mqtt 会话直接删 ----
{
  const { net } = bareNet()
  net.peers.set('p2pA', fakePeer({ via: 'p2p', state: 'ready' }))
  net.peers.set('mqA', fakePeer({ via: 'mqtt', state: 'ready' }))
  net.onRelayGone('p2pA')
  net.onRelayGone('mqA')
  const p2p = net.peers.get('p2pA')
  assert.ok(p2p, 'p2p 会话不因中继视野判死而直接删除')
  assert.ok(p2p.suspect && p2p.suspectAt > 0, 'p2p 会话应进入怀疑态（交 reaper 裁决）')
  assert.ok(!net.peers.has('mqA'), 'mqtt 会话仍应直接删除（原行为）')
}

// ---- 6) absorbDigest：冷却名单与间接介绍次数上限防复种 ----
{
  const { net } = bareNet(['introducer'])
  net.peers.set('introducer', fakePeer({ name: '中 introducer', state: 'ready' }))
  net.recentlyReaped.set('ghostX', Date.now()) // 刚回收的
  net.digestTries.set('ghostY', 2) // 已两次间接介绍未果的
  net.digestTries.set('freshZ', 0)
  net.absorbDigest('introducer', [
    'ghostX|x', 'ghostY|x', 'freshZ|新人',
  ])
  assert.ok(!net.peers.has('ghostX'), '冷却名单内的 peerId 不被摘要复种')
  assert.ok(!net.peers.has('ghostY'), '两次间接介绍未果后不再复种')
  assert.ok(net.peers.has('freshZ') && net.peers.get('freshZ').state === 'handshaking', '新成员正常间接建联')
  assert.equal(net.digestTries.get('freshZ'), 1)
}

console.log('ghosts.test.mjs ✓ 全部通过（身份去重 / 残身回收 / 视野门控 / 摘要复种防护）')
