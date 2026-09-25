// 预加载脚本：以最小暴露面把主进程能力带给渲染层（contextIsolation 开启）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('oray', {
  // 配置与启动参数
  getConfig: () => ipcRenderer.invoke('config:get'),
  getLaunchArgs: () => ipcRenderer.invoke('launch-args:get'),
  appInfo: () => ipcRenderer.invoke('app:info'),

  // 身份密钥持久化
  loadIdentity: (username) => ipcRenderer.invoke('identity:load', username),
  saveIdentity: (username, json) => ipcRenderer.invoke('identity:save', username, json),
  listIdentities: () => ipcRenderer.invoke('identity:list'),

  // 本地 KV 状态（主进程文件持久化，可靠落盘）
  kvGet: (key) => ipcRenderer.invoke('kv:get', key),
  kvSet: (key, val) => ipcRenderer.invoke('kv:set', key, val),

  // 测试/诊断
  botLog: (line) => ipcRenderer.send('bot:log', line),
  botExit: (code) => ipcRenderer.send('bot:exit', code),
  captureWindow: () => ipcRenderer.invoke('win:capture'),
  quit: () => ipcRenderer.invoke('app:quit'),

  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
})
