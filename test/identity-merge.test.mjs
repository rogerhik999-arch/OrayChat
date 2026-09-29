// 旧身份归并（重装换密钥）单元测试：别名建立/链拍平/桶合并/跨桶删除与清空
// 场景：xfold 重装两次 → 三个公钥同昵称；mac 侧应把旧公钥归并到当前公钥，
// 历史名录只留一条，聊天记录读时合并成一条时间线（原始桶不动）。
// 用法：node test/identity-merge.test.mjs
import assert from 'node:assert/strict'
import { ChatNet } from '../renderer/src/net.mjs'
import { LogStore, dmConvKey } from '../renderer/src/store.mjs'

const ME = 'aa'.repeat(32) // mac（我）
const MY_OLD = 'bb'.repeat(32) // 我重装前的旧身份
const X1 = '11'.repeat(32) // xfold 第一次安装
const X2 = '22'.repeat(32) // xfold 第二次安装
const X3 = '33'.repeat(32) // xfold 当前安装（第三次）
const BOB = '44'.repeat(32) // 无关成员

function bareNet({ names = {}, aliases = {}, myName = 'mac' } = {}) {
  const events = { notices: [], aliasSaves: [], logs: [] }
  const net = Object.create(ChatNet.prototype)
  net.destroyed = false
  net.myIdPubHex = ME
  net.myName = myName
  net.peers = new Map()
  net.peerNames = new Map([[ME, myName], ...Object.entries(names)])
  net.idAliases = new Map(Object.entries(aliases))
  net.hooks = {
    onLog: (m) => events.logs.push(m),
    onStoreNotice: (m) => events.notices.push(m),
    onIdAliases: (o) => events.aliasSaves.push(o),
  }
  net.propagateCtl = async () => {} // 不触网
  net.store = new LogStore({})
  return { net, events }
}

// ---- 1) mergeOldIdentities：同昵称旧身份一律并入当前活身份 ----
// （昵称即账号：多设备/重装都是同一个人，记录合并是预期；名录侧对仍有
//   就绪会话的旧身份保留单列，见 app.mjs buildRoster 的 hasReadySession 守卫）
{
  const { net, events } = bareNet({ names: { [X1]: 'xfold', [X2]: 'xfold', [X3]: 'xfold', [BOB]: 'bob' } })
  // xfold 的另一台设备（X2）当前有就绪会话 → 也并入（同一人），但名录仍会单列
  net.peers.set('sess-x2', { state: 'ready', idPubHex: X2 })
  net.mergeOldIdentities({ idPubHex: X3, name: 'xfold' })
  assert.equal(net.resolveId(X1), X3, '旧身份 X1 应并入当前身份 X3')
  assert.equal(net.resolveId(X2), X3, '同名另一台设备 X2 也并入（同一人的多设备）')
  assert.equal(net.resolveId(BOB), BOB, '无关成员不受影响')
  assert.equal(events.aliasSaves.length, 1, '别名变更应通知持久化')
  assert.ok(net.hasReadySession(X2), 'hasReadySession 仍如实反映活设备（名录守卫用）')
}

// ---- 2) mergeSelfIdentities：与我同名的旧身份并入我；同名好友在线时不误并 ----
{
  const { net } = bareNet({ names: { [MY_OLD]: 'mac', [BOB]: 'bob' } })
  net.mergeSelfIdentities()
  assert.equal(net.resolveId(MY_OLD), ME, '我的旧身份应并入当前身份')
  assert.equal(net.resolveId(BOB), BOB, '其他昵称不受影响')

  const { net: n2 } = bareNet({ names: { [X1]: 'mac' } }) // 与我同名的好友
  n2.peers.set('sess-x1', { state: 'ready', idPubHex: X1 })
  n2.mergeSelfIdentities()
  assert.equal(n2.resolveId(X1), X1, '同名好友当前在线（有会话）不得并入我')
}

// ---- 3) 别名链拍平：X1→X2、X2→X3 归并后全部直达 X3 ----
{
  const { net } = bareNet({ aliases: { [X1]: X2, [X2]: X3 } })
  net.commitAliases('拍平测试')
  assert.equal(net.resolveId(X1), X3)
  assert.equal(net.idAliases.get(X2), X3, '中间身份应直达最终身份（无链）')
}

// ---- 4) dmMergedBucketKeys：{我∪我的旧身份} × {对端∪对端的旧身份} ----
{
  const { net } = bareNet({ aliases: { [X1]: X3, [MY_OLD]: ME } })
  const keys = net.dmMergedBucketKeys(X3)
  const expect = new Set([
    dmConvKey(ME, X3), dmConvKey(ME, X1),
    dmConvKey(MY_OLD, X3), dmConvKey(MY_OLD, X1),
  ])
  assert.deepEqual([...keys].sort(), [...expect].sort(), '应恰好覆盖四个相关分桶')
  assert.equal(net.dmViewKey(X1), dmConvKey(ME, X3), '旧身份的视图键应等于当前身份的')
}

// ---- 5) 读时合并：三个桶归成一条时间线；各桶清空标记独立生效 ----
{
  const { net } = bareNet({ aliases: { [X1]: X3, [MY_OLD]: ME } })
  const K_new = dmConvKey(ME, X3), K_old = dmConvKey(ME, X1), K_myold = dmConvKey(MY_OLD, X3)
  const base = Date.now() - 60000 // 保留期内（30 天）的近期时间戳
  net.store.addMsg(K_new, { mid: 'm3', author: X3, text: '新身份消息', t: base + 3000 })
  net.store.addMsg(K_old, { mid: 'm1', author: X1, text: '旧身份时代的消息', t: base + 1000 })
  net.store.addMsg(K_myold, { mid: 'm2', author: MY_OLD, text: '我还是旧密钥时发的', t: base + 2000 })
  // 复刻 app.mjs viewMessages 的合并逻辑
  const merged = []
  for (const k of net.dmMergedBucketKeys(X3)) {
    if (net.store.convs.has(k)) merged.push(...net.store.visible(k))
  }
  merged.sort((a, b) => a.t - b.t)
  assert.deepEqual(merged.map((m) => m.mid), ['m1', 'm2', 'm3'], '三个桶按时间合并成一条时间线')
  // 只清旧桶：旧桶消息消失，新桶保留（各桶 clearT 独立）
  net.store.applyClear(K_old, base + 1500)
  const after = net.store.visible(K_old)
  assert.equal(after.length, 0, '旧桶清空后其消息不可见')
  assert.ok(net.store.visible(K_new).length === 1, '新桶不受旧桶清空影响')
}

// ---- 6) 跨桶删除 / 跨桶清空：合并视图里删 mid，落在哪个桶都能删掉 ----
{
  const { net } = bareNet({ aliases: { [X1]: X3 } })
  const K_old = dmConvKey(ME, X1)
  const base = Date.now() - 60000
  net.store.addMsg(K_old, { mid: 'm1', author: X1, text: '旧桶里的消息', t: base + 1000 })
  net.peers.set('sess-x3', { state: 'ready', idPubHex: X3, name: 'xfold' })
  await net.deleteMessage('dm', 'm1', 'sess-x3')
  assert.equal(net.store.visible(K_old).length, 0, '对旧身份桶里的 mid 删除应生效（按 mid 全桶生效）')
  // 清空：当前会话视图的清空覆盖全部相关桶
  net.store.addMsg(dmConvKey(ME, X3), { mid: 'm2', author: X3, text: 'x', t: base + 2000 })
  net.store.addMsg(K_old, { mid: 'm3', author: X1, text: 'y', t: base + 3000 })
  await net.clearConv('dm', 'sess-x3')
  assert.equal(net.store.visible(dmConvKey(ME, X3)).length, 0)
  assert.equal(net.store.visible(K_old).length, 0, '清空应覆盖旧身份桶')
}

// ---- 7) dropConv：删除联系人 = 清除相关分桶（幂等、未知键安全） ----
{
  const { net } = bareNet({ aliases: { [X1]: X3 } })
  const base = Date.now() - 60000
  net.store.addMsg(dmConvKey(ME, X3), { mid: 'm1', author: X3, text: 'a', t: base + 1000 })
  net.store.addMsg(dmConvKey(ME, X1), { mid: 'm2', author: X1, text: 'b', t: base + 2000 })
  net.store.addMsg('lobby', { mid: 'm3', author: X3, text: 'lobby msg', t: base + 3000 })
  for (const k of net.dmMergedBucketKeys(X3)) net.store.dropConv(k)
  assert.equal(net.store.convs.size, 1, '删除联系人后仅剩大厅桶')
  assert.ok(net.store.convs.has('lobby') && net.store.visible('lobby').length === 1, '大厅公共记录不受影响')
  assert.equal(net.store.dropConv('dm:nonexistent'), false, '未知键幂等安全')
}

console.log('identity-merge.test.mjs ✓ 全部通过（旧身份归并 / 链拍平 / 桶合并 / 跨桶删除清空 / dropConv）')
