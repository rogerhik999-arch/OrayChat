// oraychat delta —— rsync 式滚动哈希差分（P3-2）
//
// 用途：传输"相似文件"时只发差异（应用内热更新、相册增量备份等未来场景）。
// 算法（rsync 经典两步）：
//   1. 对旧文件按 blockSize 切块，建立 弱哈希(adler32 滚动) → 强哈希(sha256) → 块号 索引
//   2. 在新文件上滚动窗口匹配：弱哈希命中才算强哈希确认（抗碰撞），
//      命中即产出引用块并跳过整块，否则产出一段新数据
// 产出 patch = { blocks: [{oldIdx, newOff, len}], data: [{newOff, bytes}] }，
// applyPatch(oldBytes, patch) 还原 newBytes。传输 wire 时 data 按 filex 块再分片即可。
//
// 注意：本模块为独立工具（v1.20.0），尚未接入聊天 UI——等"热更新/相册备份"
// 产品场景落地时作为传输层前置差分器使用。

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

// adler 变体（a=0 初始；滚动：O(1) 移窗）
const M = 65521
export function adler32(u8, start = 0, len = u8.length) {
  let a = 0, b = 0
  for (let i = start; i < start + len; i++) { a = (a + u8[i]) % M; b = (b + a) % M }
  return ((b << 16) | a) >>> 0
}

// 窗口右移一格（丢弃 start 处字节、加入 start+len 处字节）：
// a' = a - w[start] + w[start+len]；b' = b - N*w[start] + a'
export function roll(adler, u8, start, len) {
  let a = (adler & 0xffff)
  let b = (adler >>> 16) & 0xffff
  a = (a - u8[start] + u8[start + len] + M) % M
  b = (b - len * u8[start] + a + M * len) % M
  return ((b << 16) | a) >>> 0
}

function strongHash(u8, start, len) {
  return bytesToHex(sha256(u8.subarray(start, start + len))).slice(0, 16)
}

// 生成 patch：把 newBytes 相对 oldBytes 的差异表达为「引用块 + 新数据」
export function computePatch(oldBytes, newBytes, blockSize = 4096) {
  if (!(blockSize >= 64)) throw new Error('blockSize 至少 64')
  // 1) 旧文件块索引
  const index = new Map() // weak -> Map<strong, oldIdx>
  const oldBlocks = Math.floor(oldBytes.length / blockSize)
  for (let i = 0; i < oldBlocks; i++) {
    const off = i * blockSize
    const weak = adler32(oldBytes, off, blockSize)
    if (!index.has(weak)) index.set(weak, new Map())
    const strong = strongHash(oldBytes, off, blockSize)
    if (!index.get(weak).has(strong)) index.get(weak).set(strong, i)
  }
  // 2) 新文件滚动匹配
  const blocks = [] // {oldIdx, newOff, len}
  const data = [] // {newOff, bytes}
  let pendingOff = 0 // 未匹配数据段起点
  const flushData = (upto) => {
    if (upto > pendingOff) data.push({ newOff: pendingOff, bytes: newBytes.slice(pendingOff, upto) })
    pendingOff = upto
  }
  if (newBytes.length >= blockSize) {
    let weak = adler32(newBytes, 0, blockSize)
    let pos = 0
    while (pos + blockSize <= newBytes.length) {
      const bucket = index.get(weak)
      if (bucket) {
        const strong = strongHash(newBytes, pos, blockSize)
        if (bucket.has(strong)) {
          flushData(pos)
          blocks.push({ oldIdx: bucket.get(strong), newOff: pos, len: blockSize })
          pos += blockSize
          pendingOff = pos // 匹配区间已消费：数据游标同步前进
          if (pos + blockSize <= newBytes.length) weak = adler32(newBytes, pos, blockSize)
          continue
        }
      }
      if (pos + blockSize < newBytes.length) weak = roll(weak, newBytes, pos, blockSize)
      pos++
    }
    flushData(newBytes.length)
  } else {
    flushData(newBytes.length)
  }
  return { blockSize, blocks, data, oldSize: oldBytes.length, newSize: newBytes.length }
}

// 应用 patch 还原 newBytes
export function applyPatch(oldBytes, patch) {
  const out = new Uint8Array(patch.newSize)
  for (const b of patch.blocks) {
    out.set(oldBytes.subarray(b.oldIdx * patch.blockSize, b.oldIdx * patch.blockSize + b.len), b.newOff)
  }
  for (const d of patch.data) out.set(d.bytes, d.newOff)
  return out
}

// 差异统计（传输量 = 引用清单 + 新数据字节）
export function patchCost(patch) {
  const refBytes = patch.blocks.length * 12 // oldIdx(4) + newOff(4) + len(4)
  const dataBytes = patch.data.reduce((a, d) => a + d.bytes.length, 0)
  return { refBytes, dataBytes, total: refBytes + dataBytes }
}
