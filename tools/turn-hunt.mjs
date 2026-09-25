// 批量探测候选的免费公共 TURN 服务器（UDP + TCP）
import dgram from 'node:dgram'
import net from 'node:net'
import crypto from 'node:crypto'

const MAGIC = Buffer.from([0x21, 0x12, 0xa4, 0x42])
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const txnId = () => crypto.randomBytes(12)
const attr = (type, value) => {
  const pad = (4 - (value.length % 4)) % 4
  const head = Buffer.alloc(4)
  head.writeUInt16BE(type, 0); head.writeUInt16BE(value.length, 2)
  return Buffer.concat([head, value, Buffer.alloc(pad)])
}
function buildStun(method, attrsBuf, txid, integrityKey, withFingerprint) {
  const fpLen = withFingerprint ? 8 : 0
  const miLen = integrityKey ? 24 : 0
  const mkHeader = (len) => {
    const h = Buffer.alloc(20)
    h.writeUInt16BE(method, 0); h.writeUInt16BE(len, 2)
    MAGIC.copy(h, 4); txid.copy(h, 8)
    return h
  }
  let msg
  if (integrityKey) {
    const macInput = Buffer.concat([mkHeader(attrsBuf.length + miLen), attrsBuf])
    const mac = crypto.createHmac('sha1', integrityKey).update(macInput).digest()
    msg = Buffer.concat([mkHeader(attrsBuf.length + miLen + fpLen), attrsBuf, attr(0x0008, mac)])
  } else msg = Buffer.concat([mkHeader(attrsBuf.length + fpLen), attrsBuf])
  if (withFingerprint) {
    const fp = crc32(msg) ^ 0x5354554e
    const b = Buffer.alloc(4); b.writeUInt32BE(fp >>> 0, 0)
    msg = Buffer.concat([msg, attr(0x8028, b)])
  }
  return msg
}
function parseAttrs(buf) {
  const out = new Map(); let off = 20
  while (off + 4 <= buf.length) {
    const type = buf.readUInt16BE(off); const len = buf.readUInt16BE(off + 2)
    out.set(type, buf.subarray(off + 4, off + 4 + len))
    off += 4 + len + ((4 - (len % 4)) % 4)
  }
  return out
}
const errCodeOf = (ec) => ec && ec.length >= 4 ? (ec[ec.length - 2] & 0x07) * 100 + ec[ec.length - 1] : -1
const xorRelay = (v) => {
  const port = v.readUInt16BE(2) ^ 0x2112
  const ip = [v[4] ^ 33, v[5] ^ 18, v[6] ^ 164, v[7] ^ 66].join('.')
  return `${ip}:${port}`
}
const REQ = attr(0x0012, Buffer.from([17, 0, 0, 0]))

// 在给定 socket 发送/接收抽象上执行两步 Allocate
function allocate(send, onReply, user, pass, timeoutMs) {
  return new Promise((resolve) => {
    const txid = txnId()
    let done = false
    const finish = (r) => { if (!done) { done = true; resolve(r) } }
    onReply((msg) => {
      const type = msg.readUInt16BE(0)
      const attrs = parseAttrs(msg.subarray ? msg : msg)
      if (type === 0x0103) finish({ ok: true, detail: `中继地址 ${attrs.has(0x0016) ? xorRelay(attrs.get(0x0016)) : '?'}` })
      else if (type === 0x0113) {
        const code = errCodeOf(attrs.get(0x0009))
        if (code === 401 && attrs.has(0x0014) && attrs.has(0x0015)) {
          const realm = attrs.get(0x0014)
          const key = crypto.createHash('md5').update(`${user}:${realm.toString('utf8')}:${pass}`).digest()
          const authAttrs = Buffer.concat([REQ, attr(0x0006, Buffer.from(user)), attr(0x0014, realm), attr(0x0015, attrs.get(0x0015))])
          send(buildStun(0x0003, authAttrs, txid, key, true))
        } else finish({ ok: false, detail: `ERR ${code}` })
      } else if (type === 0x0101) finish({ ok: false, detail: 'binding-ok(非TURN?)' })
      else finish({ ok: false, detail: `0x${type.toString(16)}` })
    })
    send(buildStun(0x0003, REQ, txid, null, true))
    setTimeout(() => finish({ ok: false, detail: 'TIMEOUT' }), timeoutMs)
  })
}

function probeUdp(host, port, user, pass, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    let pending = null
    sock.on('message', (msg) => pending?.(msg))
    sock.on('error', () => resolve({ ok: false, detail: 'socket error' }))
    sock.send(Buffer.alloc(1), port, host, () => {})
    setTimeout(() => { try { sock.close() } catch {} }, timeoutMs + 500)
    const send = (buf) => sock.send(buf, port, host, () => {})
    allocate(send, (cb) => { pending = cb }, user, pass, timeoutMs)
      .then((r) => { try { sock.close() } catch {} resolve(r) })
  })
}

function probeTcp(host, port, user, pass, timeoutMs = 7000) {
  return new Promise((resolve) => {
    const sock = net.createConnection(port, host)
    let buf = Buffer.alloc(0)
    let pending = null
    const finish = (r) => { try { sock.destroy() } catch {} resolve(r) }
    sock.on('connect', () => sock.write(buildStun(0x0003, REQ, txnId(), null, true)))
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      // STUN over TCP：按头部长度取整包（简化：请求/响应各一包）
      while (buf.length >= 20) {
        const len = buf.readUInt16BE(2)
        const total = 20 + len + ((4 - (len % 4)) % 4)
        if (buf.length < total) break
        const msg = buf.subarray(0, total)
        buf = buf.subarray(total)
        if (pending) { const cb = pending; pending = null; cb(msg) }
      }
    })
    sock.on('error', (e) => finish({ ok: false, detail: `tcp ${e.message}` }))
    sock.setTimeout(timeoutMs, () => finish({ ok: false, detail: 'tcp timeout' }))
    allocate((m) => sock.write(m), (cb) => { pending = cb }, user, pass, timeoutMs).then(finish)
  })
}

const CASES = [
  ['anyfirewall', 'turn.anyfirewall.com', 3478, 'webrtc', 'webrtc', 'udp'],
  ['anyfirewall-tcp', 'turn.anyfirewall.com', 3478, 'webrtc', 'webrtc', 'tcp'],
  ['anyfirewall-443tcp', 'turn.anyfirewall.com', 443, 'webrtc', 'webrtc', 'tcp'],
  ['expressturn-free', 'relay1.expressturn.com', 3478, 'free', 'free', 'udp'],
  ['expressturn-demo', 'relay1.expressturn.com', 3478, 'demo', 'demo', 'udp'],
  ['openrelay-3478', 'openrelay.metered.ca', 3478, 'openrelayproject', 'openrelayproject', 'udp'],
]

for (const [name, host, port, user, pass, transport] of CASES) {
  const r = transport === 'udp'
    ? await probeUdp(host, port, user, pass)
    : await probeTcp(host, port, user, pass)
  console.log(`${r.ok ? '✅' : '❌'} ${name} ${host}:${port}/${transport} (${user}) — ${r.detail}`)
}
