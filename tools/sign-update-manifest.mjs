// CI 更新清单签名工具（release workflow 收尾 job 调用）：
//   node tools/sign-update-manifest.mjs <artifacts目录> <版本号>
// 私钥：环境变量 ORAY_UPDATE_SIGN_KEY（b64，tools/gen-update-key.mjs 生成）。
// 缺失时跳过签名（不阻断发版）——分布式更新功能休眠，其余资产照常发布。
// 产物：manifest.json + manifest.sig（进入 Release，客户端验签后作为更新依据）。
// 格式必须与 renderer/src/updater.mjs 的 manifestBytes 规范一致（键序 v,ts,assets）。
// ⚠️ 目录必须递归遍历：upload-artifact 会保留子目录结构（android 的
//    app-release.apk 在 release/ 子目录），只扫根目录会漏签 → 同伴更新源仅剩 mac。
import { ed25519 } from '@noble/curves/ed25519.js'
import { b64, unb64, utf8 } from '../renderer/src/crypto.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const version = (process.argv[3] || '').replace(/^v/i, '')
const keyB64 = process.env.ORAY_UPDATE_SIGN_KEY
if (!dir || !version) { console.error('用法: sign-update-manifest.mjs <artifacts目录> <版本号>'); process.exit(1) }
if (!keyB64) { console.log('[manifest] 未配置 ORAY_UPDATE_SIGN_KEY：跳过更新清单签名（分布式更新休眠）'); process.exit(0) }

// 递归收集相对路径（GitHub 资产名会把空格规范化为点，磁盘上仍是空格）
const walk = (d, prefix = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`])
const files = walk(dir)
const pick = (re) => files.filter((f) => re.test(path.basename(f))).sort().pop()
const assets = {}
const add = (key, re) => {
  const f = pick(re)
  if (!f) return
  const buf = fs.readFileSync(path.join(dir, f))
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  // GitHub 会把资产名中的空格规范化为点；清单记录同名（updater GitHub 兜底按 name 拼 URL）
  assets[key] = { name: path.basename(f).replace(/ /g, '.'), size: buf.length, sha256, fid: sha256.slice(0, 24) }
}
// electron-builder 缺省命名：NSIS "OrayChat Setup X.Y.Z.exe"、AppImage "OrayChat-X.Y.Z.AppImage"
add('mac-zip', /^OrayChat-\d[\d.]*-arm64-mac\.zip$/)
add('win-nsis', /^OrayChat Setup \d[\d.]*\.exe$/)
add('linux-appimage', /^OrayChat-\d[\d.]*\.AppImage$/)
add('android-apk', /^app-release\.apk$/)

if (!Object.keys(assets).length) { console.log('[manifest] 目录中无已知平台资产：跳过'); process.exit(0) }

const manifest = { v: version, ts: Date.now(), assets }
const bytes = utf8(JSON.stringify({ v: manifest.v, ts: manifest.ts, assets: manifest.assets }))
const sig = ed25519.sign(bytes, unb64(keyB64))
if (!ed25519.verify(sig, bytes, ed25519.getPublicKey(unb64(keyB64)))) { console.error('[manifest] 自检失败'); process.exit(1) }
manifest.sig = b64(sig)

fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
fs.writeFileSync(path.join(dir, 'manifest.sig'), b64(sig))
console.log(`[manifest] 已签发 v${version}：${Object.keys(assets).join(', ')}（manifest.json/sig 将随 Release 发布）`)
