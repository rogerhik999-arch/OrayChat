// 跨平台强杀测试拉起的 Electron 进程。
// Windows 上 execSync 走 cmd.exe，没有 pkill（之前静默失败导致旧实例存活、
// 新实例撞单实例锁直接退出）；且 taskkill /T 才能连带 renderer/GPU 子进程。
import { execSync } from 'node:child_process'

export function killTree(proc) {
  const pid = proc?.pid
  if (!pid) return
  if (process.platform === 'win32') {
    try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* 已退出 */ }
  } else {
    try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
}

export function killTrees(procs) {
  for (const p of procs) killTree(p)
}
