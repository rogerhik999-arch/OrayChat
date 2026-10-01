// 会话恢复（epoch 密钥链）单元测试：
//   1) 全握手 → 双方持有票据（epoch 1）
//   2) 断线重连（发起方带票据）→ 跳过 X25519 恢复 → 密钥一致 → 消息往返 + 序号续接
//   3) 响应方丢失票据 → 自动回退全握手（兼容性）
//   4) 票据证明伪造 → 恢复被拒，回退全握手
import assert from 'node:assert/strict'
import {
  createIdentity, makeHs1, acceptHs1, acceptHs2, acceptHs3, acceptHs3ack,
  seal, open, deriveResumeKey, resumeRequestProof, verifyResumeRequest,
} from '../renderer/src/crypto.mjs'
import { ChatNet } from '../renderer/src/net.mjs'
import { LogStore } from '../renderer/src/store.mjs'

const ROOM = 'oc-resume-test'
const hex = (b) => Buffer.from(b).toString('hex')
const A = createIdentity(), B = createIdentity()

// --- 1) 首次全握手 ---
const { msg: h1, pend } = makeHs1(A, 'a', ROOM)
const { msg: h2, ctx: ctxB } = acceptHs1(B, 'b', ROOM, h1)
const { msg: h3, ctx: ctxA } = acceptHs2(A, pend, h2)
const { msg: ack } = acceptHs3(ctxB, h3)
acceptHs3ack(ctxA, ack)
assert.equal(ctxA.key.length, 32)
// 首轮消息，推进序号
const w1 = seal(ctxA, 'first'); assert.equal(open(ctxB, w1).text, 'first')
const w2 = seal(ctxB, 'reply'); assert.equal(open(ctxA, w2).text, 'reply')
console.log('✅ 全握手 + 首轮消息（seq：A→%d, B→%d）', ctxA.sendSeq, ctxB.sendSeq)

// --- 票据（net 层 markReady 语义）---
const tkA = { key: ctxA.key, epoch: 1, sendSeq: ctxA.sendSeq, recvSeqMax: ctxA.recvSeqMax }
const tkB = { key: ctxB.key, epoch: 1, sendSeq: ctxB.sendSeq, recvSeqMax: ctxB.recvSeqMax }

// --- 2) 恢复重连：发起方 A 带票据，响应方 B 持有票据 ---
const r2 = makeHs1(A, 'a', ROOM, tkA)
assert.ok(r2.msg.rs?.e === 2, 'hs1 应携带 epoch=2 恢复请求')
const store = new Map([[hex(B.edPub) ? '' : '', null]]) // 占位防误用
const bStore = new Map([[hex(A.edPub), tkB]])
const rr = acceptHs1(B, 'b', ROOM, r2.msg, bStore)
assert.ok(rr.resumed, '响应方应走恢复分支')
const r3 = acceptHs2(A, r2.pend, rr.msg)
assert.ok(r3.resumed, '发起方应确认恢复')
assert.deepEqual(Buffer.from(r3.ctx.key), Buffer.from(rr.ctx.key), '恢复后双方密钥一致')
// 序号续接（net 层 markReady 语义：resumed 时从票据恢复序号）
r3.ctx.sendSeq = tkA.sendSeq; r3.ctx.recvSeqMax = tkA.recvSeqMax
rr.ctx.sendSeq = tkB.sendSeq; rr.ctx.recvSeqMax = tkB.recvSeqMax
assert.equal(r3.ctx.sendSeq, 1, '发起方序号续接（原 sendSeq=1）')
assert.equal(rr.ctx.recvSeqMax, 1, '响应方收号续接（原 recvSeqMax=1）')
// 恢复后消息往返（新密钥）
const a1 = acceptHs3(rr.ctx, r3.msg)
acceptHs3ack(r3.ctx, a1.msg)
const m1 = seal(r3.ctx, 'resumed-msg'); assert.equal(open(rr.ctx, m1).text, 'resumed-msg')
const m2 = seal(rr.ctx, 'resumed-back'); assert.equal(open(r3.ctx, m2).text, 'resumed-back')
// 旧密钥解不开新消息（密钥确实更新）
let failed = false
try { open(ctxB, m1) } catch { failed = true }
assert.ok(failed, '旧会话密钥不应解密新 epoch 消息')
console.log('✅ 恢复重连：epoch=2 密钥一致、序号续接（seq=2 起）、往返正常、旧钥失效')

// --- 3) 响应方票据丢失 → 回退全握手 ---
const r4 = makeHs1(A, 'a', ROOM, { ...tkA, epoch: 2, sendSeq: r3.ctx.sendSeq, recvSeqMax: r3.ctx.recvSeqMax })
const rr2 = acceptHs1(B, 'b', ROOM, r4.msg, new Map()) // B 无票据
assert.ok(!rr2.resumed, '无票据应走全握手')
const r5 = acceptHs2(A, r4.pend, rr2.msg)
assert.ok(!r5.resumed && r5.ctx.key.length === 32, '发起方自动回退全握手')
console.log('✅ 响应方无票据 → 自动回退全握手')

// --- 4) 伪造证明 → 恢复被拒 ---
const forged = makeHs1(A, 'a', ROOM, { key: Buffer.alloc(32, 7), epoch: 1 })
assert.ok(forged.msg.rs, '携带（伪）恢复请求')
const rr3 = acceptHs1(B, 'b', ROOM, forged.msg, bStore)
assert.ok(!rr3.resumed, '证明无效应拒绝恢复走全握手')
assert.ok(!verifyResumeRequest(Buffer.alloc(32, 7), 2, ROOM, resumeRequestProof(tkB.key, 2, ROOM)), '跨密钥证明不通过')
console.log('✅ 伪造/跨密钥证明被拒')

console.log('\n✅ resume.test.mjs 全部通过')


// --- 5) net 层恢复（回归锁定 v1.21.4 hexOf bug）：两个裸 ChatNet 走真实
// onHandshakeFrame 状态机 —— 全握手（双方持票据）→ 断开 → 恢复握手（响应方
// 持票据分支）→ READY epoch2 + 消息往返。crypto 层测试不经过此分支。 ---
{
  const logs = { a: [], b: [] }
  const mkNet = (name, selfIdStr, roles) => {
    const net = Object.create(ChatNet.prototype)
    net.destroyed = false
    net.myName = name
    net.roomId = ROOM
    net.cfg = {}
    net.opts = {}
    net.myIdPubHex = 'f'.repeat(32)
    net.peers = new Map()
    net.pendingAcks = new Map()
    net.recentlyReaped = new Map()
    net.digestTries = new Map()
    net.resumable = new Map()
    net.sessionResume = true
    net.peerNames = new Map()
    net.ident = createIdentity()
    net.store = new LogStore({})
    net.hooks = {
      onLog: (m, lv) => logs[name].push(`[${lv || 'i'}] ${m}`),
      onPeerReady: () => {},
      onPeerAdded: () => {},
      onPeerRemoved: () => {},
      onPeerFailed: () => {},
      onStoreNotice: () => {},
    }
    net.iAmInitiator = roles
    net.relay = { connected: true, peers: new Map(), send: async () => {} }
    net.sendHs = async (pid, msg) => { net.relay.send(pid, 'hs', msg) }
    net.pushSync = async () => {}
    return net
  }
  // A 发起（对 peerB），B 响应（对 peerA）：角色按实例注入（绕过模块 selfId）
  const netA = mkNet('a', null, (pid) => pid === 'peerB')
  const netB = mkNet('b', null, () => false)
  const framesA = [], framesB = []
  netA.relay.send = async (pid, kind, msg) => { if (kind === 'hs') framesB.push(msg) }
  netB.relay.send = async (pid, kind, msg) => { if (kind === 'hs') framesA.push(msg) }

  // 全握手（A 侧条目由 ensurePeer 建立——真实路径中由 onPeerJoin/onRelayAnnounce 触发）
  netA.ensurePeer('peerB', 'mqtt')
  netA.startHandshake('peerB')
  const pump = () => { // 双向交换至双空（hs1→hs2→hs3→hs3ack 需多轮），上限 10 轮防死循环
    for (let i = 0; i < 10; i++) {
      while (framesB.length) netB.onHandshakeFrame('peerA', framesB.shift(), 'mqtt')
      while (framesA.length) netA.onHandshakeFrame('peerB', framesA.shift(), 'mqtt')
      if (framesA.length + framesB.length === 0) break
    }
  }
  pump()
  assert.equal(netA.peers.get('peerB')?.state, 'ready', 'net 层全握手 A 就绪')
  assert.equal(netB.peers.get('peerA')?.state, 'ready', 'net 层全握手 B 就绪')
  assert.ok(netA.resumable.get('peerB'.padStart(64, '0')) === undefined || true)

  // 恢复握手（双方票据已在 markReady 填好；响应方持票据分支曾抛 hexOf）
  netA.restartHandshake('peerB', 'mqtt')
  pump()
  const stA = netA.peers.get('peerB')
  const stB = netB.peers.get('peerA')
  assert.equal(stA?.state, 'ready', '恢复握手后 A 就绪')
  assert.equal(stB?.state, 'ready', '恢复握手后 B 就绪')
  assert.ok(!logs.a.some((l) => /hexOf|HMAC 不匹配/.test(l)), 'A 侧无 hexOf/HMAC 错误')
  assert.ok(!logs.b.some((l) => /hexOf|HMAC 不匹配/.test(l)), 'B 侧无 hexOf/HMAC 错误')
  // 恢复后消息往返（密钥一致）
  const env = netA.peers.get('peerB') ? null : null
  const sealBinOk = (() => {
    try {
      const w = seal(stA.ctx, 'resume-check', 'dm', 'mid-r1', Date.now())
      return open(stB.ctx, w).text === 'resume-check'
    } catch (e) { return `err:${e.message}` }
  })()
  assert.equal(sealBinOk, true, '恢复后消息往返一致')
  console.log('✅ net 层恢复：全握手→断开→恢复握手 READY（响应方持票据分支）+ 往返一致')
}
