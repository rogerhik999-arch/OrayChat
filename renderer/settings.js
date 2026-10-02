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
  window.__userConfig = info.userConfig || {} // hub 向导回填用

  $('defaultRoom').value = cfg.defaultRoom || ''
  $('stunUrls').value = (cfg.stunUrls || []).join('\n')
  $('turnServers').value = JSON.stringify(cfg.turnServers || [], null, 1)
  $('relayBrokers').value = (cfg.relayBrokers || []).join('\n')
  $('trayEnabled').checked = info.trayEnabled !== false
  $('sessionResume').checked = cfg.sessionResume !== false

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
  merged.sessionResume = $('sessionResume').checked
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

// ---------- 中继服务模式（desktop 专用；无 hub 预加载即隐藏整卡） ----------
function hubRender(st) {
  const state = st?.running ? '运行中' : '未运行'
  const tunnel = st?.tunnelUrl ? ` · 隧道 ${st.tunnelUrl}` : (st?.tunnelProc ? ' · 隧道建立中…' : '')
  $('hubState').textContent = `状态：${state}（本机端口 ${st?.port || '—'}${tunnel}）· 成员连接 ${st?.clients ?? 0}`
  $('hubLog').textContent = (st?.log || []).join('\n')
  $('hubTunnelBtn').disabled = !st?.running
  $('hubStopBtn').disabled = !st?.running
}
function hubCopyText() {
  const pub = $('hubPublicUrl').value.trim()
  const st = window.__hubSnap
  if (pub) return pub
  if (st?.tunnelUrl) return st.tunnelUrl
  if (st?.running) return `ws://127.0.0.1:${st.port}/mqtt`
  return ''
}
if (window.settings.hubStart) {
  $('hubCard').style.display = ''
  window.__hubSnap = null
  const hubCfg = () => ({
    enabled: $('hubEnabled').checked,
    port: Number($('hubPort').value) || 48883,
    mode: window.__hubMode || 'off',
    name: $('hubTunnelName').value.trim() || 'oraychat-hub',
    hostname: $('hubHostname').value.trim(),
  })
  const persist = () => window.settings.hubPersist(hubCfg())
  const stepMark = (id, ok, text) => { const el = $(id); el.textContent = text || (ok ? '✓ 已完成' : '未完成'); el.style.color = ok ? 'var(--ok)' : 'var(--tx2)' }

  function hubRender(st) {
    hubRenderDom(st)
    // 向导四步状态
    stepMark('hubStep1State', st?.certReady)
    stepMark('hubStep2State', !!(st?.certReady && st?.name && $('hubTunnelName').value.trim() && window.__tunnelCreated), (st?.certReady && window.__tunnelCreated) ? `✓ ${st?.name || ''}` : undefined)
    stepMark('hubStep3State', !!st?.hostname, st?.hostname ? `✓ ${st.hostname}` : undefined)
    stepMark('hubStep4State', !!(st?.running && st?.mode === 'named' && st?.tunnelProc), (st?.running && st?.mode === 'named') ? (st.tunnelProc ? `✓ 运行中 ${st.tunnelUrl}` : '连接中…') : '未启动')
    $('hubStep1Btn').disabled = !!st?.certReady
    $('hubStep2Btn').disabled = !st?.certReady
    $('hubStep3Btn').disabled = !st?.certReady
    $('hubStep4Btn').disabled = !st?.certReady
  }
  function hubRenderDom(st) {
    window.__hubSnap = st // 测试按钮/复制按钮取运行时快照
    // 日志渲染是公共尾部：named 分支曾用提前返回把它短路（v1.24.4 日志"消失"）
    $('hubLog').textContent = (st?.log || []).join('\n')
    $('hubTunnelBtn').disabled = !st?.running
    $('hubStopBtn').disabled = !st?.running
    // 已接入成员（按身份指纹聚合；名字由主窗口推送映射，未知显示指纹前 8 位）
    const members = st?.memberList || []
    const memberText = members.length
      ? members.map((m) => `${m.name || '指纹 ' + m.fp}${m.links > 1 ? `（${m.links} 条链路）` : ''}`).join('、')
      : '（暂无）'
    const el = $('hubMembers')
    if (el) el.textContent = `已接入成员（${members.length}）：${memberText}`
    if (st?.running && st?.mode === 'named') {
      // registered = 已在边缘注册（真实可服务）；tunnelProc 只代表进程在跑
      $('hubState').textContent = `状态：运行中（本机端口 ${st?.port || '—'}）· ${st.registered ? '✓ 已连接 Cloudflare 边缘' : '⏳ 正在连接边缘…'} · 链路 ${st?.clients ?? 0}`
      return
    }
    const state = st?.running ? '运行中' : '未运行'
    const tunnel = st?.tunnelUrl ? ` · ${st.tunnelUrl}` : (st?.tunnelProc ? ' · 隧道建立中…' : '')
    $('hubState').textContent = `状态：${state}（本机端口 ${st?.port || '—'}${tunnel}）· 链路 ${st?.clients ?? 0}`
  }
  // 先从持久化配置回填（重启后向导字段暂存恢复；load() 异步未必先到，自行拉取），
  // 再叠加运行时状态
  const restoreSaved = (savedHub = {}) => {
    if (savedHub.port) $('hubPort').value = String(savedHub.port)
    if (savedHub.name) $('hubTunnelName').value = savedHub.name
    if (savedHub.hostname) { $('hubHostname').value = savedHub.hostname; if (!$('hubPublicUrl').value.trim()) $('hubPublicUrl').value = `wss://${savedHub.hostname}` }
    if (savedHub.mode) window.__hubMode = savedHub.mode
    if (savedHub.mode === 'named' && savedHub.name) window.__tunnelCreated = true
    if (window.__userConfig) window.__userConfig.hub = savedHub
    $('hubEnabled').checked = !!savedHub.enabled
  }
  window.settings.get().then((info) => restoreSaved((info.userConfig || {}).hub || {})).catch(() => {})
  window.settings.hubStatus().then((st) => {
    hubRender(st)
    if (st.running) $('hubEnabled').checked = true
    if (st.name) { $('hubTunnelName').value = st.name; window.__tunnelCreated = true }
    if (st.hostname) { $('hubHostname').value = st.hostname; if (!st.publicUrl) $('hubPublicUrl').value = `wss://${st.hostname}` }
    if (st.publicUrl) $('hubPublicUrl').value = st.publicUrl
    if (st.mode && st.mode !== 'off') window.__hubMode = st.mode
  })
  window.settings.onHubEvent?.((ev) => {
    if (ev.type === 'log') $('hubLog').textContent += `\n${ev.line}`
    if (ev.type === 'tunnel' && ev.url && !$('hubPublicUrl').value.trim()) $('hubPublicUrl').value = ev.url
    window.settings.hubStatus().then(hubRender)
  })
  $('hubStartBtn').onclick = async () => {
    const r = await window.settings.hubStart({ port: Number($('hubPort').value) || 48883, tunnel: 'off' })
    if (!r.ok) toast(`启动失败：${r.err}`)
    window.settings.hubStatus().then(hubRender)
  }
  $('hubStopBtn').onclick = async () => { await window.settings.hubStop(); window.settings.hubStatus().then(hubRender) }
  $('hubTunnelBtn').onclick = async () => {
    toast('正在启动 Cloudflare 快速隧道…')
    window.__hubMode = 'quick'
    const r = await window.settings.hubStart({ port: Number($('hubPort').value) || 48883, tunnel: 'quick' })
    if (!r.ok) toast(`启动失败：${r.err}`)
    persist()
    window.settings.hubStatus().then(hubRender)
  }
  // —— 稳定地址向导四步 ——
  $('hubStep1Btn').onclick = async () => {
    toast('正在打开浏览器授权…')
    const r = await window.settings.hubLogin()
    if (!r.ok) { toast(`授权失败：${r.err}`); return }
    toast(r.already ? '此前已完成授权' : '授权成功')
    window.settings.hubStatus().then(hubRender)
  }
  $('hubStep2Btn').onclick = async () => {
    const name = $('hubTunnelName').value.trim() || 'oraychat-hub'
    $('hubTunnelName').value = name
    toast(`正在创建隧道 ${name}…`)
    const r = await window.settings.hubCreateTunnel(name)
    if (!r.ok) { toast(`创建失败：${r.err}`); return }
    window.__tunnelCreated = true
    window.__hubMode = 'named'
    toast(r.already ? '隧道已存在（继续）' : '隧道创建成功')
    persist(); window.settings.hubStatus().then(hubRender)
  }
  $('hubStep3Btn').onclick = async () => {
    const name = $('hubTunnelName').value.trim() || 'oraychat-hub'
    const host = $('hubHostname').value.trim()
    if (!host) { toast('请先填写主机名（如 mqtt.example.com）'); return }
    toast(`正在绑定 ${host}…`)
    const r = await window.settings.hubRouteDns(name, host)
    if (!r.ok) { toast(`绑定失败：${r.err}`); return }
    window.__hubMode = 'named'
    $('hubPublicUrl').value = `wss://${host}`
    toast(r.already ? '域名记录已存在（继续）' : '域名绑定成功')
    persist(); window.settings.hubStatus().then(hubRender)
  }
  $('hubStep4Btn').onclick = async () => {
    const name = $('hubTunnelName').value.trim() || 'oraychat-hub'
    const host = $('hubHostname').value.trim()
    if (!host) { toast('请先完成第③步绑定域名'); return }
    toast('正在启动稳定服务…')
    window.__hubMode = 'named'
    const r = await window.settings.hubStartNamed({ name, hostname: host, port: Number($('hubPort').value) || 48883 })
    if (!r.ok) { toast(`启动失败：${r.err}`); return }
    $('hubEnabled').checked = true
    persist(); window.settings.hubStatus().then(hubRender)
  }
  $('hubTestBtn').onclick = async () => {
    const btn = $('hubTestBtn')
    const pub = $('hubPublicUrl').value.trim()
    const st = window.__hubSnap
    // 目标优先级：对外地址（完整公网链路：边缘→隧道→本机）> 运行中隧道地址 > 本机回环（只验中继本体）
    const target = pub || st?.tunnelUrl || (st?.running ? `ws://127.0.0.1:${st.port}/mqtt` : '')
    if (!target) { $('hubTestResult').textContent = '测试结果：✗ 无可用地址（先启动中继或填对外地址）'; return }
    btn.disabled = true
    $('hubTestResult').textContent = `测试中…（成员视角连接 ${target}）`
    const r = await window.settings.hubVerify(target)
    btn.disabled = false
    const line = r.ok
      ? `测试结果：✓ 可用（往返 ${r.ms}ms · ${target}${target === pub && pub ? ' · 完整公网链路' : ' · 本机链路'}）`
      : `测试结果：✗ 失败——${r.err}`
    $('hubTestResult').textContent = line
    $('hubLog').textContent += `\n[HUB] ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 接入测试 ${r.ok ? '通过' : '失败'}（${target}${r.ok ? `，${r.ms}ms` : ''}）${r.ok ? '' : '：' + r.err}`
    window.settings.hubStatus().then(hubRender)
  }
  $('hubCopyBtn').onclick = async () => {
    const text = hubCopyText()
    if (!text) { toast('中继未运行且未填对外地址'); return }
    try { await navigator.clipboard.writeText(text); toast(`已复制 ${text}`) } catch { toast(`接入地址：${text}`) }
  }
  $('hubEnabled').onchange = persist
  $('hubPort').onchange = persist
  $('hubTunnelName').onchange = persist
  $('hubHostname').onchange = persist
  $('hubPublicUrl').onchange = () => { window.__hubMode = window.__hubMode || 'external'; persist() }
}

load().catch((e) => console.error(e))
