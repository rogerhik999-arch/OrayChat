# 长期运行状态同步：网络调研与改进路线

> 背景：用户报告"应用长期运行就会掉线，必须重启才能激活"。经两轮排查已修复六项
> 缺陷（退避失效/回调无隔离/半开盲区/DOM 无上限/同步帧无界/blob 泄漏），但前四项
> +后两项的归因都偏"资源开销与缺陷修复"。本文回答更根本的问题：**在长期运行的
> 状态同步上，我们的技术方案本身有什么结构性短板，成熟系统怎么做，主改方向是什么。**

---

## 一、归因分层：资源开销只是表层

"长期运行 → 掉线 → 必须重启"的因果链其实分四层，资源开销只是其中之一：

| 层 | 机制 | 状态 |
|---|---|---|
| L1 资源累积 | DOM 无上限、blob URL 泄漏、退避失效、回调无隔离——运行时间 × 使用量放大 | ✅ 已修（e0771c5/f2ee862） |
| L2 同步模型 | 反熵=全量对账 O(N)，N=30 天日志随使用无限增长；每 5min 一次的"自拥堵"脉冲 | ⚠️ 只做了封顶（400 条/160KB），模型未改 |
| L3 自愈无下限 | 各机制各自为战（probe 管链路、silent-cycle 管握手、goOnline 管待机），**没有任何组件保证"最坏 X 分钟内恢复在线"**——所有自愈同时失效时（它们共享同一套中继链路认知），唯一出口是重启 | ❌ 未做 |
| L4 环境层 | 公共 broker QoS0 丢帧/限流、NAT 长连接超时、移动端 Doze 断网——丢帧无法恢复（fire-and-forget），断网只能等重连 | ⚠️ 部分（退避/探测/自愈） |

**关键判断：L1 修复后仍存在两个结构性问题——L2 的"全量对账模型"和 L3 的"自愈
无下限"。这两个不解决，长跑掉线只会"变少变轻"，不会根除。**

---

## 二、成熟系统的做法（调研）

### 2.1 SWIM / Serf / memberlist + Lifeguard：成员同步的生产化路径

- SWIM（Das et al., DSN 2002）：失败检测（ping/ping-req 间接探测）+ 感染式传播；
  **成员变更捎带（piggyback）在常规协议消息上**，不单独广播。
- HashiCorp memberlist/Serf 在其上加了两点对长跑至关重要的东西：
  1. **反熵走 delta**：节点间交换的是"自上次以来的变更摘要"而非全量状态，
     常规轮次几乎零载荷，只有真正分歧时才有数据流动。
  2. **Lifeguard（2020）**：生产集群长跑后，假阳性怀疑（ suspected 节点其实活着）
     会引发 CPU/流量放大——SWIM 原版的固定怀疑时限在劣化网络下自我恶化。
     Lifeguard 用**动态怀疑时限 + 传播伙伴_local 确认**替代固定参数。
  - 教训映射：我们已有 SWIM 骨架（suspect/ping/digest/markAlive），且**心跳已
    捎带 digest（piggyback ✓）**；但反熵是全量、怀疑参数全部固定（30s/75s/90s
    预热门）——Lifeguard 指出这正是长跑假阳性掉线的放大器。

### 2.2 Scuttlebutt（van Renesse）与 Dynamo/Cassandra：数据同步的 delta 化

- Scuttlebutt 反熵：双方交换**版本向量（VV）**，各自计算"对方缺什么"只发缺失
  部分（round-trip scuttling）——常规轮次每对-peer 只有几十字节的 VV，流量与
  数据量解耦。
- Dynamo/Cassandra：Merkle 树分段哈希做差异定位（重），或轻量 delta+hinted
  handoff（轻）。Cassandra 把 repair 限制在本地范围内避免全集群数据搬运。
- **共同点：同步开销 = O(分歧量) 而非 O(数据总量)**。这正是 L2 的对症药。
- 映射到我们：LogStore 已有 mid（内容寻址）+ tombstone 带时间戳——**增量游标
  的原料齐全**，缺的只是协议。

### 2.3 MQTT 会话语义：丢帧恢复的免费兜底

- HiveMQ/EMQ 权威文档：**QoS1/2 + persistent session（cleanSession=false /
  MQTT5 sessionExpiry>0）= broker 为离线客户端排队补发**；QoS0 永不排队。
- 我们现状：mqtt.js 默认 `clean: true`（没设过）→ **断线窗口内发给我们的
  DM/删除/同步帧永久丢失**，只能靠上层反熵兜（而反熵又是全量+低频）。
- 同时 broker 端要设排队上限（max queued / session expiry）防内存无界——
  公共 broker 恰恰因此更倾向于踢掉大 session 客户端。

### 2.4 Epidemic gossip 的频率纪律

- Jelasity 讲义：anti-entropy 轮次应"几乎总在传输 0 字节"（只交换摘要），
  有分歧才有数据。我们反过来的：**每轮必传全量**——这就是 5 分钟一次的自拥堵
  脉冲的来源。

---

## 三、现状 vs 目标差距表

| 维度 | 我们现状 | 成熟系统 | 差距 |
|---|---|---|---|
| 反熵载荷 | 全量（已封顶 400 条/160KB） | VV 摘要，按需 delta | **结构性**：封顶只是止痛，delta 才根治 |
| 同步与活性隔离 | 同一 MQTT 链路同一队列（QoS0 FIFO） | 控制面/数据面分离或分优先级 | 大帧仍能挤压 presence（链路级 FIFO） |
| 丢帧恢复 | QoS0 fire-and-forget；文本有 3s×3 ACK，presence/ctl/sync 无 | QoS1+persistent session，broker 补发 | 断线窗口内 DM/删除/同步全靠 5min 后的全量反熵 |
| 自愈下限 | 组件各自自愈，无全局保证 | Serf：成员协议本身保证收敛； watchdog 常态化 | **无"沉默即复位"的兜底**——必须重启的根子 |
| 怀疑参数 | 固定（20s 宽限/75s 预热门/90s 上限） | Lifeguard 动态化 | 劣化窗口假阳性放大（已知表现为会话翻动） |
| 资源面 | DOM/blob/退避已封顶 | 常态化内存预算 | ✅ 基本追平 |

---

## 四、改进路线（按性价比排序）

### P0-1 全局看门狗（消灭"必须重启"）——性价比最高

新增一个只依赖**外部观测**的看门狗：`若连续 5 分钟：中继链路 self 认为存活，
但零入站帧（任何 presence/ctl/hs/数据帧）→ 强制网络复位（forceReconnect +
全部就绪会话 rehandshake + goOnline），60s 限频，指数升级（10/20/40min 逐次
加长复位间隔）`。
- 设计纪律（沿用本项目教训）：判据只由**真实入站帧**定义（不读任何内部状态）；
  复位动作本身要限频+退避，防复位风暴；文件传输活跃时挂起。
- 效果：把"所有自愈同时失效→必须重启"的最坏路径，变成"最多黑 5-10 分钟自动
  硬复位"。这是 L3 的根治。

### P0-2 增量游标同步（O(N)→O(分歧)）——L2 根治

利用现成原料（entries 按 t 排序、tombstone 带 t）：
1. 每个 conv/peer 维护游标 `lastSyncedT`（持久化到 local-state）；
2. pushSync 改为：`entries: t > lastSyncedT - 60s`（60s 重叠窗防时钟偏移漏帧）
   + `dels: t > lastSyncedT - 5min`（墓碑多给余量）+ 当前封顶作首连全量；
3. 收到对端 sync 的最大 t 回执后推进游标（丢失帧由下次反熵自然覆盖——
   applyState 幂等合并，重叠无害）。
- 效果：常态轮次载荷从 160KB 降到 KB 级；流量与 30 天日志总量彻底解耦；
  "越用越堵"的曲线被拉平。
- 配套：**同步分块发送**（>32KB 拆 32KB 帧间插 50ms pacing）——即使 delta
  变大（一周离线后首同步）也不挤占链路。

### P0-3 关键帧 QoS1 + persistent session（L4 丢帧兜底）

- 对 DM/删除/同步帧（已有 txid 去重，恰好一次语义不破）改 QoS1；
- 连接参数加 `clean: false, clientId 稳定化`（我们已有 `oc-<pub8>-<rand>`——
  rand 部分需移出 clientId 或改用 MQTT5 sessionExpiry，否则 broker 视为
  新会话，排队失效；同机并联链路防互踢改用 username 后缀或协议层去重兜底）；
- 私有中继（hub/Aedes）必须设排队上限；公共 broker 的 session 策略不可控，
  作为"尽力而为"层。
- 效果：断线重连窗口内的删除传播/DM 不再依赖 5 分钟后的反熵。

### P1 Lifeguard 化的怀疑参数

固定时限 → 动态：宽限期 = f(该成员近期 presence 到达节奏)（φ-accrual 我们
已有 arrivals 历史，直接复用）；被怀疑方主动 ping 能更快洗白；网络劣化窗口
（本机多链路同时抖动）整体进入"低敏感模式"（抬高所有时限）。
- 效果：消除长跑假阳性翻动（用户截图里"疑似离线，确认中…"/"⚠ 74s 未报告"
  一类抖动的协议层来源）。

### P2 结构升级（房间规模/日志规模进一步增长后）

- Merkle 分段对账：按天分桶哈希，先对账桶哈希再拉差异桶——游标法的无状态版，
  解决"换设备/清数据后游标失效"的首连成本；
- sync 搬到 Web Worker：序列化/合并不占渲染进程主线程；
- presence 分层：活跃房间 10s、无人变化时降到 30s（流量减半）。

### P3 度量基线（把"感觉"变成数字）

主进程每 10min 记录：渲染进程内存、blob 数、DOM 节点数、入站帧速率、各链路
断开计数——设置页加一页"健康"面板。长跑问题从此可观测、可回归验证。

---

## 五、其他可能原因清单（当前证据下的排除与保留）

| 嫌疑 | 评估 | 依据 |
|---|---|---|
| App Nap / 后台节流 | ✅ 已排除 | NSAppSleepDisabled + backgroundThrottling:false 实测 TICK 正常 |
| Electron 主进程阻塞 | 低 | 主进程只有 hub/cloudflared/托盘，均为事件驱动 |
| Trystero 信令连接死亡 | 保留（次生） | 只影响新 P2P 建立；presence/消息/握手全走自有中继层，不是"全员掉线"形态 |
| 公共 broker 限流/踢线 | 真实存在 | 退避修复前我们就是最大的噪音源（3s 轰炸）；修复后风险大幅下降 |
| NAT 长连接静默超时 | 真实存在 | 家用路由/NAT 网关 TCP 表项常 5-30min 超时；keepalive 30s 应能保活，但 QoS0 半开（TCP 活着应用层黑洞）已实测存在——半开探测即为它而设 |
| 移动端 Doze | 真实存在（手机端） | 已有时钟漂移检测 + goOnline 兜底；Android 15 后台限制会进一步收紧 |

---

## 六、结论（主解决方案一句话版）

资源开销六项修复解决的是"别把自己弄死"；**要达到"长期运行的理想稳态"，主攻
三件事：①全局看门狗把'必须重启'变成'自动硬复位'（自愈下限）；②增量游标同步
把对账开销与数据总量解耦（O(N)→O(分歧)）；③关键帧 QoS1+会话保持让断线窗口
的删除/DM 不再依赖低频全量反熵（丢帧兜底）**。三者都建立在既有骨架上
（SWIM digest 已捎带、mid/tombstone 原料已齐、txid 去重已就位），无需推翻
现有架构。

## 参考

- SWIM: Das, Gupta, Motivala — *SWIM: Scalable Weakly-consistent Infection-style
  Process Group Membership Protocol* (DSN 2002)
- Lifeguard: Prakash et al. — *Lifeguard: SWIM-ing with Situational Awareness*
  (HashiCorp, 2020)；memberlist/Serf 实现
- van Renesse et al. — *Efficient Reconciliation and Flow Control for Anti-Entropy
  Protocols* (Scuttlebutt, LADIS 2008)；Cassandra gossip 即其落地
- Dynamo: DeCandia et al. (SOSP 2007) — Merkle 反熵/hinted handoff
- HiveMQ MQTT Essentials Part 7/8 — persistent session 与 QoS 离线排队语义；
  EMQ：MQTT Persistent Session and Clean Session Explained
