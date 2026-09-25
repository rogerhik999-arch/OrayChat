// OrayChat 共享消息日志（可合并状态，CRDT 风格）
//
// 目标语义（大厅与私聊通用）：
//   - 全体保存：每个成员各自持久化一份会话日志
//   - 群体删除：任何成员可删除单条消息或清空整个会话，操作传播到所有成员
//   - 上线全局同步：登录后与每个对端交换会话状态并合并，最终一致
//   - 保留 30 天：按消息时间戳确定性过期，所有成员一致
//
// 合并正确性：
//   - 消息条目按 mid（96bit 随机）去重；合并取并集
//   - 单条删除写入墓碑 dels[mid]=t（保留 35 天），并集后确定性剔除 → 删除必然压过旧消息的重发
//   - 清空写入 clearT（取最大值），凡 t <= clearT 的条目确定性丢弃
//   - 因此两个成员各自应用任意操作子集后合并，状态必然收敛一致
//
// 本模块为纯逻辑（无 DOM/网络），便于 Node 单元测试。

export const RETENTION_MS = 30 * 24 * 3600 * 1000        // 消息保留 30 天
export const TOMBSTONE_MS = 35 * 24 * 3600 * 1000        // 墓碑多留 5 天防复活

function emptyConv() {
  return { entries: new Map(), dels: new Map(), clearT: 0 }
}

export class LogStore {
  // persist(json) / load()：可选持久化钩子（UI 层接 localStorage，测试可省略）
  constructor({ persist, load, now = Date.now } = {}) {
    this.persist = persist
    this.load = load
    this.now = now
    this.convs = new Map() // convKey -> {entries:Map<mid,{mid,author,text,t}>, dels:Map<mid,t>, clearT}
    this.listeners = new Set()
    if (this.load) {
      for (const [key, raw] of Object.entries(this.load() || {})) {
        this.convs.set(key, this.#deserialize(raw))
      }
      this.sweep()
    }
  }

  onChange(fn) { this.listeners.add(fn) }
  #notify(convKey) { for (const fn of this.listeners) fn(convKey) }
  #changed(convKey) {
    this.persist?.(this.exportAll())
    this.#notify(convKey)
  }

  conv(key) {
    let c = this.convs.get(key)
    if (!c) { c = emptyConv(); this.convs.set(key, c) }
    return c
  }

  #visibleEntries(c) {
    return [...c.entries.values()]
      .filter((e) => !c.dels.has(e.mid) && e.t > c.clearT)
      .sort((a, b) => a.t - b.t || (a.mid < b.mid ? -1 : 1))
  }

  // ---------- 变更操作（本地发起或远端同步到达统一走这里） ----------

  // 新消息；mid 已存在则忽略（幂等）。返回是否有变更。
  addMsg(key, { mid, author, text, t }) {
    const c = this.conv(key)
    if (!mid || c.entries.has(mid) || c.dels.has(mid)) return false
    if (t <= c.clearT || (this.now() - t) >= RETENTION_MS) return false // 已被清空覆盖 / 超过保留期
    c.entries.set(mid, { mid, author, text: String(text), t })
    this.#changed(key)
    return true
  }

  // 删除单条消息（任何成员都可发起）
  applyDel(key, mid) {
    const c = this.conv(key)
    if (!mid || c.dels.has(mid)) return false
    c.dels.set(mid, this.now())
    c.entries.delete(mid)
    this.#changed(key)
    return true
  }

  // 清空整个会话（任何成员都可发起；删除 t <= clearT 的一切）
  applyClear(key, clearT) {
    const c = this.conv(key)
    clearT = Number(clearT) || 0
    if (clearT <= c.clearT) return false
    c.clearT = clearT
    for (const [mid, e] of [...c.entries]) {
      if (e.t <= clearT) c.entries.delete(mid)
    }
    this.#changed(key)
    return true
  }

  // 合并对端导出的状态；返回是否有变更（幂等、可交换、收敛）
  applyState(key, state) {
    const c = this.conv(key)
    let changed = false
    const clearT = Number(state?.clearT) || 0
    if (clearT > c.clearT) { c.clearT = clearT; changed = true }
    for (const [mid, t] of Object.entries(state?.dels || {})) {
      if (!c.dels.has(mid)) { c.dels.set(mid, Number(t) || this.now()); changed = true }
    }
    for (const e of state?.entries || []) {
      if (!e?.mid || c.entries.has(e.mid) || c.dels.has(e.mid)) continue
      if (e.t <= c.clearT || (this.now() - e.t) >= RETENTION_MS) continue
      c.entries.set(e.mid, { mid: e.mid, author: e.author, text: String(e.text), t: e.t })
      changed = true
    }
    // 墓碑/清空生效后剔除可见集
    for (const [mid, e] of [...c.entries]) {
      if (c.dels.has(mid) || e.t <= c.clearT) { c.entries.delete(mid); changed = true }
    }
    if (changed) this.#changed(key)
    return changed
  }

  // ---------- 查询与导出 ----------

  // 可见消息（已按时间排序，仅保留期内）
  visible(key) { return this.#visibleEntries(this.conv(key)) }

  visibleCount(key) { return this.visible(key).length }

  findByText(key, substr) {
    return this.visible(key).find((e) => e.text.includes(substr)) || null
  }

  // 导出单个会话状态（用于同步给对端；只含保留期内数据，确定性排序保证两端字节一致）
  exportConv(key) {
    const c = this.conv(key)
    const cutoff = this.now() - RETENTION_MS
    return {
      entries: [...c.entries.values()]
        .filter((e) => e.t > cutoff && !c.dels.has(e.mid) && e.t > c.clearT)
        .sort((a, b) => a.t - b.t || (a.mid < b.mid ? -1 : 1)),
      dels: Object.fromEntries([...c.dels].filter(([, t]) => this.now() - t < TOMBSTONE_MS).sort()),
      clearT: c.clearT,
    }
  }

  exportAll() {
    const out = {}
    for (const [key, c] of this.convs) {
      if (c.entries.size === 0 && c.dels.size === 0 && !c.clearT) continue
      out[key] = {
        entries: [...c.entries.values()],
        dels: Object.fromEntries(c.dels),
        clearT: c.clearT,
      }
    }
    return out
  }

  // 30 天保留期清理（确定性：仅依赖 t，所有成员结果一致）
  sweep() {
    const now = this.now()
    let changed = false
    for (const [key, c] of this.convs) {
      for (const [mid, e] of [...c.entries]) {
        if (now - e.t >= RETENTION_MS) { c.entries.delete(mid); changed = true }
      }
      for (const [mid, t] of [...c.dels]) {
        if (now - t >= TOMBSTONE_MS) { c.dels.delete(mid); changed = true }
      }
    }
    if (changed) this.persist?.(this.exportAll())
    return changed
  }

  #deserialize(raw) {
    const c = emptyConv()
    if (!raw) return c
    for (const e of raw.entries || []) {
      if (e?.mid) c.entries.set(e.mid, { mid: e.mid, author: e.author, text: String(e.text), t: Number(e.t) || 0 })
    }
    for (const [mid, t] of Object.entries(raw.dels || {})) c.dels.set(mid, Number(t) || 0)
    c.clearT = Number(raw.clearT) || 0
    return c
  }
}

// 会话键：大厅固定 'lobby'；私聊用双方身份公钥（hex）字典序较小者，两端一致
export function dmConvKey(myIdPubHex, peerIdPubHex) {
  return myIdPubHex < peerIdPubHex ? myIdPubHex : peerIdPubHex
}
