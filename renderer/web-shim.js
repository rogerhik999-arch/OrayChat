// OrayChat Web 兼容层：在非 Electron 环境（Capacitor Android/iOS、纯浏览器）下
// 提供 window.oray 的等价实现。Electron 中 preload 已定义 window.oray，本文件自动让位。
// 持久化用 localStorage（WebView 生命周期内可靠；桌面端才用主进程文件 KV，因为要扛 SIGKILL）。
(function () {
  if (typeof window === 'undefined' || window.oray) return

  const DEFAULT_CONFIG = {
    defaultRoom: 'oraychat-hall',
    stunUrls: [
      'stun:stun.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
      'stun:stun.miwifi.com:3478',
    ],
    turnServers: [
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
    relayBrokers: [
      'wss://broker-cn.emqx.io:8084/mqtt',
      'wss://broker.emqx.io:8084/mqtt',
      'wss://test.mosquitto.org:8081/mqtt',
    ],
  }

  const ls = {
    get(key) { try { return localStorage.getItem(key) } catch { return null } },
    set(key, val) { try { val === null ? localStorage.removeItem(key) : localStorage.setItem(key, val) } catch { /* 忽略 */ } },
  }
  const kv = (key) => `oray-kv:${key}`

  window.oray = {
    platform: 'web',
    versions: { web: '1.0.0' },

    getConfig: async () => {
      try { return { ...DEFAULT_CONFIG, ...JSON.parse(ls.get('oray-config') || '{}') } } catch { return { ...DEFAULT_CONFIG } }
    },
    getLaunchArgs: async () => ({}),
    appInfo: async () => ({ version: '1.0.0', platform: 'web', profile: 'web' }),

    loadIdentity: async (username) => {
      try { return JSON.parse(ls.get(kv(`identity:${username}`))) || null } catch { return null }
    },
    saveIdentity: async (username, json) => { ls.set(kv(`identity:${username}`), JSON.stringify(json)); return true },
    listIdentities: async () => Object.keys(localStorage).filter((k) => k.startsWith('oray-kv:identity:')).map((k) => k.split('identity:')[1]),

    // 本地 KV（与桌面端 local-state.json 对应）：
    // localStorage 只能存字符串，对象值必须 JSON 序列化，否则读取端
    // Object.keys(字符串) 会把字符下标当键（手机端登录历史损坏的根因）
    kvGet: async (key) => {
      const raw = ls.get(kv(key))
      if (raw === null) return null
      try { return JSON.parse(raw) } catch { return raw } // 兼容历史裸字符串
    },
    kvSet: async (key, val) => {
      ls.set(kv(key), val === null || val === undefined ? null : JSON.stringify(val))
      return true
    },

    // 文件传输存储层（Web/WebView 内存版：分片存内存，完成后可下载/预览）
    fxState: async (fid, { n }) => {
      const s = (window.__orayFx = window.__orayFx || {})
      if (s[fid]?.have) return { have: [...s[fid].have] }
      return { have: new Array(Math.ceil(n / 8)).fill(0) }
    },
    fxWrite: async (fid, i, cs, bytes) => {
      const s = (window.__orayFx = window.__orayFx || {})
      const e = (s[fid] = s[fid] || { chunks: new Map(), have: [] })
      e.chunks.set(i, bytes)
      const bi = i >> 3
      while (e.have.length <= bi) e.have.push(0)
      e.have[bi] |= 1 << (i & 7)
      return true
    },
    fxFinalize: async (fid, shaHex, name, fin) => {
      const s = window.__orayFx || {}
      const e = s[fid]
      if (!e) return { ok: false, why: 'not-found' }
      const sorted = [...e.chunks.keys()].sort((a, b) => a - b)
      const total = sorted.reduce((acc, i) => acc + e.chunks.get(i).length, 0)
      const all = new Uint8Array(total)
      let off = 0
      for (const i of sorted) { all.set(e.chunks.get(i), off); off += e.chunks.get(i).length }
      const digest = await crypto.subtle.digest('SHA-256', all)
      const hexs = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
      if (hexs !== shaHex) return { ok: false, why: 'sha-mismatch' }
      e.bytes = all; e.name = name
      if (fin?.alg === 'deflate') {
        // P2-1 流压缩：整文件解压后终检原始哈希
        const stream = new Blob([all]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
        const raw = new Uint8Array(await new Response(stream).arrayBuffer())
        const rd = await crypto.subtle.digest('SHA-256', raw)
        const rhex = [...new Uint8Array(rd)].map((b) => b.toString(16).padStart(2, '0')).join('')
        if (rhex !== fin.rawSha) return { ok: false, why: 'raw-sha-mismatch' }
        e.bytes = raw
      }
      return { ok: true, path: `mem:${fid}` }
    },
    fxRead: async (fid) => {
      const e = (window.__orayFx || {})[fid]
      return e?.bytes || null
    },
    fxReadRange: async (fid, i, cs, len) => {
      const e = (window.__orayFx || {})[fid]
      if (!e?.chunks) {
        if (!e?.bytes) return null
        return e.bytes.slice(i * cs, i * cs + len)
      }
      const chunk = e.chunks.get(i)
      if (!chunk) return null
      return chunk.slice(0, len)
    },
    fxSave: async (fid, name) => {
      const e = (window.__orayFx || {})[fid]
      if (!e?.bytes) return { ok: false, why: 'not-found' }
      try {
        const url = URL.createObjectURL(new Blob([e.bytes]))
        const a = document.createElement('a')
        a.href = url; a.download = name || String(fid)
        document.body.appendChild(a); a.click(); a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 30000)
        return { ok: true, path: a.download }
      } catch (err) { return { ok: false, why: err.message } }
    },
    fxOpen: async (fid) => window.oray.fxSave(fid, (window.__orayFx || {})[fid]?.name),
    fxAbort: async (fid) => { delete (window.__orayFx || {})[fid]; return true },
    fxReadPath: async () => null, // WebView 无任意路径读取（bot 注入仅桌面端）

    setUnread: () => {},
    notifyMsg: () => { /* Web 版通知走 Notification API 由上层自理 */ },

    botLog: (line) => console.log(line),
    botExit: (code) => console.log(`[botExit] ${code}`),
    captureWindow: async () => null,
    quit: () => { /* Web 版无退出概念 */ },
  }
})()

// Capacitor/移动端：无独立设置窗口（BrowserWindow），以页面导航方式打开 settings.html
if (typeof window !== 'undefined' && window.oray && !window.oray.openSettings && window.oray.platform === 'web') {
  window.oray.openSettings = () => { location.href = 'settings.html' }
}

// 设置页的 Web 等价实现（settings.html 在 WebView 中直接导航打开时）
if (typeof window !== 'undefined' && !window.settings) {
  window.settings = {
    get: async () => {
      const userConfig = JSON.parse(localStorage.getItem('oray-config') || '{}')
      const identities = Object.keys(localStorage).filter((k) => k.startsWith('oray-kv:identity:')).map((k) => k.split('identity:')[1])
      return { userConfig, trayEnabled: true, version: '1.7.0', profile: 'mobile', identities, sessionResume: userConfig.sessionResume !== false }
    },
    setUserConfig: async (cfg) => { localStorage.setItem('oray-config', JSON.stringify(cfg)); return true },
    setTrayEnabled: async () => true, // 移动端无托盘
    clearData: async (kind, room) => {
      if (kind === 'login-history') {
        localStorage.removeItem('oray-kv:oc-login-history')
        return 1
      }
      if (kind === 'room-log' && room) {
        localStorage.removeItem(`oray-kv:oc-log2:${room}`)
        localStorage.removeItem(`oray-kv:oc-names:${room}`)
        return 1
      }
      return 0
    },
    listRooms: async () => Object.keys(localStorage).filter((k) => k.startsWith('oray-kv:oc-log2:')).map((k) => k.split('oc-log2:')[1]),
    openMainWindow: async () => { location.href = 'index.html' },
  }
}
