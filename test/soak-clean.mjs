// clean:false vs clean:true 链路稳定性 soak（各 3 分钟，公共 broker 单实例）
import { createRequire } from 'node:module'
const mqtt = createRequire(new URL('../package.json', import.meta.url))('mqtt')

async function soak(label, clean, seconds) {
  const url = 'wss://broker-cn.emqx.io:8084/mqtt'
  const clientId = `oc-soaktest1-${label}`
  let connects = 0, closes = 0
  const c = mqtt.connect(url, { clean, clientId, reconnectPeriod: 0, connectTimeout: 8000, keepalive: 30 })
  c.on('connect', () => { connects++; console.log(`[${label}] connect #${connects} @${Math.round(process.uptime())}s`) })
  c.on('close', () => { closes++; console.log(`[${label}] close #${closes} @${Math.round(process.uptime())}s`) })
  c.on('error', () => {})
  c.subscribe(`oraychat-soak/${label}`)
  await new Promise((r) => setTimeout(r, seconds * 1000))
  try { c.end(true) } catch {}
  console.log(`[${label}] 结果: connects=${connects} closes=${closes}`)
  return { connects, closes }
}

const a = await soak('cleanfalse', false, 180)
const b = await soak('cleantrue', true, 180)
console.log(`结论: clean=false 翻动=${a.closes > 2 ? '有' : '无'}（${a.connects}/${a.closes}），clean=true 翻动=${b.closes > 2 ? '有' : '无'}（${b.connects}/${b.closes}）`)
process.exit(0)
