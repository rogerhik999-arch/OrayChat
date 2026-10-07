// 72h 双实例长跑 soak（docs/longrun-hardening-plan.md 任务 E）
// 启动：nohup caffeinate -i node test/soak-longrun.mjs > /tmp/oc-soak.log 2>&1 &
// 报告：/tmp/oc-soak-report.jsonl（每 5min 一条样本）；结论看 soak 汇总行
// 语义：双实例同房常驻，采样双向 READY/日志异常/链路翻动；每 2h 轮流重启一个
// 实例（模拟设备重启）；进程崩溃如实记录【不自动复活】——崩溃本身是发现。
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { killTrees } from './proc-kill.mjs'

const ROOT = path.dirname(path.dirname(import.meta.url.replace('file://', '')))
const ELECTRON = createRequire(path.join(ROOT, 'package.json'))('electron')
const ROOM = `oc-soak-${Date.now().toString(36)}`
const REPORT = '/tmp/oc-soak-report.jsonl'
const DURATION_H = Number(process.env.SOAK_HOURS || 72)
const profiles = ['soaka', 'soakb']
const procs = { soaka: null, soakb: null }
const lines = { soaka: [], soakb: [] }
const stats = { restarts: 0, crashes: 0, samples: 0, anomalies: 0, startAt: Date.now() }

const log = (m) => { const line = `[soak ${new Date().toISOString()}] ${m}`; console.log(line); fs.appendFileSync(REPORT, JSON.stringify({ t: Date.now(), type: 'log', m: line }) + '\n') }
const sample = (o) => { stats.samples++; fs.appendFileSync(REPORT, JSON.stringify({ t: Date.now(), type: 'sample', ...o }) + '\n') }

function launch(p) {
  const proc = spawn(ELECTRON, ['.', `--profile=${p}`, '--bot', `--name=${p === 'soaka' ? '甲' : '乙'}`, `--room=${ROOM}`, '--roster-log', '--auto-reply'], { cwd: ROOT, env: process.env })
  procs[p] = proc
  proc.stdout.on('data', (d) => lines[p].push(...d.toString().split('\n').filter(Boolean)))
  proc.stderr.on('data', (d) => lines[p].push(...d.toString().split('\n').filter(Boolean)))
  proc.on('exit', (code) => {
    if (stats.startAt + DURATION_H * 3600 * 1000 > Date.now()) {
      stats.crashes++
      log(`⚠ 实例 ${p} 意外退出 code=${code}（已如实记录，不自动复活）`)
    }
  })
  return proc
}
const L = (p) => lines[p].join('\n')
const readyBoth = () => /\[BOT\] READY peer=乙/.test(L('soaka')) && /\[BOT\] READY peer=甲/.test(L('soakb'))
const readyCount = (p, peer) => (L(p).match(new RegExp(`\\[BOT\\] READY peer=${peer}`, 'g')) || []).length

fs.writeFileSync(REPORT, '')
log(`72h soak 启动：房间 ${ROOM}，时长 ${DURATION_H}h，报告 ${REPORT}`)
launch('soaka')
await new Promise((r) => setTimeout(r, 4000))
launch('soakb')

// 每 5min 采样；每 2h 轮流重启实例（模拟设备重启：正常退出+重启，不算崩溃）
let nextRestart = Date.now() + 2 * 3600 * 1000
let restartIdx = 0
const timer = setInterval(async () => {
  const both = readyBoth()
  const drops = ['soaka', 'soakb'].map((p) => (L(p).match(/中继链路断开/g) || []).length)
  const errors = ['soaka', 'soakb'].map((p) => (lines[p].filter((l) => /Uncaught|ReferenceError|TypeError/.test(l)).length))
  const anomaly = !both || errors.some((e) => e > 0)
  if (anomaly) stats.anomalies++
  sample({ bothReady: both, dropsA: drops[0], dropsB: drops[1], rendererErrors: errors, anomaly })
  if (anomaly) log(`⚠ 异常样本：bothReady=${both} errors=${JSON.stringify(errors)} drops=${JSON.stringify(drops)}`)

  if (Date.now() > nextRestart) {
    const p = profiles[restartIdx++ % 2]
    log(`计划重启 ${p}（模拟设备重启）`)
    const proc = procs[p]
    if (proc) { try { proc.kill() } catch {} }
    await new Promise((r) => setTimeout(r, 5000))
    if (procs[p] === proc) { procs[p] = null; launch(p); stats.restarts++ }
    nextRestart = Date.now() + 2 * 3600 * 1000
  }

  if (Date.now() - stats.startAt > DURATION_H * 3600 * 1000) {
    clearInterval(timer)
    log(`== soak 结束 == 样本 ${stats.samples}，异常 ${stats.anomalies}，计划重启 ${stats.restarts}，意外崩溃 ${stats.crashes}`)
    log(stats.crashes === 0 && stats.anomalies === 0 ? '✅ 72h 零人工干预掉线、零渲染异常' : '❌ 存在异常，详见报告')
    killTrees(Object.values(procs).filter(Boolean))
    process.exit(stats.crashes === 0 && stats.anomalies === 0 ? 0 : 1)
  }
}, 5 * 60 * 1000)
