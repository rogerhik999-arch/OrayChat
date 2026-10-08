// 分布式自动更新（docs/update-plan.md M1）
// 链路：presence 心跳捎带 ver+签名清单（gossip）→ 验签采纳 → 策略/守门状态机
// → filex 多源拉包（fx-want，复用既有传输）→ 校验 → 主进程 staging → 换装。
// 安全底线：无有效 Ed25519 签名的清单一律拒绝；版本单调（禁降级）；
// 拉到的包 fid=sha256 前 24hex 内容寻址绑定 + finalize 终检（filex 已有）。
import { ed25519 } from '@noble/curves/ed25519.js'
import { b64, unb64, utf8 } from './crypto.mjs'

// 内置信任公钥（tools/gen-update-key.mjs 生成；私钥在 CI Secret ORAY_UPDATE_SIGN_KEY）
export const TRUSTED_PUBKEYS = [
  'e4QPiZx0CTdMy8dcl+PxnNLykdv0b7EYaxzu+mdWPX4=',
]

// 策略五档
export const POLICIES = ['off', 'prompt', 'download-prompt', 'quit-install', 'full-auto']

// ---------- 语义化版本比较（返回 >0 / 0 / <0）----------
export function semverCompare(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '').replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

// ---------- 清单验签（canonical bytes = 去掉 sig 字段后的稳定序列化）----------
export function manifestBytes(m) {
  const { sig, ...rest } = m
  return utf8(JSON.stringify({ v: rest.v, ts: rest.ts, assets: rest.assets }))
}

export function verifyManifest(m, trusted = TRUSTED_PUBKEYS) {
  try {
    if (!m || typeof m.v !== 'string' || !m.sig || !m.assets) return false
    const bytes = manifestBytes(m)
    return (trusted || TRUSTED_PUBKEYS).some((pk) => {
      try { return ed25519.verify(unb64(m.sig), bytes, unb64(pk)) } catch { return false }
    })
  } catch { return false }
}

// ---------- 平台资产键（与 CI manifest job 的命名一致）----------
export function platformAssetKey(platform) {
  if (platform === 'darwin') return 'mac-zip'
  if (platform === 'win32') return 'win-nsis'
  if (platform === 'linux') return 'linux-appimage'
  if (platform === 'android') return 'android-apk'
  return null
}

// ---------- 守门状态机（纯函数，便于逐条件单测）----------
// 输入：{policy, knownPkg, myVersion, ignored, transferring, lastAutoApplyAt,
//        autoApplyFails, hubRunning, hubMembers, idleSince, jitterUntil, stagedOk, now}
// 返回：'apply' | 'stage' | 'download' | 'defer:<原因> | null
export function gateDecision(s) {
  if (!s.policy || s.policy === 'off') return null
  if (!s.knownPkg) return null
  if (semverCompare(s.knownPkg.v, s.myVersion) <= 0) return null // 版本单调：同版/更旧不动
  if (s.ignored?.includes(s.knownPkg.v)) return null
  if (s.policy === 'prompt') return 'notify'
  // 以下各档都需要先下载（已在 files/ 就直接 stage）
  if (s.transferring) return 'defer:传输进行中'
  // 崩溃环：距上次自动应用 <10min，或同版本失败 ≥2 次 → 降级提示
  if (s.lastAutoApplyAt && s.now - s.lastAutoApplyAt < 10 * 60000) return 'defer:崩溃环冷却'
  if ((s.autoApplyFails || 0) >= 2) return 'notify:自动更新连续失败已降级'
  if (s.policy === 'download-prompt') return s.stagedOk ? 'notify-install' : 'download'
  if (s.policy === 'quit-install') return s.stagedOk ? 'apply-on-quit' : 'download'
  // full-auto：抖动未到 → 等待
  if (s.jitterUntil && s.now < s.jitterUntil) return 'defer:错峰抖动'
  // 主机感知：本机是中继主机且正在服务成员 → 等服务空闲/维护窗口/硬期限
  if (s.hubRunning && (s.hubMembers || 0) > 0) {
    const idleOk = s.idleSince && s.now - s.idleSince >= 10 * 60000
    const inWindow = inMaintenanceWindow(s.now, s.maintenanceHour)
    const deadline = s.knownPkg.ts && s.now - s.knownPkg.ts > 72 * 3600 * 1000
    if (!idleOk && !inWindow && !deadline) return 'defer:中继服务中'
  }
  return s.stagedOk ? 'apply' : 'download'
}

// 维护窗口：本地小时 == 配置小时（默认 4 点）即视为窗口内（1 小时粒度）
export function inMaintenanceWindow(now, hour = 4) {
  return new Date(now).getHours() === hour
}

// ---------- GitHub 清单兜底发现（盲种子补救，纯函数便于单测）----------
// 心跳里的 peer.ver 只是版本号；pkg 只在机器采纳过清单后才随 gossip 传播——手动
// 安装新版的机器是"盲种子"（人人可见其版本，却无清单可广播），全房间会陷入
// 无清单死锁（GitHub 兜底只下载包，清单本身原设计没有任何主动获取路径）。
// 见到比本机更高的对端版本、且本地清单覆盖不了它时，主动去 GitHub 拉签名清单
// （与 gossip 清单同源同验签）。退避 30 分钟：未认证 GitHub API 限流 60 次/h。
export const GH_PROBE_BACKOFF_MS = 30 * 60000
export function shouldProbeGitHub({ maxPeerVer, myVersion, knownPkgV, source, lastProbeAt, now }) {
  if (!maxPeerVer || source === 'peers-only') return false
  if (semverCompare(maxPeerVer, myVersion) <= 0) return false // 无人比我新
  if (knownPkgV && semverCompare(knownPkgV, maxPeerVer) >= 0) return false // 本地清单已覆盖
  return now - (lastProbeAt || 0) >= GH_PROBE_BACKOFF_MS
}

// ---------- 源路由：同伴拉取失败后的兜底窗口（纯函数便于单测）----------
// gossip 采纳可能先于与持有者的握手完成（presence 不受限、握手需数秒）——首拉
// 常见"在线成员都没有这个文件"竞态。失败后转 GitHub 一段时间，**到点必须回退
// 重试同伴**（持有者可能已上线；此前的一次性布尔闩锁会让同伴路径永不重试，
// 叠加 GitHub 兜底故障时整条更新链路永久空转，2026-10-08 实机测试发现）。
export const PEER_RETRY_MS = 10 * 60000
export function routeSource({ source, peerPullFailedAt, now }) {
  if (source === 'github-only') return 'github'
  if (source === 'peers-only') return 'peers'
  return peerPullFailedAt && now - peerPullFailedAt < PEER_RETRY_MS ? 'github' : 'peers'
}


// ---------- 主类 ----------
export class Updater {
  constructor({ net, filex, appVersion, platform, kv, notify, ipc, onLog, trusted }) {
    this.net = net
    this.filex = filex
    this.appVersion = appVersion
    this.platform = platform
    this.kv = kv || { get: async () => undefined, set: async () => {} }
    this.notify = notify || (() => {})
    this.ipc = ipc || {} // { stage(pkg), apply(version) } → 主进程
    this.onLog = onLog || (() => {})
    this.knownPkg = null // 验签通过的最新清单
    this.trustedPubkeys = trusted || TRUSTED_PUBKEYS // 实例级覆盖（测试注入）
    this.stagedOk = false
    this.phase = 'idle' // idle|downloading|staged|applying
    this.ignored = []
    this.cfg = { policy: 'download-prompt', source: 'peers-first', maintenanceHour: 4 }
    this.idleSince = null
    this._hubBusy = false
    this._lastSeenVer = null
    this._ghProbeAt = 0 // 上次 GitHub 清单兜底探测时刻（退避用）
    this._peerPullFailedAt = 0 // 上次同伴拉取失败时刻（routeSource 退避窗口用）
    this._ghProbing = false
  }

  async init() {
    try {
      const saved = JSON.parse((await this.kv.get('oc-updater-cfg')) || '{}')
      this.cfg = { ...this.cfg, ...saved }
      this.ignored = JSON.parse((await this.kv.get('oc-updater-ignored')) || '[]')
      const state = JSON.parse((await this.kv.get('oc-updater-state')) || '{}')
      this.lastAutoApplyAt = state.lastAutoApplyAt || 0
      this.autoApplyFails = state.autoApplyFails || 0
      // 崩溃环确认：上次自动应用的就是当前版本且已稳定运行（本模块被初始化即运行中）
      if (state.autoAppliedVer === this.appVersion && state.autoAppliedAt && Date.now() - state.autoAppliedAt > 120000) {
        this.autoApplyFails = 0
        await this.kv.set('oc-updater-state', JSON.stringify({ ...state, autoApplyFails: 0 }))
      }
      // 历史已知清单（重启续接）
      if (state.knownPkg && verifyManifest(state.knownPkg, this.trustedPubkeys)) {
        this.knownPkg = state.knownPkg
        this._lastSeenVer = state.knownPkg.v
      }
    } catch { /* 坏数据按无状态启动 */ }
    // 30s 轮询：配置变更（设置页写入）+ 主机服务空闲检测 + 守门 tick
    this.tickTimer = setInterval(() => { void this.tick() }, 30000)
    void this.tick()
  }

  destroy() { if (this.tickTimer) clearInterval(this.tickTimer) }

  async saveCfg(patch) {
    this.cfg = { ...this.cfg, ...patch }
    await this.kv.set('oc-updater-cfg', JSON.stringify(this.cfg))
  }

  // presence 心跳捎带的 gossip 载荷（net 层每 15s 调用）
  gossipPayload() {
    return { ver: this.appVersion, pkg: this.knownPkg }
  }

  // 收到对端心跳的 pkg：验签 → 择优（高版本胜）→ 落 KV → evaluate
  async onPkgGossip(pkg, fromName) {
    if (!pkg || pkg === this.knownPkg) return
    if (!verifyManifest(pkg, this.trustedPubkeys)) { this.onLog(`收到无效更新清单（来自 ${fromName || '对端'}，签名不符已丢弃）`, 'warn'); return }
    if (this.knownPkg && semverCompare(pkg.v, this.knownPkg.v) <= 0) return
    await this.adoptManifest(pkg, `来自 ${fromName || '房间'} 的签名清单`)
  }

  // 采纳清单（gossip 与 GitHub 兜底共用；调用方负责验签与版本择优）→ 落 KV → evaluate
  async adoptManifest(pkg, from) {
    this.knownPkg = pkg
    this.stagedOk = false
    this.phase = 'idle'
    await this.kv.set('oc-updater-state', JSON.stringify({
      lastAutoApplyAt: this.lastAutoApplyAt || 0, autoApplyFails: this.autoApplyFails || 0,
      autoAppliedVer: (await this.readState()).autoAppliedVer || null, knownPkg: pkg,
    }))
    this.onLog(`发现新版本 ${pkg.v}（${from}）`)
    void this.evaluate('gossip')
  }

  // GitHub 清单兜底发现（盲种子补救）：清单获取与 gossip 采纳同权同验签
  async probeGitHubManifest() {
    if (this._ghProbing) return
    this._ghProbing = true
    try {
      const m = await this.fetchFromGitHub()
      if (m && semverCompare(m.v, this.appVersion) > 0
        && (!this.knownPkg || semverCompare(m.v, this.knownPkg.v) > 0)) {
        await this.adoptManifest(m, 'GitHub 清单兜底发现')
      }
    } catch (e) {
      this.onLog(`GitHub 清单兜底失败：${e?.message || e}（${Math.round(GH_PROBE_BACKOFF_MS / 60000)} 分钟后随下轮 tick 重试）`, 'warn')
    } finally {
      this._ghProbing = false
    }
  }

  // GitHub 兜底（M2）：主进程拉最新 Release 的签名清单（验签后与 gossip 清单同权）
  async fetchFromGitHub() {
    if (!this.ipc?.githubManifest) return null
    const m = await this.ipc.githubManifest()
    if (!m || !verifyManifest(m, this.trustedPubkeys)) throw new Error('GitHub 清单验签失败')
    return m
  }

  // GitHub 直下资产（主进程下载到 files/<fid>，与 filex 拉取同位）
  async downloadAssetFromGitHub(asset) {
    if (!this.ipc?.githubAsset) throw new Error('GitHub 下载不可用')
    await this.ipc.githubAsset(asset)
  }

  // 守门 tick（30s）
  async tick() {
    if (!this.net) return
    try {
      // 配置热加载（设置页可能改了策略）
      const saved = JSON.parse((await this.kv.get('oc-updater-cfg')) || '{}')
      this.cfg = { ...this.cfg, ...saved }
      // 盲种子补救：ready 对端有比本机更高的版本号而本地清单覆盖不了 → 主动去
      // GitHub 拉签名清单（shouldProbeGitHub 内含 30 分钟退避与 peers-only 排除）
      const maxPeerVer = [...(this.net.peers?.values() || [])]
        .filter((p) => p.state === 'ready' && p.ver)
        .reduce((mx, p) => (semverCompare(p.ver, mx) > 0 ? p.ver : mx), this.appVersion)
      if (shouldProbeGitHub({
        maxPeerVer, myVersion: this.appVersion, knownPkgV: this.knownPkg?.v,
        source: this.cfg.source, lastProbeAt: this._ghProbeAt, now: Date.now(),
      })) {
        this._ghProbeAt = Date.now()
        await this.probeGitHubManifest() // 采纳（若成功）先落盘，本轮 evaluate 随即可见
      }
      // 主机服务空闲检测（hubStatus 由 app 层注入）
      if (this.hubStatus) {
        const st = await this.hubStatus()
        const serving = !!(st?.running && (st?.memberList?.length || 0) > 0)
        if (serving && !this._hubBusy) { this._hubBusy = true; this.idleSince = null }
        else if (!serving && this._hubBusy) { this._hubBusy = false; this.idleSince = Date.now() }
        else if (!serving && !this.idleSince) this.idleSince = Date.now()
        this._hubSnap = st
      }
      await this.evaluate('tick')
    } catch { /* tick 失败等下轮 */ }
  }

  // 决策执行（gossip 触发与周期 tick 共用）
  async evaluate(trigger) {
    const st = this._hubSnap || {}
    const decision = gateDecision({
      policy: this.cfg.policy,
      knownPkg: this.knownPkg,
      myVersion: this.appVersion,
      ignored: this.ignored,
      transferring: !!this.filex?.hasActiveTransfer?.() && [...(this.filex.tx?.values() || [])].some((t) => t.state === 'active'),
      lastAutoApplyAt: this.lastAutoApplyAt || 0,
      autoApplyFails: this.autoApplyFails || 0,
      hubRunning: !!st.running,
      hubMembers: st.memberList?.length || 0,
      idleSince: this.idleSince,
      jitterUntil: this.jitterUntil,
      maintenanceHour: this.cfg.maintenanceHour,
      stagedOk: this.stagedOk,
      now: Date.now(),
    })
    if (!decision || decision.startsWith('defer')) return
      // Android（M3 轻量版）：WebView 内存 io 装不下 140MB 安装包——走"通知 +
      // 引导到 Releases 页"（系统边界：安装本就必须用户确认）。原生 filex-io 桥
      // 落地后可升级为包直送一键装
      if (this.platform === 'android' && ['download', 'notify', 'notify-install', 'apply', 'apply-on-quit'].includes(decision)) {
        if (this._androidNotified !== this.knownPkg.v) {
          this._androidNotified = this.knownPkg.v
          this.notify(`新版本 ${this.knownPkg.v} 已发布：请到 GitHub Releases 页下载安装`)
          this.onLog(`Android 检测到新版本 ${this.knownPkg.v}（引导下载模式）`)
        }
        return
      }
      try {
      if (decision === 'notify') { this.notify(`发现新版本 ${this.knownPkg.v}（设置→更新 可选择策略）`); return }
      if (decision === 'notify-install') { this.notify(`新版本 ${this.knownPkg.v} 已下载就绪，重启即完成更新`); return }
      if (decision === 'download') {
        if (routeSource({ source: this.cfg.source, peerPullFailedAt: this._peerPullFailedAt, now: Date.now() }) === 'github') {
          // GitHub 失败退避 5 分钟：未认证 API 限流 60/h，失败循环会打爆限额（实测 403）
          if (this._ghFailAt && Date.now() - this._ghFailAt < 5 * 60000) return
          void this.downloadViaGitHub()
          return
        }
        void this.download()
        return
      }
      if (decision === 'apply-on-quit') { this.notify(`新版本 ${this.knownPkg.v} 已就绪，退出时自动换装`); return } // before-quit 钩子执行换装
      if (decision === 'apply') { void this.applyStaged(true); return }
    } catch (e) { this.onLog(`更新流程异常: ${e?.message || e}`, 'warn') }
  }

  // GitHub 兜底下载：清单+资产走主进程，校验/暂存与同伴路径完全一致
  async downloadViaGitHub() {
    if (this.phase === 'downloading' || this.phase === 'staged' || this.phase === 'applying') return
    const cur = this.knownPkg
    try {
      this.phase = 'downloading'
      const gh = await this.fetchFromGitHub()
      if (!gh || semverCompare(gh.v, this.appVersion) <= 0) throw new Error('GitHub 无更新')
      const asset = gh.assets?.[platformAssetKey(this.platform)]
      if (!asset) throw new Error('GitHub 清单无本平台资产')
      this.onLog(`从 GitHub 拉取更新包 ${gh.v}（${Math.round(asset.size / 1048576)}MB）`)
      await this.downloadAssetFromGitHub(asset)
      const bytes = await this.filex.io.read(asset.fid)
      if (!bytes) throw new Error('包不在本机')
      const { sha256Hex } = await import('./filex.mjs')
      if (asset.sha256 && (await sha256Hex(bytes)) !== asset.sha256) throw new Error('整包 SHA-256 不符（拒绝）')
      this.knownPkg = gh
      this.phase = 'staged'
      this.onLog(`GitHub 更新包校验通过（${gh.v}），已暂存待安装`)
      await this.ipc.stage?.({ version: gh.v, fid: asset.fid, assetName: asset.name || '' })
      this.stagedOk = true
      this.notify(`新版本 ${gh.v} 已就绪`)
      void this.evaluate('staged')
    } catch (e) {
      this.phase = 'idle'
      this._ghFailAt = Date.now()
      this.onLog(`GitHub 兜底失败：${e?.message || e}`, 'warn')
    }
  }

  // 多源拉包（filex 既有协议）→ 校验 → 主进程 staging
  async download() {
    if (this.phase === 'downloading' || this.phase === 'staged' || this.phase === 'applying') return
    const pkg = this.knownPkg
    if (!pkg) return
    const asset = pkg.assets?.[platformAssetKey(this.platform)]
    if (!asset) { this.onLog(`清单中没有本平台（${this.platform}）的资产，跳过更新`, 'warn'); return }
    if (semverCompare(pkg.v, this.appVersion) <= 0) return
    this.phase = 'downloading'
    this.onLog(`开始从同伴拉取更新包 ${pkg.v}（fid=${asset.fid.slice(0, 12)}…，${Math.round(asset.size / 1048576)}MB）`)
    try {
      const already = await this.filex.holding(asset.fid)
      if (!already) {
        // fx-want 多源：包随房间分发，多个持有者并发供块。pullFromPeers 只启动
        // 拉取事务（接收方驱动、异步完成）——轮询等传输完成再校验。
        // "已在传输队列中" = 上一轮启动的事务还在跑（tick 重入）→ 直接进入等待。
        try {
          await this.filex.pullFromPeers(asset.fid, { name: `OrayChat-${pkg.v}-update`, size: asset.size })
        } catch (e) {
          if (!/已在传输队列中/.test(e?.message || '')) throw e
        }
        // 首窗 3 分钟；大文件慢链路（实测 144MB @230KB/s ≈ 11 分钟）只要事务仍在
        // active 推进就续等（上限 30 分钟）——过早放弃会把进行中的拉取整轮作废，
        // 叠加源路由窗口后出现 GitHub/同伴来回震荡（2026-10-08 实机测试发现）
        const waitT0 = Date.now()
        while (!(await this.filex.holding(asset.fid)) && Date.now() - waitT0 < 30 * 60000) {
          if (this.phase !== 'downloading') return // tick 重入/策略变更：放弃本轮
          const txActive = this.filex.tx?.get(asset.fid)?.state === 'active'
          if (Date.now() - waitT0 >= 180000 && !txActive) break
          await new Promise((r) => setTimeout(r, 5000))
        }
        if (!(await this.filex.holding(asset.fid))) throw new Error('拉取超时——稍后自动重试，或等更多成员成为种子')
      }
      // 全量终检（fid 前缀绑定之外再对整包 sha256 与清单比对——双保险）
      const bytes = await this.filex.io.read(asset.fid)
      if (!bytes) throw new Error('包不在本机')
      const { sha256Hex } = await import('./filex.mjs')
      const sha = await sha256Hex(bytes)
      if (asset.sha256 && sha !== asset.sha256) throw new Error('整包 SHA-256 与签名清单不符（拒绝）')
      this.phase = 'staged'
      this.onLog(`更新包校验通过（${pkg.v}），已暂存待安装`)
      await this.ipc.stage?.({ version: pkg.v, fid: asset.fid, assetName: asset.name || '' })
      this.stagedOk = true
      this.notify(`新版本 ${pkg.v} 已就绪`)
      void this.evaluate('staged')
    } catch (e) {
      this.phase = 'idle'
      this._peerPullFailedAt = Date.now() // 源路由：10 分钟内走 GitHub 兜底，到点回退重试同伴（routeSource）
      this.onLog(`更新包获取失败：${e?.message || e}（30 分钟后随下轮 tick 重试，或转 GitHub 兜底）`, 'warn')
      this.jitterUntil = Date.now() + 30 * 60000 // 拉取失败：歇 30 分钟再试（避免风暴）
    }
  }

  // 应用（quit-install=等用户退出时换；full-auto=守门过后立即换+自动重启）
  async applyStaged(immediate) {
    if (!this.stagedOk || this.phase === 'applying') return
    this.phase = 'applying'
    const state = await this.readState()
    this.lastAutoApplyAt = Date.now()
    this.autoApplyFails = (state.autoAppliedVer === this.knownPkg.v ? state.autoApplyFails || 0 : 0)
    await this.kv.set('oc-updater-state', JSON.stringify({
      ...state, lastAutoApplyAt: this.lastAutoApplyAt, autoAppliedVer: this.knownPkg.v,
      autoAppliedAt: Date.now(), autoApplyFails: this.autoApplyFails,
    }))
    await this.kv.set('oc-updater-apply', JSON.stringify({ ver: this.knownPkg.v, at: Date.now(), startsSince: 0 })) // 回滚簿记
    this.onLog(`${immediate ? '自动更新' : '退出换装'}：应用 ${this.knownPkg.v}（换装后自动重启并成为种子）`, 'warn')
    try { await this.ipc.apply?.({ version: this.knownPkg.v, immediate }) } catch (e) {
      this.phase = 'staged'
      this.onLog(`换装启动失败: ${e?.message || e}`, 'error')
    }
  }

  async ignoreCurrent() {
    if (!this.knownPkg) return
    if (!this.ignored.includes(this.knownPkg.v)) this.ignored.push(this.knownPkg.v)
    await this.kv.set('oc-updater-ignored', JSON.stringify(this.ignored))
  }

  async readState() {
    try { return JSON.parse((await this.kv.get('oc-updater-state')) || '{}') } catch { return {} }
  }

  // 设置页/健康面板消费的状态快照
  status() {
    return {
      version: this.appVersion,
      phase: this.phase,
      policy: this.cfg.policy,
      source: this.cfg.source,
      knownPkg: this.knownPkg ? { v: this.knownPkg.v, ts: this.knownPkg.ts } : null,
      stagedOk: this.stagedOk,
      fails: this.autoApplyFails || 0,
    }
  }
}
