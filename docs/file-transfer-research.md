# 分布式网络中的稳定文件传输：理论与方法 → OrayChat filex 借鉴路线

> 调研时间：2026-09-30 · 对应实现：`renderer/src/filex.mjs`（v1.17.2）
> 结论先行：我们的骨架（选择性重传 ARQ + 内容寻址断点续传 + 接收方驱动 + 双路径迁移）
> 与工业实践同构，方向正确；最大差距在 **拥塞控制（固定窗口无自适应）**、
> **有序通道的队头阻塞**、**无前向纠错**、**整文件 SHA 全有全无校验** 四点。

---

## 一、我们已经做对的（与经典系统的对照印证）

| 我们的机制 | 理论/工业对照 | 说明 |
|---|---|---|
| 分片 + 接收方位图 + 只补缺失块 | 选择性重传 SR-ARQ（TCP 的演进方向）、BitTorrent fast-resume | 比退回 GBN 的方案都强；位图持久化 = BT 的 resume file |
| fid = 内容 SHA-256 前 24 hex | HTTP 强校验器 ETag/If-Range、tus.io 的 Upload-Metadata | 内容寻址天然支持跨重启续传与去重 |
| 接收方每 2s 广播位图（兼作重传请求） | NACK/ACK 驱动（NORM 组播）、receiver-driven transport | 弱网下比发送方盲目重发高效 |
| 完成时整文件 SHA-256 校验 | tus/HTTP 的端到端完整性；BT 的 piece hash 终检 | 传输层 AEAD 每块已认证，SHA 是端到端兜底 |
| p2p↔MQTT 双路径、就绪两路全收（MBB） | QUIC connection migration（RFC 9000 §9）、MPTCP/MPQUIC 的简化版 | 路径迁移不断流是我们实测有效的能力 |
| 会话恢复 epoch 密钥链（序号续接） | QUIC 0-RTT/ticket resume 的同构物 | 重连免全握手 |
| 传输保护（reaper 跳过活跃传输对端） | 流控与生命周期解耦的原则 | v1.17.2 刚修的"传输中被判死" |

**判断**：不需要推倒重来，下一步是"把固定参数换成自适应、给丢块加纠错、给校验加分块"。

---

## 二、理论/方法清单与可借鉴点

### A. 拥塞控制族（差距最大、收益最大）

- **AIMD / CUBIC**（TCP 系）：窗口线性增、乘性减。我们是**固定窗口**（p2p 16 块 / 中继 4 块），
  无增无减——链路好时吃亏（吞吐上不去），链路差时雪崩（突发灌爆缓冲区）。
- **LEDBAT**（RFC 6817，BitTorrent uTP 的传输）：**基于延迟而非丢包**的让路式拥塞控制——
  测量单向延迟抬升，一旦超过阈值就降速，把带宽让给交互流量。
  → **对我们是刚需**：v1.17.2 修的"文件块挤死心跳"就是没有 LEDBAT 的后果。
  理论化方案：文件传输设**总速率上限**（如 ≤2× 当前 ACK 测得速率，且默认封顶 N MB/s），
  心跳/presence 天然获得余量。
- **BBR**（Google）：不再以丢包为信号，而是主动估计 **bottleneck 带宽 × RTT（BDP）**，
  窗口 ≈ BDP。极简落地：滑动平均 ACK 到达速率 r 与块 RTT，window = clamp(r × RTT × 1.5,
  4, 64)。
- **Pacing（步调发送）**：BBR/QUIC 都强调按速率匀速发而非窗口突发。我们中继路径已有
  25ms/块固定 pacing，但 **p2p 路径是全速灌窗口**（突发 16×32KB）——应改为按测得速率匀速。

**借鉴落地（P0）**：自适应窗口 + 字节级 pacing。参数全部来自已有的 fx-have 位图（ACK 流），
不需要新协议帧。

### B. ARQ 谱系与前向纠错（FEC）

- ARQ 三代：停等 → Go-Back-N → **选择性重传**（我们已是）。
- **FEC 前向纠错**：不重传、发冗余直接恢复。
  - Reed-Solomon（k+n 编码，任意 n 到齐即可解）——RAID6、QR 码同款数学；
  - **喷泉码**：LT 码 → **RaptorQ（RFC 6330）**：无限的编码块，收到略多于 k 个即可解码，
    3GPP 广播/MDS 在用，有 wasm 实现（在浏览器可跑）；
  - 工程简化版：**8+1 XOR**（9 块一组，第 9 块 = 其余 8 块异或）——任丢 1 块免重传，
    一行位运算实现，成本 +12.5%。
- **对我们的意义**：中继路径 QoS0 会丢帧，每丢一块要等 1.5s 重发 + 一整个 RTT；
  FEC 把"丢块恢复"从 网络往返 级降到 本地计算 级。中继弱链路（手机场景）收益最大。
- **配合项**：interleaving（交织）把连续突发丢块打散到不同 FEC 组。

**借鉴落地（P1）**：先 8+1 XOR（一天工作量），观察中继丢块率数据再决定是否上 RaptorQ。

### C. BitTorrent 工程学（20 年实战打磨的细节）

- **rarest-first 块选择**：优先下载全网最稀缺块。1:1 传输用不上（单源无稀缺度），
  **未来大厅群文件/多设备同账号**时直接套用。
- **Endgame 模式**：最后几块是长尾（重传 RTT 主导），向所有可用源同时请求、谁先到用谁、
  收到后取消其余。→ 我们的单源版：**最后 2% 时窗口加倍 + 超时重发阈值减半**，一行改动，
  解决"99% 卡半天"的体感问题。
- **tit-for-tat / choking**：激励公平。私聊熟人场景不需要。
- **fast-resume**：位图 + 文件 mtime 持久化，跳过重校验 = 我们的 `<fid>.json`（已对齐）。
- **多源并行下载**：同一 fid 从多个持有者取不同块（BT 的核心吞吐来源）。当前 1:1 单源；
  未来"大厅文件"若做，按 gossip 广播持有位图 → 各取所需（epidemic 协议天然契合我们
  已有的 SWIM 摘要通道）。

**借鉴落地（P1 endgame；P3 多源）**。

### D. WebRTC/SCTP 层特性（我们栈的独有约束与机会）

- **已确认**：Trystero 把所有 action（hs/m/ctl/sync/fx）复用**一条默认配置的 DataChannel**
  （`createDataChannel("data")` = ordered + reliable）。ordered 通道有经典的
  **队头阻塞（HOL blocking）**：丢一帧，后面所有帧（包括心跳 ctl！）都要等它重传。
  这与 v1.17.2 观察到的"心跳饿死"在理论上是**叠加关系**——不仅是 broker QoS0 拥堵，
  SCTP 层的有序等待也在放大延迟。
- 文件块**语义上完全乱序安全**（每块独立 AEAD + 位图收账），理想通道是
  `ordered: false`（WebRTC 标准能力，专为这类流量设计）。
- 落地障碍：Trystero 不暴露 channel 参数。选项：a) 上游 PR 加 options；b) esbuild
  alias 打补丁覆盖 `@trystero-p2p/core/dist/peer.mjs` 的 createDataChannel；
  c) 我们的协议层已全部 reorder-tolerant（seq/txid/AAD 去重），把**整条通道**改 unordered
  也可行——需要回归验证 hs/msg 对乱序的容忍（hs 有重发、msg 有 seq 窗口，理论上成立）。
- **partial reliability**（maxRetransmits/maxPacketLifetime）：为流媒体设计，文件传输不需要。

**借鉴落地（P1 实验，P2 推广）**：unordered 通道。先在上游提 issue 验证可行性，
不行就走 esbuild alias vendor 补丁（标注升级成本）。

### E. 完整性校验的谱系：整体 SHA → 分块 → Merkle

- 我们现在：每块 AEAD（传输安全）+ 整文件 SHA-256（端到端完整性）。
  缺点：**全有全无**——200MB 传完才知道哪块坏（虽然 AEAD 下"坏=丢=重传"，实际影响是
  定位慢而非数据错）。
- **Merkle tree**（块哈希树，BT piece hash / Git / 区块链同源）：根哈希进 offer，
  每块可用 O(log n) 路径独立验证。收益：a) 任意块独立校验，配合多源信任（未来）；
  b) 断点续传可先校验已有部分再续；c) 部分损坏定位到块。
- 对照 BT：piece hash 就是扁平版 Merkle（每块一个 hash 存 offer）——**最简落地**：
  offer 附每块 SHA-256 截断（32KB 块 × 8B 截断哈希，200MB 文件 ≈ 50KB 清单），接收方
  边收边验，坏块立即丢弃重传，不用等终检。

**借鉴落地（P2）**：扁平块哈希清单（BT 式）性价比最高；全 Merkle 留给多源场景。

### F. 压缩：块压缩 vs 流压缩

- 现状：每块独立 deflate-raw（收益≥3% 才用）。**块边界切碎了字典**，压缩率低于整文件
  压缩 10-30%（文本类）。
- `CompressionStream` 是**流式**的：可以先整文件流式 deflate → 对输出切块 → 接收方
  拼整流后解压。压缩率↑、CPU↓（一次压缩 vs N 次小压缩）。
- 续传兼容性设计点：fid 仍基于**压缩后**内容哈希（不变，断点续传照旧）；z=1 块级标志
  弃用、换流级压缩标志（offer 字段）。已传一半的旧版本文件不兼容——版本字段区分。
- **zstd**：压缩率/速度双优于 deflate，但 CompressionStream 不支持，需 wasm（~100KB）。
  值不值得看流量占比，v2 再说。
- 媒体文件（jpg/mp4/webp）本已压缩，内容感知跳过——我们已做。

**借鉴落地（P2）**：流式整文件压缩（兼容性开关 `mode:'stream'`）。

### G. 传输语义与工业协议对照

- **MQTT QoS0 vs QoS1**：QoS1（PUBACK）至少一次，配合我们的 mid/txid 去重 = 恰好一次。
  公共 broker 对 QoS1 更容易限流——值得做成实验开关实测丢块率/吞吐差异（P2 实验）。
- **tus.io**（断点续传上传的事实标准）：Upload-Offset/Length/Metadata + PATCH。
  我们的 offer/have/位图 与之形状一致（印证）；tus 的 **expiration + 并发 offset 锁**
  值得抄一点：多端同账号同时续传同一 fid 时需要互斥（当前 1:1 不冲突）。
- **rsync rolling checksum**（adler32 滚动哈希，delta 同步）：传输"相似文件"只发差异块。
  对 OrayChat 的潜在场景：未来做"应用内热更新/相册增量备份"时直接套用。当前不做。

### H. 多路径传输（MPQUIC/MPTCP 思想）

- 我们实际拥有两条异质路径（DataChannel + MQTT broker），但当前是**主备切换**
  （forceRelay 是逃生阀）。学术/工业的下一步是**并行调度**：按两条路径各自的实测速率
  分配块（快路径多发），任一路径丢块不影响另一路。
- 落地很轻：pump 已知道每块的 ACK 反馈，按路径统计 EMA 吞吐，窗口按比例拆分。
- 收益：中继+直连同时跑满，且天然容错（这就是 MPQUIC 的核心论文结论）。

**借鉴落地（P2）**：双路径并行调度（当前先保持主备，等 unordered 通道解决后再上）。

### I. 明确"不引入"的方向

- **网络编码**（Avalanche/线性编码）：理论优雅，工程复杂度与调试成本高，FEC（RaptorQ）
  是其工业落地替代——不引入。
- **自建 TURN/STUN/信令**：违背本项目"免公共服务依赖"初衷（私有化部署文档保留方案即可）。
- **DHT/Kademlia 发现**：房间人数 ≤ 数百，SWIM 摘要已够。
- **QUIC 自建传输层**（替换 WebRTC）：Electron 可行但移动端 WebView 不可行，放弃。

---

## 三、落地路线（按收益/成本排序）

| 级别 | 项 | 理论来源 | 预期收益 | 工作量 |
|---|---|---|---|---|
| P0-1 | 自适应窗口：window = clamp(1.5 × ACK速率 × RTT, 4, 64)；字节级 pacing 替代固定块数 | BBR(BDP) + LEDBAT(RFC 6817) | 弱网吞吐↑、心跳不再被挤（根治 v1.17.2 那类死锁） | 1 天 |
| P0-2 | 文件传输总速率预算（默认封顶如 4MB/s，中继路径 1MB/s）| LEDBAT 让路 | 交互消息/心跳永久获得余量 | 半天 |
| P1-1 | FEC 8+1 XOR 组（offer 声明 fec:1，冗余块流）| RS/喷泉码的工程简化 | 中继丢块恢复从 RTT 级降到 0 往返 | 1 天 |
| P1-2 | Endgame：最后 2% 窗口加倍 + 重发阈值减半 | BitTorrent | 消除"99% 卡半天" | 2 小时 |
| P1-3 | unordered 通道实验（上游 PR / esbuild alias 补丁）| WebRTC SCTP ordered/unordered | 消除 HOL：丢帧不再阻塞心跳与消息 | 1-2 天（含回归） |
| P2-1 | 整文件流式压缩替代块压缩（mode:'stream' 版本开关）| 流式压缩管线 | 文本类流量 -10~30%，CPU↓ | 1 天 |
| P2-2 | 扁平块哈希清单（offer 附每块截断哈希，边收边验）| BitTorrent piece hash / Merkle 简化 | 坏块即时定位，终检不再全有全无 | 半天 |
| P2-3 | MQTT QoS1 实验（去重已有）| MQTT QoS 语义 | 用 broker 重传兜 QoS0 丢帧 | 半天+实测 |
| P2-4 | 双路径并行调度（按实测 EMA 速率分配块）| MPQUIC/MPTCP | 吞吐≈两路之和，天然容错 | 1-2 天 |
| P3-1 | 群文件多源并行（gossip 位图 + rarest-first）| BitTorrent + epidemic gossip | 大厅文件多人加速 | 3-5 天 |
| P3-2 | delta 同步（rolling hash，相似文件只传差异）| rsync | 热更新/相册增量场景 | 3 天 |

### 不需要做的
网络编码（RaptorQ 已是工业版）、DHT 发现（SWIM 摘要已够）、自建基础设施、
QUIC 自建传输（WebView 不可行）。

---

## 四、与 v1.17.2 实测问题的理论回溯

| 实测现象 | 理论解释 | 已修（v1.17.x） | 理论正解（本次路线） |
|---|---|---|---|
| 中继发图 33% 卡死 + 心跳饿死 | 缓冲区膨胀 bufferbloat + 无速率预算 | 32KB 块 + 传输保护 + 中继重建 | P0-1/P0-2 自适应窗口 + 速率预算（根治） |
| offer 丢帧永久 0% | 单向控制帧无重传（ARQ 覆盖缺口） | offer 周期重发 | 已是理论正解 |
| 直连半死通道无进展 | 路径健康度未感知 | forceRelay 逃生阀 | P2-4 双路径并行（终极） |
| 弱网整条通道抖动放大 | ordered 通道 HOL blocking | —（未解） | P1-3 unordered 通道 |
| 接收端"损坏文件"观感 | UI 状态机缺口 | 占位渲染 | 已是正解 |
