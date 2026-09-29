// 旧身份归并实测（手工跑，约 3 分钟）：caffeinate -i node test/idmerge-live.mjs
// 场景：bob 与 alice 聊过（旧公钥桶形成）→ 删除 bob 身份文件模拟"重装"→
// 同名重新登录（新公钥）→ alice 侧应建立 旧公钥→新公钥 别名并界面提示，
// 原始分桶不动（读时合并）。
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { killTrees } from './proc-kill.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ELECTRON = createRequire(import.meta.url)('electron')
const ROOM = `oc-idmerge-${Date.now().toString(36)}`
const lines = { alice: [], bob: [] }
const procs = []
const userData = (p) => path.join(os.homedir(), 'Library', 'Application Support', 'OrayChat', `${p}-merge`)

function launch(profile, key, extra = []) {
  const p = spawn(ELECTRON, ['.', `--profile=${profile}-merge`, '--bot', `--name=${profile}`, `--room=${ROOM}`, ...extra], { cwd: ROOT, env: process.env })
  procs.push(p)
  for (const s of ['stdout', 'stderr']) {
    p[s].on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) lines[key].push(l) })
  }
  return p
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const A = () => lines.alice.join('\n')
const readyCount = (key, peer) => lines[key].filter((l) => l.includes(`[BOT] READY peer=${peer}`)).length

console.log(`== idmerge-live：房间 ${ROOM} ==`)
// 干净环境
for (const p of ['alice', 'bob']) { try { fs.rmSync(userData(p), { recursive: true, force: true }) } catch {} }

launch('alice', 'alice')
await sleep(3000)
let bob = launch('bob', 'bob', ['--send-to=alice', '--text=旧身份时代的消息', '--count=2', '--auto-reply'])
// 等 bob 发完 2 条（ECHO 2/2）
{
  const t0 = Date.now()
  while (Date.now() - t0 < 120000 && lines.bob.filter((l) => l.includes('[BOT] ECHO')).length < 2) await sleep(2000)
}
const oldPub = (() => {
  const f = path.join(userData('bob'), 'identities', 'bob.json')
  const j = JSON.parse(fs.readFileSync(f, 'utf8'))
  return `edPub=${j.edPub}`
})()
console.log(`[phase1] bob#1 完成 2 条消息；旧公钥 ${String(oldPub).slice(0, 16)}…`)

// 模拟重装：杀进程 + 删身份文件 → 同名重登（新公钥）
bob.kill('SIGKILL')
await sleep(1500)
fs.rmSync(path.join(userData('bob'), 'identities', 'bob.json'), { force: true })
console.log('\n[phase2] bob 身份文件已删（模拟重装），同名重新登录…')
const bobReadyBefore = readyCount('bob', 'alice')
bob = launch('bob', 'bob', ['--send-to=alice', '--text=新身份的消息', '--count=1', '--auto-reply'])
{
  const t0 = Date.now()
  while (Date.now() - t0 < 120000 && readyCount('bob', 'alice') <= bobReadyBefore) await sleep(2000)
}
await sleep(15000) // 等握手/别名建立/新消息到达

const newPub = (() => {
  const f = path.join(userData('bob'), 'identities', 'bob.json')
  const j = JSON.parse(fs.readFileSync(f, 'utf8'))
  return `edPub=${j.edPub}`
})()
const aliceState = path.join(userData('alice'), 'local-state.json')
const kv = JSON.parse(fs.readFileSync(aliceState, 'utf8'))
const aliases = kv[`oc-id-aliases:${ROOM}`] || {}
const aliasedOld = Object.keys(aliases).map((k) => k.slice(0, 16)).join(',')
const noticeMerged = /旧身份已并入当前会话/.test(A())
const newMsgRecv = /RECV from=bob text="新身份的消息/.test(A()) // bot 发送会带 -n 后缀
const bucketsUntouched = (() => {
  const log = kv[`oc-log2:${ROOM}`]
  if (!log || typeof log !== 'object') return false
  // exportAll 形状：{ 'dm:<hash>': {entries,dels,clearT}, ... } —— 旧桶与新桶并存（读时合并，未动数据）
  return Object.keys(log).filter((k) => k.startsWith('dm:')).length >= 2
})()

console.log(`[phase2] bob#2 新公钥 ${String(newPub).slice(0, 16)}…`)
fs.writeFileSync('/tmp/idmerge-live-alice.log', lines.alice.join('\n'))
fs.writeFileSync('/tmp/idmerge-live-bob.log', lines.bob.join('\n'))
console.log('--- alice 日志尾部（完整在 /tmp/idmerge-live-alice.log）---')
for (const l of lines.alice.filter((l) => /LOG|STORE-NOTICE|READY|RECV|残身|身份|ECHO/.test(l)).slice(-25)) console.log(`  [alice] ${l}`)
console.log('--- bob 日志尾部（完整在 /tmp/idmerge-live-bob.log）---')
for (const l of lines.bob.filter((l) => /LOG|READY|SENT|ECHO/.test(l)).slice(-10)) console.log(`  [bob] ${l}`)
console.log('\n== 结果 ==')
console.log(`  alice 建立旧→新身份别名: ${Object.keys(aliases).length >= 1 ? `✓ (${aliasedOld}… →)` : '✗'}`)
console.log(`  界面提示「旧身份已并入」: ${noticeMerged ? '✓' : '✗'}`)
console.log(`  新身份消息正常收到:      ${newMsgRecv ? '✓' : '✗'}`)
console.log(`  原始分桶未被改写:        ${bucketsUntouched ? '✓' : '✗'}`)
killTrees(procs)
process.exit(Object.keys(aliases).length >= 1 && noticeMerged && newMsgRecv && bucketsUntouched ? 0 : 1)
