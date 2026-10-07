// 设置窗口预加载：settings.html 专用（contextIsolation 开启）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings:get'),
  setUserConfig: (cfg) => ipcRenderer.invoke('settings:set-user-config', cfg),
  setTrayEnabled: (on) => ipcRenderer.invoke('settings:set-tray-enabled', on),
  clearData: (kind, room) => ipcRenderer.invoke('settings:clear-data', kind, room),
  listRooms: () => ipcRenderer.invoke('settings:list-rooms'),
  health: () => ipcRenderer.invoke('settings:health'),
  updater: () => ipcRenderer.invoke('settings:updater'),
  updaterSetCfg: (cfg) => ipcRenderer.invoke('settings:updater-cfg-set', cfg),
  openMainWindow: () => ipcRenderer.invoke('settings:open-main'),
  // 中继服务模式（v1.23.0；desktop 专用——mobile 无此预加载即不显示该区块）
  hubStart: (opts) => ipcRenderer.invoke('hub:start', opts),
  hubStop: () => ipcRenderer.invoke('hub:stop'),
  hubStatus: () => ipcRenderer.invoke('hub:status'),
  hubPersist: (hubCfg) => ipcRenderer.invoke('hub:persist', hubCfg),
  onHubEvent: (fn) => { ipcRenderer.on('hub:event', (_e, ev) => fn(ev)) },
  // 命名隧道四步向导（v1.24.0）：授权 → 创建 → 绑域名 → 启动稳定服务（app 全托管）
  hubLogin: () => ipcRenderer.invoke('hub:login'),
  hubCreateTunnel: (name) => ipcRenderer.invoke('hub:create-tunnel', name),
  hubRouteDns: (name, hostname) => ipcRenderer.invoke('hub:route-dns', name, hostname),
  hubStartNamed: (cfg) => ipcRenderer.invoke('hub:start-named', cfg),
  hubStopTunnel: () => ipcRenderer.invoke('hub:tunnel-stop'),
  hubVerify: (target) => ipcRenderer.invoke('hub:verify', target),
  // 安全码列表：从主窗口身份推导需要 crypto——简化为展示身份列表 + 指纹由主窗口页面呈现
})
