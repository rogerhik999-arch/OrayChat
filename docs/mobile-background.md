# 手机端后台驻留 — 设计备忘（暂缓实施）

> 状态：**暂缓**（2026-09-26 产品决策：当前"离线暂存 + 上线同步"已覆盖核心体验，
> 真正的后台驻留涉及原生层改造，延后评估）。本文记录现状、可行方案与边界，
> 后续启动时以此为起点。

## 现状（v1.3.0）

- 手机端（Capacitor WebView）**没有**后台驻留：切后台/锁屏后 JS 定时器暂停、
  套接字被系统切断，WebRTC 连接进入断开状态。
- 体验由两套既有机制兜底：
  1. **离线暂存**：共享日志全体保存——离开期间的大厅消息在其他成员的
     `local-state.json`（Android/iOS 为 WebView localStorage）中持久化；
  2. **上线同步**：重新打开 App 时自动重新握手 + 与在线成员交换状态合并，
     错过的消息补齐；`connectionstatechange` 断线检测会提示并自动降级中继。
- 系统可能短暂保留进程（各厂商差异大，MIUI 等更激进），但行为不可依赖。

## 关键约束：WebView 的 JS 在后台会被暂停

即使进程存活，Android/iOS 都会冻结后台 WebView 的 JS 定时器与网络调度。
因此"把现有页面切后台"不能实现持续收消息——任何方案都必须把"保活连接"
的职责移出页面 JS，或依赖系统推送。

## Android 可行方案

### 方案 A：前台服务 + 常驻通知（最接近桌面托盘形态）
- `Foreground Service` + 常驻通知栏"OrayChat 运行中"（需 `FOREGROUND_SERVICE`
  与 `POST_NOTIFICATIONS` 权限，Android 13+ 要运行时申请）。
- 坑：**前台服务只保进程不死，WebView 的 JS 照样被冻结**。要后台收消息需：
  - `@capacitor-community/background-runner`：官方社区插件，在独立后台 JS
    环境跑精简任务（无 DOM）。需要把"MQTT 心跳 + 收信暂存"重写为该环境的
    独立模块（复用 crypto.mjs 的加密原语是可行的——纯 JS），消息落到
    Preferences/storage，回前台由主页面合并。
  - 或第三方 WebView 保活插件（如 background-mode 类）：兼容性风险高，
    各厂商系统（MIUI/EMUI/ColorOS）有额外的电池白名单限制。
- 工作量估计：插件集成 + 后台任务重写 + 厂商兼容测试 ≈ 2-4 天。

### 方案 B：推送提醒（国内现实方案）
- 离线消息经推送通道提醒，点通知回 App 后走既有同步。
- FCM 在国内不可靠；需要接厂商通道（小米/华为/OPPO/vivo 各自 SDK）或
  聚合推送服务。与"私有化"定位有张力（推送依赖厂商云）。
- 工作量估计：单厂商通道 1-2 天，聚合则更多。

### 方案 C（最低成本）：维持现状
- 依赖上线同步。断线提示（v1.1.0 起）已让用户知道错过消息需要重连。
- 缺点：用户离开期间不实时。

## iOS 可行方案

系统不允许无限期后台运行，现实选项：
- **远程推送**（APNs）：离线时由自建中继/推送服务下发；需 Apple 开发者账号
  与推送证书（当前无账号）。
- Background Fetch / Processing Task：受系统调度，不保证实时。
- 结论：iOS 采用"推送 + 上线同步"，接受系统限制。

## 实施前置条件

- [ ] 产品确认 Android 前台服务的通知形态与厂商兼容范围
- [ ] 若走推送：确认私有化部署的推送服务形态（自建 unifiedpush / 厂商通道）
- [ ] background-runner 模块的加密兼容性验证（crypto.mjs 在该环境的可用性）

## 相关代码

- 心跳与断线检测：`renderer/src/net.mjs`（`sendPresenceHeartbeat` /
  `attachConnectionWatch` / `handleConnectionDrop`）
- 离线暂存与同步：`renderer/src/store.mjs` + `net.mjs pushSync/onSyncFrame`
- 中继层：`renderer/src/relay.mjs`（presence/inbox，后台任务可直接复用其
  topic 协议与帧加密）
