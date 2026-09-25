// “记住口令”e2e：真实拉起桌面实例
//   阶段1: alice 口令登录并 --remember-pass 保存；bob 同口令加入，完成加密往返
//   阶段2: 双方重启，alice 登录时不带 --room-pass → 自动使用本机记住的口令，与 bob 再次互连
//   阶段3: 对照组——全新 profile（无口令、未记住）加入同一房间 → 60s 无法与任何成员互连
//          （口令不同 = 互不可见的群体，门禁未被削弱）
// 运行：node test/e2e-remember.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron')
const ROOM = `oc-rem-${Date.now().toString(36)}`
const PASS = `pass-记住-${Date.now().toString(36)}`

const lines = { ra: [], rb: [], eve: [] }
const procs = []

function launch(key, name, args) {
  const p = spawn(ELECTRON, ['.', `--profile=${key}`, '--bot', `--name=${name}`, `--room=${ROOM}`, ...args], { cwd: ROOT })
  p.__key = key
  procs.push(p)
  const sink = lines[key]
  p.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (line.trim()) { sink.push(line); console.log(`  [${key}] ${line}`) }
    }
  })
  p.stderr.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (line.trim() && !/webrtc|stun_port|socket_tcp|sandbox_ext/.test(line)) sink.push(line)
    }
  })
  return p
}

function kill(key) {
  const i = procs.findIndex((p) => p.__key === key)
  if (i >= 0) { try { procs[i].kill('SIGKILL') } catch { /* 忽略 */ } procs.splice(i, 1) }
}
function killAll() { for (const p of procs) { try { p.kill('SIGKILL') } catch { /* 忽略 */ } } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitReady(key, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (lines[key].some((l) => /\[BOT\] READY peer=/.test(l))) return true
    await sleep(1000)
  }
  return false
}

async function run() {
  console.log(`== 记住口令 e2e：房间 ${ROOM} ==`)
  const results = []
  let pass = true

  // ---- 阶段 1：alice 记住口令；bob 同口令加入，完成加密往返 ----
  console.log('\n--- 阶段 1：口令登录 + alice --remember-pass 保存 ---')
  launch('ra', 'alice', [`--room-pass=${PASS}`, '--remember-pass', '--auto-reply', '--no-exit'])
  await sleep(2500)
  launch('rb', 'bob', [`--room-pass=${PASS}`, '--send-to=alice', '--text=hello', '--count=1'])
  let ok1 = false
  {
    const start = Date.now()
    while (Date.now() - start < 90000) {
      if (lines.rb.some((l) => l.includes('[TEST-OK]'))) { ok1 = true; break }
      await sleep(1000)
    }
  }
  results.push(['阶段1：口令登录 + 记住口令，完成加密往返', ok1])
  console.log(`  ${ok1 ? '✅' : '❌'} 阶段 1`)
  pass = pass && ok1

  // ---- 阶段 2：双方重启，alice 不带口令参数 → 用本机记住的口令重连 ----
  console.log('\n--- 阶段 2：重启后 alice 不带口令参数 → 自动使用本机记住的口令 ---')
  killAll(); await sleep(1500)
  launch('rb', 'bob', [`--room-pass=${PASS}`, '--auto-reply', '--no-exit'])
  await sleep(2500)
  launch('ra', 'alice', ['--auto-reply', '--no-exit']) // 注意：没有 --room-pass
  const ok2 = await waitReady('ra', 90000)
  results.push(['阶段2：重启后无口令参数仍成功互连（本机记住的口令生效）', ok2])
  console.log(`  ${ok2 ? '✅' : '❌'} 阶段 2`)
  pass = pass && ok2

  // ---- 阶段 3：对照：全新 profile（无口令、未记住）无法进入 ----
  console.log('\n--- 阶段 3：对照组：未记住口令的实例无法进入（门禁仍在） ---')
  launch('eve', 'eve', ['--exit-after-ms=60000'])
  await sleep(62000)
  const eveReady = lines.eve.some((l) => /\[BOT\] READY peer=/.test(l))
  results.push(['阶段3：对照——无口令实例 60s 无法与任何成员互连', !eveReady])
  console.log(`  ${!eveReady ? '✅' : '❌'} 阶段 3`)
  pass = pass && !eveReady

  console.log('\n== 记住口令 e2e 断言汇总 ==')
  for (const [name, ok] of results) console.log(`  ${ok ? '✅' : '❌'} ${name}`)
  if (pass) console.log('\n🎉 记住口令 e2e 通过：重启免输口令互连，且门禁未被削弱')
  killAll()
  process.exit(pass ? 0 : 1)
}

run().catch((e) => {
  console.error(`\n❌ ${e.message}`)
  killAll()
  process.exit(1)
})
