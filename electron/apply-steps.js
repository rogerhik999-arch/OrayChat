// 换装步骤生成（纯函数、零依赖——node 单测直接可测；updater.js 引用执行）。
// bash 系列（mac/linux）：全程日志回显 staging/update-helper.log——"换装没发生"
// 类问题从此有第一手证据（2026-10-11 用户实报：1.30.3 退出后未更新，旧 helper
// 零日志无从归因）。
function buildApplySteps(platform, opts) {
  const dst = opts.dst
  const pid = opts.pid
  const logPath = opts.logPath || '/dev/null'
  const common = [
    'exec >> "' + logPath + '" 2>&1',
    'echo "[helper $(date)] start v=' + (opts.version || '') + ' pid=' + pid + '"',
    'for i in $(seq 1 120); do kill -0 ' + pid + ' 2>/dev/null || break; sleep 0.5; done',
    'sleep 1',
    'echo "[helper] app exited, applying"',
  ]
  if (platform === 'darwin') {
    return common.concat([
      'rm -rf "' + dst + '.bak"',
      '[ -d "' + dst + '" ] && ditto "' + dst + '" "' + dst + '.bak"',
      'rm -rf "' + dst + '"',
      'ditto "' + opts.appPath + '" "' + dst + '"',
      'echo "[helper] applied, launching"',
      'sleep 0.5',
      'open "' + dst + '"',
      'echo "[helper] done"',
    ])
  }
  // linux：AppImage 原子替换自身（mv 同分区原子）
  return common.concat([
    '[ -f "' + dst + '" ] && cp "' + dst + '" "' + dst + '.bak"',
    'cp "' + opts.appPath + '" "' + dst + '.new"',
    'chmod +x "' + dst + '.new"',
    'mv -f "' + dst + '.new" "' + dst + '"',
    'echo "[helper] applied, launching"',
    '(cd "$(dirname "' + dst + '")" && nohup "$(basename "' + dst + '")" >/dev/null 2>&1 &)',
    'echo "[helper] done"',
  ])
}

// Windows cmd 版（纯 ASCII——中文在 GBK 代码页是乱码；label 等待循环语法最简；
// 每步日志回显；装完按探测路径拉起新版——NSIS /S 不会自动启动应用）。
// scope：旧装在 Program Files（per-machine）→ /allusers，否则 /currentuser——
// 范围装错会双份安装，快捷方式仍指旧版（表现为"更新了却还是旧版"）。
function buildWinCmd(opts) {
  const pid = opts.pid
  const logPath = opts.logPath
  const allusers = opts.allUsers ? ' /allusers' : ' /currentuser'
  const lines = [
    '@echo off',
    `echo [%date% %time%] helper start v=${opts.version || ''} pid=${pid} >> "${logPath}"`,
    ':wait',
    `tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul`,
    'if not errorlevel 1 (',
    '  timeout /t 2 /nobreak >nul',
    '  goto wait',
    ')',
    `echo [%date% %time%] app exited, installing >> "${logPath}"`,
    `"${opts.installerPath}"${allusers} >> "${logPath}" 2>&1`,
    `echo [%date% %time%] install errorlevel=%errorlevel%, launching >> "${logPath}"`,
  ]
  for (const p of opts.launchPaths || []) lines.push(`if exist "${p}" (start "" "${p}" & goto :done)`)
  lines.push(':done')
  lines.push(`echo [%date% %time%] helper done >> "${logPath}"`)
  return lines.join('\r\n')
}

module.exports = { buildApplySteps, buildWinCmd }
