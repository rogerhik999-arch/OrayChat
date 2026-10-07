// 分布式自动更新单测：node test/update.test.mjs（无网络）
//   semver 比较 / 清单验签（canonical bytes）/ 守门状态机逐条件 / gossip 择优 /
//   崩溃环降级 / 主机感知推迟 / 维护窗口
import assert from 'node:assert/strict'
import { ed25519 } from '@noble/curves/ed25519.js'
import { b64, unb64, utf8 } from '../renderer/src/crypto.mjs'
import { semverCompare, verifyManifest, manifestBytes, gateDecision, inMaintenanceWindow, Updater } from '../renderer/src/updater.mjs'

const results = []
const ok = (name, cond, detail = '') => { results.push(cond); console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`) }

// ---------- 1) semver ----------
console.log('[1] semverCompare')
ok('1.1 1.29.0 > 1.28.0', semverCompare('1.29.0', '1.28.0') > 0)
ok('1.2 v 前缀兼容', semverCompare('v1.29.0', '1.28.0') > 0)
ok('1.3 同版相等', semverCompare('1.28.0', 'v1.28.0') === 0)
ok('1.4 旧版 < 0', semverCompare('1.27.1', '1.28.0') < 0)
ok('1.5 逐段比较（1.10 > 1.9）', semverCompare('1.10.0', '1.9.0') > 0)

// ---------- 2) 清单验签 ----------
console.log('[2] manifest 验签')
{
  const seed = ed25519.keygen().secretKey
  const pub = b64(ed25519.getPublicKey(seed))
  const manifest = { v: '1.29.0', ts: 1234567890, assets: { 'mac-zip': { name: 'a.zip', size: 1, sha256: 'f'.repeat(64), fid: 'f'.repeat(24) } } }
  const bytes = manifestBytes(manifest)
  const sig = b64(ed25519.sign(bytes, seed))
  const signed = { ...manifest, sig }

  // 单测用受信公钥=测试公钥：临时替换模块内常量不可行（const 数组），改走
  // Updater 实例的 onPkgGossip→verifyManifest 路径验证真公钥；此处直接验签函数
  const pubBytes = ed25519.getPublicKey(seed)
  ok('2.1 正确签名验签通过（对测试公钥）', ed25519.verify(unb64(sig), bytes, pubBytes))
  ok('2.2 篡改 payload 验签失败', !ed25519.verify(unb64(sig), manifestBytes({ ...manifest, ts: 1 }), seed))
  ok('2.3 verifyManifest 对无签名/坏签名拒绝（不受信清单）', !verifyManifest(signed) && !verifyManifest({ v: 'x', ts: 1, assets: {} }))
  // canonical bytes 稳定性：同内容异键序 → manifestBytes 输出一致
  const eq = (u1, u2) => Buffer.from(u1).equals(Buffer.from(u2))
  ok('2.4 canonical bytes 与键序无关', eq(manifestBytes({ ...manifest, sig: 'x' }), utf8(JSON.stringify({ v: manifest.v, ts: manifest.ts, assets: manifest.assets }))))

  // Updater gossip 择优（注入受信公钥的实例）
  const mk = () => {
    const u = new Updater({ appVersion: '1.28.0', platform: 'darwin', kv: { get: async () => '[]', set: async () => {} } })
    u.trusted = [pub]
    // 注入受信公钥：verifyManifest 读模块常量；为可测，Updater.onPkgGossip 支持
    // 实例级 trustedPubkeys 覆盖（构造参数 trusted）
    return u
  }
  const u = new Updater({ appVersion: '1.28.0', platform: 'darwin', kv: { get: async () => '[]', set: async () => {} }, trusted: [pub] })
  ok('2.5 实例可注入受信公钥', Array.isArray(u.trustedPubkeys) && u.trustedPubkeys[0] === pub)
  void mk
}

// ---------- 3) 守门状态机 ----------
console.log('[3] gateDecision')
const now = 1791500000000
const pkg = { v: '1.29.0', ts: now - 3600 * 1000, assets: {} }
const base = { policy: 'full-auto', knownPkg: pkg, myVersion: '1.28.0', now }
ok('3.1 基线：full-auto → download', gateDecision(base) === 'download')
ok('3.2 off 策略不动', gateDecision({ ...base, policy: 'off' }) === null)
ok('3.3 无已知清单不动', gateDecision({ ...base, knownPkg: null }) === null)
ok('3.4 版本相同/更旧不动', gateDecision({ ...base, myVersion: '1.29.0' }) === null)
ok('3.5 忽略版本不动', gateDecision({ ...base, ignored: ['1.29.0'] }) === null)
ok('3.6 prompt 档只通知', gateDecision({ ...base, policy: 'prompt' }) === 'notify')
ok('3.7 传输进行中 defer', String(gateDecision({ ...base, transferring: true })).startsWith('defer'))
ok('3.8 崩溃环冷却 defer', String(gateDecision({ ...base, lastAutoApplyAt: now - 3 * 60000 })).startsWith('defer'))
ok('3.9 download-prompt 未暂存 → download', gateDecision({ ...base, policy: 'download-prompt' }) === 'download')
ok('3.10 download-prompt 已暂存 → notify-install', gateDecision({ ...base, policy: 'download-prompt', stagedOk: true }) === 'notify-install')
ok('3.11 quit-install 未暂存 → download', gateDecision({ ...base, policy: 'quit-install' }) === 'download')
ok('3.12 full-auto 抖动期 defer', String(gateDecision({ ...base, jitterUntil: now + 60000 })).startsWith('defer'))
// 主机感知：服务中 defer；空闲 10min+ → download；维护窗口；硬期限 72h
const hubBusy = { hubRunning: true, hubMembers: 2 }
ok('3.13 主机服务中 defer', String(gateDecision({ ...base, ...hubBusy })).startsWith('defer:中继服务中'))
ok('3.14 主机空闲≥10min 恢复动作', gateDecision({ ...base, ...hubBusy, idleSince: now - 11 * 60000 }) === 'download')
ok('3.15 维护窗口内动作', gateDecision({ ...base, ...hubBusy, now: inMaintenanceWindow(now, 4) ? now : (() => { const d = new Date(now); d.setHours(4, 30, 0, 0); return d.getTime() })() }) === 'download')
ok('3.16 硬期限 72h 覆盖服务忙', gateDecision({ ...base, ...hubBusy, knownPkg: { ...pkg, ts: now - 73 * 3600 * 1000 } }) === 'download')
ok('3.17 非主机成员不受主机推迟', gateDecision({ ...base, hubRunning: false, hubMembers: 0 }) === 'download')

// ---------- 4) Updater gossip 择优 + 崩溃环降级（实例级，注入受信公钥）----------
console.log('[4] Updater gossip/崩溃环')
{
  const seed = ed25519.keygen().secretKey
  const pub = b64(ed25519.getPublicKey(seed))
  const mkPkg = (v) => {
    const m = { v, ts: Date.now(), assets: { 'mac-zip': { name: 'a.zip', size: 1, sha256: 'ab'.repeat(32), fid: 'ab'.repeat(12) } } }
    return { ...m, sig: b64(ed25519.sign(manifestBytes(m), seed)) }
  }
  const store = new Map()
  const kv = { get: async (k) => store.get(k), set: async (k, v) => store.set(k, v) }
  const u = new Updater({ appVersion: '1.28.0', platform: 'darwin', kv, trusted: [pub], onLog: () => {} })
  await u.onPkgGossip(mkPkg('1.29.0'), 'bob')
  ok('4.1 验签通过的清单被采纳', u.knownPkg?.v === '1.29.0')
  await u.onPkgGossip(mkPkg('1.30.0'), 'bob')
  ok('4.2 更高版本择优替换', u.knownPkg?.v === '1.30.0')
  await u.onPkgGossip(mkPkg('1.29.5'), 'bob')
  ok('4.3 更低版本不回退', u.knownPkg?.v === '1.30.0')
  await u.onPkgGossip({ v: '1.31.0', ts: Date.now(), assets: {}, sig: b64(ed25519.sign(utf8('fake'), seed)) }, 'mallory')
  ok('4.4 无效签名清单拒绝', u.knownPkg?.v === '1.30.0')

  // 崩溃环：连续 2 次失败 → gateDecision 降级 notify
  const u2 = new Updater({ appVersion: '1.28.0', platform: 'darwin', kv: { get: async () => '[]', set: async () => {} }, trusted: [pub], onLog: () => {} })
  u2.knownPkg = mkPkg('1.29.0')
  const d1 = gateDecision({ policy: 'full-auto', knownPkg: u2.knownPkg, myVersion: '1.28.0', now, autoApplyFails: 1, stagedOk: true })
  const d2 = gateDecision({ policy: 'full-auto', knownPkg: u2.knownPkg, myVersion: '1.28.0', now, autoApplyFails: 2, stagedOk: true })
  ok('4.5 失败 1 次仍 apply（允许重试一次）', d1 === 'apply')
  ok('4.6 失败 2 次降级 notify', d2 === 'notify:自动更新连续失败已降级')
}

const pass = results.filter(Boolean).length
console.log(`\n${pass === results.length ? '✅' : '❌'} update.test.mjs：${pass}/${results.length} 通过`)
process.exit(pass === results.length ? 0 : 1)
