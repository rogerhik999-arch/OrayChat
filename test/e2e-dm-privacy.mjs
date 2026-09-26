// 私聊隐私 e2e（三实例）：锁定“发给一个人的消息只有那个人能收到”的不变量
//   正向对照：alice 的大厅消息经“共享日志同步”到达 bob 与 carol（全员可见语义）
//   隐私断言：bob 私聊发给 alice 的消息 → alice 收到并回显；carol 绝不能收到
//   时序健壮：全部断言基于同步帧（公共 broker 延迟抖动不影响结果）
// 运行：node test/e2e-dm-privacy.mjs
import { spawn, execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron')
const ROOM = `oc-priv-${Date.now().toString(36)}`
const LOBBY_TEXT = `lobby-broadcast-${Date.now().toString(36)}`
const DM_TEXT = `dm-private-${Date.now().toString(36)}`

const lines = { a: [], b: [], c: [] }
const procs = new Map()

function launch(key, name, args) {
  const p = spawn(ELECTRON, ['.', `--profile=${key}`, '--bot', `--name=${name}`, `--room=${ROOM}`, ...args], { cwd: ROOT })
  procs.set(key, p)
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
const kill = (key) => { try { execSync(`pkill -9 -f "profile=${key}"`) } catch { /* 忽略 */ } procs.delete(key) }
const killAll = () => { try { execSync('pkill -9 -f "OrayChatGroup/node_modules/electron/dist"') } catch { /* 忽略 */ } procs.clear() }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitLog(keys, pattern, label, timeoutMs = 300000) {
  const start = Date.now()
  const re = new RegExp(pattern)
  while (Date.now() - start < timeoutMs) {
    for (const k of keys) {
      const hit = lines[k].find((l) => re.test(l))
      if (hit) return { key: k, line: hit }
    }
    await sleep(1000)
  }
  throw new Error(`超时（${timeoutMs / 1000}s）：未在 ${keys} 等到 /${pattern}/`)
}

async function run() {
  console.log(`== 私聊隐私 e2e：房间 ${ROOM} ==`)
  // alice 落一条大厅消息到自己的共享日志（--lobby-alone：不等对端，上线后经同步扩散）
  launch('a', 'alice', ['--auto-reply', `--lobby-text=${LOBBY_TEXT}`, '--lobby-alone', '--lobby-delay-ms=2000', '--no-exit'])
  await sleep(5000)
  launch('b', 'bob', ['--no-exit'])
  await sleep(8000)
  launch('c', 'carol', ['--no-exit'])

  // 正向对照：bob 与 carol 都通过同步拿到 alice 的大厅消息（全员可见语义）
  await waitLog(['b'], 'SYNC conv=lobby changed=true n=1 last="lobby-broadcast', 'bob 同步大厅消息')
  await waitLog(['c'], 'SYNC conv=lobby changed=true n=1 last="lobby-broadcast', 'carol 同步大厅消息')
  console.log('  ✅ 大厅消息经同步到达 bob 与 carol（全员可见）')

  // 隐私断言：bob 私聊 DM_TEXT → 只有 alice 收到（并回显）
  kill('b'); await sleep(1500)
  launch('b', 'bob', [`--send-to=alice`, `--text=${DM_TEXT}`, '--count=1'])
  await waitLog(['a'], `RECV from=bob text="${DM_TEXT}`, 'bob→alice 私聊')
  await waitLog(['b'], `RECV from=alice text="echo: ${DM_TEXT}`, 'alice 回显')
  await sleep(10000) // 给“万一泄漏给 carol”的帧留出到达时间

  console.log('\n== 断言 ==')
  const carolSawLobby = lines.c.some((l) => l.includes(LOBBY_TEXT))
  const bobGotDm = lines.b.some((l) => l.includes(`RECV from=alice text="echo: ${DM_TEXT}`))
  const carolLeak = lines.c.some((l) => l.includes(DM_TEXT))
  const results = [
    ['正向对照：大厅消息经同步到达 bob 与 carol（全员可见）', carolSawLobby],
    ['私聊：bob 发给 alice，alice 收到并回显', bobGotDm],
    ['隐私不变量：carol 全程未收到该私聊消息', !carolLeak],
  ]
  let pass = true
  for (const [name, ok] of results) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}`)
    pass = pass && ok
  }
  if (pass) console.log('\n🎉 私聊隐私不变量成立：发给一个人 = 只有一个人收到；大厅 = 全员可见')
  killAll()
  process.exit(pass ? 0 : 1)
}

run().catch((e) => { console.error(`\n❌ ${e.message}`); killAll(); process.exit(1) })
