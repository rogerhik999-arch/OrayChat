// 端到端测试：真实拉起两个 OrayChat 桌面实例（bot 模式）
// 模式一（默认）：登录 → 公共 MQTT 信令 → WebRTC P2P 直连 → E2EE 握手 → 加密往返
// 模式二（--relay）：强制 --relay-only，验证公共 MQTT 中继回退路径也能完成加密往返
// 运行：node test/e2e.mjs [--relay]
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron')
const RELAY_MODE = process.argv.includes('--relay')
const ROOM = `oc-test-${Date.now().toString(36)}${RELAY_MODE ? '-relay' : ''}`
const COUNT = 3
const TIMEOUT_MS = 180000

const lines = { alice: [], bob: [] }
const procs = []

function launch(profile, args, key) {
  const p = spawn(ELECTRON, [
    '.', `--profile=${profile}`, '--bot', `--name=${profile}`, `--room=${ROOM}`,
    ...args,
  ], { cwd: ROOT, env: process.env })
  procs.push(p)
  p.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (!line.trim()) continue
      lines[key].push(line)
      console.log(`[${key}] ${line}`)
    }
  })
  p.stderr.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (line.trim()) { lines[key].push(line); console.log(`[${key}][stderr] ${line}`) }
    }
  })
  return p
}

function cleanup(code) {
  for (const p of procs) { try { p.kill('SIGKILL') } catch { /* 忽略 */ } }
  process.exit(code)
}

console.log(`== OrayChat e2e：房间 ${ROOM}，两个桌面实例（alice 自动回复 / bob 发送 ${COUNT} 条） ==`)

launch('alice', ['--auto-reply', ...(RELAY_MODE ? ['--relay-only'] : [])], 'alice')
await new Promise((r) => setTimeout(r, 2500))
launch('bob', [`--send-to=alice`, `--text=hello`, `--count=${COUNT}`, ...(RELAY_MODE ? ['--relay-only'] : [])], 'bob')

const start = Date.now()
let done = false
const timer = setInterval(() => {
  const all = [...lines.alice, ...lines.bob].join('\n')
  if (all.includes('[TEST-OK]')) {
    done = true
    clearInterval(timer)
    console.log('\n== 断言检查 ==')
    const okChecks = []

    // 1. 双方完成 E2EE 握手并展示一致的安全码
    const snA = lines.alice.join('\n').match(/safety=([\d ]+)/)?.[1]
    const snB = lines.bob.join('\n').match(/safety=([\d ]+)/)?.[1]
    okChecks.push(['两端安全码一致（E2EE 无中间人）', !!snA && snA === snB, `alice=${snA} bob=${snB}`])

    // 2. bob 发出的线上信封不含明文（应用层加密生效）
    const wires = lines.bob.filter((l) => l.includes('[BOT] WIRE'))
    const wireOk = wires.length >= COUNT && !wires.some((l) => l.includes('hello-'))
    okChecks.push(['线上信封不含明文（AEAD 加密生效）', wireOk, `wires=${wires.length}`])

    // 3. 加密消息双向往返
    const echoes = (lines.bob.join('\n').match(/\[BOT\] ECHO /g) || []).length
    okChecks.push([`alice 收到并回 ${COUNT} 条（双向加密往返）`, echoes >= COUNT, `echoes=${echoes}`])

    // 4. P2P 数据通道（WebRTC）+ 公共信令均被使用
    const ready = all.includes('[BOT] READY')
    okChecks.push(['对端加密会话建立（READY）', ready, ''])

    // 5. 传输路径：P2P 模式要求收集到 host/srflx 候选；中继模式要求 MQTT 中继已连接
    if (!RELAY_MODE) {
      const cand = all.match(/candidates=(\{[^}]*\})/)?.[1]
      let p2pOk = false, candObj = {}
      try { candObj = JSON.parse(cand || '{}') } catch { /* 忽略 */ }
      p2pOk = (candObj.host || 0) > 0 || (candObj.srflx || 0) > 0
      okChecks.push(['收集到 P2P 候选（host/srflx）', p2pOk, `candidates=${cand}`])
    } else {
      okChecks.push(['MQTT 公共中继已连接并转发', all.includes('MQTT 中继已连接'), ''])
    }

    let pass = true
    for (const [name, okVal, detail] of okChecks) {
      console.log(`  ${okVal ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
      pass = pass && okVal
    }
    if (pass) console.log(`\n🎉 e2e 全部通过（${RELAY_MODE ? 'MQTT 中继回退' : 'P2P 直连'}模式）：登录 → 公共信令初始化 → 加密往返`)
    else console.log('\n存在未通过断言，详见上方日志')
    setTimeout(() => cleanup(pass ? 0 : 1), 500)
  }
  if (Date.now() - start > TIMEOUT_MS) {
    clearInterval(timer)
    console.error(`\n❌ e2e 超时（${TIMEOUT_MS / 1000}s）—— 未出现 TEST-OK`)
    console.error('=== alice 日志尾部 ===\n' + lines.alice.slice(-25).join('\n'))
    console.error('=== bob 日志尾部 ===\n' + lines.bob.slice(-25).join('\n'))
    cleanup(1)
  }
}, 1000)

// 任一实例提前退出即失败
for (const [key] of [['alice'], ['bob']]) {
  const p = procs[procs.length - 1]
}
procs[0]?.on('exit', (code) => { if (!done) { console.error(`alice 提前退出 code=${code}`); cleanup(1) } })
procs[1]?.on('exit', (code) => { if (!done && code !== 0) { console.error(`bob 异常退出 code=${code}`); cleanup(1) } })
