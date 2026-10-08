// 设置页截图工具的 stub 预载：提供与 settingsPreload 同形的 window.settings（全假数据）
// 用途：tools/shot-settings.mjs 渲染 settings.html 两种宽度并导出 PNG，供 UI 自检
const { contextBridge } = require('electron')
const now = Date.now()
const cfg = {
  defaultRoom: 'oraychat-hall',
  stunUrls: ['stun:stun.l.google.com:19302'],
  turnServers: [{ urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }],
  relayBrokers: ['wss://mqtt.example.com', 'wss://broker-cn.emqx.io:8084/mqtt'],
  sessionResume: true,
  hub: { enabled: true, port: 48883, mode: 'named', name: 'oraychat-hub', hostname: 'mqtt.example.com' },
}
contextBridge.exposeInMainWorld('settings', {
  get: async () => ({ userConfig: cfg, trayEnabled: true, version: '1.29.0', profile: 'dev', identities: ['Roger-Mac'] }),
  setUserConfig: async () => true,
  setTrayEnabled: async () => true,
  clearData: async () => 3,
  listRooms: async () => ['oraychat-hall', 'family'],
  health: async () => [0, 1, 2, 3, 4].map((i) => ({
    t: now - (5 - i) * 600000, heap: 180 + i * 3, blobs: 20 + i, dom: 320 + i * 2,
    inRate: 2 + (i % 3), drops: i === 2 ? 1 : 0, linksAlive: 2, linksAll: 2, ready: 2, wd: i === 3 ? 1 : 0,
  })),
  updater: async () => ({
    status: { version: '1.29.0', phase: 'idle', policy: 'download-prompt', source: 'peers-first', stagedOk: false, fails: 0, knownPkg: { v: '1.30.0', ts: now - 3600000 } },
    cfg: { policy: 'download-prompt', source: 'peers-first' },
  }),
  updaterApply: async () => ({}),
  updaterSetCfg: async () => true,
  openMainWindow: async () => {},
  hubStart: async () => ({ ok: true }),
  hubStop: async () => ({ ok: true }),
  hubStatus: async () => ({
    running: true, port: 48883, mode: 'named', tunnelUrl: 'wss://mqtt.example.com', registered: true,
    clients: 3, certReady: true, name: 'oraychat-hub', hostname: 'mqtt.example.com',
    publicUrl: 'wss://mqtt.example.com', token: 'tok-demo-9f2c',
    memberList: [{ name: 'FengGpd', fp: 'a1b2c3d4', links: 1 }, { name: '3070', fp: 'e5f6a7b8', links: 2 }],
    log: ['[HUB] relay started (named mode)', '[HUB] edge connected'],
  }),
  hubPersist: async () => true,
  onHubEvent: () => {},
  hubLogin: async () => ({ ok: true }),
  hubCreateTunnel: async () => ({ ok: true }),
  hubRouteDns: async () => ({ ok: true }),
  hubStartNamed: async () => ({ ok: true }),
  hubStopTunnel: async () => ({ ok: true }),
  hubVerify: async () => ({ ok: true, ms: 42 }),
})
