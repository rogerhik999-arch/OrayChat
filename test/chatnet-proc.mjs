// ChatNet 中继模式双进程测试（Node）
// 用法: node test/chatnet-proc.mjs <name> <room> <role: sender|replier>
// sender: 就绪后发 2 条消息；replier: 收到即回 echo；双方打印 [PROC] 日志
import * as oc from '../renderer/src/crypto.mjs'
import { ChatNet, buildRtcConfig, DEFAULT_CONFIG } from '../renderer/src/net.mjs'

const [name, room, role] = process.argv.slice(2)
const ident = oc.createIdentity()
const log = (m) => console.log(`[PROC ${name}] ${m}`)

const cfg = { ...DEFAULT_CONFIG, rtcConfig: buildRtcConfig(DEFAULT_CONFIG) }
const net = new ChatNet(ident, name, room, cfg, {
  onLog: (m, lv) => log(`LOG ${lv || 'info'} ${m}`),
  onPeerReady: (id, p) => log(`READY peer=${p.name} safety=${p.safety} via=${p.via}`),
  onMessage: async (id, p, text) => {
    log(`RECV from=${p.name} text=${JSON.stringify(text)}`)
    if (role === 'replier') {
      try { await net.send(id, `echo: ${text}`); log(`REPLIED echo`) } catch (e) { log(`REPLY-ERR ${e.message}`) }
    }
  },
  onPeerRemoved: (id, p) => log(`PEER-GONE ${p.name || id}`),
}, { forceRelay: true })

if (role === 'sender') {
  let sent = 0
  const timer = setInterval(async () => {
    for (const [id, p] of net.peers) {
      if (p.state === 'ready' && p.name === 'replier' && sent < 2) {
        try { await net.send(id, `probe-${++sent}`); log(`SENT ${sent}`) } catch (e) { log(`SEND-ERR ${e.message}`) }
      }
    }
    if (sent >= 2) clearInterval(timer)
  }, 1500)
}

setTimeout(() => { log('done'); process.exit(0) }, 45000)
