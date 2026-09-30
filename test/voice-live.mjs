// 语音消息实测（手工跑，约 2 分钟）：caffeinate -i node test/voice-live.mjs
// 场景：alice 注入器发送合成 WAV 语音（kind:'voice' + duration/waveform 元数据）
// → bob 接收：VOICE-IN 元数据完整、FILE-DONE、接收文件字节 = 发送字节（SHA 一致）
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
const ROOM = `oc-voice-${Date.now().toString(36)}`
const lines = { alice: [], bob: [] }
const procs = []
const userData = (p) => path.join(os.homedir(), 'Library', 'Application Support', 'OrayChat', `${p}-voice`)

function launch(profile, key, extra = []) {
  const p = spawn(ELECTRON, ['.', `--profile=${profile}-voice`, '--bot', `--name=${profile}`, `--room=${ROOM}`, ...extra], { cwd: ROOT, env: process.env })
  procs.push(p)
  for (const s of ['stdout', 'stderr']) {
    p[s].on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) lines[key].push(l) })
  }
  return p
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const A = () => lines.alice.join('\n')
const B = () => lines.bob.join('\n')

console.log(`== voice-live：房间 ${ROOM} ==`)
for (const p of ['alice', 'bob']) { try { fs.rmSync(userData(p), { recursive: true, force: true }) } catch {} }

launch('alice', 'alice', ['--send-voice-after-ms=4000', '--voice-duration-ms=1800'])
await sleep(3000)
launch('bob', 'bob')

// 等收发完成（最长 2.5 分钟）
{
  const t0 = Date.now()
  while (Date.now() - t0 < 150000) {
    if (/VOICE-OUT/.test(A()) && /VOICE-IN/.test(B()) && /FILE-DONE dir=recv/.test(B())) break
    await sleep(3000)
  }
}
await sleep(3000)
fs.writeFileSync('/tmp/voice-live-alice.log', lines.alice.join('\n'))
fs.writeFileSync('/tmp/voice-live-bob.log', lines.bob.join('\n'))

const sent = (A().match(/VOICE-OUT fid=(\w+) size=(\d+) duration=(\d+) waveform=(\S+)/) || [])
const recv = (B().match(/VOICE-IN fid=(\w+) size=(\d+) duration=(\d+) waveform=(\S+)/) || [])
const metaOk = sent.length === 5 && recv.length === 5
  && sent[1] === recv[1] && sent[3] === recv[3] && sent[4] === recv[4]
const recvDone = /FILE-DONE dir=recv/.test(B())
// 接收文件字节校验
const bobFiles = path.join(userData('bob'), 'files')
const files = fs.existsSync(bobFiles) ? fs.readdirSync(bobFiles).filter((f) => !f.endsWith('.json')) : []
// WAV 合成的语音体积 = 44 + 1.8s*16000*2 = 58044
const voiceFile = files.find((f) => { try { return fs.statSync(path.join(bobFiles, f)).size === Number(recv[2]) } catch { return false } })
const bytesOk = voiceFile && crypto2.createHash('sha256').update(fs.readFileSync(path.join(bobFiles, voiceFile))).digest('hex').slice(0, 24) === (recv[1])
const durOk = recv[3] === '1800'
const wfOk = JSON.parse(recv[4] || '""').length === 48 // 日志里 JSON.stringify 带引号

console.log(`[结果] VOICE-OUT=${!!sent.length} VOICE-IN=${!!recv.length} 元数据一致=${metaOk ? '✓' : '✗'} 接收DONE=${recvDone ? '✓' : '✗'}`)
console.log(`[结果] 字节SHA前缀一致=${bytesOk ? '✓' : '✗'} duration=1800 保留=${durOk ? '✓' : '✗'} waveform=48位=${wfOk ? '✓' : '✗'}`)
console.log(`[细节] sent: fid=${sent[1]?.slice(0, 12)} dur=${sent[3]} wf=${(sent[4] || '').slice(0, 12)}…`)
killTrees(procs)
const ok = metaOk && recvDone && bytesOk && durOk && wfOk
console.log(ok ? '\n🎉 voice-live 全部通过' : '\n!! voice-live 有失败项（日志在 /tmp/voice-live-*.log）')
process.exit(ok ? 0 : 1)
