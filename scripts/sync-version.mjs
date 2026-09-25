// 版本号同步：package.json 是单一事实来源
//   - android/app/build.gradle  → versionName / versionCode
//   - ios/App/App/Info.plist    → CFBundleShortVersionString / CFBundleVersion
// versionCode = major*10000 + minor*100 + patch（SemVer 递增 ⇒ 单调递增）
// 用法：node scripts/sync-version.mjs   （在 npm version / 发布前由 CI 调用）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const [maj, min, patch] = version.replace(/-.*$/, '').split('.').map(Number)
const versionCode = maj * 10000 + min * 100 + patch

let touched = []

// ---- Android ----
const gradlePath = path.join(ROOT, 'android', 'app', 'build.gradle')
if (fs.existsSync(gradlePath)) {
  let g = fs.readFileSync(gradlePath, 'utf8')
  g = g.replace(/versionCode \d+/g, `versionCode ${versionCode}`)
  g = g.replace(/versionName "[^"]*"/g, `versionName "${version}"`)
  fs.writeFileSync(gradlePath, g)
  touched.push('android/app/build.gradle')
}

// ---- iOS ----
const plistPath = path.join(ROOT, 'ios', 'App', 'App', 'Info.plist')
if (fs.existsSync(plistPath)) {
  let p = fs.readFileSync(plistPath, 'utf8')
  p = p.replace(/(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${version}$2`)
  p = p.replace(/(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${versionCode}$2`)
  fs.writeFileSync(plistPath, p)
  touched.push('ios/App/App/Info.plist')
}

console.log(`sync-version: ${version} (versionCode=${versionCode}) → [${touched.join(', ') || '平台目录尚未生成，跳过'}]`)
