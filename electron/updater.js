// 分布式自动更新——主进程换装（docs/update-plan.md M1，macOS 先行）
// 职责：把 filex 拉到的包（userData/files/<fid>）解包校验进 staging；
// 应用时 spawn 脱离的 helper 脚本（等主进程退出→备份旧版→ditto 换装→重启）。
// Windows NSIS / Linux AppImage 在 M2；Android 走 M3 系统安装器。
const { app, ipcMain } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const state = { staged: null } // { version, appPath }

function userDataDir() { return app.getPath('userData') }

// files/<fid> 可能带原始扩展名（filex finalize 习惯）：精确名 → 前缀匹配
function findPkgFile(fid) {
  const dir = path.join(userDataDir(), 'files')
  const exact = path.join(dir, fid)
  if (fs.existsSync(exact)) return exact
  try {
    const hit = fs.readdirSync(dir).find((f) => f.startsWith(fid))
    return hit ? path.join(dir, hit) : null
  } catch { return null }
}

// staging：解包 + 自检（Info.plist 版本必须等于清单版本）
async function stage({ version, fid }) {
  if (process.platform !== 'darwin') return { ok: false, err: 'M2 平台' }
  const src = findPkgFile(fid)
  if (!src) return { ok: false, err: `包不在本机（files/${fid}）` }
  const staging = path.join(userDataDir(), 'staging', version)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    execFileSync('unzip', ['-q', '-o', src, '-d', staging], { timeout: 120000 })
  } catch (e) {
    return { ok: false, err: `解包失败: ${e.message}` }
  }
  const appPath = path.join(staging, 'OrayChat.app')
  const plist = path.join(appPath, 'Contents', 'Info.plist')
  if (!fs.existsSync(plist)) return { ok: false, err: '包内无 OrayChat.app（结构不符）' }
  let stagedVer = ''
  try {
    stagedVer = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]).toString().trim()
  } catch { /* plutil 失败不阻断（结构已核对） */ }
  if (stagedVer && stagedVer !== version) return { ok: false, err: `包内版本 ${stagedVer} ≠ 清单 ${version}` }
  state.staged = { version, appPath }
  return { ok: true, version, appPath }
}

// 应用：spawn 脱离 helper（等本进程退出→备份→ditto→重启），随后退出主进程。
// immediate=true（全自动档）/ false（quit-install：由 before-quit 触发同一函数）。
async function apply({ version, immediate }) {
  const st = state.staged && state.staged.version === version ? state.staged : null
  if (!st) return { ok: false, err: '尚未 staging（先 stage）' }
  const helper = path.join(userDataDir(), 'staging', 'update-helper.sh')
  const dst = process.env.ORAY_UPDATE_DST || '/Applications/OrayChat.app'
  const pid = process.pid
  fs.writeFileSync(helper, [
    '#!/bin/bash',
    `# OrayChat 换装 helper（自动生成）：等 ${pid} 退出 → 备份 → ditto → 重启`,
    `for i in $(seq 1 120); do kill -0 ${pid} 2>/dev/null || break; sleep 0.5; done`,
    'sleep 1',
    `rm -rf "${dst}.bak"`,
    `[ -d "${dst}" ] && ditto "${dst}" "${dst}.bak"`,
    `rm -rf "${dst}"`,
    `ditto "${st.appPath}" "${dst}"`,
    'sleep 0.5',
    ...(process.env.ORAY_UPDATE_NO_LAUNCH ? [] : [`open "${dst}"`]),
  ].join('\n'), { mode: 0o755 })
  const child = spawn('/bin/bash', [helper], { detached: true, stdio: 'ignore' })
  child.unref()
  return { ok: true, helper }
}

// quit 回调由 main.js 注入（IPC 注册集中在 main.js，避免重复通道注册抛错）
let quitCb = null
function registerIpc(cb) { quitCb = cb }
function quitForUpdate() {
  try { quitCb && quitCb() } catch { app.exit(0) }
}

module.exports = { registerIpc, quitForUpdate, stage, apply, state }
