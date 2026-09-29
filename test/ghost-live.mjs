// 残身回收实测（手工跑，约 8 分钟）：caffeinate -i node test/ghost-live.mjs
// （caffeinate 防系统休眠——曾因测试机睡着导致中继全断、时序失效）
// 用户不变量：对端崩溃/重启后，alice 的在线列表不得残留旧条目（peers 数回落）。
// 场景1：bob SIGKILL → 同 profile 重启（同身份、新 selfId）→ 列表应回到 1 条 bob
// 场景2：bob 再次 SIGKILL 不回来 → 几分钟内 peers 应回落到 0
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { killTrees } from './proc-kill.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ELECTRON = createRequire(import.meta.url)('electron')
const ROOM = `oc-ghost-${Date.now().toString(36)}`
const lines = { alice: [], bob: [] }
const procs = []

function launch(profile, key) {
  const p = spawn(ELECTRON, ['.', `--profile=${profile}-ghost`, '--bot', `--name=${profile}`, `--room=${ROOM}`, '--auto-reply', '--hb-log'], { cwd: ROOT, env: process.env })
  procs.push(p)
  for (const s of ['stdout', 'stderr']) {
    p[s].on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue
        lines[key].push(line)
      }
    })
  }
  return p
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const A = () => lines.alice.join('\n')
const lastTick = (key) => {
  const t = lines[key].filter((l) => l.includes('[BOT] TICK')).pop() || ''
  const m = t.match(/peers=(\d+) ready=(\d+)/)
  return m ? { peers: +m[1], ready: +m[2] } : null
}
const dump = (name) => {
  const interesting = lines.alice.filter((l) => /LOG|残身|清理|身份|READY|TICK|CONN/.test(l) && !/hs1|hs2|hs3/.test(l))
  fs.writeFileSync(`/tmp/ghost-live-${name}.log`, lines.alice.join('\n'))
  console.log(`--- alice 日志摘录（完整在 /tmp/ghost-live-${name}.log）---`)
  for (const l of interesting.slice(-40)) console.log(`  [alice] ${l}`)
}

console.log(`== ghost-live：房间 ${ROOM} ==`)
launch('alice', 'alice')
await sleep(3000)
let bob = launch('bob', 'bob')

// 等双向就绪
{
  const t0 = Date.now()
  while (Date.now() - t0 < 120000 && !(/\[BOT\] READY peer=alice/.test(lines.bob.join('\n')) && /\[BOT\] READY peer=bob/.test(A()))) await sleep(2000)
  console.log(`[phase1] 双向就绪 (${Math.round((Date.now() - t0) / 1000)}s) tick=${JSON.stringify(lastTick('alice'))}`)
}
if (!/\[BOT\] READY peer=bob/.test(A())) { console.log('!! bob 未就绪，中止'); killTrees(procs); process.exit(1) }

// 场景1：SIGKILL 杀 bob（无优雅 leave）→ 同 profile 重启
bob.kill('SIGKILL')
await sleep(2000)
console.log('\n[phase2] bob 已被 SIGKILL，重启同 profile（同身份、新 selfId）…')
// 注意：lines.bob 累积了 bob#1 的旧日志，等待条件必须按「新增一条 READY」计数
const bobReadyBefore = lines.bob.filter((l) => l.includes('[BOT] READY peer=alice')).length
bob = launch('bob', 'bob')
{
  const t0 = Date.now()
  while (Date.now() - t0 < 120000 && lines.bob.filter((l) => l.includes('[BOT] READY peer=alice')).length <= bobReadyBefore) await sleep(2000)
}
// 重启后等 90s 让清理路径（去重/onRelayGone/reaper）跑完
await sleep(90000)
dump('phase2')
const tick2 = lastTick('alice')
const deduped = /同一身份经新连接上线|同一昵称经新连接上线/.test(A())
console.log(`[phase2] bob#2 就绪；alice tick=${JSON.stringify(tick2)}（期望 peers=1）身份去重日志=${deduped ? '✓' : '未出现'}`)
const phase2ok = tick2 && tick2.peers === 1

// 场景2：再次 SIGKILL，不重启 → 等 peers 回落 0（任一清理路径均可）
bob.kill('SIGKILL')
console.log('\n[phase3] bob#2 再次 SIGKILL 且不再回来，等待列表回落（最长 6 分钟）…')
{
  const t0 = Date.now()
  while (Date.now() - t0 < 360000) {
    await sleep(10000)
    const t = lastTick('alice')
    if (t && t.peers === 0) break
  }
}
dump('phase3')
const tick3 = lastTick('alice')
const secs3 = Math.round(360000 / 1000)
const reaped = /清理残身/.test(A())
console.log(`[phase3] alice tick=${JSON.stringify(tick3)}（期望 peers=0）reaper日志=${reaped ? '✓' : '未出现（可能经 onRelayGone 清理，同样正确）'}`)
const phase3ok = tick3 && tick3.peers === 0
console.log('\n== 结果 ==')
console.log(`  场景1 重启后列表回落到 1: ${phase2ok ? '✓' : '✗'}`)
console.log(`  场景2 崩溃后列表回落到 0: ${phase3ok ? '✓' : '✗'}`)
killTrees(procs)
process.exit(phase2ok && phase3ok ? 0 : 1)
