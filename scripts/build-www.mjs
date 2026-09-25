// 构建 Capacitor 的 www/ 目录（renderer 的纯 Web 子集，供 Android/iOS WebView 加载）
// 用法：node scripts/build-www.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const WWW = path.join(ROOT, 'www')

fs.rmSync(WWW, { recursive: true, force: true })
fs.mkdirSync(path.join(WWW, 'dist'), { recursive: true })
for (const f of ['index.html', 'style.css', 'web-shim.js']) {
  fs.copyFileSync(path.join(ROOT, 'renderer', f), path.join(WWW, f))
}
fs.copyFileSync(path.join(ROOT, 'renderer', 'dist', 'app.bundle.js'), path.join(WWW, 'dist', 'app.bundle.js'))
console.log(`www/ 构建完成：${fs.readdirSync(WWW).join(', ')}`)
