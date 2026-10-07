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
    mode: window.__hubMode || window.__savedHubMode || 'off',
    name: $('hubTunnelName').value.trim() || 'oraychat-hub',
    hostname: $('hubHostname').value.trim(),
    token: window.__hubSnap?.token || window.__savedHubToken || '',
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
    window.__hubSnap = st
    $('hubLog').textContent = (st?.log || []).join('\n')
    $('hubTunnelBtn').disabled = !st?.running
    $('hubStopBtn').disabled = !st?.running
    // 公网暴露 开/关 互斥：隧道进程在跑 → 显示「关闭公网暴露」
    const tunnelOn = !!(st?.tunnelProc || (st?.mode === 'named' && st?.tunnelUrl))
    const openBtn = $('hubTunnelBtn'), closeBtn = $('hubTunnelStopBtn')
    if (openBtn) openBtn.style.display = tunnelOn ? 'none' : ''
    if (closeBtn) closeBtn.style.display = tunnelOn ? '' : 'none'
    if (closeBtn) closeBtn.disabled = !st?.running
    // 已接入成员（按身份指纹聚合；名字由主窗口推送映射，未知显示指纹前 8 位）
    const members = st?.memberList || []
    const memberText = members.length
      ? members.map((m) => `${m.name || '指纹 ' + m.fp}${m.links > 1 ? `（${m.links} 条链路）` : ''}`).join('、')
      : '（暂无）'
    const el = $('hubMembers')
    if (el) el.textContent = `已接入成员（${members.length}）：${memberText}`
    // 公网暴露状态（明确三分：未暴露 / 快速隧道 / 稳定地址）
    const expose = $('hubExposeState')
    if (expose) {
      if (!st?.running) { expose.textContent = '中继未运行'; expose.style.color = 'var(--tx2)' }
      else if (st.mode === 'named' && st.tunnelUrl) { expose.textContent = `🟢 已暴露（稳定地址 ${st.tunnelUrl}${st.registered ? '，边缘已连接' : '，边缘连接中'}）`; expose.style.color = 'var(--ok)' }
      else if (st.tunnelUrl) { expose.textContent = `🟢 已暴露（快速隧道 ${st.tunnelUrl}，重启后地址会变）`; expose.style.color = 'var(--ok)' }
      else { expose.textContent = '🔴 未暴露公网——仅本机可用，远程成员无法接入（点右侧按钮一键暴露）'; expose.style.color = '#e05555' }
    }
    if (st?.running && st?.mode === 'named') {
      $('hubState').textContent = `状态：运行中（本机端口 ${st?.port || '—'}）· ${st.registered ? '✓ 已连接 Cloudflare 边缘' : '⏳ 正在连接边缘…'} · 链路 ${st?.clients ?? 0}`
    } else {
      const state = st?.running ? '运行中' : '未运行'
      const tunnel = st?.tunnelUrl ? ` · ${st.tunnelUrl}` : (st?.tunnelProc ? ' · 隧道建立中…' : '')
      $('hubState').textContent = `状态：${state}（本机端口 ${st?.port || '—'}${tunnel}）· 链路 ${st?.clients ?? 0}`
    }
    const tEl = $('hubTokenView')
    if (tEl) tEl.textContent = st?.token || '—'
  }
  // 先从持久化配置回填（重启后向导字段暂存恢复；load() 异步未必先到，自行拉取）
  const restoreSaved = (savedHub = {}) => {
    if (savedHub.port) $('hubPort').value = String(savedHub.port)
    if (savedHub.name) $('hubTunnelName').value = savedHub.name
    if (savedHub.hostname) { $('hubHostname').value = savedHub.hostname; if (!$('hubPublicUrl').value.trim()) $('hubPublicUrl').value = `wss://${savedHub.hostname}` }
    if (savedHub.mode) { window.__hubMode = savedHub.mode; window.__savedHubMode = savedHub.mode }
    if (savedHub.mode === 'named' && savedHub.name) window.__tunnelCreated = true
    if (window.__userConfig) window.__userConfig.hub = savedHub
    $('hubEnabled').checked = !!savedHub.enabled
  }
  window.settings.get().then((info) => restoreSaved((info.userConfig || {}).hub || {})).catch(() => {})

  // 健康面板（任务 A）：有采样数据才显示区块
  // 更新区块（任务 M1-5）
  if (window.settings.updater) {
    const renderUpd = async () => {
      try {
        const u = await window.settings.updater()
        const status = u.status || {}
        const cfg = u.cfg || {}
        $('updateCard').style.display = ''
        $('updVersion').textContent = `${status.version || '—'} / ${status.knownPkg?.v || '（房间无更新信息）'}`
        $('updPolicy').value = cfg.policy || status.policy || 'download-prompt'
        $('updSource').value = cfg.source || status.source || 'peers-first'
        const btn = $('updInstallBtn')
        if (btn) btn.style.display = status.stagedOk ? '' : 'none'
        const bits = [`阶段 ${status.phase || 'idle'}`]
        if (status.stagedOk) bits.push('✅ 已暂存待装')
        if ((status.fails || 0) > 0) bits.push(`自动更新失败 ${status.fails} 次`)
        if (status.knownPkg) bits.push(`清单 ${new Date(status.knownPkg.ts).toLocaleString('zh-CN')}`)
        $('updStatus').textContent = bits.join(' · ')
      } catch { /* 状态不可读就不显示 */ }
    }
    renderUpd()
    setInterval(renderUpd, 15000)
    $('updInstallBtn').onclick = async () => {
      const u = await window.settings.updater()
      const v = u.status?.knownPkg?.v
      if (!v) return
      toast(`正在换装 ${v}，应用将自动重启…`)
      await window.settings.updaterApply({ version: v, immediate: true })
    }
    $('updGithubBtn').onclick = () => toast('GitHub 为自动兜底：同伴无源时自动走 GitHub，无需手动检查')
    $('updPolicy').onchange = () => window.settings.updaterSetCfg({ policy: $('updPolicy').value })
    $('updSource').onchange = () => window.settings.updaterSetCfg({ source: $('updSource').value })
  }

  window.settings.health?.().then((samples) => {
    if (!Array.isArray(samples) || !samples.length) return
    $('healthCard').style.display = ''
    const fmt = (x) => {
      const d = new Date(x.t)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 堆${x.heap}MB · blob${x.blobs} · DOM${x.dom} · 入站${x.inRate}/s · 断线${x.drops} · 链路${x.linksAlive}/${x.linksAll} · 就绪${x.ready}${x.wd ? ` · 看门狗×${x.wd}` : ''}`
    }
    const last = samples[samples.length - 1]
    const d = new Date(last.t)
    const age = Math.round((Date.now() - last.t) / 60000)
    $('healthNow').textContent = `最近样本（${age} 分钟前）：${fmt(last)}`
    $('healthList').textContent = samples.slice(-24).reverse().map(fmt).join('\n')
  }).catch(() => {})
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
    const r = await window.settings.hubStart({ port: Number($('hubPort').value) || 48883, tunnel: 'off', token: window.__hubSnap?.token || window.__savedHubToken || '' })
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
  $('hubTunnelStopBtn').onclick = async () => {
    toast('正在关闭公网暴露…')
    await window.settings.hubStopTunnel()
    window.__hubMode = 'off'
    persist()
    window.settings.hubStatus().then(hubRender)
    toast('已关闭公网暴露（中继本体继续运行）')
  }
  // 稳定地址向导四步
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
  $('hubTokenCopyBtn').onclick = async () => {
    const t = window.__hubSnap?.token
    if (!t) { toast('中继未运行'); return }
    try { await navigator.clipboard.writeText(t); toast('准入 token 已复制') } catch { toast(`token：${t}`) }
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
