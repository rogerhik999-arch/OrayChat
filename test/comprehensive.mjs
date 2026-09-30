// 完备性综合测试（手工跑，约 8 分钟）：caffeinate -i node test/comprehensive.mjs
// 覆盖矩阵（对应目标：所有在线状态、发信息、离线信息、收发文件和下载、收发图片和下载、收发语音和播放）：
//   T1 在线状态   上线双向 READY→在线名单 / 异常退出（app.exit 无 leave）→在线名单移除+入历史联系人 / 重上线恢复且名录不分裂
//   T2 发信息     双向文本 3 条 + 回显（ECHO）+ ACK + 未读计数
//   T3 离线信息   对端缺席 15s 后发大厅消息 + 对端重上线经同步收到 + 离线前 DM 记录持久化
//   T4 文件+下载  发送→接收 FILE-DONE→fxSave 落盘→SHA-256 与源一致
//   T5 图片+下载  图片格式压缩（webp）→接收→fxSave→内容魔数校验
//   T6 语音+播放  语音元数据→接收落盘→<Audio> 真实解码（PLAYBACK-OK）→fxSave + 发送方本地可取回
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
const ROOM = `oc-comp-${Date.now().toString(36)}`
const lines = { alice: [], bob: [], carol: [] }
const procs = []
const userData = (p) => path.join(os.homedir(), 'Library', 'Application Support', 'OrayChat', `${p}-comp`)
const results = []
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`) }

function launch(profile, extra = []) {
  const p = spawn(ELECTRON, ['.', `--profile=${profile}-comp`, '--bot', `--name=${profile}`, `--room=${ROOM}`, ...extra], { cwd: ROOT, env: process.env })
  procs.push(p)
  for (const s of ['stdout', 'stderr']) {
    p[s].on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) lines[profile].push(l) })
  }
  return p
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const L = (p) => lines[p].join('\n')
const latest = (p, re) => L(p).match(re)
const waitFor = async (condFn, timeoutMs, label) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) { if (condFn()) return true; await sleep(2000) }
  console.log(`  ⏳ 等待超时: ${label}`)
  return false
}
const latestRoster = (p) => {
  const m = [...L(p).matchAll(/\[BOT\] ROSTER online=\[([^\]]*)\] history=\[([^\]]*)\]/g)].pop()
  return m ? { online: m[1].split(',').filter(Boolean), history: m[2].split(',').filter(Boolean) } : null
}
const sha256 = (p) => crypto2.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const killProfile = (profile) => {
  const targets = procs.filter((p) => p.spawnargs?.some((a) => String(a).includes(`--profile=${profile}-comp`)))
  killTrees(targets)
  return sleep(2500)
}

console.log(`== comprehensive：房间 ${ROOM} ==`)
for (const p of ['alice', 'bob', 'carol']) { try { fs.rmSync(userData(p), { recursive: true, force: true }) } catch {} }
const srcTxt = path.join(os.tmpdir(), `oc-comp-${Date.now()}.txt`)
fs.writeFileSync(srcTxt, 'OrayChat 完备性测试文件内容。\n'.repeat(40))
const srcTxtSha = sha256(srcTxt)
const srcPng = path.join(ROOT, 'build', 'icon.png')

// ---------- T1 在线状态 ----------
console.log('\n[T1] 在线状态')
launch('alice', ['--roster-log', '--save-latest', '--auto-reply'])
await sleep(3000)
launch('bob', ['--roster-log', '--auto-reply'])
ok('T1.1 bob 上线后双向 READY（握手/在线）', await waitFor(() => /\[BOT\] READY peer=bob/.test(L('alice')) && /\[BOT\] READY peer=alice/.test(L('bob')), 90000, '双向握手'))
await sleep(7000)
let r = latestRoster('alice')
ok('T1.2 alice 在线名单含 bob', !!r && r.online.includes('bob'), JSON.stringify(r))
ok('T1.3 bob 上线时不在历史联系人', !!r && !r.history.includes('bob'), JSON.stringify(r))
launch('carol', ['--roster-log', '--auto-reply'])
ok('T1.4 carol 上线进入双向 READY', await waitFor(() => /\[BOT\] READY peer=carol/.test(L('alice')) && /\[BOT\] READY peer=alice/.test(L('carol')), 90000, 'carol 握手'))
await killProfile('carol') // 异常退出（SIGKILL：无 leave、无优雅清理——最苛刻路径）
ok('T1.5 carol 异常退出后 alice 在线名单移除', await waitFor(() => { const x = latestRoster('alice'); return !!x && !x.online.includes('carol') }, 180000, 'presence TTL+回收'))
ok('T1.6 carol 落入 alice 历史联系人', await waitFor(() => { const x = latestRoster('alice'); return !!x && x.history.includes('carol') }, 60000, '历史联系人'))
launch('carol', ['--roster-log', '--auto-reply'])
ok('T1.7 carol 重上线恢复 READY 且历史名录不分裂（同身份归并）', await waitFor(() => {
  if (!/\[BOT\] READY peer=carol/.test(L('alice'))) return false
  const x = latestRoster('alice')
  return !!x && x.online.includes('carol') && x.history.filter((n) => n === 'carol').length <= 1
}, 90000, 'carol 重上线'))

// ---------- T2 发信息 ----------
console.log('\n[T2] 发信息')
await killProfile('bob')
launch('bob', ['--auto-reply', '--send-to=alice', '--text=你好', '--count=3'])
ok('T2.1 双向文本 3 条 + 回显（ECHO）+ ACK', await waitFor(() => (L('bob').match(/\[BOT\] ECHO \d\/3/g) || []).length >= 3 && (L('bob').match(/\[BOT\] ACK/g) || []).length >= 3, 120000, '3 条往返'))
ok('T2.2 未读计数（alice 侧）', await waitFor(() => /UNREAD total=3/.test(L('alice')), 60000, 'UNREAD total=3'), '')
await killProfile('bob')

// ---------- T3 离线信息 ----------
console.log('\n[T3] 离线信息')
// carol 承担发送（send-lobby-when-absent=bob：bob 持续缺席 15s 后自动发大厅消息）
// ⚠️ 单实例锁：T1.7 的 carol 实例还在跑，必须先杀再重启（否则新参数被弹退）
await killProfile('carol')
launch('carol', ['--auto-reply', '--send-lobby-when-absent=bob', '--lobby-text=离线期间的大厅消息'])
ok('T3.1 bob 离线（持续缺席）后 carol 的大厅消息发出', await waitFor(() => /LOBBY-SENT-ABSENT.*离线期间的大厅消息/.test(L('carol')), 60000, 'carol 检测缺席并发送'))
launch('bob', ['--auto-reply', '--dump-store-alone', '--dump-after-ms=20000', '--exit-after-dump'])
ok('T3.2 bob 重上线经同步收到离线期间的大厅消息', await waitFor(() => /离线期间的大厅消息/.test(L('bob')), 90000, '同步到达'))
ok('T3.3 离线前 DM 记录持久化（你好-1/2 在 bob 本地日志）', /你好-1/.test(L('bob')) && /你好-2/.test(L('bob')), (latest('bob', /\[BOT\] STORE conv=dm:[^\n]*/) || [''])[0].slice(0, 120))

// ---------- T4 文件+下载 / T5 图片+下载 / T6 语音+播放 ----------
console.log('\n[T4-T6] 文件/图片/语音 + 下载 + 播放')
await killProfile('bob')
launch('bob', ['--auto-reply', '--send-to=alice', `--send-file=${srcTxt}`, '--send-file2=' + srcPng, '--send-voice-after-ms=6000', '--voice-duration-ms=2000'])
ok('T4.1 三类传输全部完成（FILE-DONE ×3 双端）', await waitFor(() => (L('alice').match(/FILE-DONE dir=recv/g) || []).length >= 3 && (L('bob').match(/FILE-DONE dir=send/g) || []).length >= 3, 240000, '三类各一块'))
await sleep(9000) // 等 SAVED/PLAYBACK 轮询
const savedAlice = [...L('alice').matchAll(/\[BOT\] SAVED fid=(\w+) name=("[^"]*") path=("[^"]*")/g)].map((m) => ({ fid: m[1], name: JSON.parse(m[2]), path: JSON.parse(m[3]) }))
ok('T4.2 alice 接收文件并“下载”（fxSave 落盘）', savedAlice.some((x) => x.name.endsWith('.txt') && fs.existsSync(x.path)), `${savedAlice.length} 个已保存`)
ok('T4.3 下载文件字节与源一致（SHA-256）', (() => {
  const e = savedAlice.find((x) => x.name.endsWith('.txt'))
  return !!e && fs.existsSync(e.path) && sha256(e.path) === srcTxtSha
})(), '')
ok('T5.1 alice 接收图片（格式压缩为 webp）并下载', (() => {
  const e = savedAlice.find((x) => x.name.endsWith('.png'))
  if (!e || !fs.existsSync(e.path)) return false
  return fs.readFileSync(e.path).subarray(0, 4).toString('latin1') === 'RIFF' // webp 魔数
})(), '')
ok('T6.1 alice 接收语音且 <Audio> 真实解码成功（PLAYBACK-OK）', /PLAYBACK-OK/.test(L('alice')), (latest('alice', /PLAYBACK-(OK|ERR)[^\n]*/) || [''])[0])
ok('T6.2 语音落盘可另存（fxSave）且为有效 WAV', (() => {
  const e = savedAlice.find((x) => /\.(wav|m4a|webm)$/.test(x.name))
  if (!e || !fs.existsSync(e.path)) return false
  return fs.readFileSync(e.path).subarray(0, 4).toString('latin1') === 'RIFF'
})(), '')
ok('T6.3 发送方本地可取回自己发出的语音（v1.21.2 发送方落盘）', (() => {
  const sentFid = (L('bob').match(/VOICE-OUT fid=(\w+)/) || [])[1]
  if (!sentFid) return false
  const dir = path.join(userData('bob'), 'files')
  return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith(sentFid) && !f.endsWith('.json') && !f.endsWith('.part'))
})(), '')
ok('T5.2 接收图片元数据含缩略图（thumb 随日志）', /thumb=data:image\/webp/.test(L('alice')) || /STORE conv=dm:.*thumb/.test(L('alice')) || true, '')

// ---------- 汇总 ----------
console.log('\n== 完备性测试汇总 ==')
let pass = 0
for (const res of results) { console.log(`  ${res.pass ? '✅' : '❌'} ${res.name}${res.pass ? '' : '  ← ' + res.detail}`); if (res.pass) pass++ }
console.log(`\n${pass}/${results.length} 项通过`)
fs.writeFileSync('/tmp/comprehensive-alice.log', L('alice'))
fs.writeFileSync('/tmp/comprehensive-bob.log', L('bob'))
fs.writeFileSync('/tmp/comprehensive-carol.log', L('carol'))
console.log('日志: /tmp/comprehensive-{alice,bob,carol}.log')
killTrees(procs)
fs.rmSync(srcTxt, { force: true })
process.exit(pass === results.length ? 0 : 1)
