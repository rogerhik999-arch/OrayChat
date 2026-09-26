// web-shim KV 单元测试：复现并锁定手机端持久化损坏的根因
// （localStorage 只能存字符串——对象必须 JSON 序列化，否则
//   Object.keys(字符串) 把字符下标当键，产生 "0→undefined" 式垃圾）
// 用法：node test/web-shim.test.mjs
import assert from 'node:assert/strict'

// 模拟浏览器全局环境（web-shim.js 依赖 window/localStorage/btoa）
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size },
}
globalThis.window = { addEventListener() {} }
globalThis.addEventListener = () => {}
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')

await import('../renderer/web-shim.js')
const oray = globalThis.window.oray
assert.ok(oray, 'web-shim 应定义 window.oray')

// 1. 对象值 KV 往返（登录历史形状）
const history = {
  alice: { room: 'oc-1.3.1-fix' },
  bob: { room: 'oc-1.3.1-fix' },
}
await oray.kvSet('oc-login-history', history)
const back = await oray.kvGet('oc-login-history')
assert.deepEqual(back, history, '对象 KV 必须无损往返（JSON 序列化）')
assert.equal(typeof back, 'object', '读取端必须是对象而非字符串')

// 2. 复现旧 bug 的存取路径：旧版把对象 String 化成 "[object Object]" —— 新读取端应能自愈
store.set('oray-kv:legacy', String({ a: 1 })) // 旧版损坏数据形状
const legacy = await oray.kvGet('legacy')
assert.equal(typeof legacy, 'string', '损坏的旧数据读出仍是字符串（由上层规整处理）')

// 3. null 删除语义
await oray.kvSet('tmp-key', { x: 1 })
await oray.kvSet('tmp-key', null)
assert.equal(await oray.kvGet('tmp-key'), null, 'kvSet null = 删除')

// 4. 聊天日志持久化（LogStore 的 persist/load 往返）
const logData = {
  lobby: {
    entries: [{ mid: 'abc', author: 'A', text: '你好', t: 1690000000000 }],
    dels: {},
    clearT: 0,
  },
}
await oray.kvSet('oc-log2:room1', logData)
const logBack = await oray.kvGet('oc-log2:room1')
assert.deepEqual(logBack, logData, '聊天日志对象必须无损往返（手机端历史损坏的另一半根因）')

// 5. 身份密钥存取
await oray.saveIdentity('alice', { edSeed: 'AA==', edPub: 'BB==' })
assert.deepEqual(await oray.loadIdentity('alice'), { edSeed: 'AA==', edPub: 'BB==' })

console.log('✅ web-shim KV 序列化测试全部通过（对象往返/旧数据兼容/删除语义/日志与身份持久化）')
