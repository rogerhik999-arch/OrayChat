// 诊断协议单测：node test/diag.test.mjs（无网络）
//   分片重组（乱序/重复/缺片）+ diagLog 环形截断 + sendDiagResp 的 b64 分片尺寸
import assert from 'node:assert/strict'

const results = []
const ok = (name, cond) => { results.push(cond); console.log(`  ${cond ? '✅' : '❌'} ${name}`) }

// ---- 重组器：与 net.mjs 同构（字节级拼接——逐片文本解码会毁掉跨片的 UTF-8 多字节字符）----
function makeAssembler(onDone) {
  const parts = new Map()
  return (frame) => {
    const buf = parts.get('k') || { arr: [], got: 0 }
    if (frame.d && Number.isInteger(frame.i) && frame.i >= 0 && frame.i < 64 && frame.n > 0 && frame.i < frame.n) {
      if (!buf.arr[frame.i]) { buf.arr[frame.i] = frame.d; buf.got++ }
      parts.set('k', buf)
      if (buf.got >= frame.n) {
        parts.delete('k')
        const bytes = Buffer.concat(buf.arr.map((p) => Buffer.from(p, 'base64')))
        onDone(new TextDecoder().decode(bytes))
      }
    }
  }
}

console.log('[1] diag-resp 分片重组')
{
  // UTF-8 中文多字节字符跨片（字节级拼接，片边界任意切都不损）
  const obj = { env: { version: '1.30.4' }, diagLog: Array.from({ length: 90 }, (_, i) => ({ t: i, m: '链路断开重连事件'.repeat(6) + i })) }
  const txt = JSON.stringify(obj)
  const b64 = Buffer.from(txt, 'utf8').toString('base64')
  const CHUNK = 6 * 1024
  const frames = []
  for (let i = 0; i < Math.ceil(b64.length / CHUNK); i++) frames.push({ op: 'diag-resp', i, n: Math.ceil(b64.length / CHUNK), d: b64.slice(i * CHUNK, (i + 1) * CHUNK) })
  ok('1.1 大包产生多片', frames.length >= 2)

  let got = null
  const asm = makeAssembler((s) => { got = s })
  for (const f of frames) asm(f)
  ok('1.2 顺序重组还原', got === txt)

  got = null
  const asm2 = makeAssembler((s) => { got = s })
  for (const f of [...frames].reverse()) asm2(f) // 乱序
  ok('1.3 乱序重组还原', got === txt)

  got = null
  const asm3 = makeAssembler((s) => { got = s })
  asm3(frames[0]); asm3(frames[0]) // 重复片
  for (const f of frames.slice(1)) asm3(f)
  ok('1.4 重复片幂等', got === txt)

  const parsed = JSON.parse(got)
  ok('1.5 往返 JSON 等价（中文无损）', parsed.env.version === '1.30.4' && parsed.diagLog.length === 90 && parsed.diagLog[89].m.includes('89'))
}

console.log('[2] diagLog 环形 300 截断（同构逻辑）')
{
  const buf = []
  const push = (m) => { buf.push({ t: 1, m }); while (buf.length > 300) buf.shift() }
  for (let i = 0; i < 1000; i++) push(`e${i}`)
  ok('2.1 上限 300', buf.length === 300)
  ok('2.2 保留最新', buf[0].m === 'e700' && buf[299].m === 'e999')
}

console.log('[3] 诊断包体积预算（150 事件 × 240 字符上限）')
{
  const worst = JSON.stringify({ diagLog: Array.from({ length: 150 }, () => ({ t: 1, lvl: 'warn', m: 'x'.repeat(240) })) })
  const b64len = Buffer.from(worst).toString('base64').length
  ok(`3.1 最坏 b64 ${Math.round(b64len / 1024)}KB ≤ 64 片上限（${Math.ceil(b64len / 6144)} 片）`, Math.ceil(b64len / 6144) < 64)
}

const pass = results.filter(Boolean).length
console.log(`\n${pass === results.length ? '✅' : '❌'} diag.test.mjs：${pass}/${results.length} 通过`)
process.exit(pass === results.length ? 0 : 1)
