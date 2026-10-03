// 删除联系人实测（手工跑，约 3 分钟）：caffeinate -i node test/delcontact-live.mjs
// 场景：bob 与 alice 互聊 → bob 离线（历史名录残留僵尸）→ alice 删除联系人 bob
// → 名录消失、私聊桶清除；bob 重新上线互联 → 自动恢复显示。
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { killTrees } from './proc-kill.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ELECTRON = createRequire(import.meta.url)('electron')
const ROOM = `oc-delc-${Date.now().toString(36)}`
const lines = { alice: [], bob: [] }
const procs = []
const userData = (p) => path.join(os.homedir(), 'Library', 'Application Support', 'OrayChat', `${p}-delc`)

function launch(profile, key, extra = []) {
  const p = spawn(ELECTRON, ['.', `--profile=${profile}-delc`, '--bot', `--name=${profile}`, `--room=${ROOM}`, ...extra], { cwd: ROOT, env: process.env })
  procs.push(p)
  for (const s of ['stdout', 'stderr']) {
    p[s].on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) lines[key].push(l) })
  }
  return p
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const A = () => lines.alice.join('\n')
const readyCount = (key, peer) => lines[key].filter((l) => l.includes(`[BOT] READY peer=${peer}`)).length

console.log(`== delcontact-live：房间 ${ROOM} ==`)
for (const p of ['alice', 'bob']) { try { fs.rmSync(userData(p), { recursive: true, force: true }) } catch {} }

launch('alice', 'alice')
await sleep(3000)
let bob = launch('bob', 'bob', ['--send-to=alice', '--text=僵尸前的消息', '--count=2', '--auto-reply'])
{
  const t0 = Date.now()
  while (Date.now() - t0 < 120000 && lines.bob.filter((l) => l.includes('[BOT] ECHO')).length < 2) await sleep(2000)
}
// bob 优雅退出（leave 事件 → alice 侧移除在线条目；历史名录仍留 bob）
bob.kill('SIGKILL')
console.log('[phase1] 互聊 2 条完成，bob 已退出')

// alice 删除联系人 bob（等 90s 保证 bob 不在在线列表）
await sleep(90000)
const bobPubBefore = JSON.parse(fs.readFileSync(path.join(userData('alice'), 'local-state.json'), 'utf8'))[`oc-names:${ROOM}`]
console.log(`[phase2] alice 名录（删除前）: ${Object.keys(bobPubBefore || {}).length} 个身份`)
// ⚠️ 单实例锁：必须先杀 alice#1，否则 alice#2 被弹退、删除参数不执行
killTrees(procs)
await sleep(2000)
procs.length = 0
launch('alice', 'alice', ['--del-contact=bob', '--del-contact-after-ms=6000'])
{
  const t0 = Date.now()
  while (Date.now() - t0 < 60000 && !/CONTACT-DELETED/.test(A())) await sleep(2000)
}
await sleep(3000)
const kvAfter = JSON.parse(fs.readFileSync(path.join(userData('alice'), 'local-state.json'), 'utf8'))
const namesAfter = kvAfter[`oc-names:${ROOM}`] || {}
const ignoredAfter = kvAfter[`oc-ignored-ids:${ROOM}`] || []
const bucketsAfter = Object.keys(kvAfter[`oc-log2:${ROOM}`] || {}).filter((k) => k.startsWith('dm:'))
const deleted = /CONTACT-DELETED/.test(A())
const rosterLine = (A().match(/\[BOT\] ROSTER ([^\n]*)/) || [])[1] || ''
console.log(`[phase2] CONTACT-DELETED=${deleted ? '✓' : '✗'} 名录=${JSON.stringify(rosterLine)} 忽略名单=${ignoredAfter.length} 剩余dm桶=${bucketsAfter.length}`)

// bob 重新上线（同 profile 同身份）→ alice 应自动恢复显示
console.log('\n[phase3] bob 重新上线，验证自动恢复…')
bob = launch('bob', 'bob', ['--send-to=alice', '--text=我回来了', '--count=1', '--auto-reply'])
{
  const t0 = Date.now()
  while (Date.now() - t0 < 120000 && readyCount('bob', 'alice') < 1) await sleep(2000)
}
await sleep(10000)
const revivedRoster = (A().match(/\[BOT\] ROSTER ([^\n]*)/g) || []).pop() || ''
const recvBack = /RECV from=bob text="我回来了/.test(A())
const ignoredFinal = (JSON.parse(fs.readFileSync(path.join(userData('alice'), 'local-state.json'), 'utf8'))[`oc-ignored-ids:${ROOM}`] || []).length
fs.writeFileSync('/tmp/delcontact-live-alice.log', lines.alice.join('\n'))
fs.writeFileSync('/tmp/delcontact-live-bob.log', lines.bob.join('\n'))
console.log(`[phase3] bob 回归后：新消息收到=${recvBack ? '✓' : '✗'} 忽略名单大小=${ignoredFinal}（期望 0）`)
console.log(`[phase3] ${revivedRoster}`)

console.log('\n== 结果 ==')
console.log(`  删除执行（CONTACT-DELETED）:      ${deleted ? '✓' : '✗'}`)
console.log(`  删除后名录不含 bob:              ${!/fwd/i.test(rosterLine) && rosterLine.trim() !== '' ? (rosterLine.includes('(empty)') ? '✓' : '?') : '?'}（${rosterLine.trim()}）`)
console.log(`  忽略名单持久化（1 个身份）:        ${ignoredAfter.length === 1 ? '✓' : '✗'}`)
console.log(`  私聊桶已清除:                    ${bucketsAfter.length === 0 ? '✓' : `✗ (${bucketsAfter.length})`}`)
console.log(`  bob 回归自动恢复 + 新消息收到:     ${recvBack && ignoredFinal === 0 ? '✓' : '✗'}`)
killTrees(procs)
const ok = deleted && ignoredAfter.length === 1 && bucketsAfter.length === 0 && recvBack && ignoredFinal === 0
process.exit(ok ? 0 : 1)
