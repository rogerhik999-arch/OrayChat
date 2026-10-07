// 更新签名密钥生成工具：node tools/gen-update-key.mjs
// 产出 Ed25519 密钥对——公钥硬编码进 renderer/src/updater.mjs（TRUSTED_PUBKEYS），
// 私钥（b64）配置为 GitHub Secret ORAY_UPDATE_SIGN_KEY 供 CI 签发 manifest。
// 私钥泄漏处置：重新生成→公钥双过渡期→发一版带新公钥的清单。
import { ed25519 } from '@noble/curves/ed25519.js'
import { utf8, b64, hex } from '../renderer/src/crypto.mjs'

const seed = ed25519.keygen().secretKey
const pub = ed25519.getPublicKey(seed)

// 自检：签名/验签回环
const msg = utf8('oraychat-update-manifest-v1')
const sig = ed25519.sign(msg, seed)
if (!ed25519.verify(sig, msg, pub)) { console.error('自检失败'); process.exit(1) }

console.log('公钥（硬编码进 renderer/src/updater.mjs 的 TRUSTED_PUBKEYS）：')
console.log(`  '${b64(pub)}'`)
console.log('\n私钥（b64，配置 GitHub Secret：ORAY_UPDATE_SIGN_KEY——只贴下面这一行）：')
console.log(`  ${b64(seed)}`)
console.log(`\n指纹（备查）：${hex(pub).slice(0, 16)}`)
