// RelayTransport 独立测试（Node，同进程双实例，注入不同 instanceId）
// 验证：presence 互通、inbox 定向投递、双向帧回环
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { RelayTransport } from '../renderer/src/relay.mjs'

const APP = 'oraychat-p2p-v1'
const ROOM = `relay-test-${Date.now().toString(36)}`
const idA = crypto.randomBytes(10).toString('hex')
const idB = crypto.randomBytes(10).toString('hex')

const frames = { a: [], b: [] }
const t1 = new RelayTransport({
  appId: APP, roomId: ROOM, myName: 'nodeA', instanceId: idA,
  brokerUrls: ['wss://broker-cn.emqx.io:8084/mqtt'],
  onAnnounce: (id, info) => console.log(`A 见到 ${id.slice(0, 10)} (${info.name})`),
  onFrame: (from, kind, data) => { frames.a.push({ from, kind, data }); console.log(`A 收到帧 kind=${kind}`) },
  onLog: (m) => console.log(`[A] ${m}`),
})
const t2 = new RelayTransport({
  appId: APP, roomId: ROOM, myName: 'nodeB', instanceId: idB,
  brokerUrls: ['wss://broker-cn.emqx.io:8084/mqtt'],
  onAnnounce: (id, info) => console.log(`B 见到 ${id.slice(0, 10)} (${info.name})`),
  onFrame: (from, kind, data) => { frames.b.push({ from, kind, data }); console.log(`B 收到帧 kind=${kind}`) },
  onLog: (m) => console.log(`[B] ${m}`),
})

// 等待双方 presence 互通
await new Promise((r) => setTimeout(r, 10000))
console.log(`\nA.peers=${[...t1.peers.keys()].map((k) => k.slice(0, 10))} B.peers=${[...t2.peers.keys()].map((k) => k.slice(0, 10))}`)
assert.ok(t1.peers.has(idB), 'A 应通过 presence 发现 B')
assert.ok(t2.peers.has(idA), 'B 应通过 presence 发现 A')

// A → B 定向帧
t1.send(idB, 'hs', { t: 'OC-HS1-v1', probe: 'hello-b' })
await new Promise((r) => setTimeout(r, 3000))
console.log('B 收到的帧:', JSON.stringify(frames.b))
assert.ok(frames.b.some((f) => f.from === idA && f.kind === 'hs'), 'B 应收到 A 的定向 hs 帧')

// B → A 回帧
t2.send(idA, 'msg', { v: 1, c: 'ZW5jcnlwdGVkLWNpcGhlcnRleHQ', s: 1 })
await new Promise((r) => setTimeout(r, 3000))
console.log('A 收到的帧:', JSON.stringify(frames.a))
assert.ok(frames.a.some((f) => f.from === idB && f.kind === 'msg'), 'A 应收到 B 的回执帧')

t1.destroy(); t2.destroy()
console.log('\n✅ relay presence + 双向定向投递全部正常')
process.exit(0)
