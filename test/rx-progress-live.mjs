// 接收进度 UI 实测（手工跑，约 1 分钟）：caffeinate -i node test/rx-progress-live.mjs
// 场景：alice 发 60MB 随机文件（不可压缩、p2p 约 15s）→ bob 打开会话中段截图 + DOM dump
// → 断言接收气泡出现 .fx-progress 进度条（"接收 N%"），并核对截图。
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { killTrees } from './proc-kill.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ELECTRON = createRequire(import.meta.url)('electron')
const ROOM = `oc-rxp-${Date.now().toString(36)}`
const lines = { alice: [], bob: [] }
const procs = []
const userData = (p) => path.join(os.homedir(), 'Library', 'Application Support', 'OrayChat', `${p}-rxp`)
const shot = '/tmp/rx-progress-bob.png'

// 60MB 随机（crypto.getRandomValues 单次上限 65536，分块填充）
const testFile = path.join(os.tmpdir(), `oc-rxp-${Date.now()}.bin`)
{
  const buf = Buffer.alloc(60 * 1024 * 1024)
  for (let off = 0; off < buf.length; off += 65536) crypto.getRandomValues(buf.subarray(off, Math.min(off + 65536, buf.length)))
  fs.writeFileSync(testFile, buf)
}

function launch(profile, key, extra = []) {
  const p = spawn(ELECTRON, ['.', `--profile=${profile}-rxp`, '--bot', `--name=${profile}`, `--room=${ROOM}`, ...extra], { cwd: ROOT, env: process.env })
  procs.push(p)
  for (const s of ['stdout', 'stderr']) {
    p[s].on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) lines[key].push(l) })
  }
  return p
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const B = () => lines.bob.join('\n')

console.log(`== rx-progress-live：房间 ${ROOM} ==`)
for (const p of ['alice', 'bob']) { try { fs.rmSync(userData(p), { recursive: true, force: true }) } catch {} }
try { fs.rmSync(shot, { force: true }) } catch {}

launch('alice', 'alice', ['--send-file=' + testFile, '--send-file-after-ms=3000'])
await sleep(3000)
// 相位条件截图：__p1 锁存「进度条 ≥12%」（传输中段），之后等进度条**消失**
// （done 完成态已渲染——期间无任何下一条消息，专测节流吞事件的回归）
launch('bob', 'bob', ['--open-dm=alice', `--shot=${shot}`,
  '--shot-when=(window.__p1 = window.__p1 || (!!document.querySelector(".fx-fill") && parseInt(document.querySelector(".fx-fill").style.width) >= 12), window.__p1 === true && !document.querySelector(".fx-progress"))',
  '--shot-when-timeout-ms=240000', '--exit-after-shot', '--dom-dump'])

// 等截图生成（进度条出现时）
{
  const t0 = Date.now()
  while (Date.now() - t0 < 200000 && !fs.existsSync(shot)) await sleep(2000)
}
const dumpLine = [...lines.bob].reverse().find((l) => l.includes('[dom-dump]'))
let dump = null
try { dump = JSON.parse(dumpLine.slice(dumpLine.indexOf('{'))) } catch {}

// 等传输收尾的等待已无意义（bob 在截图后即退出）；直接汇总
killTrees(procs)
fs.rmSync(testFile, { force: true })

const sent = /SEND-FILE-START/.test(lines.alice.join('\n'))
const doneRecv = /FILE-DONE dir=recv/.test(B())
console.log('\n== 结果 ==')
console.log(`  截图生成:            ${fs.existsSync(shot) ? '✓' : '✗'} ${shot}`)
console.log(`  alice 已开始发送:    ${sent ? '✓' : '✗'}`)
console.log(`  bob 接收完成:        ${doneRecv ? '✓' : '✗'}（RPROGRESS ${(B().match(/RPROGRESS/g) || []).length} 次）`)
console.log(`  完成态已渲染:        ${doneRecv && dump && !dump.progress?.length && dump.cards?.length ? '✓ 卡片在、进度条消失（无需下一条消息）' : `✗ dump=${dumpLine?.slice(0, 160) || '无'}`}`)

// 中段快照（本运行只截完成态）；完成态断言：接收完成 + 卡片存在 + 进度条已消失
const ok = fs.existsSync(shot) && sent && doneRecv && !!dump && !dump.progress?.length && !!dump.cards?.length
if (!ok) {
  console.log('\n== 失败诊断：alice 尾部 ==')
  console.log(lines.alice.slice(-25).join('\n'))
  console.log('\n== 失败诊断：bob 尾部 ==')
  console.log(lines.bob.slice(-25).join('\n'))
}
console.log(ok ? '\n✅ 接收进度条 UI 验证通过' : '\n❌ 接收进度条未出现（或传输未完成）')
process.exit(ok ? 0 : 1)
