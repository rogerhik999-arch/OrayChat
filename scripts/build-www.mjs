// 构建 Capacitor 的 www/ 目录（renderer 的纯 Web 子集，供 Android/iOS WebView 加载）
// 用法：node scripts/build-www.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const WWW = path.join(ROOT, 'www')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

fs.rmSync(WWW, { recursive: true, force: true })
fs.mkdirSync(path.join(WWW, 'dist'), { recursive: true })
for (const f of ['index.html', 'style.css', 'web-shim.js', 'settings.html', 'settings.js']) {
  let content = fs.readFileSync(path.join(ROOT, 'renderer', f), 'utf8')
  // mobile 端真实版本注入（web-shim 无 electron appInfo，曾硬编码导致登录页/设置页
  // 版本号与实际包版本脱节）
  content = content.replaceAll('__APP_VERSION__', VERSION)
  fs.writeFileSync(path.join(WWW, f), content)
}
fs.copyFileSync(path.join(ROOT, 'renderer', 'dist', 'app.bundle.js'), path.join(WWW, 'dist', 'app.bundle.js'))
console.log(`www/ 构建完成：${fs.readdirSync(WWW).join(', ')}`)
