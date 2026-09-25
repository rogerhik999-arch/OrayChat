// 房间口令 e2e：真实拉起三个桌面实例
//   阶段1: alice/bob 用相同口令登录同一房间 → 正常互连（READY、加密往返可用）
//   阶段2: eve 用错误口令进入同一房间 → 信令无法解密、中继帧被丢弃，
//          60 秒内始终无法与任何成员建立会话（门禁生效）
// 运行：node test/e2e-pass.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron')
const ROOM = `oc-pass-${Date.now().toString(36)}`
const PASS = `sesame-口令-${Date.now().toString(36)}`

const lines = { pa: [], pb: [], eve: [] }
const procs = []

function launch(key, name, args) {
  const p = spawn(ELECTRON, ['.', `--profile=${key}`, '--bot', `--name=${name}`, `--room=${ROOM}`, ...args], { cwd: ROOT })
  procs.push(p)
  p.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (line.trim()) { lines[key].push(line); console.log(`  [${key}] ${line}`) }
    }
  })
  p.stderr.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (line.trim() && !/webrtc|stun_port|socket_tcp|sandbox_ext/.test(line)) lines[key].push(line)
    }
  })
  return p
}

function killAll() { for (const p of procs) { try { p.kill('SIGKILL') } catch { /* 忽略 */ } } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  console.log(`== 房间口令 e2e：房间 ${ROOM} ==`)
  const results = []
  let pass = true

  // ---- 阶段 1：正确口令 → 正常互连 ----
  console.log('\n--- 阶段 1：相同口令的成员正常互连 ---')
  launch('pa', 'alice', [`--room-pass=${PASS}`, '--auto-reply'])
  await sleep(2500)
  launch('pb', 'bob', [`--room-pass=${PASS}`, '--send-to=alice', '--text=hello', '--count=1'])
  const start = Date.now()
  let readyBoth = false
  while (Date.now() - start < 90000) {
    const a = lines.pa.some((l) => l.includes('[BOT] READY peer='))
    const b = lines.pb.some((l) => l.includes('[BOT] READY peer=') && l.includes('TEST-OK')) || lines.pb.some((l) => l.includes('[TEST-OK]'))
    if (lines.pa.some((l) => l.includes('[BOT] READY')) && lines.pb.some((l) => l.includes('[TEST-OK]'))) { readyBoth = true; break }
    await sleep(1000)
  }
  results.push(['阶段1：相同口令成员正常互连并完成加密往返', readyBoth])
  console.log(`  ${readyBoth ? '✅' : '❌'} 阶段 1 ${readyBoth ? '通过' : '失败（90s 未完成互连）'}`)
  pass = pass && readyBoth

  // 记录阶段 2 开始时刻，alice/bob 此后不应出现与 eve 的新会话
  const aliceReadyCount = lines.pa.filter((l) => l.includes('[BOT] READY')).length

  // ---- 阶段 2：错误口令 → 被门禁挡住 ----
  console.log('\n--- 阶段 2：错误口令被拒绝（信令无法解密，无法建立任何会话） ---')
  launch('eve', 'eve', ['--room-pass=wrong-password', '--exit-after-ms=60000'])
  await sleep(62000)
  const eveReady = lines.eve.some((l) => l.includes('[BOT] READY'))
  const eveJoinErr = lines.eve.some((l) => l.includes('incorrect room password')) || lines.eve.some((l) => l.includes('加入房间失败'))
  const aliceNewPeers = lines.pa.filter((l) => l.includes('[BOT] READY')).length > aliceReadyCount
  const gateOk = !eveReady && !aliceNewPeers
  results.push([`阶段2：错误口令 60s 内无法建立任何会话${eveJoinErr ? '（收到口令错误提示）' : ''}`, gateOk])
  console.log(`  ${gateOk ? '✅' : '❌'} 阶段 2 ${gateOk ? '通过' : '失败'}：eveReady=${eveReady} aliceNewPeers=${aliceNewPeers}`)

  console.log('\n== 房间口令 e2e 断言汇总 ==')
  for (const [name, ok] of results) console.log(`  ${ok ? '✅' : '❌'} ${name}`)
  if (pass && gateOk) console.log('\n🎉 房间口令 e2e 通过：正确口令互通，错误口令被门禁挡住')
  else pass = false
  killAll()
  process.exit(pass ? 0 : 1)
}

run().catch((e) => {
  console.error(`\n❌ ${e.message}`)
  killAll()
  process.exit(1)
})
