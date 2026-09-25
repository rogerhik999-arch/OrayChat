// crypto.js 协议单元测试（Node 直接跑：node test/crypto.test.js）
// 覆盖：完整握手（双向角色）、密钥一致、AEAD 往返、篡改检测、重放拒绝、
//       错误密钥解密失败、签名伪造拒绝、安全码两端一致。
import assert from 'node:assert/strict'
import {
  createIdentity, identityToJson, identityFromJson, makeHs1, acceptHs1, acceptHs2,
  acceptHs3, acceptHs3ack, seal, open, safetyNumber, identityFingerprint,
  deriveRoomKey, sealRoom, openRoom,
} from '../renderer/src/crypto.mjs'

const ROOM = 'oc-test-room'
const alice = createIdentity()
const bob = createIdentity()

// --- 身份序列化往返 ---
const alice2 = identityFromJson(JSON.parse(JSON.stringify(identityToJson(alice))))
assert.equal(Buffer.from(alice2.edPub).toString('hex'), Buffer.from(alice.edPub).toString('hex'))

// --- 完整握手：Alice 发起（她这边 peerId 字典序更小）---
const { msg: hs1, pend } = makeHs1(alice, 'alice', ROOM)
const { msg: hs2, ctx: bobCtx } = acceptHs1(bob, 'bob', ROOM, hs1)
const { msg: hs3, ctx: aliceCtx } = acceptHs2(alice, pend, hs2)
const { msg: hs3ack } = acceptHs3(bobCtx, hs3)
acceptHs3ack(aliceCtx, hs3ack)

// --- 消息往返（双向）---
const w1 = seal(aliceCtx, '你好 bob, hello P2P!')
const r1 = open(bobCtx, w1)
assert.equal(r1.text, '你好 bob, hello P2P!')
const w2 = seal(bobCtx, '收到，加密通道 OK')
const r2 = open(aliceCtx, w2)
assert.equal(r2.text, '收到，加密通道 OK')
assert.ok(w2.s >= 1 && r1.t <= Date.now())

// --- 篡改检测：改密文一个字节必须解密失败 ---
const w3 = seal(aliceCtx, 'tamper test')
const raw = Buffer.from(w3.c, 'base64')
raw[raw.length - 1] ^= 1
const tampered = { ...w3, c: raw.toString('base64') }
assert.throws(() => open(bobCtx, tampered), /认证|decrypt|tag|crypto|序号/i)

// --- 重放拒绝：同一条消息发两次 ---
assert.throws(() => open(bobCtx, w1), /序号|重放/)

// --- 密钥不匹配：用另一个会话的密钥解密必须失败 ---
const eve = createIdentity()
const { msg: ehs1, pend:epend } = makeHs1(eve, 'eve', ROOM)
const { msg: ehs2, ctx: mallCtx } = acceptHs1(bob, 'bob', ROOM, ehs1)
const { msg: ehs3, ctx: eveCtx } = acceptHs2(eve, epend, ehs2)
acceptHs3(mallCtx, ehs3)
assert.throws(() => open(mallCtx, seal(aliceCtx, 'not for mallory')), /认证|decrypt|tag|crypto|序号/i)

// --- 伪造身份：假 hs1 签名必须被拒绝 ---
const fake = createIdentity()
const forgedHs1 = makeHs1(fake, 'alice', ROOM).msg
forgedHs1.idPub = Buffer.from(alice.edPub).toString('base64') // 偷换身份公钥
assert.throws(() => acceptHs1(bob, 'bob', ROOM, forgedHs1), /签名/)

// --- 错误房间 ---
const wrongRoom = makeHs1(alice, 'alice', 'other-room').msg
assert.throws(() => acceptHs1(bob, 'bob', ROOM, wrongRoom), /房间|签名/)

// --- 安全码：两端一致、不同对之间不同 ---
const snAB1 = safetyNumber(alice.edPub, bob.edPub)
const snAB2 = safetyNumber(bob.edPub, alice.edPub)
assert.equal(snAB1, snAB2, '安全码两端必须一致（与顺序无关）')
assert.notEqual(snAB1, safetyNumber(alice.edPub, eve.edPub))
assert.ok(/^\d{4}( \d{4}){4}$/.test(snAB1), '安全码格式：5组4位数字')
console.log('安全码示例 alice↔bob:', snAB1)
console.log('alice 指纹:', identityFingerprint(alice.edPub))

// --- 房间口令：密钥派生 + 帧加密门禁 ---
const k1 = deriveRoomKey('口令-abc', 'oraychat-p2p-v1', 'room-1')
const k2 = deriveRoomKey('口令-abc', 'oraychat-p2p-v1', 'room-1')
const k3 = deriveRoomKey('口令-xyz', 'oraychat-p2p-v1', 'room-1')
const k4 = deriveRoomKey('口令-abc', 'oraychat-p2p-v1', 'room-2')
assert.equal(Buffer.from(k1).equals(Buffer.from(k2)), true, '同口令同房间派生同一密钥')
assert.equal(Buffer.from(k1).equals(Buffer.from(k3)), false, '不同口令派生不同密钥')
assert.equal(Buffer.from(k1).equals(Buffer.from(k4)), false, '不同房间派生不同密钥')
assert.equal(deriveRoomKey('', 'a', 'b'), null, '空口令 = 无口令房间')
const frame = { from: 'peerA', kind: 'hs', data: { t: 'OC-HS1-v1', x: 1 } }
const wrapped = sealRoom(k1, frame)
assert.ok(wrapped.e && !JSON.stringify(wrapped).includes('peerA'), '加密帧不含明文字段')
assert.deepEqual(openRoom(k1, wrapped), frame, '正确口令可解密')
assert.throws(() => openRoom(k3, wrapped), /tag|decrypt|认证|crypto/i, '错误口令解密必须失败')
assert.throws(() => openRoom(k1, { from: 'evil' }), /未加密帧/, '口令房间拒绝未加密帧（防注入）')
assert.deepEqual(openRoom(null, { hello: 1 }), { hello: 1 }, '无口令房间帧原样透传（兼容）')
console.log('✅ 房间口令：密钥派生 + 帧加密 + 门禁语义')

console.log('\n✅ crypto.test.js 全部通过（8 组断言）')
