// 公共基础设施连通性检测（Node 直接跑：node tools/check-services.mjs）
// 验证 OrayChat 默认使用的三类"开源/免费公共服务"是否真实可用：
//   1. STUN（NAT 打洞地址发现）—— 发 RFC5389 Binding Request，解析公网映射地址
//   2. TURN（中继兜底）—— 对 Open Relay 走完整 RFC5766 Allocate 流程（401 → 带
//      MESSAGE-INTEGRITY 重试），拿到中继地址即证明免费凭据真实有效
//   3. MQTT 公共信令（会话初始化）—— WSS 连上、订阅+发布回环收一条消息
// 本脚本只用 Node 内置模块 + mqtt 包（OrayChat 已有的依赖）。

import dgram from 'node:dgram'
import crypto from 'node:crypto'
import tls from 'node:tls'
import mqtt from 'mqtt'

const STUN_SERVERS = [
  ['stun.l.google.com', 19302],
  ['stun.cloudflare.com', 3478],
  ['stun.qq.com', 3478],
  ['stun.miwifi.com', 3478],
]
const TURN_SERVERS = [
  ['openrelay.metered.ca', 80],   // UDP
  ['openrelay.metered.ca', 3478], // UDP
]
const MQTT_BROKERS = [
  'wss://broker-cn.emqx.io:8084/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
]

const MAGIC = Buffer.from([0x21, 0x12, 0xa4, 0x42])
const results = []
const ok = (name, detail) => { results.push({ name, ok: true, detail }); console.log(`  ✅ ${name} — ${detail}`) }
const bad = (name, detail) => { results.push({ name, ok: false, detail }); console.log(`  ❌ ${name} — ${detail}`) }

function txnId() { return crypto.randomBytes(12) }
function attr(type, value) {
  const pad = (4 - (value.length % 4)) % 4
  const head = Buffer.alloc(4)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(value.length, 2)
  return Buffer.concat([head, value, Buffer.alloc(pad)])
}
function stunHeader(type, txid) {
  const h = Buffer.alloc(20)
  h.writeUInt16BE(type, 0)
  h.writeUInt16BE(0, 2) // 长度由调用方回填
  MAGIC.copy(h, 4)
  txid.copy(h, 8)
  return h
}
function buildMessage(type, attrsBuf, txid, integrityKey) {
  const body = attrsBuf || Buffer.alloc(0)
  const h = Buffer.alloc(20)
  h.writeUInt16BE(type, 0)
  h.writeUInt16BE(body.length + (integrityKey ? 24 : 0), 2)
  MAGIC.copy(h, 4)
  txid.copy(h, 8)
  let msg = Buffer.concat([h, body])
  if (integrityKey) {
    const mi = attr(0x0008, crypto.createHmac('sha1', integrityKey).update(msg).digest())
    msg = Buffer.concat([msg, mi])
    msg.writeUInt16BE(body.length + 24, 2)
  }
  return msg
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// 组包：可选 MESSAGE-INTEGRITY 与 FINGERPRINT（RFC 5389/8489 伪头长度规则：
// HMAC 输入的长度字段只计入到 MI 本身（不含 FP）；CRC 输入的长度字段计入 MI+FP）
function buildStun(method, attrsBuf, txid, integrityKey, withFingerprint) {
  const fpLen = withFingerprint ? 8 : 0
  const miLen = integrityKey ? 24 : 0
  const mkHeader = (len) => {
    const h = Buffer.alloc(20)
    h.writeUInt16BE(method, 0)
    h.writeUInt16BE(len, 2)
    MAGIC.copy(h, 4)
    txid.copy(h, 8)
    return h
  }
  let msg
  if (integrityKey) {
    // 1) HMAC：长度字段 = attrs + MI（不含 FP）
    const macInput = Buffer.concat([mkHeader(attrsBuf.length + miLen), attrsBuf])
    const mac = crypto.createHmac('sha1', integrityKey).update(macInput).digest()
    // 2) 组装含 MI 的消息：长度字段 = attrs + MI + FP
    msg = Buffer.concat([mkHeader(attrsBuf.length + miLen + fpLen), attrsBuf, attr(0x0008, mac)])
  } else {
    msg = Buffer.concat([mkHeader(attrsBuf.length + fpLen), attrsBuf])
  }
  if (withFingerprint) {
    const fp = crc32(msg) ^ 0x5354554e
    const fpBuf = Buffer.alloc(4)
    fpBuf.writeUInt32BE(fp >>> 0, 0)
    msg = Buffer.concat([msg, attr(0x8028, fpBuf)])
  }
  return msg
}
function parseAttrs(buf) {
  const out = new Map()
  let off = 20
  while (off + 4 <= buf.length) {
    const type = buf.readUInt16BE(off)
    const len = buf.readUInt16BE(off + 2)
    out.set(type, buf.subarray(off + 4, off + 4 + len))
    off += 4 + len + ((4 - (len % 4)) % 4)
  }
  return out
}
function xorAddress(v) {
  // XOR-MAPPED-ADDRESS / XOR-RELAYED-ADDRESS: family(2B) + xport(2B) + xip(4B)
  const port = v.readUInt16BE(2) ^ 0x2112
  const ip = Buffer.from([
    v[4] ^ MAGIC[0], v[5] ^ MAGIC[1], v[6] ^ MAGIC[2], v[7] ^ MAGIC[3],
  ]).join('.')
  return { ip, port }
}
function utf16(buf) { return buf.toString('utf8') }

// ---------- STUN Binding ----------
function probeStun(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    const txid = txnId()
    const req = buildMessage(0x0001, Buffer.alloc(0), txid)
    let done = false
    const finish = (r) => { if (!done) { done = true; try { sock.close() } catch {} resolve(r) } }
    sock.on('message', (msg) => {
      const type = msg.readUInt16BE(0)
      const attrs = parseAttrs(msg)
      if (type === 0x0101 && attrs.has(0x0020)) {
        const { ip, port: p } = xorAddress(attrs.get(0x0020))
        finish({ ok: true, detail: `映射地址 ${ip}:${p}` })
      } else finish({ ok: false, detail: `响应类型 0x${type.toString(16)}，无映射地址` })
    })
    sock.on('error', (e) => finish({ ok: false, detail: e.message }))
    sock.send(req, port, host, () => {})
    setTimeout(() => finish({ ok: false, detail: '超时无响应' }), timeoutMs)
  })
}

// ---------- TURN Allocate（RFC5766 完整两步握手）----------
function probeTurn(host, port, user = 'openrelayproject', pass = 'openrelayproject', timeoutMs = 7000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    const txid = txnId()
    let done = false
    let round = 0
    const trail = []
    const finish = (r) => { if (!done) { done = true; try { sock.close() } catch {} resolve(r) } }
    const reqTransport = attr(0x0012, Buffer.from([17, 0, 0, 0])) // REQUESTED-TRANSPORT=UDP

    sock.on('message', (msg) => {
      const type = msg.readUInt16BE(0)
      const attrs = parseAttrs(msg)
      if (type === 0x0103) { // Allocate Success
        const relay = attrs.has(0x0016) ? xorAddress(attrs.get(0x0016)) : null
        finish({ ok: true, detail: `${relay ? `中继地址 ${relay.ip}:${relay.port}` : '分配成功'}（${trail.join(' → ') || '一轮'}）` })
        return
      }
      if (type === 0x0113) { // Allocate Error
        const ec = attrs.get(0x0009)
        const code = ec && ec.length >= 4 ? (ec[ec.length - 2] & 0x07) * 100 + ec[ec.length - 1] : -1
        trail.push(code)
        if (code === 401 && attrs.has(0x0014) && attrs.has(0x0015)) {
          // 401 挑战：用长期凭据（md5(user:realm:pass) 作 HMAC-SHA1 密钥）重试 Allocate
          const realm = utf16(attrs.get(0x0014))
          const nonce = attrs.get(0x0015)
          const key = crypto.createHash('md5').update(`${user}:${realm}:${pass}`).digest()
          const authAttrs = Buffer.concat([
            attr(0x0006, Buffer.from(user)),   // USERNAME
            attr(0x0014, attrs.get(0x0014)),   // REALM
            attr(0x0015, nonce),               // NONCE
            reqTransport,
          ])
          sock.send(buildStun(0x0003, authAttrs, txid, key, true), port, host, () => {})
          return
        }
        if (code === 437) { finish({ ok: true, detail: `437 分配已存在（凭据认证通过，挑战序列 ${trail.join(' → ')}` }); return }
        finish({ ok: false, detail: `错误码 ${trail.join(' → ')}` })
        return
      }
      finish({ ok: false, detail: `未预期的响应 0x${type.toString(16)}` })
    })
    sock.on('error', (e) => finish({ ok: false, detail: e.message }))
    sock.send(buildStun(0x0003, reqTransport, txid, null, true), port, host, () => {})
    setTimeout(() => finish({ ok: false, detail: '超时无响应' }), timeoutMs)
  })
}

// ---------- MQTT WSS 回环 ----------
function probeMqtt(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (r) => { if (!done) { done = true; try { client.end(true) } catch {} resolve(r) } }
    const topic = `oraychat-probe/${crypto.randomBytes(6).toString('hex')}`
    let client
    try {
      client = mqtt.connect(url, { connectTimeout: timeoutMs, reconnectPeriod: 0, keepalive: 15 })
    } catch (e) { resolve({ ok: false, detail: e.message }); return }
    client.on('connect', () => {
      client.subscribe(topic, (err) => {
        if (err) { finish({ ok: false, detail: `订阅失败 ${err.message}` }); return }
        client.publish(topic, `probe-${Date.now()}`, { qos: 0 })
      })
    })
    client.on('message', (t, payload) => {
      if (t === topic) finish({ ok: true, detail: `连接+订阅+发布回环成功（收到 ${payload.length}B）` })
    })
    client.on('error', (e) => finish({ ok: false, detail: e.message }))
    client.on('close', () => finish({ ok: false, detail: '连接被关闭' }))
    setTimeout(() => finish({ ok: false, detail: '超时' }), timeoutMs)
  })
}

// ---------- 主流程 ----------

console.log('== STUN 公共服务器（NAT 打洞） ==')
for (const [h, p] of STUN_SERVERS) {
  const r = await probeStun(h, p)
  ;(r.ok ? ok : bad)(`STUN ${h}:${p}`, r.detail)
}

console.log('\n== TURN 公共中继（Open Relay Project，免费公共凭据） ==')
for (const [h, p] of TURN_SERVERS) {
  const r = await probeTurn(h, p)
  ;(r.ok ? ok : bad)(`TURN ${h}:${p} (udp)`, r.detail)
}

console.log('\n== MQTT 公共信令 broker（WSS，会话初始化） ==')
for (const u of MQTT_BROKERS) {
  const r = await probeMqtt(u)
  ;(r.ok ? ok : bad)(`MQTT ${u}`, r.detail)
}

const passed = results.filter((r) => r.ok).length
console.log(`\n汇总：${passed}/${results.length} 项通过`)
process.exit(passed > 0 ? 0 : 1)
