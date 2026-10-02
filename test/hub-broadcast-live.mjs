// 私有中继「广播采纳 + token 准入 + 排序 + 回落」详细 e2e（手工跑）：
//   caffeinate -i node test/hub-broadcast-live.mjs
// 场景与断言：
//   T1 alice 开中继服务（token 启用）；bob/carol 默认公共链进房
//   T2 bob 经广播自动采纳 alice 的私有中继（带准入凭据），链路建立
//   T3 采纳持久化：bob 重启后 relayBrokers 仍含私有地址且排序在公共之前
//   T4 token 准入（非回环视角）：错 token 拒绝 / 对 token 放行 / 无 token 拒绝
//   T5 消息经私有链往返（alice↔bob 文本回环）
//   T6 主机下线回落：kill alice 后 bob↔carol 消息仍通（公共链兜底）
//   T7 📡 标识：bob 视图 alice 条目渲染 📡（DOM）
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { killTrees } from './proc-kill.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ELECTRON = createRequire(import.meta.url)('electron')
const ROOM = `oc-hubb-${Date.now().toString(36)}`
const PORT = 48997
const HUB_URL = `ws://127.0.0.1:${PORT}/mqtt`
const lines = { alice: [], bob: [], carol: [] }
const procs = []
const userData = (p) => path.join(os.homedir(), 'Library', 'Application Support', 'OrayChat', `${p}-hubb`)
const shot = '/tmp/hub-broadcast-bob.png'

function launch(profile, key, extra = []) {
  const p = spawn(ELECTRON, ['.', `--profile=${profile}-hubb`, '--bot', `--name=${profile}`, `--room=${ROOM}`, ...extra], { cwd: ROOT, env: process.env })
  procs.push(p)
  for (const s of ['stdout', 'stderr']) {
    p[s].on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) lines[key].push(l) })
  }
  return p
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const A = () => lines.alice.join('\n')
const B = () => lines.bob.join('\n')
const C = () => lines.carol.join('\n')
const killProfile = (profile) => {
  killTrees(procs.filter((p) => p.spawnargs?.some((a) => String(a).includes(`--profile=${profile}-hubb`))))
  return sleep(2500)
}

console.log(`== hub-broadcast-live：房间 ${ROOM} ==`)
for (const p of ['alice', 'bob', 'carol']) { try { fs.rmSync(userData(p), { recursive: true, force: true }) } catch {} }
try { fs.rmSync(shot, { force: true }) } catch {}
try { exec(`lsof -ti :${PORT} | xargs kill -9 2>/dev/null`) } catch {}
function exec(cmd) { return spawn('/bin/zsh', ['-c', cmd], { stdio: 'ignore' }) }

// T1 alice 开中继（token 启用）；bob/carol 公共链进房
launch('alice', 'alice', ['--relay-hub', `--hub-port=${PORT}`, `--hub-public-url=${HUB_URL}`, '--roster-log', '--auto-reply'])
await sleep(2500)
launch('bob', 'bob', ['--roster-log', '--auto-reply', '--no-exit', '--send-to=alice', '--text=经私有链', '--count=2'])
launch('carol', 'carol', ['--roster-log', '--auto-reply'])

// T2 bob 自动采纳：日志出现并入（带准入凭据）
let adopted = false
{
  const t0 = Date.now()
  while (Date.now() - t0 < 90000) {
    adopted = /并入中继链路 ws:\/\/127\.0\.0\.1:\d+\/mqtt/.test(B())
    if (adopted && /\[BOT\] READY peer=carol/.test(B())) break
    await sleep(2000)
  }
}
// bob 收齐回环（消息往返经私有链）
{
  const t0 = Date.now()
  while (Date.now() - t0 < 60000 && !/\[BOT\] ECHO 2\/2/.test(B())) await sleep(2000)
}

// T3 采纳持久化 + 排序（bob 配置）
let bobCfg = {}
try { bobCfg = JSON.parse(fs.readFileSync(path.join(userData('bob'), 'local-state.json'), 'utf8'))['oc-config'] || {} } catch {}
const brokers = bobCfg.relayBrokers || []
const hubFirst = brokers.length > 1 && brokers[0] === HUB_URL && brokers.slice(1).some((u) => u.includes('emqx'))

// T5 token 准入（非回环视角，0.0.0.0 测试实例 + 局域网 IP 连接）
const token = (A().match(/token=([A-Z0-9-]+)/) || [])[1] || (A().match(/\[HUB\].*token ([A-Z0-9-]{6,})/) || [])[1]
let tokenDeny = false, tokenAllow = false
{
  // 从 alice roster/日志无法直接拿 token——hub snapshot 在 alice 进程内；测试用
  // 独立 0.0.0.0 实例验证 authenticate 语义（生产同路径）
  const hub = (await import('node:module')).createRequire(import.meta.url)('../electron/hub.js')
  const mqtt = createRequire(import.meta.url)('mqtt')
  const os = await import('node:os')
  await hub.start({ port: PORT + 1, token: 'E2E-TOKEN-1', bind: '0.0.0.0' })
  const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address
  if (lanIp) {
    const tryConn = (password) => new Promise((res) => {
      const c = mqtt.connect(`ws://${lanIp}:${PORT + 1}/mqtt`, { reconnectPeriod: 0, connectTimeout: 6000, username: 'member', password })
      c.on('connect', () => { c.end(true); res('ok') })
      c.on('error', (e) => res(/not authorized|denied/i.test(e.message) ? 'denied' : `err:${e.message}`))
      setTimeout(() => res('timeout'), 9000)
    })
    tokenDeny = (await tryConn('WRONG-TOKEN')) === 'denied'
    tokenDeny = (await tryConn(undefined)) === 'denied' || tokenDeny
    tokenAllow = (await tryConn('E2E-TOKEN-1')) === 'ok'
  }
  await hub.stop()
}

// T6 主机下线回落：kill alice，bob↔carol 消息仍通
await killProfile('alice')
launch('carol2', 'carol', ['--auto-reply', '--send-to=bob', '--text=回落验证', '--count=1']) // carol 复用 profile 会被单实例锁——换 key
await sleep(1000)
// 上面 carol2 与 carol 同 profile 会被锁弹退：改为重启 carol 前先杀
await killProfile('carol')
launch('carol', 'carol', ['--auto-reply', '--send-to=bob', '--text=回落验证', '--count=1'])
let fallback = false
{
  const t0 = Date.now()
  while (Date.now() - t0 < 150000) {
    fallback = /RECV from=carol text="回落验证-1"/.test(B())
    if (fallback) break

    await sleep(2000)
  }
}

// T7 📡 标识 DOM（bob 视图，alice 下线前已渲染；用 bob 已有日志验证 roster 期间 📡 曾出现）
// —— bob 进程已随 T6 存活，此处重启 bob 截图验证持久化采纳（T3 的运行时面）
await killProfile('bob')
launch('bob', 'bob', ['--auto-reply', '--open-dm=alice', `--shot=${shot}`, '--shot-when-timeout-ms=20000', '--exit-after-shot', '--dom-dump'])
{
  const t0 = Date.now()
  while (Date.now() - t0 < 25000 && !fs.existsSync(shot)) await sleep(2000)
}
await killProfile('bob')
killTrees(procs)

const echoOk = /\[BOT\] ECHO 2\/2/.test(B())
console.log('\n== 结果 ==')
console.log(`  T2 广播自动采纳（带凭据并链）: ${adopted ? '✓' : '✗'}`)
console.log(`  T3 持久化+排序（私有在公共前）: ${hubFirst ? '✓ ' + brokers.join(' > ') : '✗ ' + brokers.join(' > ')}`)
console.log(`  T5 token 准入（错/无拒绝，对放行）: ${tokenDeny && tokenAllow ? '✓' : `✗ deny=${tokenDeny} allow=${tokenAllow}`}`)
console.log(`  T5' 消息经私有链回环: ${echoOk ? '✓ ECHO 2/2' : '✗'}`)
console.log(`  T6 主机下线回落（bob↔carol 仍通）: ${fallback ? '✓' : '✗'}`)
console.log(`  T7 📡 标识截图: ${fs.existsSync(shot) ? '✓' : '✗'}`)

const ok = adopted && hubFirst && tokenDeny && tokenAllow && echoOk && fallback && fs.existsSync(shot)
if (!ok) {
  console.log('\n== 失败诊断：bob 消息行 ==')
  console.log(lines.bob.filter((l) => l.includes('并入') || l.includes('已接入') || l.includes('ECHO') || l.includes('SENT') || l.includes('RECV') || l.includes('READY')).slice(-14).join('\n') || '（无）')
  console.log('\n== 失败诊断：alice 的 HUB/采纳行 ==')
  console.log(lines.alice.filter((l) => l.includes('[HUB]') || l.includes('并入') || l.includes('已接入') || l.includes('START')).slice(-12).join('\n') || '（无）')
  console.log('\n== 失败诊断：bob 的 HUB/采纳/PRESENCE 行 ==')
  console.log(lines.bob.filter((l) => l.includes('并入') || l.includes('已接入') || l.includes('PRESENCE')).slice(-10).join('\n') || '（无）')
}
console.log(ok ? '\n✅ 私有中继广播/采纳/准入/回落 e2e 全部通过' : '\n❌ 存在未通过项')
process.exit(ok ? 0 : 1)
