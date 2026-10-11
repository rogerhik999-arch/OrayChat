#!/usr/bin/env node
// 隧道一键体检：诊断"开着却 530"的三层证据（2026-10-11 lw 机器案例沉淀）
//   node tools/tunnel-doctor.mjs [hostname ...]   # 缺省体检全部已知 hub 隧道
// 三层：①外部 HTTP 探测（404=健康 / 530=边缘无路由 / 502=判死中）
//      ②Cloudflare API 边缘连接数（cloudflared tunnel list，cert.pem 授权）
//      ③DNS 路由核验（tunnel route dns 幂等：already configured=正确；
//        record exists=错配（指向别的目标），加 --overwrite-dns 修复）
// 典型病理对应：
//   连接 4 条 + HTTP 530 + route 报 exists      → DNS 错配（重启无解，需覆盖）
//   连接 0 条 + HTTP 530 + route already config → 机器侧 cloudflared 未运行/未连上
//   连接 4 条 + HTTP 530（持续）+ 假活          → 见 hub.js 边缘探测器（fa7494a）
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const CFD = path.join(os.homedir(), 'Library', 'Application Support', 'OrayChat', 'default', 'cloudflared', 'cloudflared')
const DEFAULT_HOSTS = {
  'mqtt.hoveraiworld.party': 'hoveraiworld',
  'hawf.hoveraiworld.party': 'haw-fenggpd',
  'hawlw.hoveraiworld.party': 'hawlw',
  'haw3070.hoveraiworld.party': 'haw3070',
}

const args = process.argv.slice(2)
const targets = args.length
  ? Object.fromEntries(args.map((h) => [h, h.split('.')[0].replace('haw', 'haw')]))
  : DEFAULT_HOSTS

const probe = (host) => new Promise((resolve) => {
  const t = setTimeout(() => resolve('timeout'), 8000)
  fetch(`https://${host}/`, { signal: AbortSignal.timeout(7500) })
    .then((r) => { clearTimeout(t); resolve(String(r.status)) })
    .catch(() => { clearTimeout(t); resolve('unreachable') })
})

// 边缘连接数（一次 API 拉全表）
let connByTunnel = {}
try {
  const out = execFileSync(CFD, ['tunnel', 'list'], { timeout: 30000 }).toString()
  for (const line of out.split('\n').slice(1)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\S+\s+(.*)$/)
    if (m) connByTunnel[m[2]] = m[3].trim() ? m[3].trim().split(',').length : 0
  }
} catch (e) { console.log(`⚠ tunnel list 失败（cert.pem 未授权或网络）：${e.message.split('\n')[0]}`) }

console.log('host'.padEnd(32), 'http'.padEnd(6), 'edge-conn'.padEnd(10), '诊断')
for (const [host, tunnel] of Object.entries(targets)) {
  const http = await probe(host)
  const conns = connByTunnel[tunnel] ?? '?'
  let verdict = ''
  if (http === '404') verdict = '✅ 健康'
  else if (http === '530' || http === '533') {
    if (conns === 0) verdict = '❌ 隧道 0 连接：机器侧 cloudflared 未运行（机器睡眠/hub 未恢复）'
    else if (conns === '?') verdict = '❌ 530（连接数未知——tunnel list 失败）'
    else verdict = `❌ 连接 ${conns} 条却 530：DNS 错配或假活。跑核验：${CFD} tunnel route dns ${tunnel} ${host}`
  } else if (http === '502') verdict = '⏳ 边缘判死中（刚断开，等 1-2 分钟再查）'
  else verdict = `⚠ 异常 HTTP ${http}`
  console.log(host.padEnd(32), http.padEnd(6), String(conns).padEnd(10), verdict)
}
