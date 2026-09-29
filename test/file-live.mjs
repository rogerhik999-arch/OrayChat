// 文件/图片传输实测（手工跑，约 2 分钟）：caffeinate -i node test/file-live.mjs
// 场景：双实例互连 → alice 发 300KB 文本文件 + 仓库图标 PNG（图片格式压缩路径）
// → 断言双方 FILE-DONE、接收字节 SHA-256 与源文件一致、图片走 WebP 压缩。
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
const ROOM = `oc-fx-${Date.now().toString(36)}`
const lines = { alice: [], bob: [] }
const procs = []
const userData = (p) => path.join(os.homedir(), 'Library', 'Application Support', 'OrayChat', `${p}-fx`)

// 生成 300KB 高可压缩文本文件（协议级压缩应显著受益）
const bigText = ('OrayChat 文件传输测试。'.repeat(400) + '\n').repeat(1) // ~13KB
const testFile = path.join(os.tmpdir(), `oc-fx-${Date.now()}.txt`)
fs.writeFileSync(testFile, bigText.repeat(24)) // ~320KB
const srcSha = crypto2.createHash('sha256').update(fs.readFileSync(testFile)).digest('hex')
const iconPng = path.join(ROOT, 'build', 'icon.png')

function launch(profile, key, extra = []) {
  const p = spawn(ELECTRON, ['.', `--profile=${profile}-fx`, '--bot', `--name=${profile}`, `--room=${ROOM}`, ...extra], { cwd: ROOT, env: process.env })
  procs.push(p)
  for (const s of ['stdout', 'stderr']) {
    p[s].on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) lines[key].push(l) })
  }
  return p
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const A = () => lines.alice.join('\n')
const B = () => lines.bob.join('\n')

console.log(`== file-live：房间 ${ROOM} ==`)
for (const p of ['alice', 'bob']) { try { fs.rmSync(userData(p), { recursive: true, force: true }) } catch {} }

launch('alice', 'alice', [
  '--send-file=' + testFile,
  '--send-file-after-ms=4000',
  '--send-file2=' + iconPng,
])
await sleep(3000)
launch('bob', 'bob')

// 等两个传输都完成（最长 3 分钟）
{
  const t0 = Date.now()
  while (Date.now() - t0 < 180000) {
    const done = (B().match(/FILE-DONE dir=recv/g) || []).length
    if (done >= 2) break
    await sleep(3000)
  }
}
await sleep(3000)
fs.writeFileSync('/tmp/file-live-alice.log', lines.alice.join('\n'))
fs.writeFileSync('/tmp/file-live-bob.log', lines.bob.join('\n'))

// 校验接收字节
const bobFiles = path.join(userData('bob'), 'files')
const received = fs.existsSync(bobFiles) ? fs.readdirSync(bobFiles).filter((f) => !f.endsWith('.json')) : []
const shaOf = (p) => crypto2.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const txtOk = received.some((f) => shaOf(path.join(bobFiles, f)) === srcSha)
const sentDone = /FILE-DONE dir=send/.test(A())
const recvDone = (B().match(/FILE-DONE dir=recv/g) || []).length
const imgCompressed = /发送图片.*已压缩/.test(A())
const imgDone = /LOG info 图片.*接收完成/.test(B()) || /FILE-DONE dir=recv/.test(B())
const imgSent = /SEND-FILE-START name="icon.png"/.test(A())
const errLines = [...A().matchAll(/\[BOT\] LOG error [^\n]*/g)].map((m) => m[0])

console.log(`[结果] 接收文件数=${received.length} 文本SHA一致=${txtOk ? '✓' : '✗'} 发送DONE=${sentDone ? '✓' : '✗'} 接收DONE=${recvDone}/2`)
console.log(`[结果] 图片走格式压缩=${imgCompressed ? '✓' : '✗'} 图片发出=${imgSent ? '✓' : '✗'} 图片接收=${imgDone ? '✓' : '✗'}`)
if (errLines.length) console.log('[alice 错误行]', errLines.slice(0, 3))
killTrees(procs)
fs.unlinkSync(testFile)
const ok = txtOk && sentDone && recvDone >= 2 && imgCompressed && imgSent
console.log(ok ? '\n🎉 file-live 全部通过' : '\n!! file-live 有失败项（日志在 /tmp/file-live-*.log）')
process.exit(ok ? 0 : 1)
