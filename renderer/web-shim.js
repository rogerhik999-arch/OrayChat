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

    botLog: (line) => console.log(line),
    botExit: (code) => console.log(`[botExit] ${code}`),
    captureWindow: async () => null,
    quit: () => { /* Web 版无退出概念 */ },
  }
})()
