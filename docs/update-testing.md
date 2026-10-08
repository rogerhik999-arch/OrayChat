# 更新功能测试指南（跨平台：macOS / Windows / Linux）

面向在实际部署机器上拉取本项目、对**分布式自动更新**做测试与纠错的场景。
更新链路：**版本 gossip（presence 心跳捎带）→ 清单 Ed25519 验签采纳（对端只有版本号而无清单——"盲种子"——时，主动去 GitHub 兜底拉清单）→ filex 多源拉包（或 GitHub 兜底）→ SHA-256 校验 → staging → 换装（守门）→ 回滚簿记**。

## 0. 准备

```bash
git clone https://github.com/rogerhik999-arch/OrayChat.git
cd OrayChat
npm install          # 依赖（@noble/curves 等）
npm run build        # esbuild 出 renderer/dist/app.bundle.js（L2/L4 需要）
```

- Node ≥ 20（工具与单测）；跑 L2/L4 还需 `npm install` 后的 electron 可运行（Linux 无桌面时用 `xvfb-run -a <命令>`）。
- 网络：能连公共 MQTT broker（信令）+ github.com（GitHub 兜底/清单验证）。

## 1. 测试金字塔

| 层 | 命令 | 要求 | 验证内容 | 时长 |
|---|---|---|---|---|
| L1 单元 | `node test/update.test.mjs` | 纯 Node | semver 比较、清单规范化字节、Ed25519 验签、守门 gateDecision 全条件、平台资产键 | 秒级 |
| L2 同机演练 | `node test/update-live.mjs` | electron + 桌面（或 xvfb） | 全链：甲(种子)广播 → 乙(过期客户端) gossip 发现 → fx 多源拉包 → 验签+SHA → staged。**沙箱化，不碰真安装** | ~2 分钟 |
| L3 清单自检 | `node tools/verify-update-manifest.mjs` | 能访问 github.com | 生产 Release 清单签名有效、资产齐全（可用 `--file`/`--key` 验本地/测试清单） | 秒级 |
| L4 真机整链 | 手工（见 §4） | 两台真机或一台+GitHub | 真实下载→暂存→换装→重启后版本变化→回滚簿记 | 分钟级 |

预期输出：
- L1 末行 `✅ update.test.mjs：45/45 通过`
- L2 末行 `✅ update-live：gossip→拉取→校验→暂存 全链通过`（日志在 `<系统临时目录>/oc-updlive/{a,b}.log`）
- L3 末行 `✅ Ed25519 验签有效`

## 2. 各平台路径与机制速查

userData 根 = `<平台appData>/OrayChat/<profile>`，profile 默认 `default`（`--profile=x` 可指定，多开测试互不干扰）：

| 用途 | Windows | Linux | macOS |
|---|---|---|---|
| userData | `%APPDATA%\OrayChat\<p>` | `~/.config/OrayChat/<p>` | `~/Library/Application Support/OrayChat/<p>` |
| 关键状态 | `local-state.json` 内 KV：`oc-updater-cfg`（策略/源）、`oc-updater-state`（knownPkg/失败计数/autoAppliedVer）、`oc-updater-apply`（换装簿记 ver/at/startsSince） |||
| 已下载包 | `files\<fid>`（fid=sha256 前 24） |||
| 暂存产物 | `staging\<版本>\Setup exe` | `staging\<版本>\OrayChat.AppImage` | `staging\<版本>\OrayChat.app` |
| 换装 helper | `staging\update-helper.cmd` | `staging/update-helper.sh` | 同左 |
| 换装动作 | 等进程退出 → `Setup.exe /S` 静默装（安装器接管重启） | `cp→chmod→mv` 原子替换 AppImage → `nohup` 拉起 | 备份 `.bak` → ditto 到 `/Applications` → open |
| 自动回滚 | ❌（重装旧版 Setup 即回滚） | ⚠️ 簿记在，恢复需手动 `mv <dst>.bak <dst>` | ✅ 连续 3 次启动未见 boot-ok → 自动恢复 `.bak` |

> ⚠️ **Windows 换装 helper（update-helper.cmd）2026-10-08 由 bash 方案重写为 cmd 方案，尚未实机验证——这是 L4 在 Windows 上的头号纠错项**（旧实现 spawn `/bin/bash` 在 Windows 必 ENOENT，症状：面板显示已暂存、点安装后应用退出但再也不起来/无动静）。

## 3. L2 同机演练（安全沙箱，推荐先跑这个）

```bash
node test/update-live.mjs
```

内部流程：生成**独立测试密钥**（与生产密钥无关）+ 假更新包 v9.9.9 + 签名清单 → 启动甲（注入包与清单，直接广播）→ 4 秒后启动乙（`--update-test-client`：版本报低、策略 quit-install、只带测试公钥）→ 断言乙的 `oc-updater-state.knownPkg.v == 9.9.9` 且 `files/` 出现对应 fid。

沙箱边界（对真安装零影响）：`ORAY_UPDATE_DST` 指向系统临时目录、`ORAY_UPDATE_NO_LAUNCH=1`（不真重启）。相关注入机制（main.js 读环境变量）：`ORAY_UPDATE_PUBKEY`（受信公钥）、`ORAY_UPDATE_TEST_PKG`、`ORAY_UPDATE_TEST_MANIFEST`、`ORAY_UPDATE_TEST_FID`、`ORAY_UPDATE_TEST_CLIENT`——可用来自造演练变体。

注意：
- **同一台机同时只跑一份演练**（同 profile 互踩）；跑前清理残留 electron 实例。
- 断言读的是落盘状态（乙 profile 的 local-state.json），不是日志行——日志只用来排错。
- Linux 服务器无桌面：`xvfb-run -a node test/update-live.mjs`。

## 4. L4 真机整链（Windows / Linux）

准备：目标机装**旧版**（如 v1.29.0 的 `Setup.exe` / `AppImage`，Release 附件），同房间放一台**持有效清单**的设备——经更新链路升级上去的机器换装重启后即"种子"（心跳每 15s 捎带清单广播）。注意**手动安装**的最新版是"盲种子"：心跳只带版本号不带清单，靠它发现不了更新，此场景依赖客户端的 GitHub 清单兜底发现（30s tick 触发、30 分钟退避，需 github.com 可达）。 companion 全下线也能测 GitHub 兜底（默认源 `peers-first` 含之）。

1. 旧版登录房间 → 设置 → 左侧「更新」：确认策略/源（默认 download-prompt / peers-first）。
2. **半分钟内**「当前版本 / 已知最新」的后者应变为新版号（gossip 采纳成功；盲种子场景则再等一个 tick 由 GitHub 兜底拉到清单）。
3. 观察阶段行：`idle → downloading → staged`，同时 `files\<fid>` 出现、大小接近安装包。
4. `staged` 后面板出现**「立即安装并重启」**：
   - **Windows**：点击 → 应用退出 → `update-helper.cmd` 等 PID 消失 → `Setup /S` 静默安装 → 安装器拉起新版。*未实机验证，纠错点：若退出后无动静，手动 `type %APPDATA%\OrayChat\default\staging\update-helper.cmd` 检查内容，再 `cmd /c <该文件>` 看报错。*
   - **Linux**：点击 → 退出 → helper.sh 原子替换 AppImage → nohup 拉起。起不来时手动恢复：`mv <AppImage>.bak <AppImage>`。
5. 重启后验证：设置 → 关于 版本号已更新；`local-state.json` 出现 `oc-updater-apply`（ver/at/startsSince）与后续 `oc-boot-ok`。
6. **策略矩阵**建议各跑一轮：`download-prompt`（默认，下载完等确认）、`quit-install`（退出时换装）、`full-auto`（守门：无传输 + 中继服务空闲 ≥10min 或 04:00 维护窗 + 错峰抖动 + 崩溃环冷却——"没动静"先看是不是在守门）。
7. 拒绝路径抽查：把任一字节改动的假 manifest.json + 原 sig 放进 `oc-updater-state.knownPkg` → 重启应被拒（验签失败不采纳）。

## 5. 纠错速查（症状 → 检查点）

| 症状 | 检查点 |
|---|---|
| 「已知最新」一直显示「（房间无更新信息）」 | 房间无同伴持有效清单 **且** GitHub 兜底不通。注意"盲种子"：**手动安装**新版（非经更新链路升级）的机器心跳只带版本号、不带清单，靠它发现不了更新——新版客户端见到更高对端版本会主动去 GitHub 拉清单（30 分钟退避、peers-only 源除外）；仍失败看下一行 |
| GitHub 清单/包下载超时（api.github.com 通、github.com 下载域超时） | 典型代理环境：github.com release 资产直连被墙、系统代理可达。客户端 GitHub 下载已走 `net.fetch`（自动用系统代理）；L3 工具是裸 Node fetch 不认系统代理——给终端 `export HTTPS_PROXY=http://127.0.0.1:<端口>` 再跑对照 |
| 阶段一直 `idle` | 守门等待（传输中/中继服务忙碌/崩溃环冷却）。看 `oc-updater-state.autoApplyFails`：≥2 已自动降级为只提示 |
| 下载卡 0% | 同伴无完整源（未满足 fx-hold）→ 让持有者主窗口保持打开；或源切 `github-only` 对照 |
| staged 后点安装无动静（Windows） | 见 §4.4 纠错点（cmd helper 未实机验证） |
| 换装后起不来（Linux） | `mv <AppImage>.bak <AppImage>` 手动回滚，把 helper.sh 内容与执行报错带回来 |
| 「签名不符的清单」被拒 | 确认清单来源与受信公钥匹配：`node tools/verify-update-manifest.mjs --file <manifest.json> [--key <b64>]` |
| L2 断言失败但双方 bot 日志无异常 | 确认 profile 路径（`--profile=b` → userData 根/OrayChat/b）；确认 `npm run build` 产物存在 |
| Linux 无窗口启动失败 | `xvfb-run -a`；应用需要显示（无纯 headless 模式） |

## 6. 相关文件索引

| 文件 | 作用 |
|---|---|
| `renderer/src/updater.mjs` | 渲染层核心：验签/择优/gossip/守门 gateDecision/策略 |
| `electron/updater.js` | 主进程：三平台 staging/换装 helper/GitHub 兜底下载/回滚 |
| `test/update.test.mjs` | L1 单元（33 断言） |
| `test/update-live.mjs` | L2 同机沙箱演练 |
| `tools/verify-update-manifest.mjs` | L3 清单验签自检 |
| `tools/gen-update-key.mjs` / `tools/sign-update-manifest.mjs` | 密钥生成 / CI 签名（本地重演清单产线） |
