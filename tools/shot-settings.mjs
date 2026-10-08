// 设置页 UI 自检截图：stub 数据渲染 settings.html，桌面（880px 侧栏布局）+ 手机（412px chips 布局）
// 用法：npx electron tools/shot-settings.mjs   输出 /tmp/oc-set-*.png
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const snap = async (win, file) => {
  const img = await win.webContents.capturePage()
  fs.writeFileSync(file, img.toPNG())
  console.log('shot →', file)
}
const run = (win, code) => win.webContents.executeJavaScript(code)
const navState = (win) => run(win, `[...document.querySelectorAll('.nav-item')].map((b) => b.dataset.cat + '=' + (b.style.display === 'none' ? 'hide' : 'show')).join(' ')`)
const clickCat = (win, cat) => run(win, `[...document.querySelectorAll('.nav-item')].find((b) => b.dataset.cat === '${cat}').click()`)

app.whenReady().then(async () => {
  const preload = path.join(ROOT, 'tools', 'shot-settings-preload.cjs')
  const url = 'file://' + path.join(ROOT, 'renderer', 'settings.html')
  const mk = async (w, h, x) => {
    const win = new BrowserWindow({ width: w, height: h, x, y: 40, show: true, webPreferences: { preload, contextIsolation: true } })
    await win.loadURL(url)
    return win
  }
  const desktop = await mk(880, 760, 60)
  const mobile = await mk(412, 880, 980)
  await sleep(1200)

  // 导航项可见性核对：桌面 8 项全显；手机应隐藏 中继/更新/健康（无对应能力）
  console.log('DESKTOP NAV:', await navState(desktop))
  console.log('MOBILE NAV :', await navState(mobile))

  await snap(desktop, '/tmp/oc-set-desktop-all.png')
  await clickCat(desktop, 'hub')
  await sleep(250)
  await snap(desktop, '/tmp/oc-set-desktop-hub.png')
  await clickCat(desktop, 'network')
  await sleep(250)
  await snap(desktop, '/tmp/oc-set-desktop-network.png')

  await snap(mobile, '/tmp/oc-set-mobile-all.png')
  await clickCat(mobile, 'general')
  await sleep(250)
  console.log('MOBILE AFTER general click:', await navState(mobile))
  console.log('MOBILE NAV HTML:', await run(mobile, `document.getElementById('settingsNav').outerHTML.slice(0, 600)`))
  await snap(mobile, '/tmp/oc-set-mobile-general.png')

  // 可用性隐藏核对：模拟手机 web-shim（无 hub/更新/健康能力）→ 对应导航项应隐藏、卡片不可见
  console.log('HIDE-CHECK :', await run(desktop, `['hubCard','updateCard','healthCard'].forEach((id) => document.getElementById(id).dataset.ready = '0'); applyNav(); [...document.querySelectorAll('.nav-item')].map((b) => b.dataset.cat + '=' + (b.style.display === 'none' ? 'hide' : 'show')).join(' ') + ' | hubCard.display=' + document.getElementById('hubCard').style.display`))
  app.quit()
}).catch((e) => { console.error(e); app.exit(1) })
