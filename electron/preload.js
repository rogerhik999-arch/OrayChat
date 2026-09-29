// 预加载脚本：以最小暴露面把主进程能力带给渲染层（contextIsolation 开启）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('oray', {
  // 配置与启动参数
  getConfig: () => ipcRenderer.invoke('config:get'),
  getLaunchArgs: () => ipcRenderer.invoke('launch-args:get'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  openSettings: () => ipcRenderer.invoke('settings:open'),

  // 身份密钥持久化
  loadIdentity: (username) => ipcRenderer.invoke('identity:load', username),
  saveIdentity: (username, json) => ipcRenderer.invoke('identity:save', username, json),
  listIdentities: () => ipcRenderer.invoke('identity:list'),

  // 本地 KV 状态（主进程文件持久化，可靠落盘）
  kvGet: (key) => ipcRenderer.invoke('kv:get', key),
  kvSet: (key, val) => ipcRenderer.invoke('kv:set', key, val),

  // 文件传输存储层（filex io 适配器：分片落盘/位图/校验/读取/另存）
  fxState: (fid, meta) => ipcRenderer.invoke('fx:state', fid, meta),
  fxWrite: (fid, i, cs, bytes) => ipcRenderer.invoke('fx:write', fid, i, cs, bytes),
  fxFinalize: (fid, shaHex, name) => ipcRenderer.invoke('fx:finalize', fid, shaHex, name),
  fxRead: (fid) => ipcRenderer.invoke('fx:read', fid),
  fxSave: (fid, name) => ipcRenderer.invoke('fx:save', fid, name),
  fxOpen: (fid) => ipcRenderer.invoke('fx:open', fid),
  fxAbort: (fid) => ipcRenderer.invoke('fx:abort', fid),
  fxReadPath: (p) => ipcRenderer.invoke('fx:readPath', p),

  // 测试/诊断
  // 未读与通知
  setUnread: (n) => ipcRenderer.send('unread:update', n),
  notifyMsg: ({ title, body, peerKey }) => ipcRenderer.send('notify:msg', { title, body, peerKey }),

  botLog: (line) => ipcRenderer.send('bot:log', line),
  botExit: (code) => ipcRenderer.send('bot:exit', code),
  captureWindow: () => ipcRenderer.invoke('win:capture'),
  closeWindow: () => ipcRenderer.send('win:close'),
  quit: () => ipcRenderer.invoke('app:quit'),

  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
})
