// 语音/图片 UI 截图验证（手工跑）：node test/voice-ui.mjs
// alice 发语音（注入器）+ 图片；bob --shot 截图 → 人工/断言核对气泡渲染
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { killTrees } from './proc-kill.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ELECTRON = createRequire(import.meta.url)('electron')
const ROOM = `oc-vui-${Date.now().toString(36)}`
const lines = { alice: [], bob: [] }
const procs = []
const userData = (p) => path.join(os.homedir(), 'Library', 'Application Support', 'OrayChat', `${p}-vui`)
const shot = '/tmp/voice-ui-bob.png'

// 注入用小文本文件
const txt = path.join(os.tmpdir(), `oc-vui-${Date.now()}.txt`)
fs.writeFileSync(txt, 'hello voice ui test'.repeat(50))

function launch(profile, key, extra = []) {
  const p = spawn(ELECTRON, ['.', `--profile=${profile}-vui`, '--bot', `--name=${profile}`, `--room=${ROOM}`, ...extra], { cwd: ROOT, env: process.env })
  procs.push(p)
  for (const s of ['stdout', 'stderr']) {
    p[s].on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) lines[key].push(l) })
  }
  return p
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const B = () => lines.bob.join('\n')

console.log(`== voice-ui：房间 ${ROOM} ==`)
for (const p of ['alice', 'bob']) { try { fs.rmSync(userData(p), { recursive: true, force: true }) } catch {} }
try { fs.rmSync(shot, { force: true }) } catch {}

launch('alice', 'alice', ['--send-voice-after-ms=3000', `--send-file=${txt}`, '--send-file2=' + path.join(ROOT, 'build', 'icon.png')])
await sleep(3000)
launch('bob', 'bob', [`--shot=${shot}`, '--shot-delay-ms=45000', '--exit-after-shot', '--open-dm=alice', '--dom-dump'])

// 等 bob 截图退出
{
  const t0 = Date.now()
  while (Date.now() - t0 < 90000 && !fs.existsSync(shot)) await sleep(2000)
}
await sleep(1000)
killTrees(procs)
fs.unlinkSync(txt)

fs.writeFileSync('/tmp/voice-ui-alice.log', lines.alice.join('\n'))
fs.writeFileSync('/tmp/voice-ui-bob.log', lines.bob.join('\n'))
const done = /FILE-DONE dir=recv/.test(B()) && /VOICE-IN/.test(B())
console.log(`bob 收到语音+图片并完成传输: ${done ? '✓' : '✗'}`)
console.log(`截图: ${fs.existsSync(shot) ? shot : '未生成'}`)
console.log('请人工核对截图：语音应为 ▶+波形气泡（非文件卡片），图片应显示缩略图/原图（非碎图）')
process.exit(fs.existsSync(shot) && done ? 0 : 1)
