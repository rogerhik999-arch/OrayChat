// 设置窗口逻辑：加载/保存配置、清空数据、关于信息
const $ = (id) => document.getElementById(id)
const toast = (msg) => {
  const t = $('toast')
  t.textContent = msg
  t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), 1800)
}

// 内置默认（与 renderer/src/net.mjs DEFAULT_CONFIG 保持一致；展示用）
const DEFAULTS = {
  stunUrls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478', 'stun:stun.miwifi.com:3478'],
  turnServers: [
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  relayBrokers: ['wss://broker-cn.emqx.io:8084/mqtt', 'wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt'],
  defaultRoom: 'oraychat-hall',
}

let currentUserConfig = {}

async function load() {
  const info = await window.settings.get()
  const cfg = { ...DEFAULTS, ...(info.userConfig || {}) }
  currentUserConfig = info.userConfig || {}

  $('defaultRoom').value = cfg.defaultRoom || ''
  $('stunUrls').value = (cfg.stunUrls || []).join('\n')
  $('turnServers').value = JSON.stringify(cfg.turnServers || [], null, 1)
  $('relayBrokers').value = (cfg.relayBrokers || []).join('\n')
  $('trayEnabled').checked = info.trayEnabled !== false

  $('aboutVersion').textContent = `v${info.version}`
  $('aboutProfile').textContent = info.profile
  $('aboutIdentities').textContent = (info.identities || []).join('、') || '（本机暂无）'

  const rooms = await window.settings.listRooms()
  const sel = $('roomSelect')
  sel.innerHTML = ''
  for (const r of rooms) {
    const o = document.createElement('option')
    o.value = r
    o.textContent = r
    sel.appendChild(o)
  }
  if (!rooms.length) {
    const o = document.createElement('option')
    o.textContent = '（本机暂无聊天记录）'
    sel.appendChild(o)
  }
}

function collectNetwork() {
  const stunUrls = $('stunUrls').value.split('\n').map((x) => x.trim()).filter(Boolean)
  let turnServers
  try {
    turnServers = JSON.parse($('turnServers').value || '[]')
    if (!Array.isArray(turnServers)) throw new Error('TURN 必须是 JSON 数组')
  } catch (e) {
    toast(`TURN 配置错误：${e.message}`)
    return null
  }
  const relayBrokers = $('relayBrokers').value.split('\n').map((x) => x.trim()).filter(Boolean)
  return { stunUrls, turnServers, relayBrokers }
}

$('saveGeneral').onclick = async () => {
  const room = $('defaultRoom').value.trim() || DEFAULTS.defaultRoom
  const merged = { ...currentUserConfig, defaultRoom: room }
  await window.settings.setUserConfig(merged)
  await window.settings.setTrayEnabled($('trayEnabled').checked)
  toast('已保存（重启应用后全部生效）')
}

$('saveNetwork').onclick = async () => {
  const net = collectNetwork()
  if (!net) return
  const merged = { ...currentUserConfig, ...net }
  await window.settings.setUserConfig(merged)
  toast('已保存（重启应用后生效）')
}

$('clearLogin').onclick = async () => {
  const n = await window.settings.clearData('login-history')
  toast(n ? `已清空 ${n} 条登录历史` : '登录历史已为空')
}

$('clearRoom').onclick = async () => {
  const room = $('roomSelect').value
  if (!room || room.startsWith('（')) { toast('没有可清空的房间记录'); return }
  const n = await window.settings.clearData('room-log', room)
  toast(n ? `已清空房间「${room}」的本机聊天记录` : '清空失败')
  load()
}

$('openMain').onclick = () => window.settings.openMainWindow()

load().catch((e) => console.error(e))
