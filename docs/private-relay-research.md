# 私有中继服务研究：客户端兼营 MQTT 中继 + Cloudflare 暴露（及替代方案）

> 2026-10-02 调研。动因：公共 EMQX broker 的实测痛点——夜间 SSL 错误频发（comprehensive 多轮
> 因 broker 窗口劣化失败）、QoS0 拥堵（大文件帧挤死心跳，v1.17.2 根因）、丢包（网关级），
> 以及公共 TURN 已消亡的先例（见项目记忆）——**公共免费基础设施随时可能劣化到不可用**。
> 用户提案：一个客户端同时开启"中继服务模式"，充当私有 MQTT broker，用 Cloudflare 暴露稳定
> 服务地址，作为全房间的中继。
>
> **✅ P0 已落地（v1.23.0）**：electron/hub.js（内嵌 Aedes，仅绑 127.0.0.1）+ cloudflared
> 快速隧道托管（二进制缓存于 OrayChat/cloudflared/，PATH/基础目录自动查找，找不到优雅降级
> 为本机链）+ 设置页「中继服务模式」卡（启停/端口/隧道/复制接入地址/状态灯/日志）+
> relay.mjs addBroker() 运行时并链 + 主机自动接入本地回环链 + CSP 放行 ws:。
> 实测：test/hub-live.mjs（纯私有链拓扑：握手/消息/文件/SHA 全绿）与
> test/hub-tunnel-live.mjs（bob 仅连 wss://<trycloudflare>.com 经 CF 边缘全公网握手+消息 ✓）。
> ⚠️ 落地坑：aedes 1.x 必须用 `await Aedes.createBroker()`（new Aedes() 半初始化不回 CONNACK）；
> aedes-server-factory 的 ws 分支不处理 mqtt.js 的 `mqtt` 子协议（connack timeout）——自建
> http+ws 桥（handleProtocols 协商）；CSP connect-src 需加 ws:。

## 0. 结论先行

**可行，且与现有架构契合度极高。** relay.mjs 的并联链路设计（v1.11.0，Nostr 式多 broker 并联
+ txid 去重 + 单链路自愈）意味着：私有 broker 接入 = 在设置页 broker 列表里多一行 URL，协议层
零改动。E2EE 在 relay 层已有（`sealRoom/openRoom`，broker 只见密文），私有化不改变信任模型。
推荐分三档落地（P0 客户端+CF Tunnel / P1 VPS 自建 / P2 Serverless），P0 约两天工作量。

## 1. 现状与痛点（为什么值得做）

| 痛点 | 实测证据 | 私有中继的改善 |
|---|---|---|
| 公共 broker 夜间 SSL 错误 | comprehensive 多轮 25-28/29 失败均伴随 `SSL_ERROR_SYSCALL`/`加入房间失败`，重跑隔窗口才过 | 自家 TLS 端点，无嘈杂邻居、无共享限流 |
| QoS0 拥堵 | v1.17.2：大文件帧挤死心跳/presence → SWIM 误判 → 会话被拆（已用 32KB 块+pacing 缓解，但公共队列不可控） | 带宽独享，队列可观测可控（可调 QoS/限速） |
| 无 SLA、随时劣化 | 公共 TURN 消亡先例；EMQX 公共服务无承诺 | 自有基础设施（受限于主机在线，见 §4） |
| 无法观测 | broker 侧行为黑盒 | Aedes/EMQX 自带日志、连接数/流量指标 |
| 可选：反垃圾 | 房间名即边界，任何人可向 topic 投喂密文垃圾（读不懂但可占带宽） | 可加 broker 级 token 认证（§5） |

## 2. 信任与安全模型（不变式核查）

- **E2EE 不受影响**：中继帧全部经 `sealRoom`（HKDF 房间密钥 + AEAD）加密，broker 只见
  `{from, kind, 密文, txid}`。私有 broker 的运营者（=房间成员自己）比公共 EMQX 的运营者
  （=任何人）更可信而非更可疑。
- **房间边界不变**：房间名仍是群体边界；broker URL 的私密性只是额外的准入窄门（不知道 URL
  连不上），不是安全边界——安全仍由 E2EE 与房间密钥承担。
- **隐私面**：CF Tunnel 边缘节点可见 SNI/流量元数据（时长、体量），与走公共 EMQX 相同量级；
  内容仍不可见。

## 3. 三条方案对照

### P0 客户端兼营 broker + Cloudflare Tunnel（用户提案，推荐首选）

**架构**：Electron 主进程内嵌 [Aedes](https://github.com/mosjs/aedes)（纯 JS MQTT broker，零
原生依赖）→ cloudflared Tunnel 出站连接 → 固定域名 `wss://mqtt.<你的域名>` → 房间成员把它
加进 broker 列表成为第 3 条并联链路。

```
[Mac 客户端]                [手机/其他成员]
 Electron main                relay.mjs 并联链路
 ├─ 渲染层（现有）      ┌───>  链1: broker-cn.emqx.io（公共兜底）
 ├─ Aedes broker :8083 ─┤───>  链2: broker.emqx.io（公共兜底）
 └─ cloudflared 出站 ───┴───>  链3: wss://mqtt.example.com（私有，优先用）
        ↑ CF 边缘（443/WSS，无需公网 IP/端口映射）
```

**为什么极低风险**：
- relay.mjs 已支持任意 broker 列表并联（`parallelN`、txid 去重、单链路死亡自动重连）——
  私有链只是列表多一项；`aliveLinks()` 保证任一存活即 `connected`。
- 私有链宕机 → 自动回落公共双链，房间不中断（现状即如此）。
- mqtt.js 客户端连 Aedes 与连 EMQX 无差别（标准 MQTT 3.1.1 over WSS）。

**工作量分解（估 1.5-2 天）**：
1. Electron main 内嵌 Aedes + `ws` 桥（~100 行）：仅 `--relay-hub` 或设置开关时启动；
   绑定 127.0.0.1。
2. cloudflared 生命周期管理（~80 行）：`app.getPath('userData')` 下二进制缓存
   （`cloudflared` npm 包或首次下载）；命名隧道需用户一次性 `cloudflared login`+
   配置域名（UI 引导页）；quick tunnel（trycloudflare.com）零配置但 URL 每次变——
   仅适合测试。
3. 设置页「中继服务模式」区块：开关、域名显示、成员接入 URL 一键复制、状态灯（连接数）。
4. 成员接入：**v1 手动**——主机把 `wss://...` 发给成员，成员粘贴进设置页 broker 列表
   （编辑能力 v1.7.0 已有）；**v2 自动**——ctl 帧广播 hub 配置（经公共链加密传播），
   成员自动并入 broker 列表并持久化。
5. Aedes 侧可选项：房间 token 认证（见 §5）、每连接限速。

**性能边界**：
- 上行带宽 = 主机家庭/办公网络上行为主瓶颈（中继流量全经它）。100Mbps 上行≈12MB/s，
  足够 30 人房间聊天+语音+常态文件；大文件仍优先 P2P 直连（relay 只是回退/信令）。
- CF 免费隧道代理 WebSocket 无带宽计费；聊天规模完全在 ToS 合理使用内。
- 延迟：成员→CF 边缘→主机→（可选经 CF 回成员）比直连公共 broker 多一跳边缘，
  但换走 TLS 稳定+无拥堵；实测建议压测对比（现有 bot 矩阵可直接跑）。

**风险与缓解**：
- 主机休眠/离线 → 私有链掉线，自动回落公共链（现有自愈全覆盖）；提示用户主机端
  已有 App Nap 禁用（v1.9.1）。
- cloudflared 外部依赖 → 缓存于 userData；启动失败仅降级为"无私有链"，不阻塞应用。
- 端口冲突/防火墙 → 绑定 127.0.0.1 随机高位端口，cloudflared 出站无需入站规则。

### P1 VPS 自建（最稳，月成本 ~$4-6）

同款 Aedes/EMQX/NanoMQ（docker compose）跑在便宜 VPS（Hetzner/腾讯轻量等）+ Caddy 自动
TLS，域名直连不走 CF。**顺带解决第二个老大难**：同机部署 coturn（TURN over UDP）——
公共 TURN 已消亡，自建 TURN 直接提升 P2P 直连率（当前直连失败一律走 MQTT 中继，带宽
效率远低于 TURN UDP 转发）。设置页 TURN 列表已存在，填入即用。
适合：有 VPS 或愿意花小钱；家中上行慢/主机不常开。
工作量：compose 一小时 + 设置页填 URL；客户端零改动（broker/TURN 都是配置项）。

### P2 Cloudflare Workers + Durable Objects（Serverless，无主机依赖）

用 DO 实现"房间扇出 hub"（不必是 MQTT——可以更简的自有 WSS 协议；relay.mjs 增加第三种
transport 类型即可，与 mqtt 链路并存）。无需任何机器在线、全球边缘、$5/mo Workers Paid
（DO 需要；无流量出口费）。工程量最大（~3-5 天）：DO WebSocket 扇出 + 存活管理 + 与
relay.mjs 传输抽象对接；且引入 CF 平台绑定（宕机史：2024-06 与 2025-11 两次全球级故障）
。**建议作为 P0/P1 稳定后的可选冗余**，不作为首选。

### 对照表

| | P0 客户端+CF Tunnel | P1 VPS 自建 | P2 Workers DO |
|---|---|---|---|
| 稳定性 | 高（主机在线时） | **最高**（机房+专职） | 高（平台级） |
| 成本 | 0 + 自有域名 | ~$5/月 | $5/月 |
| 工作量 | 1.5-2 天 | ~半天（客户端零改动） | 3-5 天 |
| 附加收益 | 中继服务模式（可分享他人房间） | **+自建 TURN 提升直连率** | 无主机依赖 |
| 主要风险 | 主机离线/家宽上行 | 无（最传统可靠） | 平台绑定+工程量 |
| E2EE 影响 | 无 | 无 | 无 |

## 4. 通用设计原则（三档通用）

1. **并联而非替换**：私有链永远是第 3 条链，不是唯一链；公共双链保留为兜底。
   现有 `aliveLinks()` 语义已正确（任一存活即在线）。
2. **中继无脑**：broker 永远只见密文、只做扇出；不引入服务端逻辑（保持 SimpleX/DERP
   式"dumb relay"哲学——自愈、去重、排序全部留在端上，已有）。
3. **可观测**：私有 broker 记连接数/消息量/字节量日志；UI 状态灯显示每条链路健康
   （现有「公共MQTT中继」徽标扩展为多链路指示）。
4. **退化即现状**：私有链任何故障的最终表现=回到今天的公共双链，不新增故障模式。

## 5. 可选增强（不在 P0 必做清单）

- **Broker 级 token 认证**（反垃圾，非安全）：开启中继模式时生成房间 token；mqtt.js
  username/password 携带；Aedes authenticate 钩子校验。crypto.mjs 的 roomPassword 能力
  自 v1.2.0 休眠保留，也可在信令层复用（SDP 信令加密兼门禁）。
- **多主机冗余**：两个成员各开中继模式 → 列表两条私有链，parallelN 并联天然支持。
- **压测基线**：用现有 bot 注入器跑"私有链 vs 公共链"对照（消息 RTT、文件吞吐、
  SSL 错误率），数据决定要不要把私有链优先级排到公共链之前。
- **家用盒子形态**：中继模式同样适合树莓派/NAS 常驻（等同于 P0 的"主机不关"版）。

## 6. 建议路线

1. **P0（推荐立即做）**：客户端中继服务模式（Aedes + cloudflared 命名隧道 + 设置页 +
   手动分享 URL）。两天内可落地，零协议风险，直接吃掉夜间 broker 劣化的痛点。
2. **P1（若有 VPS/愿意花小钱）**：VPS compose（broker+coturn），客户端只填两行配置；
   顺带把直连率问题一起解决。
3. **P2（观察后定）**：Workers DO serverless hub，作为无主机冗余链评估。
4. 全程保持 §4 的四条原则；先用 bot 矩阵建立基线，落地后对照收益。
