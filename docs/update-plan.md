# 分布式自动更新开发计划（update-plan）

> 依据：docs/update-research.md（方案可行性/架构/风险/发布侧/冲突分析）。
> 本计划把方案拆成可执行的工作包：文件落点、验收标准、分期。

## 0. 已拍板默认值（可改）

| 项 | 默认 |
|---|---|
| 签名密钥 | Ed25519；私钥存 GitHub Secret `ORAY_UPDATE_SIGN_KEY`，公钥硬编码进客户端（renderer/src/updater.mjs） |
| 默认策略 | 同伴优先 + GitHub 兜底；"下载后提示安装" |
| 全自动档 | 逐台手动开启；含全部守门条件（§2） |
| 中继主机 | 默认兼当自动拉新包的种子源 |
| 维护窗口 | 默认本地 04:00；硬期限 72h（到期即使服务忙也应用） |
| 发布节奏 | 不变——只在用户明确指令时发版 |

## 1. 系统组件与文件落点

| 组件 | 落点 | 说明 |
|---|---|---|
| 密钥生成工具 | `tools/gen-update-key.mjs` | 本地生成 Ed25519 对；公钥打印进源码、私钥给 CI secret |
| CI 签名 job | `.github/workflows/release.yml` | 9 资产构建完后：逐资产 sha256 → manifest.json → 签名 → 上传 manifest.json/.sig（9→11 资产） |
| 版本 gossip | `renderer/src/net.mjs`（presence 心跳帧）+ `updater.mjs` | 心跳捎带 `ver` + `pkg`（最新已知签名清单，1-2KB，gossip 高版本胜出；**接收端验签后才采纳/转发**） |
| 策略/守门引擎 | `renderer/src/updater.mjs`（新） | 五档策略、源三选、抖动、主机感知、崩溃环、版本单调（semver） |
| 拉包 | 复用 `filex.mjs` 多源 | fx-want → 多持有者并发拉块 → files/<fid>（零新传输代码） |
| 校验 | `updater.mjs` | manifest.sig 验签（内置公钥）+ sha256 终检 + 版本单调三闸 |
| 换装（主进程） | `electron/updater.js`（新）+ IPC `updater:stage/apply/state` | macOS：staging 解包→detached helper 等退出→ditto→`open` 拉起；Windows：NSIS /S；Linux：AppImage 原子 swap |
| 回滚 | `electron/updater.js` | staging 保旧版备份；启动 boot-ok 自检标记，连续 3 次缺失→恢复备份 |
| cloudflared 随包刷新 | `electron/main.js` 复制逻辑 | 按版本号不同才覆盖 userData/cloudflared |
| 设置页 | `renderer/settings.html/js` | 更新区块：策略五档/源三选/当前+最新版本/检查更新/「从 Release 拉取成为种子」/维护窗口 |
| Android 辅助 | Capacitor 插件（android 源码小改）+ web-shim | filex 落 APK → FileProvider Intent 一键装（系统边界：无法静默） |
| iOS | 不做 | 无通道 |

## 2. 全自动档准入（守门条件最终版，全部满足才动手）

1. 策略 = 全自动（五档之一，逐台设置）
2. 签名清单验签通过 + SHA-256 终检 + 版本单调（> 当前版本，且非忽略版本）
3. filex 无活跃传输
4. 距上次自动更新重启 ≥10min（崩溃环保护；连续 2 次失败→自动降级"提示安装"+告警）
5. 错峰抖动已到（0-30min 随机，摊平同时重启）
6. **主机感知推迟**：本机是中继主机且 hub.memberList 非空 → 等服务空闲（清空
   ≥10min）或维护窗口（04:00，硬期限 72h）；非主机成员不受此条
7. staging 完成且自检通过（解包后版本/结构正确）

## 3. 分期

### M1 —— P0 桌面主链路（macOS 先行，~2-3 天）
- [ ] 密钥工具 + 公钥内置；CI manifest job（Secret 配置）
- [ ] presence 心跳捎带 ver/pkg（gossip，验签后采纳）
- [ ] updater.mjs：策略/守门状态机（§2 全条件）、semver 比较、拉包（filex 多源）、校验、staging
- [ ] electron/updater.js：macOS stage/apply（detached helper 换装+拉起）+ IPC
- [ ] 设置页更新区块；托盘/关窗路径适配（isQuiting；重启后恢复前台/托盘状态）
- [ ] 更新成功自动持有包（files/ 天然成种子）；fx-hold 响应
- [ ] 单测：semver 比较、守门状态机（假 net 逐条件驱动）、清单验签、gossip 择优
- 验收：双实例实机演练——A 持 vN+1 包（测试签名密钥+假清单），B 经 gossip 发现→多源拉包→校验→staging→确认换装→重启后版本号为 vN+1 且自动成为种子

### M2 —— P1 补全（+1-2 天）
- [ ] Windows NSIS 静默换装；Linux AppImage 原子 swap
- [ ] 回滚机制（旧版备份 + boot-ok 自检）
- [ ] GitHub 兜底直下（含既有镜像前缀/重试经验）
- [ ] "重启并更新"按钮 UX + 系统通知（自动更新完成提示）
- [ ] cloudflared 随包按版本刷新
- 验收：三平台换装实机各过一次；回滚演练一次

### M3 —— P2 Android 辅助（+1 天）
- [ ] Capacitor 插件：APK 路径 → FileProvider 安装 Intent
- [ ] web-shim 更新桥 + 移动端设置区块
- 验收：APK 经 filex 到机 → 一键装成功

## 4. 测试与验证策略

- 单测：守门状态机逐条件驱动（假 net/假 hub snapshot）、semver、Ed25519 验签、
  gossip 择优、崩溃环降级
- 实机演练：`test/update-live.mjs`——双实例 + 测试密钥 + 假清单（小 zip 包），
  断言 gossip 发现→拉包→校验→staging→换装→重启→版本号更新→成为种子 全链
- 回归：全套单测 + e2e + comprehensive（更新模块对既有路径零侵入——
  presence 帧只加字段，filex 走既有 API）
- 长跑：72h soak 继续观测（更新机制不改变心跳/回收路径）

## 5. 风险登记

| 风险 | 缓解 |
|---|---|
| 私钥泄漏 | 仅存 GitHub Secret；泄露处置=换钥+双公钥过渡期清单 |
| 坏包重启环 | 崩溃环守门 + 自动降级 + 回滚备份 |
| 主机闪断 | 主机感知推迟 + 错峰抖动 + 公共链回落（架构原语已验证） |
| 混版协议 | 更新非强制；协议层混版兼容已实测（v1.7.0↔HEAD） |
| Android 无法静默 | 半自动定位明确，不伪装成全自动 |
