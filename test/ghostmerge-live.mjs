// 同名历史身份合并（残身治理 UI）实测：caffeinate -i node test/ghostmerge-live.mjs
// 场景（模拟"手机重装换钥"的存量残身，不依赖真实多台设备）：
//   1) alice 的 names 表预种两个 xfold6 旧身份 + 一个 3070 旧身份（重装残留）
//   2) alice 启动 → 历史联系人应为 2 行（xfold6 合并一行标"2 个历史身份" + 3070 一行）
//      ——DOM 断言（shot-when 条件：合并行文案出现）
//   3) 真实 bob 上线（昵称 xfold6）与 alice 握手就绪 → 别名/同名接管生效：
//      alice 名录里 xfold6 旧身份归并进在线 bob，历史联系人不再单列 xfold6
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { killTrees } from './proc-kill.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ELECTRON = createRequire(import.meta.url)('electron')
const ROOM = `oc-ghostmerge-${Date.now().toString(36)}`
const lines = { alice: [], bob: [] }
const procs = []
const userData = (p) => path.join(os.homedir(), 'Library', 'Application Support', 'OrayChat', `${p}-gm`)
const shot = '/tmp/oc-e2e/ghostmerge-alice.png'

const oldX1 = 'a1'.repeat(32)
const oldX2 = 'b2'.repeat(32)
const old30 = 'c3'.repeat(32)

function launch(profile, key, extra = []) {
  const p = spawn(ELECTRON, ['.', `--profile=${profile}-gm`, '--bot', `--name=${profile}`, `--room=${ROOM}`, ...extra], { cwd: ROOT, env: process.env })
  procs.push(p)
  for (const s of ['stdout', 'stderr']) {
    p[s].on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) lines[key].push(l) })
  }
  return p
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const A = () => lines.alice.join('\n')
const latestRoster = () => {
  const m = [...A().matchAll(/\[BOT\] ROSTER online=\[([^\]]*)\] history=\[([^\]]*)\]/g)].pop()
  return m ? { online: m[1].split(',').filter(Boolean), history: m[2].split(',').filter(Boolean) } : null
}

console.log(`== ghostmerge-live：房间 ${ROOM} ==`)
for (const p of ['alice', 'bob']) { try { fs.rmSync(userData(p), { recursive: true, force: true }) } catch {} }
try { fs.rmSync(shot, { force: true }) } catch {}

// 预种存量残身：两个 xfold6 旧身份 + 一个 3070 旧身份（重装换钥的常态残留）
fs.mkdirSync(userData('alice'), { recursive: true })
fs.writeFileSync(path.join(userData('alice'), 'local-state.json'), JSON.stringify({
  [`oc-names:${ROOM}`]: { [oldX1]: 'xfold6', [oldX2]: 'xfold6', [old30]: '3070' },
}))

launch('alice', 'alice', ['--roster-log', '--auto-reply', '--dom-dump', `--shot=${shot}`,
  // 探针：把内部状态写进 title（dom-dump 抓取），永不命中 → 45s 兜底截图；
  // bob 在 3s 后启动，45s 时别名应已建立——拍到的正是归并后的状态
  '--shot-when=(function(){try{document.title="PROBE"+JSON.stringify({names:window.__ocDebug.names,al:window.__ocDebug.aliases,roster:window.__ocDebug.roster,resolve:window.__ocDebug.resolve})}catch(e){document.title="PROBE-ERR"+e}return false})()',
  '--shot-when-timeout-ms=45000'])
await sleep(3000)
// 真实 bob（昵称同样叫 xfold6——模拟重装后的新身份）上线握手 → 别名/同名接管生效
// （launch 默认 --name=bob；argv 解析后值覆盖前值，故追加 --name=xfold6）
launch('bob', 'bob', ['--roster-log', '--auto-reply', '--no-exit', '--name=xfold6', '--send-to=alice', '--text=我是新装好的 xfold6', '--count=1'])

let t7ok = false
let probe = null
{
  const t0 = Date.now()
  while (Date.now() - t0 < 50000 && !fs.existsSync(shot)) await sleep(1500)
}
for (const l of lines.alice) {
  if (!l.includes('[dom-dump]')) continue
  try {
    const dd = JSON.parse(l.slice(l.indexOf('{')))
    // DOM：xfold6 行（在线或历史）全程只有一行；3070 一行
    const xf = dd.roster?.filter((n) => n.includes('xfold6')).length || 0
    t7ok = xf === 1 && dd.roster?.some((n) => n.includes('3070'))
    const m = (dd.title || '').match(/PROBE(\{.*)/)
    if (m) { try { probe = JSON.parse(m[1]) } catch { /* 忽略 */ } }
  } catch { /* 忽略 */ }
}
if (probe) {
  console.log(`[probe] names=${JSON.stringify(probe.names)}`)
  console.log(`[probe] aliases=${JSON.stringify(probe.al)}`)
  console.log(`[probe] roster=${JSON.stringify(probe.roster)}`)
}

let ready = false
{
  const t0 = Date.now()
  while (Date.now() - t0 < 90000) {
    ready = /\[BOT\] READY peer=xfold6/.test(A())
    if (ready) break
    await sleep(2000)
  }
}
await sleep(8000) // 等别名建立 + roster 刷新
const rReady = latestRoster()
const mergedAway = !!rReady && rReady.online.includes('xfold6')
  && rReady.history.filter((n) => n === 'xfold6').length === 0
console.log(`[roster] bob 就绪=${ready} 归并后=${JSON.stringify(rReady)}`)
killTrees(procs.filter((p) => p.spawnargs?.some((a) => String(a).includes('--profile=bob-gm'))))
await sleep(3000)
const rFinal = latestRoster()
// bob 退出后：旧身份已别名归并，历史名录的 xfold6 仍只有一行（bob 的身份）
const noResurrect = !!rFinal && rFinal.history.filter((n) => n === 'xfold6').length <= 1
console.log(`[roster] bob 退出后=${JSON.stringify(rFinal)}`)
killTrees(procs)
let ok = false
console.log('\n== 结果 ==')
console.log(`  残身合并展示（xfold6×2 → 一行"2 个历史身份"）: ${t7ok ? '✓' : '✗'}`)
console.log(`  真机上线归并（同名 bob 就绪后旧 xfold6 退出历史名录）: ${mergedAway ? '✓' : '✗'}`)
console.log(`  bob 退出后无复种（历史名录 xfold6 ≤1 行）: ${noResurrect ? '✓' : '✗'}`)
console.log(`  截图: ${fs.existsSync(shot) ? shot : '未生成'}`)
ok = t7ok && mergedAway && noResurrect
if (!ok) {
  for (const k of ['alice', 'bob']) { try { fs.writeFileSync(`/tmp/oc-e2e/ghostmerge-${k}.log`, lines[k].join('\n')) } catch {} }
}
process.exit(ok ? 0 : 1)
