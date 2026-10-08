// 更新清单验签工具（部署机自检用，跨平台纯 Node ≥18）：
//   node tools/verify-update-manifest.mjs                     # 拉 GitHub 最新 Release 的清单并验签（生产公钥）
//   node tools/verify-update-manifest.mjs --file manifest.json [--sig manifest.sig]
//   node tools/verify-update-manifest.mjs --key <b64公钥> ... # 演练时改用测试公钥
// 输出：版本、各平台资产（名称/大小/sha256 前 16）、验签结果；exit 0=有效 1=无效。
// 可选环境变量：ORAY_RELEASE_REPO（默认 rogerhik999-arch/OrayChat）验证 fork 的发版。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'

const PROD_PUBKEY = 'e4QPiZx0CTdMy8dcl+PxnNLykdv0b7EYaxzu+mdWPX4='
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null }
const repo = process.env.ORAY_RELEASE_REPO || 'rogerhik999-arch/OrayChat'
const key = arg('--key') || PROD_PUBKEY

const verify = (m, sigB64, pubB64) => {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: m.v, ts: m.ts, assets: m.assets }))
  try { return ed25519.verify(Buffer.from(sigB64, 'base64'), bytes, Buffer.from(pubB64, 'base64')) } catch { return false }
}
const report = (m, sig, source) => {
  const ok = verify(m, sig, key)
  console.log(`清单来源: ${source}`)
  console.log(`版本: v${m.v}  签发时间: ${new Date(m.ts).toLocaleString()}  资产数: ${Object.keys(m.assets || {}).length}`)
  for (const [k, a] of Object.entries(m.assets || {})) {
    console.log(`  ${k.padEnd(15)} ${a.name}  ${(a.size / 1048576).toFixed(1)}MB  sha256:${a.sha256.slice(0, 16)}…`)
  }
  console.log(`${ok ? '✅ Ed25519 验签有效' : '❌ 验签失败：签名/公钥不匹配或清单被篡改（客户端将拒绝此清单）'}`)
  process.exit(ok ? 0 : 1)
}

const fileArg = arg('--file')
if (fileArg) {
  const m = JSON.parse(fs.readFileSync(fileArg, 'utf8'))
  const sig = arg('--sig') ? fs.readFileSync(arg('--sig'), 'utf8').trim()
    : fs.readFileSync(path.join(path.dirname(fileArg), 'manifest.sig'), 'utf8').trim()
  report(m, sig, fileArg)
} else {
  const api = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'oraychat-verify' } })
  if (!api.ok) { console.error(`❌ 拉 releases/latest 失败: HTTP ${api.status}（网络不通/限流时稍后重试）`); process.exit(1) }
  const rel = await api.json()
  const pick = (name) => (rel.assets || []).find((a) => a.name === name)
  const mj = pick('manifest.json')
  if (!mj) { console.error(`❌ 最新 Release（${rel.tag_name}）无 manifest.json——CI 未产出签名清单`); process.exit(1) }
  const m = await (await fetch(mj.browser_download_url, { headers: { 'User-Agent': 'oraychat-verify' } })).json()
  const sj = pick('manifest.sig')
  const sig = sj ? (await (await fetch(sj.browser_download_url, { headers: { 'User-Agent': 'oraychat-verify' } })).text()).trim() : m.sig
  report(m, sig, `github.com/${repo} ${rel.tag_name}`)
}
