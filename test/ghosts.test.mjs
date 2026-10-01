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
  net.hsCooldown = new Map()
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

// ---- 2) dedupeIdentity：同名接管清所有非 ready 条目（v1.22.2 起 presence 残留不阻挡）----
// 昵称即账号：新同名会话就绪即接管；真有两台同名活设备，被清的那台经 presence 重启握手自愈。
// 保留条件只剩 ready（另一台真活设备）
{
  const { net } = bareNet()
  net.peers.set('ghostFailed', fakePeer({ name: 'xfold', state: 'failed', idPubHex: '22'.repeat(32) }))
  net.peers.set('otherDevice', fakePeer({ name: 'xfold', state: 'ready', idPubHex: '33'.repeat(32) }))
  net.peers.set('liveSameName', fakePeer({ name: 'xfold', state: 'failed', idPubHex: '44'.repeat(32) }))
  net.relay.peers.set('liveSameName', { lastSeen: NOW }) // 中继仍看到他（presence 残留）
  net.peers.set('ghostNoPub', fakePeer({ name: 'xfold', state: 'failed', idPubHex: null }))
  net.peers.set('newA', fakePeer({ name: 'xfold', state: 'ready', idPubHex: '55'.repeat(32) }))
  net.dedupeIdentity('newA', net.peers.get('newA'))
  assert.ok(!net.peers.has('ghostFailed'), '同名 failed 残身应被清理')
  assert.ok(!net.peers.has('liveSameName'), '同名 failed 且 presence 残留的旧条目也应清理（v1.22.2）')
  assert.ok(!net.peers.has('ghostNoPub'), '无身份公钥的同名 failed 条目（握手早期失败）也应清理')
  assert.ok(net.peers.has('otherDevice'), '同名但 ready（另一台真设备）应保留')
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

// ---- 3b) pcAlive 免死只保护 ready：僵尸 WebRTC 通道不得让非就绪条目永生 ----
// （用户实测 xfold6 手机离线后仍显示「协商中（第 N 次尝试）」：对端 app 已关、
// ICE 保活未超时，pc 长时间僵尸 connected 挡住回收，握手超时又不断重启）
{
  const { net } = bareNet([])
  // 该清：handshaking + 僵尸 pc connected + 无 presence + 60s 无进展
  net.peers.set('z1', fakePeer({ state: 'handshaking', lastProgress: NOW - 60000, pc: { connectionState: 'connected' } }))
  // 该清：failed + 僵尸 pc
  net.peers.set('z2', fakePeer({ state: 'failed', lastProgress: NOW - 60000, pc: { connectionState: 'connected' } }))
  // 不该清：ready + pc connected（真活会话）
  net.peers.set('k5', fakePeer({ state: 'ready', suspect: true, suspectAt: NOW - 100000, pc: { connectionState: 'connected' } }))
  net.reapGhosts()
  assert.ok(!net.peers.has('z1') && !net.peers.has('z2'), '非就绪条目不得因僵尸 pc 免于回收')
  assert.ok(net.peers.has('k5'), 'ready 会话的 pcAlive 保护不变')
}

// ---- 3b2) 非就绪条目总寿命硬上限 90s：内部续命（重启自刷 lastProgress）也必死 ----
// （v1.22.2 后用户实测 xfold6 依旧：超时→重启循环里 startHandshake 自刷
// lastProgress，30s 判据被本方行为无限续命——硬上限 bornAt 起封顶）
{
  const { net } = bareNet([])
  // bornAt 10 分钟前；lastProgress 模拟"刚被重启刷新过"（30s 判据不满足）
  net.peers.set('z3', fakePeer({ state: 'handshaking', lastProgress: NOW - 5000, bornAt: NOW - 600000 }))
  net.reapGhosts()
  assert.ok(!net.peers.has('z3'), 'bornAt 超 90s 的非就绪条目必须回收（总寿命硬上限）')
  // 真在线（presence 在）不受硬上限影响
  net.peers.set('z4', fakePeer({ state: 'handshaking', lastProgress: NOW - 5000, bornAt: NOW - 600000 }))
  net.relay.peers.set('z4', { lastSeen: NOW })
  net.reapGhosts()
  assert.ok(net.peers.has('z4'), 'presence 仍在的真在线条目不受硬上限影响')
}

// ---- 3c) dedupeIdentity 同名接管：不再被 presence 残留 TTL 挡住 ----
// （用户实测 3070 重启后双条目：旧条目 failed 无身份公钥，sameIdentity 失效；
// sameName 又被「中继视野还有它」的保守条件挡住）
{
  const { net } = bareNet(['oldPid'])
  const oldPeer = fakePeer({ name: '3070', state: 'failed', idPubHex: null, lastProgress: NOW - 10000 })
  net.peers.set('oldPid', oldPeer)
  const newPeer = fakePeer({ name: '3070', state: 'ready', idPubHex: 'cc'.repeat(32) })
  net.peers.set('newPid', newPeer)
  net.relay.peers.set('oldPid', { lastSeen: NOW }) // presence 残留在 TTL 内
  net.dedupeIdentity('newPid', newPeer)
  assert.ok(!net.peers.has('oldPid'), '同名非就绪旧条目应在接管时清理（presence 残留不得阻挡）')
  assert.ok(net.peers.has('newPid'))
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

// ---- 7) 握手失败簿记：只计数告警，不拦截自动建联（v1.21.3 冷却曾在抖动网络
// 下致双方互等死锁——presence 活跃的对端必须保持可恢复）；条目回收由 30s
// 快速 reaper 兜住；对端主动 hs1 无条目也接受 ----
{
  const { net } = bareNet()
  const mk = (over = {}) => fakePeer({ name: 'ghosty', state: 'failed', lastError: '握手超时', lastProgress: NOW - 100000, ...over })
  const p1 = mk()
  net.peers.set('g1', p1)
  net.failHandshake('g1', p1, '握手超时')
  net.failHandshake('g1', p1, '握手超时')
  net.failHandshake('g1', p1, '握手超时')
  assert.equal(p1.hsFails, 3, '失败计数累计')
  assert.ok(net.peers.has('g1'), '条目保留（由 30s reaper 回收，不做建联冷却）')
  // presence 再到：允许重新建联（对端在线必须可恢复）
  net.onRelayAnnounce('g1', { name: 'ghosty' })
  assert.ok(net.peers.has('g1'), 'presence 活跃的对端始终可自动建联')
  // 对端主动 hs1：无条目也接受 —— 对端发起 = 对端排序在我之前 = pid < selfId
  const { selfId } = await import('../renderer/src/net.mjs')
  let pid = null
  for (let i = 0; i < 500 && !pid; i++) {
    const cand = Array.from({ length: 20 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('')
    if (cand < selfId) pid = cand
  }
  assert.ok(pid, '应能生成 < selfId 的 peerId')
  const { makeHs1, createIdentity } = await import('../renderer/src/crypto.mjs')
  const ident = createIdentity()
  const { msg } = makeHs1(ident, 'ghosty', 'room-x', null)
  net.onHandshakeFrame(pid, msg, 'mqtt')
  assert.ok(net.peers.has(pid), '对端主动 hs1 无条目也接受')
}

console.log('ghosts.test.mjs ✓ 全部通过（身份去重 / 残身回收 / 视野门控 / 摘要复种防护 / 握手失败簿记）')
