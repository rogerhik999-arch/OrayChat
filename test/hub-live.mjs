// 私有中继服务实测（手工跑，约 1 分钟）：caffeinate -i node test/hub-live.mjs
// 拓扑：alice 开中继服务模式（--relay-hub，内嵌 Aedes @127.0.0.1:48990）；
// alice 与 bob 的 broker 列表【仅】含 ws://127.0.0.1:48990/mqtt（无公共链）——
// 证明私有 broker 承载完整协议：presence/握手/消息/ACK/文件传输。
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto2 from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { killTrees } from './proc-kill.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ELECTRON = createRequire(import.meta.url)('electron')
const ROOM = `oc-hub-${Date.now().toString(36)}`
const PORT = 48990
const lines = { alice: [], bob: [], carol: [] }
const procs = []
const userData = (p) => path.join(os.homedir(), 'Library', 'Application Support', 'OrayChat', `${p}-hub`)

// 预写 profile 配置：broker 列表仅私有链（公共链零参与，拓扑隔离）
for (const p of ['alice', 'bob', 'carol']) {
  fs.rmSync(userData(p), { recursive: true, force: true })
  fs.mkdirSync(userData(p), { recursive: true })
  fs.writeFileSync(path.join(userData(p), 'local-state.json'), JSON.stringify({
    'oc-config': { relayBrokers: [`ws://127.0.0.1:${PORT}/mqtt`] },
  }))
}

const testFile = path.join(os.tmpdir(), `oc-hub-${Date.now()}.txt`)
fs.writeFileSync(testFile, '私有中继文件传输验证。\n'.repeat(200))
const srcSha = crypto2.createHash('sha256').update(fs.readFileSync(testFile)).digest('hex')

function launch(profile, key, extra = []) {
  const p = spawn(ELECTRON, ['.', `--profile=${profile}-hub`, '--bot', `--name=${profile}`, `--room=${ROOM}`, ...extra], { cwd: ROOT, env: process.env })
  procs.push(p)
  for (const s of ['stdout', 'stderr']) {
    p[s].on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) lines[key].push(l) })
  }
  return p
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const A = () => lines.alice.join('\n')
const B = () => lines.bob.join('\n')

console.log(`== hub-live：房间 ${ROOM}，私有链 ws://127.0.0.1:${PORT}/mqtt ==`)
// 残留实例会占用 hub 端口（单实例锁 + listen EADDRINUSE），先清场
import('node:child_process').then(({ execSync }) => {
  try { execSync(`lsof -ti :${PORT} | xargs kill -9 2>/dev/null`, { shell: '/bin/zsh' }) } catch { /* 无残留 */ }
})
await sleep(1500)

launch('alice', 'alice', ['--relay-hub', `--hub-port=${PORT}`, '--roster-log', '--save-latest', '--auto-reply'])
await sleep(3000)
// bob 发文本回环；carol 发文件（bot 注入器 fileMode 下不跑文本回环，须分开）
launch('bob', 'bob', ['--send-to=alice', '--text=私有链', '--count=2', '--auto-reply'])
await sleep(2000)
launch('carol', 'carol', ['--send-to=alice', `--send-file=${testFile}`, '--auto-reply'])

// 等消息回环 + 文件完成
let okEcho = false, okFile = false
{
  const t0 = Date.now()
  while (Date.now() - t0 < 120000) {
    okEcho = okEcho || /\[BOT\] ECHO 2\/2/.test(B())
    okFile = okFile || /FILE-DONE dir=recv/.test(A())
    if (okEcho && okFile) break
    await sleep(2000)
  }
}
await sleep(3000) // 等 SAVED
killTrees(procs)
fs.rmSync(testFile, { force: true })

const hubListen = / broker 监听 ws:\/\/127\.0\.0\.1:\d+/.test(A())
const hubClients = (A().match(/client 连接 total=(\d+)/g) || []).length > 0
const saved = [...A().matchAll(/\[BOT\] SAVED fid=(\w+) name=("[^"]*") path=("[^"]*")/g)].pop()
let shaOk = false
if (saved) {
  try { shaOk = crypto2.createHash('sha256').update(fs.readFileSync(JSON.parse(saved[3]))).digest('hex') === srcSha } catch { /* 未落盘 */ }
}

console.log('\n== 结果 ==')
console.log(`  hub broker 监听:        ${hubListen ? '✓' : '✗'}`)
console.log(`  hub 有客户端接入:       ${hubClients ? '✓' : '✗'}`)
console.log(`  双向握手+消息回环:      ${okEcho ? '✓ ECHO 2/2' : '✗'}`)
console.log(`  文件经私有链传输完成:   ${okFile ? '✓ FILE-DONE' : '✗'}`)
console.log(`  下载 SHA-256 一致:      ${shaOk ? '✓' : '✗'}`)

const ok = hubListen && okEcho && okFile && shaOk
if (!ok) {
  console.log('\n== 失败诊断：alice 尾部 ==')
  console.log(lines.alice.slice(-20).join('\n'))
  console.log('\n== 失败诊断：bob 尾部 ==')
  console.log(lines.bob.slice(-20).join('\n'))
}
console.log(ok ? '\n✅ 私有中继服务实测通过' : '\n❌ 私有中继服务实测失败')
process.exit(ok ? 0 : 1)
