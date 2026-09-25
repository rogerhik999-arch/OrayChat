// LogStore 单元测试：合并收敛、删除传播、清空、30 天保留
import assert from 'node:assert/strict'
import { LogStore, dmConvKey, RETENTION_MS } from '../renderer/src/store.mjs'

const D = 24 * 3600 * 1000
let clock = 1_000_000_000_000
const now = () => clock
const mid = (s) => s.padEnd(24, '0')

// --- 基础增删查 ---
const s = new LogStore({ now })
assert.equal(s.addMsg('lobby', { mid: mid('m1'), author: 'A', text: 'hello', t: now() }), true)
assert.equal(s.addMsg('lobby', { mid: mid('m1'), author: 'A', text: 'hello', t: now() }), false, '重复 mid 幂等')
assert.equal(s.visibleCount('lobby'), 1)
s.applyDel('lobby', mid('m1'))
assert.equal(s.visibleCount('lobby'), 0, '删除后不可见')
// 被删除的消息重新同步过来也不得复活
assert.equal(s.addMsg('lobby', { mid: mid('m1'), author: 'A', text: 'hello', t: now() }), false, '墓碑压制重发')
console.log('✅ 增删查与墓碑压制')

// --- 清空：clearT 之后的消息保留，之前的丢弃 ---
clock += 10 * D
s.applyClear('lobby', now() - 5 * D) // 清空 5 天前的一切
s.addMsg('lobby', { mid: mid('old'), author: 'A', text: 'old', t: now() - 8 * D }) // 应被拒（<= clearT）
s.addMsg('lobby', { mid: mid('new'), author: 'B', text: 'new', t: now() })         // 应保留
assert.deepEqual(s.visible('lobby').map((e) => e.mid), [mid('new')], 'clearT 生效')
// 再收到 old 也要被 clearT 过滤
assert.equal(s.applyState('lobby', { entries: [{ mid: mid('old'), author: 'A', text: 'old', t: now() - 8 * D }], dels: {}, clearT: 0 }), false)
console.log('✅ 清空标记（clearT 语义）')

// --- 合并收敛：两个成员各自持有不同子集，交换状态后必须完全一致 ---
const alice = new LogStore({ now: Date.now })
const bob = new LogStore({ now: Date.now })
const T = Date.now()
const mk = (n, author, text, off) => ({ mid: mid(n), author, text, t: T - off })
// alice 有 m2,m3,m4，且删了 m3；bob 有 m1,m2,m5，并清空到 T-100D
alice.addMsg('c', mk('m2', 'A', 'msg2', 40 * D))
alice.addMsg('c', mk('m3', 'B', 'msg3', 30 * D))
alice.addMsg('c', mk('m4', 'A', 'msg4', 20 * D))
alice.applyDel('c', mid('m3'))
bob.addMsg('c', mk('m1', 'B', 'msg1', 90 * D))
bob.addMsg('c', mk('m2', 'A', 'msg2', 40 * D))
bob.addMsg('c', mk('m5', 'B', 'msg5', 10 * D))
bob.applyClear('c', T - 80 * D) // m1(T-90D) 被清掉
// 双向交换
alice.applyState('c', bob.exportConv('c'))
bob.applyState('c', alice.exportConv('c'))
// 再交换一轮（应无变更）
const a2 = alice.applyState('c', bob.exportConv('c'))
const b2 = bob.applyState('c', alice.exportConv('c'))
assert.equal(a2, false, '第二轮 alice 无变更（已收敛）')
assert.equal(b2, false, '第二轮 bob 无变更（已收敛）')
assert.deepEqual(
  JSON.stringify(alice.exportConv('c')),
  JSON.stringify(bob.exportConv('c')),
  '两端状态逐字节一致',
)
assert.deepEqual(
  alice.visible('c').map((e) => e.mid),
  [mid('m4'), mid('m5')],
  '合并结果：m1 被 clear 清掉，m3 被墓碑删掉，m1/m2 超过 30 天保留期被过滤',
)
// 收敛后 m3 重新传来也不复活
assert.equal(alice.applyState('c', { entries: [mk('m3', 'B', 'msg3', 30 * D)], dels: {}, clearT: 0 }), false)
console.log('✅ 双成员合并收敛 + 删除/清空压制复活')

// --- 三成员随机操作序列收敛性（简化 fuzz） ---
const stores = [0, 1, 2].map(() => new LogStore({ now: Date.now }))
let seq = 0
for (let round = 0; round < 30; round++) {
  const i = round % 3
  const op = round % 5
  if (op < 3) {
    seq++
    stores[i].addMsg('g', { mid: mid(`x${seq}`), author: `P${i}`, text: `t${seq}`, t: Date.now() })
  } else {
    const vis = stores[i].visible('g')
    if (vis.length > 1) stores[i].applyDel('g', vis[0].mid)
  }
  // 每轮随机两两同步
  const [x, y] = [[0, 1], [1, 2], [0, 2]][round % 3]
  stores[x].applyState('g', stores[y].exportConv('g'))
  stores[y].applyState('g', stores[x].exportConv('g'))
}
// 最终全量同步两轮
for (let r = 0; r < 2; r++) {
  for (const [x, y] of [[0, 1], [1, 2], [0, 2], [1, 0], [2, 1], [2, 0]]) {
    stores[x].applyState('g', stores[y].exportConv('g'))
  }
}
const ref = JSON.stringify(stores[0].exportConv('g'))
assert.ok(JSON.stringify(stores[1].exportConv('g')) === ref && JSON.stringify(stores[2].exportConv('g')) === ref,
  '三成员随机操作后状态完全收敛')
console.log('✅ 三成员随机操作收敛性')

// --- 30 天保留期 ---
const t0 = Date.now()
const rs = new LogStore({ now: () => t0 })
rs.addMsg('r', { mid: mid('keep'), author: 'A', text: 'keep', t: t0 - 29 * D })
rs.addMsg('r', { mid: mid('drop'), author: 'A', text: 'drop', t: t0 - 31 * D }) // 写入即过期
assert.deepEqual(rs.visible('r').map((e) => e.mid), [mid('keep')])
rs.addMsg('r', { mid: mid('later'), author: 'A', text: 'later', t: t0 - 1 * D })
assert.equal(rs.sweep(), false, '无过期项')
assert.equal(rs.visibleCount('r'), 2)
// 时间前进 2 天：keep(29d)→31d 过期，later(1d)→3d 保留
const rs2 = new LogStore({ now: () => t0 + 2 * D, load: () => rs.exportAll() })
rs2.sweep()
assert.deepEqual(rs2.visible('r').map((e) => e.mid), [mid('later')], '30 天自动清除')
// 导出也不含过期项
assert.ok(!JSON.stringify(rs2.exportConv('r')).includes('keep'))
console.log('✅ 30 天保留期（写入过滤 + 定期清扫 + 同步过滤）')

// --- 私聊会话键两端一致 ---
assert.equal(dmConvKey('bbb', 'aaa'), 'aaa')
assert.equal(dmConvKey('aaa', 'bbb'), 'aaa')
console.log('✅ 私聊会话键规范（两端同键）')

console.log('\n✅ history.test.mjs 全部通过')
