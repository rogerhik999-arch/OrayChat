// 分布式自动更新——主进程换装与 GitHub 兜底（docs/update-plan.md M1/M2）
// 平台机制：
//   macOS   zip   → detached helper：等退出→备份→ditto→重启
//   Windows NSIS  → detached helper：等退出→静默安装 /S（安装器自身接管重启）
//   Linux   AppImage → 原子替换 process.execPath + chmod + 重启（最简）
// 回滚（M2）：换装保留旧版备份（dst.bak）；boot-ok 自检簿记连续缺失 → 恢复备份。
// 演练沙箱：ORAY_UPDATE_DST / ORAY_UPDATE_NO_LAUNCH。
const { app, net } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

// GitHub 下载走 Chromium 网络栈（net.fetch）：自动使用系统代理。Node 裸 fetch
// 不认 Windows 系统代理——github.com 直连超时、代理可达的环境（典型国内网络）
// 会让兜底链路整个卡死。app 未 ready 或无 net.fetch 时退回 Node fetch。
const xfetch = (url, opts) => (app.isReady() && typeof net?.fetch === 'function' ? net.fetch(url, opts) : fetch(url, opts))

const state = { staged: null } // { version, appPath|installerPath }

const userDataDir = () => app.getPath('userData')
const filesDir = () => path.join(userDataDir(), 'files')

function findPkgFile(fid) {
  const dir = filesDir()
  const exact = path.join(dir, fid)
  if (fs.existsSync(exact)) return exact
  try {
    const hit = fs.readdirSync(dir).find((f) => f.startsWith(fid))
    return hit ? path.join(dir, hit) : null
  } catch { return null }
}

// 换装步骤生成（纯函数：单测锁定各平台关键行为）
function buildApplySteps(platform, opts) {
  const dst = opts.dst
  const pid = opts.pid
  const common = [
    'for i in $(seq 1 120); do kill -0 ' + pid + ' 2>/dev/null || break; sleep 0.5; done',
    'sleep 1',
  ]
  if (platform === 'darwin') {
    return common.concat([
      'rm -rf "' + dst + '.bak"',
      '[ -d "' + dst + '" ] && ditto "' + dst + '" "' + dst + '.bak"',
      'rm -rf "' + dst + '"',
      'ditto "' + opts.appPath + '" "' + dst + '"',
      'sleep 0.5',
      'open "' + dst + '"',
    ])
  }
  if (platform === 'win32') {
    return common.concat(['"' + opts.installerPath + '" /S']) // NSIS 静默安装，安装器接管重启
  }
  // linux：AppImage 原子替换自身（mv 同分区原子）
  return common.concat([
    '[ -f "' + dst + '" ] && cp "' + dst + '" "' + dst + '.bak"',
    'cp "' + opts.appPath + '" "' + dst + '.new"',
    'chmod +x "' + dst + '.new"',
    'mv -f "' + dst + '.new" "' + dst + '"',
    '(cd "$(dirname "' + dst + '")" && nohup "$(basename "' + dst + '")" >/dev/null 2>&1 &)',
  ])
}

async function stage(opts) {
  const version = opts.version
  const fid = opts.fid
  const src = findPkgFile(fid)
  if (!src) return { ok: false, err: '包不在本机（files/' + fid + '）' }
  const staging = path.join(userDataDir(), 'staging', version)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  const platform = process.platform
  if (platform === 'darwin') {
    try { execFileSync('unzip', ['-q', '-o', src, '-d', staging], { timeout: 120000 }) } catch (e) { return { ok: false, err: '解包失败: ' + e.message } }
    const appPath = path.join(staging, 'OrayChat.app')
    const plist = path.join(appPath, 'Contents', 'Info.plist')
    if (!fs.existsSync(plist)) return { ok: false, err: '包内无 OrayChat.app（结构不符）' }
    let stagedVer = ''
    try { stagedVer = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]).toString().trim() } catch { /* 结构已核对 */ }
    if (stagedVer && stagedVer !== version) return { ok: false, err: '包内版本 ' + stagedVer + ' ≠ 清单 ' + version }
    state.staged = { version, appPath }
    return { ok: true, version, appPath }
  }
  if (platform === 'win32') {
    // NSIS 安装器原样保留（/S 自验自装）；版本自检交给安装器
    const installerPath = path.join(staging, path.basename(src))
    fs.copyFileSync(src, installerPath)
    state.staged = { version, installerPath }
    return { ok: true, version, installerPath }
  }
  if (platform === 'linux') {
    const appImagePath = path.join(staging, 'OrayChat.AppImage')
    fs.copyFileSync(src, appImagePath)
    try { fs.chmodSync(appImagePath, 0o755) } catch { /* ignore */ }
    state.staged = { version, appPath: appImagePath }
    return { ok: true, version, appPath: appImagePath }
  }
  return { ok: false, err: '不支持的平台' }
}

async function apply(opts) {
  const version = opts.version
  const st = state.staged && state.staged.version === version ? state.staged : null
  if (!st) return { ok: false, err: '尚未 staging（先 stage）' }
  const pid = process.pid
  let steps
  if (process.platform === 'darwin') {
    steps = buildApplySteps('darwin', { dst: process.env.ORAY_UPDATE_DST || '/Applications/OrayChat.app', appPath: st.appPath, pid: pid })
  } else if (process.platform === 'win32') {
    // Windows 无 /bin/bash：写 cmd 批处理 helper——等待本进程退出（释放 exe 句柄）
    // 后静默安装，NSIS /S 自带完成重启。未实机验证（首次跨平台测试重点纠错项）。
    const helper = path.join(userDataDir(), 'staging', 'update-helper.cmd')
    fs.writeFileSync(helper, [
      '@echo off',
      'rem OrayChat 换装 helper（自动生成 v' + version + '）',
      'for /l %%i in (1,1,120) do (tasklist /FI "PID eq ' + pid + '" 2>nul | find "' + pid + '" >nul && ping -n 2 127.0.0.1 >nul)',
      'ping -n 2 127.0.0.1 >nul',
      '"' + st.installerPath + '" /S',
    ].join('\r\n'))
    const child = spawn('cmd.exe', ['/c', helper], { detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true, helper: helper }
  } else {
    steps = buildApplySteps('linux', { dst: process.env.ORAY_UPDATE_DST || process.execPath, appPath: st.appPath, pid: pid })
  }
  const helper = path.join(userDataDir(), 'staging', 'update-helper.sh')
  fs.writeFileSync(helper, ['#!/bin/bash', '# OrayChat 换装 helper（自动生成 v' + version + '）'].concat(steps).join('\n'), { mode: 0o755 })
  const child = spawn('/bin/bash', [helper], { detached: true, stdio: 'ignore' })
  child.unref()
  return { ok: true, helper: helper }
}

// 清单资产 URL：CI 签名清单里只有 name/size/sha256/fid——必须在这里补下载地址。
// 缺失时 downloadAssetFromGitHub fetch(undefined) 静默失败、整条兜底链路空转
// （2026-10-08 实机测试发现）。
// ⚠️ 两个约束实测得出：①url 不能挂清单对象上过 IPC——structured clone 丢非枚举
//   属性，普通枚举属性又会进 manifestBytes 序列化破坏验签 → 用 fid 映射表在
//   main 进程内部传递；②API 未认证限流 60/h，重试必须有节流（配合渲染层退避）。
function assetDownloadUrl(asset, rel) {
  if (asset.url || asset.browser_download_url) return asset.url || asset.browser_download_url
  const apiAsset = (rel.assets || []).find((a) => a.name === asset.name)
  if (apiAsset?.browser_download_url) return apiAsset.browser_download_url
  return `https://github.com/rogerhik999-arch/OrayChat/releases/download/${rel.tag_name}/${asset.name}`
}
const ghAssetUrlByFid = new Map() // fid → 下载地址（githubFetchManifest 时填充）

// GitHub 兜底（主进程下载，绕开渲染层 CSP；写进 files/<fid> 供 filex/staging 复用）
async function githubFetchManifest() {
  const res = await xfetch('https://api.github.com/repos/rogerhik999-arch/OrayChat/releases/latest', { headers: { 'User-Agent': 'oraychat-updater' } })
  if (!res.ok) throw new Error('releases/latest ' + res.status)
  const rel = await res.json()
  const mAsset = (rel.assets || []).find((a) => a.name === 'manifest.json')
  if (!mAsset) throw new Error('最新 Release 无签名清单（分布式更新未启用或 CI 跳过）')
  const m = await (await xfetch(mAsset.browser_download_url, { headers: { 'User-Agent': 'oraychat-updater' } })).json()
  const sigAsset = (rel.assets || []).find((a) => a.name === 'manifest.sig')
  if (sigAsset) m.sig = (await (await xfetch(sigAsset.browser_download_url, { headers: { 'User-Agent': 'oraychat-updater' } })).text()).trim()
  for (const k of Object.keys(m.assets || {})) ghAssetUrlByFid.set(m.assets[k].fid, assetDownloadUrl(m.assets[k], rel))
  return m
}

async function githubDownloadAsset(asset) {
  const url = asset.url || asset.browser_download_url || ghAssetUrlByFid.get(asset.fid)
  if (!url) throw new Error('资产无下载地址（清单未附 URL 且非本次 API 结果）')
  const res = await xfetch(url, { headers: { 'User-Agent': 'oraychat-updater' } })
  if (!res.ok) throw new Error('资产下载 ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  const dir = filesDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, asset.fid), buf)
  return { size: buf.length }
}

// 回滚（M2）：恢复 dst.bak（macOS 由 main.js 生成 rollback.sh；此函数供 IPC 调试）
async function rollback() {
  if (process.platform !== 'darwin') return { ok: false, err: 'M2 平台回滚走启动簿记' }
  const dst = '/Applications/OrayChat.app'
  if (!fs.existsSync(dst + '.bak')) return { ok: false, err: '无备份可回滚' }
  execFileSync('ditto', [dst + '.bak', dst])
  return { ok: true }
}

let quitCb = null
function registerIpc(cb) { quitCb = cb }
function quitForUpdate() {
  try { quitCb && quitCb() } catch { app.exit(0) }
}

module.exports = { registerIpc, quitForUpdate, stage, apply, rollback, githubFetchManifest, githubDownloadAsset, buildApplySteps, state }
