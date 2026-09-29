// 多 broker 并联（Nostr 式）单元测试：双链路存活、帧去重、单链路故障零感知
// 用法：node test/relay-multi.test.mjs
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { RelayTransport } from '../renderer/src/relay.mjs'

const APP = 'oraychat-p2p-v1'
const ROOM = `relay-multi-${Date.now().toString(36)}`
const idA = crypto.randomBytes(10).toString('hex')
const idB = crypto.randomBytes(10).toString('hex')
const BROKERS = ['wss://broker-cn.emqx.io:8084/mqtt', 'wss://broker.emqx.io:8084/mqtt']

const frames = { b: [] }
const t1 = new RelayTransport({
  appId: APP, roomId: ROOM, myName: 'nodeA', instanceId: idA, parallel: 2,
  brokerUrls: BROKERS,
  onAnnounce: () => {},
  onFrame: (from, kind, data) => { frames.b.push({ from, kind, data }) },
  onLog: (m) => console.log(`[A] ${m}`),
})
const t2 = new RelayTransport({
  appId: APP, roomId: ROOM, myName: 'nodeB', instanceId: idB, parallel: 2,
  brokerUrls: BROKERS,
  onAnnounce: () => {},
  onFrame: (from, kind, data) => { frames.b.push({ from, kind, data }) },
  onLog: (m) => console.log(`[B] ${m}`),
})

// 1) 等双方 presence 互通 + 双链路并联
{
  const start = Date.now()
  while (Date.now() - start < 60000 && !(t1.peers.has(idB) && t2.peers.has(idA))) {
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log(`\npresence 互通耗时 ${Math.round((Date.now() - start) / 1000)}s`)
  console.log(`A 并联链路: ${t1.aliveLinks().length} 条  B 并联链路: ${t2.aliveLinks().length} 条`)
}
assert.ok(t1.peers.has(idB), 'A 应通过 presence 发现 B')
assert.ok(t2.peers.has(idA), 'B 应通过 presence 发现 A')
assert.equal(t1.aliveLinks().length, 2, 'A 应有 2 条并联链路')
assert.equal(t2.aliveLinks().length, 2, 'B 应有 2 条并联链路')

// 2) 连发 5 帧：去重后 B 恰好收到 5 个（多链路随机分流不会造成重复投递）
for (let i = 1; i <= 5; i++) t1.send(idB, 'msg', { n: i })
await new Promise((r) => setTimeout(r, 6000))
const got = frames.b.filter((f) => f.from === idA && f.kind === 'msg')
console.log(`\n发送 5 帧，B 实收 ${got.length} 帧（去重生效 = 无重复）`)
assert.equal(got.length, 5, '并联链路下不应出现重复帧')

// 3) 杀掉 A 的一条链路：connected 仍为 true，消息继续可达
const victim = t1.aliveLinks()[0]
victim.client.end(true)
await new Promise((r) => setTimeout(r, 3000))
console.log(`\n单链路被杀后 A.connected=${t1.connected}（存活 ${t1.aliveLinks().length} 条）`)
assert.ok(t1.connected, '单链路死亡后整体仍应在线')

// 4) 单链路死亡期间消息仍达（另一条链路承载）
const before = frames.b.filter((f) => f.from === idA && f.kind === 'msg').length
t1.send(idB, 'msg', { n: 99 })
await new Promise((r) => setTimeout(r, 6000))
const after = frames.b.filter((f) => f.from === idA && f.kind === 'msg').length
console.log(`单链路故障期间发送 1 帧：${before} → ${after}（应 +1）`)
assert.equal(after - before, 1, '单链路故障不影响投递')

t1.destroy(); t2.destroy()
console.log('\n✅ relay-multi：双链路并联 / txid 去重 / 单链路故障零感知 全部通过')
process.exit(0)
