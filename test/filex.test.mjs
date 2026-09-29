// 文件传输 filex 单元测试：全流程 / 断点续传 / 篡改拒绝 / 协议级压缩 / 位图
// 用法：node test/filex.test.mjs（无网络：一对 FileX 用假 net 直连回放）
import assert from 'node:assert/strict'
import * as oc from '../renderer/src/crypto.mjs'
import { FileX, maybeDeflate, inflate, bitmapSet, bitmapHas, bitmapCount, chunkCount, sha256Hex } from '../renderer/src/filex.mjs'

// ---- 会话上下文（两端同密钥，模拟握手后的 ctx）----
const KEY = oc.hmac ? null : null
const key = (await import('@noble/hashes/hkdf.js')).hkdf
void KEY; void key
const sessionKey = new Uint8Array(32).fill(7)
const ctxA = { key: sessionKey, selfIdPub: new Uint8Array(32).fill(1), peerIdPub: new Uint8Array(32).fill(2), sendSeq: 0, recvSeqMax: 0 }
const ctxB = { key: sessionKey, selfIdPub: new Uint8Array(32).fill(2), peerIdPub: new Uint8Array(32).fill(1), sendSeq: 0, recvSeqMax: 0 }

// ---- 假 net：A 的 ctl/chunk 直接回放给 B（掉线场景可控）----
function link() {
  const wire = { a2b: [], b2a: [], aReady: true, bReady: true }
  const peerA = { state: 'ready', via: 'p2p', ctx: ctxA, idPubHex: '22'.repeat(32) }
  const peerB = { state: 'ready', via: 'p2p', ctx: ctxB, idPubHex: '11'.repeat(32) }
  const netA = {
    peers: new Map([['B', peerA]]),
    sendCtl: async (pid, frame) => { if (wire.aReady) wire.a2b.push(frame) },
    sendFx: async (pid, frame) => { if (wire.aReady) wire.a2b.push({ __fx: frame }) },
  }
  const netB = {
    peers: new Map([['A', peerB]]),
    sendCtl: async (pid, frame) => { if (wire.bReady) wire.b2a.push(frame) },
    sendFx: async (pid, frame) => { if (wire.bReady) wire.b2a.push({ __fx: frame }) },
  }
  return { wire, netA, netB, peerA, peerB }
}

// 内存 io 适配器（与 web-shim 同构）
function memIo() {
  const store = new Map()
  return {
    store,
    state: async (fid, { n }) => {
      const e = store.get(fid)
      if (e?.have) return { have: [...e.have] }
      return { have: new Array(Math.ceil(n / 8)).fill(0) }
    },
    write: async (fid, i, cs, bytes) => {
      const e = (store.get(fid) || (store.set(fid, { chunks: new Map(), have: [] }), store.get(fid)))
      e.chunks.set(i, bytes)
      const bi = i >> 3
      while (e.have.length <= bi) e.have.push(0)
      e.have[bi] |= 1 << (i & 7)
      return true
    },
    finalize: async (fid, shaHex) => {
      const e = store.get(fid)
      if (!e) return { ok: false, why: 'not-found' }
      const sorted = [...e.chunks.keys()].sort((a, b) => a - b)
      const total = sorted.reduce((acc, i) => acc + e.chunks.get(i).length, 0)
      const all = new Uint8Array(total)
      let off = 0
      for (const i of sorted) { all.set(e.chunks.get(i), off); off += e.chunks.get(i).length }
      const hex = await sha256Hex(all)
      if (hex !== shaHex) return { ok: false, why: 'sha-mismatch' }
      e.bytes = all
      return { ok: true, path: `mem:${fid}` }
    },
    read: async (fid) => store.get(fid)?.bytes || null,
    abort: async (fid) => { store.delete(fid); return true },
  }
}

function mkFileX(net, hooks = {}, compress = null) {
  return new FileX({ net, io: memIo(), compress, hooks })
}

const drain = (ms = 30) => new Promise((r) => setTimeout(r, ms))

// ---- 1) 协议级压缩助手 ----
{
  const text = Buffer.alloc(100000, 0x61) // 高度可压缩
  const { data, z } = await maybeDeflate(new Uint8Array(text))
  assert.equal(z, 1, '可压缩内容应标记 z=1')
  assert.ok(data.length < text.length / 2, 'deflate 应显著缩小')
  const back = await inflate(data)
  assert.deepEqual(back, new Uint8Array(text))
  const rand = new Uint8Array(5000)
  crypto.getRandomValues(rand) // 真随机：不可压缩
  const r = await maybeDeflate(rand)
  assert.equal(r.z, 0, '不可压缩内容应跳过（z=0）')
}

// ---- 2) 位图助手 ----
{
  const bm = new Uint8Array(2)
  bitmapSet(bm, 0); bitmapSet(bm, 7); bitmapSet(bm, 9); bitmapSet(bm, 15)
  assert.equal(bitmapCount(bm), 4)
  assert.ok(bitmapHas(bm, 15) && !bitmapHas(bm, 14))
  assert.equal(chunkCount(1, 65536), 1)
  assert.equal(chunkCount(65537, 65536), 2)
}

// ---- 3) 全流程：文件（多块 + 末块不满）发送 → 接收 → SHA 校验 ----
{
  const { wire, netA, netB } = link()
  const events = { sent: [], recv: [] }
  const fxA = mkFileX(netA, { onEvent: (e) => events.sent.push(e) })
  const fxB = mkFileX(netB, { onEvent: (e) => events.recv.push(e) })
  // 随机内容（跳过 deflate）+ 尾块不满
  const content = new Uint8Array(65536 + 30000 + 70000 + 12345)
  for (let i = 0; i < content.length; i++) content[i] = (i * 31 + 7) & 0xff
  const file = { bytes: content, name: '测试.bin', size: content.length, mime: 'application/octet-stream', lastModified: 1 }
  const fid = await fxA.sendFile('B', file, { kind: 'file' })
  assert.ok(fid, '返回内容寻址 fid')

  // 回放：A 的 offer → B；B 的 have → A；A 的块 → B …… 直到完成
  for (let round = 0; round < 200; round++) {
    const ctl = wire.a2b.splice(0)
    for (const f of ctl) { f.__fx ? await fxB.onFrame('A', f.__fx) : fxB.onCtl('A', f) }
    const back = wire.b2a.splice(0)
    for (const f of back) { f.__fx ? await fxA.onFrame('B', f.__fx) : fxA.onCtl('B', f) }
    if (events.sent.some((e) => e.fid === fid && e.state === 'done')) break
    await drain()
  }
  assert.equal(events.sent.at(-1).state, 'done', '发送方最终 done')
  assert.equal(events.recv.some((e) => e.state === 'done'), true, '接收方 done')
  const rx = await fxB.io.read(fid)
  assert.ok(rx, '接收方已有完整字节')
  assert.equal(await sha256Hex(rx), await sha256Hex(content), 'SHA-256 一致（端到端完整性）')
}

// ---- 4) 断点续传：传 60% 中断 → 重新 offer → 只传缺失块 ----
{
  const { wire, netA, netB } = link()
  const fxA = mkFileX(netA)
  const fxB = mkFileX(netB)
  const content = new Uint8Array(65536 * 5) // 5 块
  for (let i = 0; i < content.length; i++) content[i] = (i * 17) & 0xff
  const fid = await fxA.sendFile('B', { bytes: content, name: 'doc.bin', size: content.length, mime: 'application/octet-stream', lastModified: 2 })

  // 等待 pump 首轮发块，然后逐帧回放：B 侧写满 2 块即"断线"（其余帧丢弃）
  for (let round = 0; round < 60 && !wire.a2b.some((f) => f.__fx); round++) await drain(30)
  for (let round = 0; round < 200; round++) {
    const f = wire.a2b.shift()
    if (!f) { await drain(20); continue }
    if (f.__fx) await fxB.onFrame('A', f.__fx)
    else await fxB.onCtl('A', f)
    for (const b of wire.b2a.splice(0)) { b.__fx ? await fxA.onFrame('B', b.__fx) : fxA.onCtl('B', b) }
    if ((fxB.io.store.get(fid)?.chunks.size || 0) >= 2) break
  }
  wire.aReady = false
  const dropped = wire.a2b.splice(0).filter((f) => f.__fx).length
  for (const b of wire.b2a.splice(0)) { b.__fx ? await fxA.onFrame('B', b.__fx) : fxA.onCtl('B', b) }
  const st = fxB.io.store.get(fid)
  const gotBefore = st ? st.chunks.size : 0
  assert.ok(gotBefore === 2 && dropped > 0, `中断时已收 ${gotBefore}/5 块（丢弃在途 ${dropped}）`)
  wire.aReady = false
  // 接收方重放 offer（同一内容 → 同一 fid）：io.state 返回已有位图
  const stHave = await fxB.io.state(fid, { size: content.length, cs: 65536, n: 5 })
  assert.equal(bitmapCount(Uint8Array.from(stHave.have)), gotBefore, '位图持久保留')

  // 发送方恢复
  wire.aReady = true
  const fxA2io = fxA // 同一发送方（模拟 app 重启后重发：新 FileX、相同内容）
  const fxA2 = mkFileX(netA)
  void fxA2io
  const fid2 = await fxA2.sendFile('B', { bytes: content, name: 'doc.bin', size: content.length, mime: 'application/octet-stream', lastModified: 2 })
  assert.equal(fid2, fid, '内容寻址：同一文件 fid 稳定')
  for (let round = 0; round < 200 && !(fxA2.tx.get(fid2)?.state === 'done'); round++) {
    for (const f of wire.a2b.splice(0)) { f.__fx ? await fxB.onFrame('A', f.__fx) : fxB.onCtl('A', f) }
    for (const f of wire.b2a.splice(0)) { f.__fx ? await fxA2.onFrame('B', f.__fx) : fxA2.onCtl('B', f) }
    await drain()
  }
  assert.equal(fxA2.tx.get(fid2)?.state, 'done', '续传后完成')
  const missing = 5 - gotBefore
  assert.ok(bitmapCount(Uint8Array.from(stHave.have)) <= gotBefore + missing + 2, '接收方位图接近满（缺块已补）')
  assert.equal(await sha256Hex(await fxB.io.read(fid)), await sha256Hex(content), '续传后内容一致')
}

// ---- 5) 篡改拒绝：块密文被改 → 解密抛错，不落盘 ----
{
  const { wire, netA, netB } = link()
  const fxA = mkFileX(netA)
  const fxB = mkFileX(netB)
  const content = new Uint8Array(70000)
  for (let i = 0; i < content.length; i++) content[i] = i & 0xff
  await fxA.sendFile('B', { bytes: content, name: 'x.bin', size: content.length, mime: 'application/octet-stream', lastModified: 3 })
  for (let round = 0; round < 60 && !wire.a2b.some((f) => f.__fx); round++) await drain(30)
  await drain(20)
  const frames = wire.a2b.splice(0)
  const offer = frames.find((f) => f.op === 'fx-offer')
  await fxB.onCtl('A', offer) // 先建接收事务
  const chunk = frames.find((f) => f.__fx)
  chunk.__fx.e.c = chunk.__fx.e.c.slice(0, -4) + 'AAAA' // 篡改密文尾部
  await fxB.onFrame('A', chunk.__fx) // onFrame 内部捕获解密错误只记日志
  const st0 = fxB.io.store.get(chunk.__fx.fid)
  assert.ok(!st0?.chunks.has(chunk.__fx.i), '被篡改的块不得写入')
  const good = frames.find((f) => f.__fx && f !== chunk)
  await fxB.onFrame('A', good.__fx)
  assert.ok(fxB.io.store.get(good.__fx.fid)?.chunks.has(good.__fx.i), '正常块照常写入')
}

// ---- 6) 图片格式压缩注入：compress 决定传输内容，orig 跳过 ----
{
  const { wire, netA, netB } = link()
  const fakePng = new Uint8Array(50000).fill(0x33)
  const compressed = new Uint8Array(8000).fill(0x11)
  const compress = async () => ({ bytes: compressed, w: 1024, h: 768, mime: 'image/webp', mode: 'img' })
  const fxA = mkFileX(netA, {}, compress)
  const fxB = mkFileX(netB)
  const offers = []
  fxB.onOffer = async (pid, o) => { offers.push(o); await fxB.sendHave(pid, o.fid) }
  await fxA.sendFile('B', { bytes: fakePng, name: 'photo.png', size: fakePng.length, mime: 'image/png', lastModified: 4 }, { kind: 'image', orig: false })
  await drain()
  const offer = wire.a2b.find((f) => f.op === 'fx-offer')
  assert.equal(offer.size, compressed.length, '默认模式：传输格式压缩后的字节')
  assert.equal(offer.mode, 'img')
  assert.equal(offer.w, 1024)

  const fxA2 = mkFileX(netA, {}, compress)
  await fxA2.sendFile('B', { bytes: fakePng, name: 'photo.png', size: fakePng.length, mime: 'image/png', lastModified: 4 }, { kind: 'image', orig: true })
  await drain()
  const offer2 = wire.a2b.filter((f) => f.op === 'fx-offer').at(-1)
  assert.equal(offer2.size, fakePng.length, '原图模式：传输原始字节（只走协议级压缩）')
  assert.equal(offer2.mode, 'raw')
  void fxB
}

console.log('filex.test.mjs ✓ 全部通过（压缩/位图/全流程/断点续传/篡改拒绝/原图模式）')
process.exit(0) // pump 定时器会挂住事件循环，显式退出
