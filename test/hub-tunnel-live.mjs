// 私有中继 + Cloudflare 快速隧道全公网实测（手工跑）：caffeinate -i node test/hub-tunnel-live.mjs
// 拓扑：alice = hub（内嵌 Aedes + cloudflared 快速隧道）；bob 仅连 wss://<trycloudflare>/
// 流量路径：bob → CF 边缘 → 隧道 → alice 本机 Aedes —— 验证公网可达与协议完整。
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { killTrees } from './proc-kill.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ELECTRON = createRequire(import.meta.url)('electron')
const ROOM = `oc-hubt-${Date.now().toString(36)}`
const PORT = 48992
const lines = { alice: [], bob: [] }
const procs = []
const userData = (p) => path.join(os.homedir(), 'Library', 'Application Support', 'OrayChat', `${p}-hubt`)

function launch(profile, key, extra = []) {
  const p = spawn(ELECTRON, ['.', `--profile=${profile}-hubt`, '--bot', `--name=${profile}`, `--room=${ROOM}`, ...extra], { cwd: ROOT, env: process.env })
  procs.push(p)
  for (const s of ['stdout', 'stderr']) {
    p[s].on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) lines[key].push(l) })
  }
  return p
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const A = () => lines.alice.join('\n')
const B = () => lines.bob.join('\n')

console.log(`== hub-tunnel-live：房间 ${ROOM} ==`)
for (const p of ['alice', 'bob']) {
  fs.rmSync(userData(p), { recursive: true, force: true })
  fs.mkdirSync(userData(p), { recursive: true })
}
try { exec('lsof -ti :48992 | xargs kill -9 2>/dev/null') } catch { /* 无残留 */ }
function exec(cmd) { return spawn('/bin/zsh', ['-c', cmd], { stdio: 'ignore' }) }

launch('alice', 'alice', ['--relay-hub', `--hub-port=${PORT}`, '--hub-tunnel', '--auto-reply'])

// 等隧道 URL（alice 日志里的 [HUB] 隧道就绪）
let tunnelUrl = ''
{
  const t0 = Date.now()
  while (Date.now() - t0 < 90000) {
    const m = A().match(/隧道就绪 (wss:\/\/[a-z0-9-]+\.trycloudflare\.com)/)
    if (m) { tunnelUrl = m[1]; break }
    await sleep(2000)
  }
}
console.log(`隧道地址: ${tunnelUrl || '（未就绪）'}`)
let okTunnel = !!tunnelUrl
let okEcho = false
if (okTunnel) {
  // bob 仅连隧道地址（无公共链、无本机链）
  fs.writeFileSync(path.join(userData('bob'), 'local-state.json'), JSON.stringify({
    'oc-config': { relayBrokers: [`${tunnelUrl}/mqtt`] },
  }))
  launch('bob', 'bob', ['--send-to=alice', '--text=隧道链路', '--count=2', '--auto-reply'])
  const t0 = Date.now()
  while (Date.now() - t0 < 120000) {
    okEcho = okEcho || /\[BOT\] ECHO 2\/2/.test(B())
    if (okEcho) break
    await sleep(2000)
  }
}
killTrees(procs)

console.log('\n== 结果 ==')
console.log(`  快速隧道就绪:            ${okTunnel ? '✓' : '✗'} ${tunnelUrl}`)
console.log(`  bob 经公网隧道完成握手+消息回环: ${okEcho ? '✓ ECHO 2/2' : '✗'}`)
const ok = okTunnel && okEcho
if (!ok) {
  console.log('\n== 失败诊断：alice 尾部 =='); console.log(lines.alice.slice(-14).join('\n'))
  console.log('\n== 失败诊断：bob 尾部 =='); console.log(lines.bob.slice(-14).join('\n'))
}
console.log(ok ? '\n✅ 隧道全链路实测通过' : '\n❌ 隧道全链路实测失败')
process.exit(ok ? 0 : 1)
