# OrayChat — 私有化 P2P 端到端加密聊天（桌面端）

一个**开源技术栈**的私有 P2P 加密聊天桌面应用（Electron + WebRTC + Node.js）：

- **登录即组网**：任意互联网终端登录后，自动与同一房间内所有在线用户建立全互联（mesh）连接
- **大厅群聊**：房间即大厅 —— 消息对房间内所有人可见；对每个成员单独建立加密会话分发
- **共享消息日志（可合并）**：大厅与私聊记录**全体保存**（每成员各存一份）；
  **任何成员可发起删除**（删单条/清空会话），删除自动传播、**所有成员同时生效**；
  **上线即全局同步**（与对端交换会话状态并合并收敛，离线期间的记录自动补齐）
- **保留 30 天**：按时间戳确定性过期，本地与同步导出一并过滤
- **消息端到端加密（E2EE）**：Ed25519 身份 + X25519 临时密钥协商 + XChaCha20-Poly1305 AEAD，
  只有通信双方可以解密；信令服务器、中继服务器、局域网窃听者均无法看到内容
- **P2P 直连优先**：WebRTC DataChannel（DTLS 之上再叠加应用层 E2EE，双层防护）
- **房间口令（门禁 + 信令加密）**：可选。启用后口令派生密钥加密 SDP/ICE 信令与 MQTT
  中继层全部帧 —— 口令不符者无法解密信令、无法注入有效帧、无法与成员建立任何会话；
  口令仅存内存、永不出网。可选"在本机记住口令"（默认关闭，明文存本机，适合磁盘加密设备）
- **免费公共基础设施完成"初始化（信令）+ 中继"**，全程无需自建服务器即可使用（详见下文）
- **中继回退**：实测发现当前所有免注册公共 TURN 已失效，本项目实现了
  **公共 MQTT E2EE 加密中继回退** 作为兜底 —— 打洞失败时消息经公共 broker 转发，
  broker 仍只见密文

## 快速开始

```bash
npm install          # macOS / Windows / Linux（Node ≥ 18）
npm start            # 构建 renderer 并启动应用
```

两台机器（或同机两个实例）各自输入昵称、填**相同房间号** → 登录 → 自动互连 → 聊天。

同机多开测试：

```bash
npx electron . --profile=pc1   # 终端 1
npx electron . --profile=pc2   # 终端 2（--profile 隔离身份与数据）
```

## 架构

```
┌────────────────────────── Electron 渲染层 ──────────────────────────┐
│  UI (app.mjs)                                                      │
│   ├─ crypto.mjs  E2EE：Ed25519身份/X25519握手/XChaCha20-Poly1305    │
│   └─ net.mjs     双传输会话层（握手状态机/重传/回退/升级）            │
│        ├─ 首选: WebRTC DataChannel（Trystero + 公共STUN/TURN）      │
│        └─ 回退: relay.mjs 公共MQTT中继（同一套E2EE信封）             │
├────────────────────────── Electron 主进程 ─────────────────────────┤
│  main.js: 多profile实例 / 身份密钥本地存储(0600) / 配置覆盖          │
└─────────────────────────────────────────────────────────────────────┘
     │ 信令(仅SDP/ICE与presence)         │ 消息(仅密文)
     ▼                                   ▼
 公共 MQTT broker(WSS)              P2P 直连 / 公共MQTT中继
 (broker-cn.emqx.io 等)             (WebRTC DTLS / MQTT WSS)
```

## 免费公共基础设施（"初始化 + 中继"难题的解法）

| 环节 | 服务 | 状态（本机实测） |
|------|------|------|
| 信令/初始化 | 公共 MQTT broker（`broker-cn.emqx.io` / `broker.emqx.io` / `test.mosquitto.org`，WSS 443/8081） | ✅ 三家全部连通（`npm run check:services`） |
| STUN 打洞 | Google / Cloudflare / 小米公共 STUN | ✅ 均返回正确映射地址 |
| TURN 中继 | Open Relay（openrelay.metered.ca） | ❌ 共享凭据已在服务端失效（详见下） |
| 中继兜底 | **公共 MQTT E2EE 加密中继**（本项目实现） | ✅ 两实例强制中继模式加密往返通过 |

**为什么不用公共 TURN？** 我们按 RFC 5766 完整实现了 Allocate 两步握手探测
（`tools/check-services.mjs`、`tools/turn-hunt.mjs`），并用 Chromium 真实 WebRTC 栈
交叉验证：Open Relay 的免费共享凭据（openrelayproject）当前返回 `401 → 400`，
Chromium 侧同样 `TURN allocate error`；其他免注册公共 TURN（anyfirewall 等）已下线。
**结论：免注册公共 TURN 基本消亡** —— 这正是本项目要解决的难点。

**解法：MQTT E2EE 中继回退（relay.mjs）**。打洞失败/直连断开时，同样的加密信封
改经公共 MQTT broker 定向投递（每端订阅自己的 inbox topic，10s presence 广播在线）。
由于会话密钥由双方身份密钥协商、消息逐条 AEAD 加密，**broker 只是"瞎子的邮局"**。
P2P 恢复后会话自动升级回直连。配合握手重传与超时重试，QoS0 丢帧可自愈。

## 安全模型

- **身份**：首次登录生成 Ed25519（身份签名）+ X25519（密钥协商）密钥对，
  存于 `<userData>/identities/`（0600）。昵称只是显示名，真实身份是公钥指纹。
- **握手**（Sigma 风格，4 帧，发起方由 peerId 字典序确定性指定，防同时握手）：
  双方各用身份私钥对"临时公钥 + 转写哈希"签名，防信令层中间人；
  会话密钥 = HKDF(X25519 eph↔stat ×2 ‖ eph↔eph ‖ stat↔stat)，**每次连接新鲜临时密钥 → 前向保密**。
- **消息**：XChaCha20-Poly1305，AAD 绑定发送方身份 + 单调序号（防篡改/重放/跨会话搬移）。
- **房间口令（可选）**：群体的"门禁 + 信令加密"。口令派生两个密钥：
  ① Trystero 信令密钥（SDP/ICE 全部加密，口令错者无法进入）；
  ② 中继层帧密钥（presence/inbox 全加密，无口令者无法旁听也无法注入）。
  口令仅存内存、不落盘、不出网。
- **安全码**：双方身份公钥的联合指纹（20 位数字，两端一致），线下核对即可确认无中间人（Signal 同款机制）。
- **威胁模型**：假定信令/中继服务器完全不可信（它们只见到握手签名与密文）；
  不防"线下核对安全码偷懒"与端点本机失窃（可后续加口令加密密钥库）。

## 私有化部署（完全自托管）

应用层无需改动，把公共基础设施换成自有服务即可 —— 修改
`<userData>/oraychat-config.json`（或部署时分发统一配置）：

```json
{
  "relayBrokers": ["wss://mqtt.corp.internal:8084/mqtt"],
  "stunUrls": ["stun:stun.corp.internal:3478"],
  "turnServers": [{ "urls": "turn:turn.corp.internal:3478",
                    "username": "oc", "credential": "强口令" }],
  "defaultRoom": "company-hall"
}
```

自托管组件（均为开源软件）：

```bash
# MQTT 信令/中继（EMQX 或 Mosquitto）
docker run -d --name emqx -p 1883:1883 -p 8084:8084 emqx/emqx:latest

# 自有 TURN（coturn）—— 替代已失效的公共 TURN
docker run -d --network host coturn/coturn \
  -n --realm=corp.internal --user=oc:强口令 --no-cli
```

## 安装包（五平台）

代码在仓库，安装包在 [GitHub Releases](https://github.com/rogerhik999-arch/OrayChat/releases)（推 `v*` tag 自动构建并上传）：

| 平台 | 产物 | 本地构建命令 |
|------|------|------|
| macOS (Apple Silicon) | `OrayChat-X.Y.Z-arm64.dmg` / `.zip` | `npx electron-builder --mac` |
| Windows | `OrayChat Setup X.Y.Z.exe`（NSIS）/ 便携版 exe | `npx electron-builder --win` |
| Linux | `OrayChat-X.Y.Z.AppImage` / `oraychat_X.Y.Z_amd64.deb` | `npx electron-builder --linux AppImage deb --x64` |
| Android 7.0+ | `app-debug.apk`（debug 签名可直接安装）/ `app-release-unsigned.apk` | `node scripts/build-www.mjs && npx cap sync android && cd android && ./gradlew assembleDebug` |
| iOS | 模拟器构建（真机需 Apple 开发者账号签名） | CI（`release.yml` ios job）；本地需 Xcode + CocoaPods |

移动端基于 [Capacitor](https://capacitorjs.com)：`renderer` 的 Web 产物经 `renderer/web-shim.js`
兼容层（`window.oray` 的 Web 实现：身份/配置/KV 持久化走 WebView localStorage）加载同一套
UI 与网络栈（WebRTC DataChannel + MQTT WSS 在 Android WebView / iOS WKWebView 均可用）。

版本号策略见 [VERSIONING.md](VERSIONING.md)：`package.json` 是唯一事实来源，
`scripts/sync-version.mjs` 派生 Android `versionCode/versionName` 与 iOS plist 版本。

国内网络本地构建的已知要点：`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`
指向 npmmirror；Gradle 依赖走阿里云镜像（`~/.gradle/init.d/` 追加脚本，见
`android/build.gradle` 内已内置）。

## 测试与验证

```bash
npm test                 # 密码学单元测试 + 共享日志单元测试 + 中继传输测试 + 双实例 P2P 端到端
npm run test:relay       # 同上，端到端强制走 MQTT 中继回退
npm run test:lobby       # 共享日志单元测试 + 大厅四阶段端到端
npm run test:pass        # 房间口令单测 + 门禁端到端（正确口令互通/错误口令被拒）
npm run test:remember    # 记住口令端到端（重启免输口令互连/无口令对照仍被拒）
npm run check:services   # 公共服务连通性探测（STUN Binding / TURN Allocate / MQTT 回环）
```

**端到端测试**真实拉起两个桌面实例（bot 模式），断言：

1. 经公共信令互相发现并完成 E2EE 握手，**两端安全码一致**（无中间人）
2. 线上信封**不含明文**（AEAD 加密生效）
3. 消息**双向加密往返**（3 发 3 收 + echo）
4. P2P 模式收集到直连候选 / 中继模式经公共 MQTT 完成全部链路

**大厅四阶段测试**（`test/e2e-lobby.mjs`）：

1. **可见性**：bob 大厅发言 → 在线的 alice 实时收到（群聊全员可见）
2. **删除传播**：alice 发起删除 → 双方大厅日志同时消失（对所有人生效）
3. **全体保存**：对端离线时发言 → 仍保存于本地共享日志
4. **上线同步**：对端重新上线 → 握手后自动全局同步，恢复离线期间的记录

**共享日志单元测试**（`test/history.test.mjs`）：合并收敛（双/三成员随机操作序列后
状态逐字节一致）、墓碑压制复活、clearT 语义、30 天保留期（写入过滤/定期清扫/同步过滤）。

**房间口令门禁测试**（`test/e2e-pass.mjs`）：相同口令的成员正常互连并完成加密往返；
错误口令的第三实例 60s 内无法解密信令（`incorrect room password`）、无法与任何成员
建立会话 —— 门禁 + 信令加密同时得到行为级验证。

**记住口令测试**（`test/e2e-remember.mjs`）：勾选记住后重启实例，不带口令参数仍能
互连（本机记住的口令生效）；无口令的对照实例依然被拒。同时验证共享日志/名字映射
经主进程文件 KV 持久化，跨强杀重启不丢。

## 已知限制 / 后续路线

- 文件传输、多设备登录同一身份未支持
- 大厅/私聊日志合并为 gossip 模型（两两同步），超大群组收敛时间线性增长（小群组无感）
- 身份密钥未用口令加密（可将 `identity:save` 换成 scrypt+AES-GCM 加密存储）
- 长期身份无轮换/撤销机制
- 公共 broker 有速率限制，不适合大规模群组（私有化部署自有 EMQX 即可解除）

## 目录结构

```
electron/          主进程 + preload（多 profile、IPC、密钥存储）
renderer/          UI 与核心逻辑（crypto.mjs / net.mjs / relay.mjs / store.mjs / app.mjs）
test/              密码学/共享日志单元测试 + 中继传输测试 + 双实例端到端（P2P/中继/大厅）
tools/             公共服务探测（STUN/TURN/MQTT）
```

MIT License
