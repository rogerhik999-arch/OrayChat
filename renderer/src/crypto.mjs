// oraychat E2EE 层
// 设计目标：即使信令服务器（公共 MQTT broker）与 TURN 中继完全不可信，
// 消息内容也只有通信双方可以解密。
//
// 密码学构件（@noble 系列开源库）：
//   - Ed25519  ：长期身份密钥（登录身份 = 公钥指纹），握手签名防中间人
//   - X25519   ：静态加密密钥 + 每次连接新生成的临时密钥（前向保密）
//   - HKDF/HMAC-SHA256：会话密钥派生与握手确认
//   - XChaCha20-Poly1305：每条消息 AEAD 加密（密文 + 认证标签）
//
// 握手（Sigma 风格；发起方由 trystero peerId 字典序确定，双方无冲突）：
//   A(发起方) -> B:  hs1 {身份公钥, 静态X密钥, 临时X密钥, 签名(绑定 roomId+公钥+昵称)}
//   B -> A:          hs2 {B 的三个公钥, 对转写哈希 t1 的签名}
//   A -> B:          hs3 {HMAC(key, "OC-HS3"||t1)}    证明已算出会话密钥
//   B -> A:          hs3ack {HMAC(key, "OC-HS3ACK"||t1)}
//   会话密钥 = HKDF( ikm = T1||T2||T3||T4, salt = t1 )  其中
//     T1 = X25519(A.eph, B.stat)  T2 = X25519(A.stat, B.eph)
//     T3 = X25519(A.eph, B.eph)   T4 = X25519(A.stat, B.stat)  （长期身份认证）
//   临时密钥每次连接重新生成 => 即使长期密钥日后泄露，历史会话仍保密。
//
// 身份信任模型：无中心 CA，安全码（双方身份公钥联合指纹）显示给用户，
// 可通过线下渠道人工比对（Signal 安全码同款机制），防止信令层中间人。

import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { randomBytes, utf8ToBytes, bytesToHex } from '@noble/hashes/utils.js'

const HS1_TAG = 'OC-HS1-v1'
const HS2_TAG = 'OC-HS2-v1'
const HS3_TAG = 'OC-HS3-v1'
const HS3ACK_TAG = 'OC-HS3ACK-v1'
const T1_TAG = 'OC-T1-v1'
const KDF_INFO = 'oraychat-session-v1'
const MSG_AAD_PREFIX = 'OC-MSG-v1'

// ---------- 编码助手 ----------

export function b64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

export function unb64(str) {
  const s = atob(str)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export function utf8(str) { return utf8ToBytes(str) }
export function hex(bytes) { return bytesToHex(bytes) }

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrs) { out.set(a, off); off += a.length }
  return out
}

// ---------- 身份 ----------

// 生成身份：Ed25519 签名密钥 + X25519 静态加密密钥
export function createIdentity() {
  const edSeed = randomBytes(32)
  const xSk = randomBytes(32)
  return {
    edSeed,
    edPub: ed25519.getPublicKey(edSeed),
    xSk,
    xPk: x25519.getPublicKey(xSk),
  }
}

export function identityToJson(id) {
  return {
    v: 1,
    edSeed: b64(id.edSeed),
    edPub: b64(id.edPub),
    xSk: b64(id.xSk),
    xPk: b64(id.xPk),
    createdAt: Date.now(),
  }
}

export function identityFromJson(j) {
  return {
    edSeed: unb64(j.edSeed),
    edPub: unb64(j.edPub),
    xSk: unb64(j.xSk),
    xPk: unb64(j.xPk),
  }
}

// 自己身份的指纹（可印在名片上的东西）
export function identityFingerprint(edPub) {
  const h = sha256(concatBytes(utf8('OC-FP'), edPub))
  return hex(h).slice(0, 16).toUpperCase().match(/.{4}/g).join(' ')
}

// 双方安全码：对（我, 对方）身份的联合指纹，两端显示一致，20 位数字便于口头核对
export function safetyNumber(myEdPub, peerEdPub) {
  const a = bytesToHex(myEdPub)
  const b = bytesToHex(peerEdPub)
  const [first, second] = a < b ? [myEdPub, peerEdPub] : [peerEdPub, myEdPub]
  const h = sha256(concatBytes(utf8('OC-SN'), first, second))
  // 取哈希前 9 字节为整数，对 10^20 取模 -> 20 位十进制数字
  let n = 0n
  for (let i = 0; i < 9; i++) n = (n << 8n) | BigInt(h[i])
  const digits = (n % 10n ** 20n).toString().padStart(20, '0')
  return digits.match(/.{4}/g).join(' ')
}

// ---------- 握手消息构造与解析 ----------

function transcript1(roomId, a) {
  // a: {idPub, xPk, ephPk} 发起方的三个公钥
  return sha256(concatBytes(utf8(T1_TAG), utf8(roomId), a.idPub, a.xPk, a.ephPk))
}

// 发起方：构造 hs1。返回 {msg, pend}，pend 为发起方握手上下文（含临时私钥，绝不出网）
export function makeHs1(myIdent, myName, roomId) {
  const ephSk = randomBytes(32)
  const ephPk = x25519.getPublicKey(ephSk)
  const sigMsg = concatBytes(
    utf8(HS1_TAG), utf8(roomId), ephPk, myIdent.xPk, myIdent.edPub, utf8(myName),
  )
  const msg = {
    t: HS1_TAG,
    dn: myName,
    room: roomId,
    idPub: b64(myIdent.edPub),
    xPk: b64(myIdent.xPk),
    eph: b64(ephPk),
    sig: b64(ed25519.sign(sigMsg, myIdent.edSeed)),
  }
  const pend = {
    selfIdPub: myIdent.edPub,
    selfXPk: myIdent.xPk,
    selfEphSk: ephSk,
    room: roomId,
  }
  return { msg, pend }
}

// 响应方：校验 hs1，构造 hs2，派生会话密钥
export function acceptHs1(myIdent, myName, roomId, hs1) {
  if (hs1.t !== HS1_TAG) throw new Error('非握手消息')
  if (hs1.room !== roomId) throw new Error('房间不匹配')
  const peerIdPub = unb64(hs1.idPub)
  const peerXPk = unb64(hs1.xPk)
  const peerEphPk = unb64(hs1.eph)
  const sigMsg = concatBytes(utf8(HS1_TAG), utf8(roomId), peerEphPk, peerXPk, peerIdPub, utf8(hs1.dn || ''))
  if (!ed25519.verify(unb64(hs1.sig), sigMsg, peerIdPub)) throw new Error('hs1 签名无效（身份伪造？）')

  const ephSk = randomBytes(32)
  const ephPk = x25519.getPublicKey(ephSk)
  const t1 = transcript1(roomId, { idPub: peerIdPub, xPk: peerXPk, ephPk: peerEphPk })
  const sigMsg2 = concatBytes(utf8(HS2_TAG), t1, ephPk, myIdent.xPk, myIdent.edPub, utf8(myName))
  const msg = {
    t: HS2_TAG,
    dn: myName,
    idPub: b64(myIdent.edPub),
    xPk: b64(myIdent.xPk),
    eph: b64(ephPk),
    sig: b64(ed25519.sign(sigMsg2, myIdent.edSeed)),
  }
  const key = deriveKey({
    self: myIdent, selfEphSk: ephSk,
    peerXPk, peerEphPk, t1,
    iAmInitiator: false,
  })
  return {
    msg,
    ctx: {
      key, t1,
      selfIdPub: myIdent.edPub,
      peerIdPub, peerXPk,
      peerName: hs1.dn || '未知用户',
      iAmInitiator: false,
      sendSeq: 0, recvSeqMax: 0,
    },
  }
}

// 发起方：校验 hs2，派生密钥，构造 hs3
export function acceptHs2(myIdent, pend, hs2) {
  if (hs2.t !== HS2_TAG) throw new Error('握手阶段错误（收到非 hs2）')
  const peerIdPub = unb64(hs2.idPub)
  const peerXPk = unb64(hs2.xPk)
  const peerEphPk = unb64(hs2.eph)
  const t1 = transcript1(pend.room, { idPub: pend.selfIdPub, xPk: pend.selfXPk, ephPk: x25519.getPublicKey(pend.selfEphSk) })
  const sigMsg2 = concatBytes(utf8(HS2_TAG), t1, peerEphPk, peerXPk, peerIdPub, utf8(hs2.dn || ''))
  if (!ed25519.verify(unb64(hs2.sig), sigMsg2, peerIdPub)) throw new Error('hs2 签名无效（中间人？）')

  const key = deriveKey({
    self: myIdent, selfEphSk: pend.selfEphSk,
    peerXPk, peerEphPk, t1,
    iAmInitiator: true,
  })
  const msg = {
    t: HS3_TAG,
    mac: b64(hmac(sha256, key, concatBytes(utf8(HS3_TAG), t1))),
  }
  return {
    msg,
    ctx: {
      key, t1,
      selfIdPub: pend.selfIdPub,
      peerIdPub, peerXPk,
      peerName: hs2.dn || '未知用户',
      iAmInitiator: true,
      sendSeq: 0, recvSeqMax: 0,
    },
  }
}

// 响应方：校验 hs3（对方确实持有会话密钥），回 hs3ack
export function acceptHs3(ctx, hs3) {
  const expect = hmac(sha256, ctx.key, concatBytes(utf8(HS3_TAG), ctx.t1))
  if (!equalCT(expect, unb64(hs3.mac))) throw new Error('hs3 HMAC 不匹配')
  const msg = { t: HS3ACK_TAG, mac: b64(hmac(sha256, ctx.key, concatBytes(utf8(HS3ACK_TAG), ctx.t1))) }
  return { msg }
}

// 发起方：校验 hs3ack，会话就绪
export function acceptHs3ack(ctx, hs3ack) {
  const expect = hmac(sha256, ctx.key, concatBytes(utf8(HS3ACK_TAG), ctx.t1))
  if (!equalCT(expect, unb64(hs3ack.mac))) throw new Error('hs3ack HMAC 不匹配')
}

function equalCT(a, b) {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

// 会话密钥：HKDF(四段 X25519 IKM, salt = 转写哈希 t1)，双方得到同一 32 字节密钥
function deriveKey({ self, selfEphSk, peerXPk, peerEphPk, t1, iAmInitiator }) {
  // T1 = A.eph ↔ B.stat；T2 = A.stat ↔ B.eph；T3 = eph↔eph；T4 = stat↔stat
  const toPeerStat = x25519.getSharedSecret(selfEphSk, peerXPk) // 我方 eph → 对方 stat
  const toPeerEph = x25519.getSharedSecret(self.xSk, peerEphPk) // 我方 stat → 对方 eph
  const ephEph = x25519.getSharedSecret(selfEphSk, peerEphPk)
  const statStat = x25519.getSharedSecret(self.xSk, peerXPk)
  // 发起方: toPeerStat=T1, toPeerEph=T2；响应方: toPeerStat=T2, toPeerEph=T1
  const ikm = iAmInitiator
    ? concatBytes(toPeerStat, toPeerEph, ephEph, statStat)
    : concatBytes(toPeerEph, toPeerStat, ephEph, statStat)
  return hkdf(sha256, ikm, t1, utf8(KDF_INFO), 32)
}

// ---------- 消息加密 ----------

// AAD 绑定：发送方身份公钥 + 会话内单调序号（防重放/篡改/跨会话搬移）
function msgAad(senderIdPub, seq) {
  return utf8(`${MSG_AAD_PREFIX}|${b64(senderIdPub)}|${seq}`)
}

// 生成全局消息 id（96bit 随机，供共享日志去重与群体删除）
export function newMid() { return hex(randomBytes(12)) }

// ---------- 房间口令（信令层加密 + 门禁） ----------
//
// 口令本身永不出网。用途：
//   1. Trystero joinRoom 的 password —— 用口令派生密钥加密 SDP/ICE 信令，
//      口令错误的对端无法解密 offer/answer，天然被挡在门外（门禁）
//   2. 派生房间密钥（HKDF，绑定 appId+roomId），用于加密 MQTT 中继回退层的
//      presence/inbox 帧 —— 旁听 broker 只见密文，无口令者无法注入有效帧

export function deriveRoomKey(password, appId, roomId) {
  if (!password) return null
  return hkdf(
    sha256,
    utf8(password),
    utf8(`oraychat-room-salt:${appId}:${roomId}`),
    utf8('oraychat-room-key-v1'),
    32,
  )
}

// 无口令：原样透传（兼容无口令房间，线上帧形状不变）；有口令：XChaCha20-Poly1305 加密
export function sealRoom(roomKey, obj) {
  if (!roomKey) return obj
  const nonce = randomBytes(24)
  const ct = xchacha20poly1305(roomKey, nonce).encrypt(utf8(JSON.stringify(obj)))
  const env = new Uint8Array(nonce.length + ct.length)
  env.set(nonce, 0)
  env.set(ct, nonce.length)
  return { e: b64(env) }
}

// 解密封间帧；口令不符（AEAD 校验失败）或收到未加密帧时抛错 → 调用方丢弃
export function openRoom(roomKey, wrapped) {
  if (!roomKey) return wrapped
  if (!wrapped || typeof wrapped.e !== 'string') throw new Error('房间已启用口令，拒绝未加密帧')
  const raw = unb64(wrapped.e)
  const pt = xchacha20poly1305(roomKey, raw.slice(0, 24)).decrypt(raw.slice(24))
  return JSON.parse(new TextDecoder().decode(pt))
}

// 加密一条消息，返回可直接发给对端的信封 {v, c, s}
// payload 携带会话类型（lobby=大厅/dm=私聊）与全局消息 id（mid，供同步去重/群体删除）
export function seal(ctx, text, conv = 'dm', mid, ts) {
  const seq = ++ctx.sendSeq
  const plaintext = utf8(JSON.stringify({ t: ts || Date.now(), m: text, id: mid || hex(randomBytes(12)), conv }))
  const nonce = randomBytes(24)
  const ct = xchacha20poly1305(ctx.key, nonce, msgAad(ctx.selfIdPub, seq)).encrypt(plaintext)
  const envelope = new Uint8Array(nonce.length + ct.length)
  envelope.set(nonce, 0)
  envelope.set(ct, nonce.length)
  return { v: 1, c: b64(envelope), s: seq }
}

// 解密对端消息信封，返回 {text, t, mid, conv}；密文被篡改或密钥不一致时抛错
export function open(ctx, envelope) {
  if (!envelope || envelope.v !== 1) throw new Error('信封版本不支持')
  const seq = Number(envelope.s)
  if (!Number.isInteger(seq) || seq <= ctx.recvSeqMax) throw new Error('消息序号异常（重放？）')
  const raw = unb64(envelope.c)
  const nonce = raw.slice(0, 24)
  const ct = raw.slice(24)
  const pt = xchacha20poly1305(ctx.key, nonce, msgAad(ctx.peerIdPub, seq)).decrypt(ct)
  ctx.recvSeqMax = seq
  const obj = JSON.parse(new TextDecoder().decode(pt))
  return { text: String(obj.m), t: Number(obj.t) || Date.now(), mid: String(obj.id || ''), conv: obj.conv === 'lobby' ? 'lobby' : 'dm' }
}
