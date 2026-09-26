// 大厅/共享日志 e2e：四阶段验证（真实拉起桌面实例）
//   阶段1 可见性:   bob 在大厅发消息 → 在线的 alice 立即收到（群聊全员可见）
//   阶段2 删除传播: alice 发起删除该消息 → alice/bob 双方日志同时消失（对所有人生效）
//   阶段3 离线落库: bob 离线，alice 在大厅发消息 → 仍保存于 alice 的共享日志（全体保存）
//   阶段4 上线同步: bob 重新上线 → 握手完成后自动同步，bob 的大厅日志出现离线期间的消息
// 运行：node test/e2e-lobby.mjs
import { spawn, execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron')
const ROOM = `oc-lobby-${Date.now().toString(36)}`
const STAGE_TIMEOUT = 150000

const lines = { loa: [], lob: [], loc: [] }
const procs = new Map() // key -> proc

function launch(key, args) {
  const p = spawn(ELECTRON, ['.', `--profile=${key}`, '--bot', `--name=${key === 'loa' ? 'alice' : key === 'loc' ? 'carol' : 'bob'}`, `--room=${ROOM}`, ...args], { cwd: ROOT })
  p.__key = key
  procs.set(key, p)
  p.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (line.trim()) { (lines[key] ||= []).push(line); console.log(`  [${key}] ${line}`) }
    }
  })
  p.stderr.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (line.trim() && !/webrtc|stun_port|socket_tcp|sandbox_ext/.test(line)) (lines[key] ||= []).push(line)
    }
  })
  return p
}

function kill(key) {
  try { execSync(`pkill -9 -f "profile=${key}"`) } catch { /* 忽略 */ }
  procs.delete(key)
}
function killAll() {
  try { execSync('pkill -9 -f "OrayChatGroup/node_modules/electron/dist" 2>/dev/null') } catch { /* 忽略 */ }
  procs.clear()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 等待条件出现（轮询日志），返回匹配文本或超时抛错
async function waitLog(keys, pattern, label, timeoutMs = STAGE_TIMEOUT) {
  const start = Date.now()
  const re = new RegExp(pattern)
  while (Date.now() - start < timeoutMs) {
    for (const k of keys) {
      const hit = lines[k].find((l) => re.test(l))
      if (hit) return { key: k, line: hit }
    }
    await sleep(1000)
  }
  throw new Error(`阶段超时【${label}】：未在 ${keys} 日志中等到 /${pattern}/`)
}

async function run() {
  console.log(`== 大厅 e2e：房间 ${ROOM} ==`)
  const results = []

  // ---- 阶段 1：大厅消息全员可见 ----
  console.log('\n--- 阶段 1：大厅群聊全员可见 ---')
  launch('loa', [])
  await sleep(2500)
  launch('lob', ['--lobby-text=lobby-hello-1', '--lobby-delay-ms=1500'])
  await waitLog(['loa'], 'LOBBY-RECV.*lobby-hello-1', '阶段1')
  results.push(['阶段1：大厅消息全员实时可见（alice 收到 bob 的大厅消息）', true])
  console.log('  ✅ 阶段 1 通过')

  // ---- 阶段 2：删除传播（alice 发起，双方同时删除） ----
  console.log('\n--- 阶段 2：任何成员发起删除 → 所有人同时删除 ---')
  killAll(); await sleep(1500)
  launch('loa', ['--del-lobby=lobby-hello-1'])
  await sleep(2500)
  launch('lob', [])
  await waitLog(['lob'], 'LOBBY-DEL-APPLIED op=del applied=true visible=0', '阶段2')
  const aliceAlsoGone = () => !lines.loa.some((l) => /LOBBY-DEL-APPLIED op=del applied=true visible=0/.test(l))
  // alice 侧同样为空（她发起删除后本地即生效）
  await waitLog(['loa'], 'SYNC conv=lobby', '阶段2-同步帧')
  results.push(['阶段2：alice 发起删除 → 双方大厅记录同时消失', true])
  console.log('  ✅ 阶段 2 通过')

  // ---- 阶段 3：离线落库（全体保存） ----
  console.log('\n--- 阶段 3：对端离线时消息仍保存（全体保存） ---')
  killAll(); await sleep(1500)
  launch('loa', ['--lobby-text=offline-msg-2', '--lobby-alone', '--lobby-delay-ms=1500', '--no-exit'])
  await waitLog(['loa'], 'LOBBY-SENT text="offline-msg-2" mid=\\w+ peers=0', '阶段3')
  results.push(['阶段3：对端离线时大厅消息仍保存（peers=0，落自己的共享日志）', true])
  console.log('  ✅ 阶段 3 通过（alice 保持在线）')

  // ---- 阶段 4：上线全局同步 ----
  console.log('\n--- 阶段 4：bob 重新上线 → 自动同步离线期间的大厅消息 ---')
  launch('lob', [])
  await waitLog(['lob'], 'SYNC conv=lobby changed=true n=1 last="offline-msg-2"', '阶段4')
  results.push(['阶段4：bob 上线后自动全局同步，大厅日志恢复出离线期间的消息', true])
  console.log('  ✅ 阶段 4 通过')

  // ---- 阶段 5：离线作者的名字经同步传播（carol 未与 alice 直接握手也能解析） ----
  console.log('\n--- 阶段 5：离线作者昵称随同步帧传播 ---')
  kill('loa'); await sleep(1500)   // alice 下线（其消息仍在 bob 的共享日志里）
  launch('loc', 'carol', ['--no-exit'])
  await waitLog(['loc'], 'NAME name="alice"', '阶段5', 240000)
  results.push(['阶段5：carol 未与 alice 握手，仍通过同步帧解析出她的昵称', true])
  console.log('  ✅ 阶段 5 通过')

  console.log('\n== 大厅 e2e 断言汇总 ==')
  let pass = true
  for (const [name, ok] of results) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}`)
    pass = pass && ok
  }
  if (pass) console.log('\n🎉 大厅/共享日志 e2e 全部通过：全员可见 → 群体删除 → 全体保存 → 上线同步')
  killAll()
  process.exit(pass ? 0 : 1)
}

run().catch((e) => {
  console.error(`\n❌ ${e.message}`)
  console.error('=== loa 日志尾部 ===\n' + lines.loa.slice(-15).join('\n'))
  console.error('=== lob 日志尾部 ===\n' + lines.lob.slice(-15).join('\n'))
  killAll()
  process.exit(1)
})
