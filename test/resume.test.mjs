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
