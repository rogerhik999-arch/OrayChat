# 分布式 IM 的语音与视频：技术/产品方案调研 → OrayChat 借鉴分析

> 调研时间：2026-09-30 · 对应实现基线：v1.20.0（filex 文件传输 + FEC + 双路径 + 流压缩已就绪）
> 结论先行：**语音/视频消息（录完再发）是分布式无中心架构的"亲儿子"**——存储转发、
> 断点续传、离线收发，与我们的 filex 完美叠加，成本极低；**实时通话**是另一族技术
> （WebRTC 媒体路径），1:1 通话可零基建落地（Trystero 已内建媒体流支持），但要
> 正视"公共 TURN 已死"的现实：P2P 打不通的对称 NAT 下只有音频量级有中继可能。

---

## 一、产品形态与技术方案调研（业界对照）

### 1.1 主流产品对照表

| 产品 | 语音消息 | 视频消息 | 实时通话 | 架构 | 关键技术事实 |
|---|---|---|---|---|---|
| WhatsApp | OGG/Opus（`PTT-*.opus`），波形气泡、一键倍速 | "圆形视频消息"（PTV）：MP4 H.264/AAC + `videonote` 标志，圆形循环气泡 | 1:1 P2P 优先→中继；群通话经专用媒体服务器 | 中心云（E2EE） | 双击麦克风发圆视频；语音转写端上 |
| Signal | 附件式 Opus 音频 + 波形 | 无专门视频消息 | 1:1 P2P/中继（RingRTC，WebRTC 分叉）；群通话自建 SFU | 中心云（E2EE + sealed sender） | 语音消息与文件同一附件加密管道 |
| Telegram | OGG/Opus + 波形 | 圆形视频消息（MP4） | 群语音聊天 SFU（WebRTC）；1:1 P2P | 中心云（默认非 E2EE） | 云端媒体，无 E2EE 负担 |
| **SimpleX** | 二进制文件走 SMP 队列，E2EE | 同左 | WebRTC，**信令搭自有消息协议的车**；中继只见时长不见内容；用户可自配 STUN/TURN | 无 ID 去中心（SMP 队列） | 与我们最同构：消息层当信令、媒体走 WebRTC |
| Matrix/Element | OGG/Opus + 波形，走加密附件 | 同附件 | m.call.* 信令走房间事件，媒体 WebRTC **必须 TURN**；群通话 SFU | 联邦（homeserver） | 联邦架构仍绕不开 TURN——说明这不是"中心化才有"的问题 |
| Session | 附件语音 | — | WebRTC 1:1，信令经 onion 路由 | 去中心（Oxen 网络） | 弱网体验差的公开抱怨集中在通话 |
| Briar | — | — | **仅语音**、纯 P2P over Tor，无视频 | P2P（蓝牙/LAN/Tor） | 极端分布式下连视频都放弃 |
| Jami | — | — | 音视频通话，P2P over DHT，RTP/TLS | 完全分布式（DHT） | DHT 当信令+ICE，无 TURN 依赖但连通率靠运气 |
| Tox | — | — | Opus + VP8/VP9 over P2P | 完全分布式（DHT） | 自研协议栈，媒体走自有可靠传输 |

### 1.2 关键技术组件（跨产品共识）

**语音消息（录后发）**
- 编码：Opus 是绝对主流（语音甜点 16-24kbps 单声道，1 分钟 ≈ 150-200KB）；iOS 系是 AAC
- 容器分裂：Chromium 系 `audio/webm;codecs=opus`；**iOS Safari 只支持 `audio/mp4`（AAC）**
  ——WhatsApp/Telegram 能统一 OGG/Opus 是因为原生录制，Web 系产品必须双格式共存
- 波形：录音时按固定窗口算 RMS，压缩成几十字节（如 48 个 0-9 数字或 6×8bit），随消息元数据走——
  这是"气泡里波形"的全部成本，无需传输音频即可渲染
- 时长、采样率进元数据；播放用 `<audio>`/WebAudio，倍速切换是标配 UX
- 转写：WhatsApp/Telegram 端上转写（Whisper 类模型）；Web 端 wasm 模型体积大，移动端慎入

**视频消息（录后发）**
- 录制即压缩：`getUserMedia` 分辨率约束（480-720p）+ `MediaRecorder` 码率上限（0.8-1.5Mbps），
  **录后不再转码**（Web 端无硬件转码路径，事后转码得不偿失）
- 时长上限（WhatsApp 圆视频 ≤60s）控制体积在 3-8MB
- 缩略图：首帧 `createImageBitmap(video)` → 96px WebP（我们的 makeThumb 已具备）
- 容器同样分裂：Android/桌面 webm(VP8/VP9)，iOS mp4(H.264)——mime 随元数据

**实时通话（WebRTC 媒体路径）**
- 1:1：P2P 直连优先，打不通走 TURN/中继；SRTP 媒体自带拥塞控制、RTCP、抖动缓冲
- 回声消除/降噪/自动增益：**getUserMedia 约束白拿**（`echoCancellation/noiseSuppression/autoGainControl: true`），
  自研 DSP 是下策
- 信令：SimpleX 证明"信令搭消息协议车"是成熟做法（我们已有：ctl 通道）
- 组通话：Mesh（每人上行×N，≤4 人）或 SFU（自建服务器）；**无中心架构无 SFU 是硬短板**
  ——Briar 干脆不做视频、Jami 靠 DHT 碰运气

**媒体传输（消息形态）的分布式优势**
- 存储转发：录音时对方离线完全没关系（gossip 同步），实时通话则要求双方同时在线
- NAT 穿越不是前置条件：消息走既有会话/中继，无 TURN 也能送达（我们的 MQTT E2EE 中继已验证）
- 带宽是柔性的：断点续传 + 慢速中继照样到达，通话则 QoS 硬约束

### 1.3 分布式/无中心架构的特有约束（各家踩过的坑）

1. **无 TURN 的连通率墙**：对称 NAT/企业防火墙下 P2P 打不通。中心产品用 TURN 兜底
   （全球部署、烧钱）；SimpleX 靠自有中继隐藏 IP 但仍需媒体路径；Briar/Tox 用 DHT 中继/直连
   ——**连通率换去中心是固有代价**。我们公共 TURN 已死，中继只剩 MQTT（文本量级）
2. **MQTT 中继不适合实时媒体**：QoS0 公共 broker 限流 + base64 开销 33% + 抖动；
   音频（24kbps ≈ 240KB/min）勉强可用作兜底，视频（≥500kbps）不可行
3. **gossip 成本×N**：私聊是成对会话，语音/视频消息发到大厅 = N 份加密副本；
   1 分钟音频 ×10 人 ≈ 2MB 日志流量——小房间可接受，需要产品上默认私聊发媒体
4. **移动端后台**：录音必须前台（我们后台 WebView 本就冻结，无冲突）；通话中锁屏
   的后台保活是原生层课题（Android 前台服务/iOS CallKit），Web/Capacitor 有天花板
5. **浏览器碎片化**：iOS/Android WebView 的 MediaRecorder 输出格式不同、WebCodecs
   音频编码 Safari 支持残缺——**媒体形态要"录什么放什么"（mime 随消息走），
   不做服务端统一转码**（我们本来就没有服务端）

---

## 二、对 OrayChat 的适配分析

### 2.1 已有能力映射（filex 红利：语音/视频消息 ≈ 免费获得 80%）

| 语音/视频消息需要 | 我们已有（v1.20.0） | 差距 |
|---|---|---|
| E2EE 分片传输 + 断点续传 | filex：sealBin/FEC/位图持久化/多源 | ✅ 直接用 |
| 小文件优先快速通道 | 令牌桶 pacing + 自适应窗口 + unordered 通道 | ✅ 直接用 |
| 元数据随消息同步 | store FX 白名单字段（type/fid/name/size/mime/w/h/thumb/mode） | 加 duration/waveform/采样率 |
| 图片/视频缩略图 | makeThumb（首帧 WebP ≤6KB 进日志） | ✅ 直接用 |
| 图片格式压缩 | compressImageForSend（WebP） | 视频不走它（录制即压缩） |
| 移动端 | Capacitor WebView（Chromium/iOS WKWebView） | 录制权限/格式分裂需处理 |
| 播放器 UI | — | 全新：气泡播放器 |

**核心判断：语音/视频消息 = MediaRecorder（几十行）+ filex 新 kind + 播放器 UI + 元数据两字段。
没有新的网络协议、没有新的加密面、没有新的基础设施。**

### 2.2 本地核实的 Trystero 能力（实时通话的关键事实）

`@trystero-p2p/core` 的 room 层已内建媒体流支持：`addStream/addTrack/replaceTrack/removeTrack`
+ 远端 track 回调（`room.mjs`：trackMetaAction + mediaManager），**跑在信令所在的同一条
peer connection 上**。含义：

- 1:1 音视频通话**零额外信令基建**：呼叫/响铃/挂断走我们 ctl 通道（SimpleX 同款"信令搭消息车"），
  媒体走 Trystero addStream（浏览器原生 SRTP/AEC/抖动缓冲全套白拿）
- 呼叫与聊天共用会话信任（安全码/E2EE 身份已核对），无新中间人面
- 媒体与数据同 PC 意味着：MQTT 中继模式下媒体仍需直连（信令可中继，SRTP 不行）——
  **通话的可达性 = filex 的 P2P 直连率**，中继兜底不存在（除音频隧道实验外，见 P2）

### 2.3 平台碎片化决策（录音格式）

实测确认的浏览器事实：
- Chromium（桌面/Android WebView）：`audio/webm;codecs=opus` ✅ / `video/webm` ✅
- iOS WKWebView（Safari 14.1+）：仅 `audio/mp4`（AAC）/ `video/mp4`(H.264)；**无 webm/opus**

决策：**录什么存什么**——MediaRecorder 按 `isTypeSupported()` 顺序选格式，mime 进消息元数据，
播放端用 `<audio>`/`<video>` 原生解码（双方系统播放器都原生支持对方格式：
Chromium 放 aac/mp4 ✅，iOS 放 opus/webm ✅[Safari 14.1+ 起支持 WebM 容器解码的 Opus]）。
不引入 opus wasm 转码器（体积/复杂度不划算）。发送前算好 duration + waveform（48 点 4bit 压缩）。

### 2.4 产品形态决策

- **私聊优先**：语音/视频消息只进 DM（与 filex 同边界）。大厅发 = N 份副本 + 日志膨胀，
  小房间（≤8 人）后续放开
- **视频消息限时 60s、分辨率 480p 竖屏**（WhatsApp 同款体量，3-8MB），语音不限时但
  UI 提示超过 5 分钟建议发文件
- **实时通话 1:1 起步**：群通话无 SFU 不做（明确不做，见下）
- 通话 UI：呼叫走 ctl（ringing/cancel/accept/reject/hangup），响铃本地 Notification + 横幅；
  通话中消息照常发（同一会话）

---

## 三、落地路线（P0-P3）

| 级别 | 项 | 借鉴来源 | 说明 | 工作量 |
|---|---|---|---|---|
| ✅ P0-1（v1.21.0） | 语音消息 | WhatsApp/Element/SimpleX | MediaRecorder 双格式（webm/opus 或 mp4/aac，isTypeSupported 探测）→ filex `kind:'voice'` + duration/waveform(48点0-9串)/元数据进 offer 与日志白名单 → 气泡播放器（波形进度/倍速 1x-1.5x-2x/全局互斥/未完成接收提示）。移动端权限：Android RECORD_AUDIO+MODIFY_AUDIO_SETTINGS / iOS NSMicrophoneUsageDescription。实机验证：合成 WAV 双实例全链路（元数据一致/字节 SHA 一致/duration/waveform 保留） | 2-3 天 |
| P0-2 | 视频消息 | WhatsApp 圆视频 | 限时 60s 录制（480p + 码率上限）→ filex `kind:'video'` + 首帧缩略图（复用 makeThumb）→ 内嵌播放气泡 | 2 天 |
| P1 | 1:1 实时通话（音频优先，视频同栈） | SimpleX（信令搭消息车）+ Trystero addStream | ctl 信令（offer/answer 经 E2EE ctl 帧）/响铃/挂断；媒体 `room.addStream`；回声消除用 getUserMedia 约束；无 TURN：直连失败时如实提示"当前网络无法建立通话，可发语音消息"（诚实的产品化，不做假兜底） | 4-5 天 |
| P2 | 音频隧道实验（可选） | Briar/Tox 思路 | 24kbps Opus（WebCodecs 或 MediaRecorder 切片）打包走 fx 数据通道 + MQTT 中继——对称 NAT 下的降级通话。带宽可行（≈240KB/min），延迟/抖动需实测；效果差就砍 | 2-3 天实验 |
| P3 | 语音转写 | WhatsApp 端上转写 | 浏览器 SpeechRecognition（Chrome 免费但走 Google 服务，与私有化相悖）或本地 wasm（体积大）——**默认不做**，列为可配置实验 | 实验性质 |
| 不做 | 群实时通话/SFU | — | 无自建服务器前提无解；Briar/Tox 同样放弃 | — |
| 不做 | 服务端转码/统一格式 | — | 我们没有服务端；客户端转码 wasm 收益不抵复杂度 | — |
| 不做 | 通话加密面扩展 | — | 复用会话身份与安全码，无新的密钥协商 | — |

### 集成细节（P0 实现备忘）

- 元数据：`{type:'voice', duration, waveform: '<48字符4bit压缩串>', rate}`；视频
  `{type:'video', duration, w, h, thumb}`——store FX 白名单加 `duration/waveform/rate`
- 语音气泡：未读蓝色小圆点 + 波形 + 时长；播放互斥（同时只放一条）；倍速 1x/2x
- 录音 UI：按住说话（touchstart/touchend + 上滑取消），桌面端点按开始/结束
- 权限失败（移动端拒授）→ 提示引导，不静默
- 文件落盘命名带原始扩展名（filex 已按 fid+.ext 存，播放器读 mime）
- 日志同步：voice/video 的元数据+缩略图随共享日志 gossip，字节走 filex（大堂 N 份成本仅文本消息场景存在，DM 不受影响）
