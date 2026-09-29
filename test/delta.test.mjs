// delta 模块单测（P3-2）：滚动哈希差分/还原/传输量统计
// 用法：node test/delta.test.mjs
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
const bytesEq = (a, b) => Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length))
import crypto from 'node:crypto'
import { computePatch, applyPatch, patchCost, adler32, roll } from '../renderer/src/delta.mjs'

// ---- 1) adler32 滚动一致性：roll 与重算结果一致 ----
{
  const u8 = crypto.randomBytes(4096)
  const h0 = adler32(u8, 0, 1024)
  const h1 = roll(h0, u8, 0, 1024)
  const h1expect = adler32(u8, 1, 1024)
  assert.equal(h1, h1expect, '滚动哈希应等于窗口滑动后重算')
}

// ---- 2) 相同文件：全块引用，零新数据 ----
{
  const oldB = crypto.randomBytes(64 * 1024)
  const patch = computePatch(oldB, oldB.slice())
  assert.equal(patch.blocks.length, 16, '16 个块全部命中')
  assert.equal(patch.data.length, 0, '无新数据')
  assert.ok(bytesEq(applyPatch(oldB, patch), oldB), '还原一致')
}

// ---- 3) 小改动：大部分块命中，仅局部新数据；还原一致 ----
{
  const oldB = crypto.randomBytes(256 * 1024)
  const newB = oldB.slice()
  newB.set(crypto.randomBytes(100), 50000) // 改 100 字节（落在 4096 块边界附近）
  newB[200000] ^= 0xff
  const patch = computePatch(oldB, newB)
  const cost = patchCost(patch)
  assert.ok(cost.dataBytes < 20 * 1024, `差异应远小于整文件（data=${cost.dataBytes}B）`)
  assert.ok(bytesEq(applyPatch(oldB, patch), newB), 'patch 还原一致')
}

// ---- 4) 完全不同：全量新数据（退化为普通传输），还原一致 ----
{
  const oldB = crypto.randomBytes(128 * 1024)
  const newB = crypto.randomBytes(100 * 1024)
  const patch = computePatch(oldB, newB)
  assert.ok(patch.blocks.length < 5, '随机内容几乎无命中')
  assert.ok(bytesEq(applyPatch(oldB, patch), newB), '还原一致')
}

// ---- 5) 插入位移：块边界移动后仍能重新对齐 ----
{
  const oldB = crypto.randomBytes(128 * 1024)
  const newB = new Uint8Array(oldB.length + 5000)
  newB.set(crypto.randomBytes(5000), 0) // 头部插入 5000 字节 → 所有旧块位移
  newB.set(oldB, 5000)
  const patch = computePatch(oldB, newB)
  // 滚动哈希对位移内容仍应命中旧块（内容相同，位置不同）
  assert.ok(patch.blocks.length >= 25, `位移后仍应命中大部分块（${patch.blocks.length}/31）`)
  assert.ok(bytesEq(applyPatch(oldB, patch), newB), '还原一致')
}

// ---- 6) 新文件小于 blockSize：全量数据 ----
{
  const oldB = crypto.randomBytes(64 * 1024)
  const newB = crypto.randomBytes(100)
  const patch = computePatch(oldB, newB)
  assert.ok(bytesEq(applyPatch(oldB, patch), newB), '还原一致')
}

console.log('delta.test.mjs ✓ 全部通过（滚动哈希/全同/小改/全异/位移/小块）')
process.exit(0)
