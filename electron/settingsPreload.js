// 设置窗口预加载：settings.html 专用（contextIsolation 开启）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings:get'),
  setUserConfig: (cfg) => ipcRenderer.invoke('settings:set-user-config', cfg),
  setTrayEnabled: (on) => ipcRenderer.invoke('settings:set-tray-enabled', on),
  clearData: (kind, room) => ipcRenderer.invoke('settings:clear-data', kind, room),
  listRooms: () => ipcRenderer.invoke('settings:list-rooms'),
  openMainWindow: () => ipcRenderer.invoke('settings:open-main'),
  // 安全码列表：从主窗口身份推导需要 crypto——简化为展示身份列表 + 指纹由主窗口页面呈现
})
