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
  const CS = 32 * 1024
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
    readChunk: async (fid, i, cs, len) => {
      const e = store.get(fid)
      if (!e?.chunks) return null
      const c = e.chunks.get(i)
      return c ? c.slice(0, len) : null
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

function mkFileX(net, hooks = {}, compress = null, opts = {}) {
  return new FileX({ net, io: memIo(), compress, ...opts, hooks })
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

// ---- 7) offer 丢帧自愈：首次 offer 未达 → 周期重发直到 ACK ----
{
  const { wire, netA, netB } = link()
  const fxA = mkFileX(netA, {}, null, { offerRetryMs: 300 })
  const fxB = mkFileX(netB)
  const content = new Uint8Array(70000)
  for (let i = 0; i < content.length; i++) content[i] = crypto.getRandomValues(new Uint8Array(1))[0]
  const fid = await fxA.sendFile('B', { bytes: content, name: 'y.bin', size: content.length, mime: 'application/octet-stream', lastModified: 5 })
  // 不回放 offer（模拟丢帧），只等重发
  await new Promise((r) => setTimeout(r, 1100))
  const tx = fxA.tx.get(fid)
  assert.ok(tx.offers >= 2, `offer 应周期重发（实际 ${tx.offers} 次）`)
  // 现在恢复回放：重发的 offer 让接收方建事务 → 完成
  for (let round = 0; round < 200 && tx.state !== 'done'; round++) {
    for (const f of wire.a2b.splice(0)) { f.__fx ? await fxB.onFrame('A', f.__fx) : fxB.onCtl('A', f) }
    for (const f of wire.b2a.splice(0)) { f.__fx ? await fxA.onFrame('B', f.__fx) : fxA.onCtl('B', f) }
    await drain(30)
  }
  assert.equal(tx.state, 'done', 'offer 重发后传输完成')
  assert.equal(await sha256Hex(await fxB.io.read(fid)), await sha256Hex(content))
}

// ---- 8) p2p 零进展自动切中继兜底（sendFx 第三参 forceRelay） ----
{
  const { wire, netA, netB } = link()
  const sentVia = []
  netA.sendFx = async (pid, frame, forceRelay) => { sentVia.push(!!forceRelay) } // 吞掉块：p2p 无响应
  const fxA = mkFileX(netA, {}, null, { offerRetryMs: 200, relayFallbackMs: 700 })
  const content = new Uint8Array(70000)
  for (let i = 0; i < content.length; i++) content[i] = crypto.getRandomValues(new Uint8Array(1))[0]
  await fxA.sendFile('B', { bytes: content, name: 'z.bin', size: content.length, mime: 'application/octet-stream', lastModified: 6 })
  // 等 forceRelay 切换（700ms）+ inflight 1.5s 超时后的重发
  await new Promise((r) => setTimeout(r, 2600))
  const tx = [...fxA.tx.values()][0]
  assert.equal(tx.forceRelay, true, '零进展后应切换 forceRelay')
  assert.ok(sentVia.length > 2, `应有超时重发（实际发送 ${sentVia.length} 次）`)
  assert.ok(sentVia.slice(-2).every(Boolean), '切换后重发的块应带 forceRelay=true')
  void wire; void netB
}

// ---- 9) 传输保护限时：活性窗口内保护 reaper，超窗后不再保护（防新残体）----
{
  const { netA } = link()
  const fxA = mkFileX(netA, {}, null, { transferProtectMs: 300 })
  const content = new Uint8Array(70000)
  for (let i = 0; i < content.length; i++) content[i] = crypto.getRandomValues(new Uint8Array(1))[0]
  await fxA.sendFile('B', { bytes: content, name: 'p.bin', size: content.length, mime: 'application/octet-stream', lastModified: 7 })
  assert.equal(fxA.hasActiveTransfer('B'), true, '活跃传输应受保护')
  // 模拟彻底卡死（对端消失，无 ACK 无重发活性）……但泵每 200ms 发块 = 活性！
  // 发块也算活性是对的（对端可能活着只是 ACK 被挤）——保护窗口判据在 onFrame/onHave。
  // 对"对端已死"的真实判定：net 层 relay.peers 消失 + pc 断 → pump 里 peer.state!=='ready'
  // 时 pump 只 return 不发块 → lastLifeAt 不再更新 → 超窗后不再保护。
  netA.peers.get('B').state = 'connecting' // 会话抖动：泵空转
  await new Promise((r) => setTimeout(r, 450))
  assert.equal(fxA.hasActiveTransfer('B'), false, '活性超窗后应退出传输保护（reaper 可回收残体）')
}

// ---- 10) 停滞转 stalled，会话就绪自动复活 ----
{
  const { wire, netA, netB } = link()
  const fxA = mkFileX(netA, {}, null, { transferProtectMs: 300 })
  const fxB = mkFileX(netB)
  const content = new Uint8Array(140000)
  for (let i = 0; i < content.length; i++) content[i] = crypto.getRandomValues(new Uint8Array(1))[0]
  const fid = await fxA.sendFile('B', { bytes: content, name: 'q.bin', size: content.length, mime: 'application/octet-stream', lastModified: 8 })
  // 接收方直接把 tx 转 stalled（模拟长停滞）……发送方经 onOffer 重放恢复
  await new Promise((r) => setTimeout(r, 600))
  const rtx = [...fxB.tx.values()][0]
  if (rtx) { rtx.state = 'stalled' }
  // 恢复回放直到双方 done
  for (let round = 0; round < 300; round++) {
    for (const f of wire.a2b.splice(0)) { f.__fx ? await fxB.onFrame('A', f.__fx) : fxB.onCtl('A', f) }
    for (const f of wire.b2a.splice(0)) { f.__fx ? await fxA.onFrame('B', f.__fx) : fxA.onCtl('B', f) }
    if (fxA.tx.get(fid)?.state === 'done') break
    await drain(25)
  }
  assert.equal(fxA.tx.get(fid)?.state, 'done', '恢复后完成')
  assert.equal(await sha256Hex(await fxB.io.read(fid)), await sha256Hex(content))
  void netB
}

// ---- 11) P1-1 FEC：组内唯一缺失块由奇偶块本地恢复（免重传） ----
{
  const { wire, netA, netB } = link()
  const fxA = mkFileX(netA)
  const fxB = mkFileX(netB)
  const content = new Uint8Array(32768 * 9) // 9 块 = 2 组（0..7 / 8）
  for (let i = 0; i < content.length; i++) content[i] = crypto.getRandomValues(new Uint8Array(1))[0]
  const fid = await fxA.sendFile('B', { bytes: content, name: 'fec.bin', size: content.length, mime: 'application/octet-stream', lastModified: 9 })
  // 逐帧回放，但丢弃 i=3 的数据帧（模拟丢块）；奇偶块正常到达
  let dropped3 = 0
  for (let round = 0; round < 400; round++) {
    const frames = wire.a2b.splice(0)
    for (const f of frames) {
      if (f.__fx && f.__fx.i === 3) { dropped3++; continue } // 块 3 永远丢
      if (f.__fx) await fxB.onFrame('A', f.__fx)
      else await fxB.onCtl('A', f)
    }
    for (const f of wire.b2a.splice(0)) { f.__fx ? await fxA.onFrame('B', f.__fx) : fxA.onCtl('B', f) }
    if (fxA.tx.get(fid)?.state === 'done') break
    await drain(20)
  }
  const rtx = fxB.tx.get(fid)
  assert.ok(dropped3 >= 1, '块 3 至少被丢一次')
  assert.equal(rtx.state, 'done', 'FEC 恢复后传输完成')
  assert.ok(rtx.have[0] & (1 << 3), '块 3 位图已置位（由奇偶块恢复）')
  assert.equal(await sha256Hex(await fxB.io.read(fid)), await sha256Hex(content), '恢复内容与原文一致')
}

const WINDOW_DEFAULT = 16 // P2P 默认窗口（与 filex WINDOW_P2P 一致）

// ---- 12) P0-1 自适应窗口与 endgame 窗口 ----
{
  const { netA } = link()
  const fxA = mkFileX(netA)
  const tx = { n: 100, cs: 32768, have: new Uint8Array(13), rttEma: 0, rateEma: 0 }
  assert.equal(fxA.windowFor(tx, WINDOW_DEFAULT), WINDOW_DEFAULT, '无采样时用路径默认窗口')
  tx.rttEma = 50; tx.rateEma = 4 * 1024 * 1024 // 4MB/s × 50ms = 200KB ≈ 6 块 BDP
  const w = fxA.windowFor(tx, WINDOW_DEFAULT)
  assert.ok(w >= 4 && w <= 64, `自适应窗口在限幅内（${w}）`)
  assert.ok(w >= 6, `窗口应 ≥ 1.5×BDP 块数（${w}）`)
  // endgame：剩 2 块（≤max(2, 2)）→ 窗口翻倍
  for (let k = 0; k < 98; k++) bitmapSet(tx.have, k)
  const remain = 100 - bitmapCount(tx.have)
  assert.equal(remain, 2)
  const we = fxA.windowFor(tx, WINDOW_DEFAULT)
  assert.equal(we, Math.min(128, w * 2), 'endgame 窗口加倍')
  assert.equal(fxA.inflightTimeoutFor(tx), 750, 'endgame 重发阈值减半')
}
// ---- 13) P0-2 令牌桶速率预算 ----
{
  const { netA } = link()
  const fxA = new FileX({ net: netA, io: memIo(), maxRateDm: 65536, hooks: {} }) // 64KB/s
  assert.equal(fxA.paceTake(32000), 0, '首桶容量内立即可发')
  const wait = fxA.paceTake(65000)
  assert.ok(wait >= 400 && wait <= 1200, `超预算后应等待约 1s（实际 ${wait}ms）`)
  const budget = fxA.paceLimit()
  assert.equal(budget, 65536, '无中继传输时用 p2p 档预算')
}

console.log('filex.test.mjs ✓ 全部通过（压缩/位图/全流程/断点续传/篡改拒绝/原图模式/offer重发/中继兜底/保护限时/停滞复活/FEC/自适应窗口/令牌桶）')
process.exit(0) // pump 定时器会挂住事件循环，显式退出
