// 长跑健壮性 P0 三件套单测：node test/longrun.test.mjs
//   ① 全局看门狗状态机（判据/冷却升级/挂起条件——Object.create 驱动，无网络）
//   ② 增量游标同步（exportSince 只发增量/墓碑余量/游标推进/30min 全量周期）
//   ③ 稳定 clientId（同 URL 恒同 / 异 URL 互异 / 指纹前缀不变）
import assert from 'node:assert/strict'
import { ChatNet } from '../renderer/src/net.mjs'
import { LogStore } from '../renderer/src/store.mjs'
import { RelayTransport } from '../renderer/src/relay.mjs'

const results = []
const ok = (name, cond, detail = '') => { results.push(cond); console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`) }

// ---------- ① 看门狗 ----------
console.log('[1] 全局看门狗状态机')
function makeNet({ connected = true, ready = 1, transferring = false, lastInbound, inflight = false } = {}) {
  const net = Object.create(ChatNet.prototype)
  net.destroyed = false
  net.relay = { connected, lastInboundAt: lastInbound ?? Date.now() }
  net.peers = new Map()
  for (let i = 0; i < ready; i++) net.peers.set(`p${i}`, { state: 'ready' })
  net.filex = { hasActiveTransfer: () => transferring }
  net.goOnlineInflight = inflight
  net.goOnline = (reason) => { net.goOnlineReasons = [...(net.goOnlineReasons || []), reason] }
  net.hooks = { onLog: () => {} }
  return net
}
{
  const net = makeNet({ lastInbound: Date.now() - 10 * 1000 })
  net.watchdogCheck()
  ok('1.1 入站新鲜（10s）不触发复位', !net.goOnlineReasons?.length && net._wdK === 0)

  const net2 = makeNet({ lastInbound: Date.now() - 6 * 60 * 1000 })
  net2.watchdogCheck()
  ok('1.2 零入站 6min + 有就绪会话 → 触发复位', net2.goOnlineReasons?.length === 1)
  ok('1.3 复位后进入冷却（10min）且升级计数=1', net2._wdK === 1 && net2._wdCooldownUntil > Date.now() + 9 * 60000)

  const t0 = net2._wdCooldownUntil
  net2.watchdogCheck()
  ok('1.4 冷却期内不重复复位', net2.goOnlineReasons?.length === 1 && net2._wdCooldownUntil === t0)

  const net3 = makeNet({ lastInbound: Date.now() - 6 * 60 * 1000 })
  net3._wdK = 1
  net3.watchdogCheck()
  ok('1.5 连续复位冷却翻倍（20min）', net3.goOnlineReasons?.length === 1 && net3._wdCooldownUntil - Date.now() > 19 * 60000)

  const net4 = makeNet({ lastInbound: Date.now() - 6 * 60 * 1000, ready: 0 })
  net4.watchdogCheck()
  ok('1.6 空房静默（无就绪会话）不触发', !net4.goOnlineReasons?.length)

  const net5 = makeNet({ lastInbound: Date.now() - 6 * 60 * 1000, connected: false })
  net5.watchdogCheck()
  ok('1.7 链路全断（非自称存活）不触发——那是重试链的活', !net5.goOnlineReasons?.length)

  const net6 = makeNet({ lastInbound: Date.now() - 6 * 60 * 1000, transferring: true })
  net6.watchdogCheck()
  ok('1.8 传输活跃期挂起', !net6.goOnlineReasons?.length)

  const net7 = makeNet({ lastInbound: Date.now() - 6 * 60 * 1000, inflight: true })
  net7.watchdogCheck()
  ok('1.9 goOnline 在途不重复触发', !net7.goOnlineReasons?.length)

  const net8 = makeNet({ lastInbound: Date.now() - 10 * 1000 })
  net8._wdK = 3
  net8.watchdogCheck()
  ok('1.10 入站恢复清零升级计数', net8._wdK === 0)
}

// ---------- ② 增量游标同步 ----------
console.log('[2] exportSince 增量导出')
{
  const now = Date.now()
  const s = new LogStore({ now: () => now })
  for (let i = 0; i < 10; i++) s.addMsg('c', { mid: `m${i}`, author: 'a'.repeat(64), text: `消息${i}`, t: now - (10 - i) * 60000, type: 'text' })
  const full = s.exportConv('c')
  ok('2.1 全量 10 条', full.entries.length === 10)

  const since = s.exportSince('c', now - 4 * 60000) // 只发最近 4 分钟（> sinceT）
  ok('2.2 增量只含游标后的条目', since.entries.length === 3 && since.entries[0].mid === 'm7', `got ${since.entries.length}`)

  // 墓碑余量：删除时间略早于 sinceT（5min 内）也要带
  s.applyDel('c', 'm9', now - 4.5 * 60000)
  const since2 = s.exportSince('c', now - 4 * 60000)
  ok('2.3 墓碑带 5min 余量（删于 sinceT 前也要发）', Object.keys(since2.dels).includes('m9'), JSON.stringify(Object.keys(since2.dels)))

  // 游标推进语义（net 层）：maxT = 条目/墓碑最大值
  const s2 = new LogStore({ now: () => now })
  for (let i = 0; i < 5; i++) s2.addMsg('c', { mid: `n${i}`, author: 'a'.repeat(64), text: `t${i}`, t: now - (5 - i) * 60000, type: 'text' })
  const st = s2.exportSince('c', now - 3 * 60000)
  const maxT = Math.max(0, ...st.entries.map((e) => e.t || 0), ...Object.values(st.dels).map((t) => t || 0))
  ok('2.4 游标推进取条目最大 t（最新条目=now-1min）', maxT === now - 60000, `maxT=${maxT} 期望=${now - 60000}`)

  // 幂等收敛：增量+全量混投，接收端结果一致
  const s3 = new LogStore({ now: () => now })
  s3.applyState('c', full)
  s3.applyState('c', since2)
  const back = s3.exportConv('c')
  ok('2.5 全量+增量混投幂等收敛（m9 已删）', back.entries.length === 9 && !back.entries.some((e) => e.mid === 'm9'), `entries=${back.entries.length}`)

  // 增量帧字节预算仍生效
  const s4 = new LogStore({ now: () => now })
  for (let i = 0; i < 50; i++) s4.addMsg('c', { mid: `b${i}`, author: 'a'.repeat(64), text: 'x'.repeat(200), t: now - (50 - i) * 1000, type: 'text', thumb: 'd'.repeat(8000) })
  const big = s4.exportSince('c', now - 100 * 1000, { bytes: 160 * 1024 })
  ok('2.6 增量帧超预算剥 thumb', JSON.stringify(big).length < 200 * 1024, `${Math.round(JSON.stringify(big).length / 1024)}KB`)
}

// ---------- ③ 稳定 clientId ----------
console.log('[3] stableClientId')
{
  const base = 'oc-abcd1234'
  const a = RelayTransport.stableClientId(base, 'wss://broker-cn.emqx.io:8084/mqtt')
  const b = RelayTransport.stableClientId(base, 'wss://broker-cn.emqx.io:8084/mqtt')
  const c = RelayTransport.stableClientId(base, 'wss://broker.emqx.io:8084/mqtt')
  ok('3.1 同 URL 恒同（persistent session 前提）', a === b)
  ok('3.2 异 URL 互异（并联防互踢）', a !== c)
  ok('3.3 保留身份指纹前缀（hub 成员识别兼容）', /^oc-abcd1234-[0-9a-z]{1,6}$/.test(a), a)
}

const pass = results.filter(Boolean).length
console.log(`\n${pass === results.length ? '✅' : '❌'} longrun.test.mjs：${pass}/${results.length} 通过`)
process.exit(pass === results.length ? 0 : 1)
