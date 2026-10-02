# OrayChat 私有中继服务使用指南

> 适用版本：v1.23.0 及以上（桌面端）。设计与方案取舍见 [private-relay-research.md](./private-relay-research.md)。

「中继服务模式」让你的 OrayChat 客户端兼职成为**房间的私有中继站**：本机运行一个 MQTT 中继（只绑定本机回环），经 Cloudflare 隧道向房间成员开放一个接入地址。成员把这个地址加进自己的 broker 列表，它就成为继两个公共中继之后的**第 3 条并联链路**。

- **消息更稳**：不再依赖公共 broker 的状态（夜间拥堵、SSL 错误、丢包都是公共服务的现实问题）
- **隐私不变**：中继只转发密文——端到端加密在你们各自的客户端之间完成，中继（包括你自己这台）永远看不到消息内容
- **永不锁死**：私有链任何故障，所有成员自动回落公共中继——最坏情况就是没有私有链的今天

```
[成员 A] ──┬─> 公共中继 1（emqx）──┐
[成员 B] ──┼─> 公共中继 2（emqx）──┼──> 房间（消息仍端到端加密）
[成员 C] ──┴─> 私有中继（你的 Mac）─┘
                    ↑
          Cloudflare 隧道（出站连接，无需公网 IP / 端口映射）
```

---

## 一、主机端：开启中继服务

> 建议用一台**经常开机**的电脑（桌面/树莓派/NAS 上的 OrayChat 均可）。它下线时私有链不可用，但房间自动回落公共中继，不丢消息。

1. 打开 OrayChat → **设置** → 找到 **「中继服务模式」** 卡片
2. 勾选 **启用中继服务**（这样重启应用后会自动恢复运行），点 **立即启动**
3. 状态栏显示 `状态：运行中（本机端口 48883）`，下方日志区出现 `broker 监听 ws://127.0.0.1:48883`

此时私有中继已在运行，但**只有本机能用**。要让其他成员（公网）接入，继续下一步：选一种暴露方式。

## 二、暴露方式 A：Cloudflare 快速隧道（零配置，1 分钟）

前提：本机已安装 `cloudflared`（见下文第三节；未安装时设置页会提示，私有链本机功能不受影响）。

1. 在中继服务卡片点 **启动 Cloudflare 快速隧道**
2. 日志区出现 `隧道就绪 wss://xxxx-xxxx.trycloudflare.com`
3. 点 **复制接入地址**，发给房间成员

**注意：快速隧道的地址每次重启应用都会变化**，成员需要跟着更新。适合体验和临时使用；长期使用请用方式 B。

## 三、暴露方式 B：稳定地址向导（推荐，全程按钮点击）

v1.24.0 起，稳定地址的准备工作**全部在设置页内完成**，无需终端命令；服务随客户端后台常驻、断线自动重连。

前提：一个 Cloudflare 账号 + 一个已托管在 Cloudflare 的域名 + 本机已安装 cloudflared（第四节）。

1. 打开 OrayChat → **设置** → **中继服务模式**
2. 按顺序点击四步（每步完成后状态变 ✓，下一步自动解锁）：
   - **① 授权 Cloudflare**：点按钮 → 自动打开浏览器 → 登录并选择域名授权 → 回到应用看到 ✓
   - **② 创建隧道**：隧道名保持默认 `oraychat-hub`（或自定义）→ 点「创建」→ ✓
   - **③ 绑定域名**：填入主机名（如 `mqtt.example.com`）→ 点「绑定」→ ✓
   - **④ 启动稳定服务**：点「启动」→ 状态显示 `✓ 运行中 wss://你的域名`
3. 点 **复制接入地址** 发给房间成员

配置会自动保存：重启客户端后，中继与稳定隧道**自动在后台恢复运行**（无需再点任何按钮）。隧道进程若意外退出，应用会自动重启它（指数退避）。

> 老版本（v1.23.x）的终端命令方式仍然有效：手动 `login/create/route/run` 后把 `wss://域名` 填进「对外公布地址」即可，两种方式共存。

## 四、cloudflared 说明（v1.25.1 起已内置，通常无需安装）

**v1.25.1 起，Windows/macOS/Linux 安装包已内置官方 cloudflared**——装好 OrayChat 即可直接使用快速隧道与命名隧道，无需任何手动安装。以下手动方式仅适用于想使用更新版本的高级用户（系统 PATH 里自装的版本会被优先采用）。

cloudflared 是 Cloudflare 官方的隧道客户端（单个可执行文件，约 40MB，无其他依赖）。OrayChat 会按以下顺序自动查找它：

1. 系统 PATH（用包管理器装的都在这里）
2. OrayChat 数据目录下的 `cloudflared/` 文件夹（手动放置的位置，见下表）

| 平台 | OrayChat 数据目录（手动放置位置） |
|---|---|
| macOS | `~/Library/Application Support/OrayChat/cloudflared/` |
| Windows | `%APPDATA%\OrayChat\cloudflared\`（资源管理器地址栏直接粘贴 `%APPDATA%\OrayChat` 回车） |
| Linux | `~/.config/OrayChat/cloudflared/` |

三种方式任选其一，装完重启 OrayChat 即可被识别。

### 方式 1：包管理器安装（最省事，推荐）

```bash
# macOS（Homebrew）
brew install cloudflared

# Windows（winget，或 scoop install cloudflared）
winget install --id Cloudflare.cloudflared

# Linux（Debian/Ubuntu，amd64）
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb

# Linux（RHEL/Fedora/CentOS）
sudo rpm -i https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-x86_64.rpm

# Arch
sudo pacman -S cloudflared
```

### 方式 2：macOS 手动下载（无 Homebrew 时）

```bash
# 1. 下载并解压（Apple Silicon；Intel 把 arm64 换成 amd64）
curl -L --output /tmp/cloudflared.tgz \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz
tar -xzf /tmp/cloudflared.tgz -C /tmp

# 2. 放入 OrayChat 数据目录并赋予执行权限
mkdir -p ~/Library/Application\ Support/OrayChat/cloudflared
mv /tmp/cloudflared ~/Library/Application\ Support/OrayChat/cloudflared/
chmod +x ~/Library/Application\ Support/OrayChat/cloudflared/cloudflared

# 3. 若下载自浏览器（非 curl），macOS 可能拦执行，去掉隔离标记
xattr -d com.apple.quarantine ~/Library/Application\ Support/OrayChat/cloudflared/cloudflared 2>/dev/null || true
```

### 方式 3：Windows 手动下载

1. 下载 <https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe>
2. 把文件改名为 **`cloudflared.exe`**，放入 `%APPDATA%\OrayChat\cloudflared\`（目录不存在就新建）
3. 若 Windows Defender / SmartScreen 拦截，选「仍要保留」

### 验证安装

终端执行 `cloudflared --version`（或带完整路径执行）能打印版本号即可。之后**重启 OrayChat**，在设置 → 中继服务点「启动 Cloudflare 快速隧道」，日志区出现 `隧道就绪 wss://...` 即成功。

### 网络受限环境

- GitHub 直连慢/失败时，可用镜像：把上面 URL 中的 `github.com/cloudflare/cloudflared/releases/latest/download` 换成 `ghfast.top/https://github.com/cloudflare/cloudflared/releases/latest/download` 等加速前缀（第三方镜像，注意甄别）
- 下载后建议核对官方校验和：发布页 `cloudflared-checksums.txt` 与本地 `shasum -a 256 <文件>` 对比
- 实在装不上也不影响聊天：私有中继的本机功能照常，只是没有公网暴露（本机客户端仍会走私有链）；或让房间里能装的用户当主机

## 五、成员端：接入私有中继（2 分钟）

1. 从主机那里拿到接入地址（`wss://...` 开头）
2. 打开 OrayChat → **设置** → **网络** → **MQTT broker** 列表，把地址**另起一行**粘贴进去（保留原有的公共地址作为兜底），保存
3. 重启 OrayChat

验证：状态栏日志（传输/系统提示）或侧栏成员状态显示连接正常即可。成员**不需要**安装 cloudflared。

## 六、日常行为（自动的，无需操作）

- **主机重启**：勾选了「启用中继服务」的话，应用启动即自动恢复中继；本机客户端自动接入自己的私有链
- **主机离线**：成员的私有链断开，自动继续走公共中继；主机回来后链路自动恢复（成员无需重启）
- **链路选择**：三条并联链路同时收发、自动去重——私有链不增加"切换"动作，只是多一条更稳的路
- **流量**：中继流量都经过主机的上行带宽；大文件传输仍优先点对点直连，中继只是兜底与信令

## 七、中继主机在房间里的标识

正在运行中继服务的成员，在所有人的在线成员列表中名字旁会显示 **📡** 徽标（随在线报告自动更新，停止服务后徽标消失）。这样房间成员能一眼知道当前谁在提供私有中继，判断网络质量问题的来源。

## 八、常见问题

**Q：房间里有必要所有人都接入吗？**
接入的人越多，私有链的收益面越大；没接入的人继续走公共链，互不影响。

**Q：我的 Mac 合盖睡眠会怎样？**
私有链掉线，房间回落公共链；唤醒后自动恢复。长期当主机用的话，建议设置里勾选「驻留系统托盘」并在系统设置中禁止 App 睡眠（v1.9.1 起 OrayChat 已内置禁用 App Nap）。

**Q：两个人开两台中继服务行不行？**
行。成员 broker 列表里各加一行，两条私有链并联，冗余更高。

**Q：可以不用 Cloudflare，纯局域网用吗？**
当前版本私有中继只绑定本机回环（127.0.0.1），局域网直连中继地址暂不支持（安全默认）；局域网内成员之间本来就能 P2P 直连，通常无需中继。

**Q：接入地址泄露给别人会怎样？**
不知道内容密码就读不了任何消息（E2EE）；最多被当作普通中继连接。介意的话可用命名隧道 + 不公开的子域名，或未来版本的中继 token（见研究文档 §5）。

**Q：为什么我的成员连接不上？**
依次检查：① 主机端状态是否"运行中"；② 隧道是否就绪（快速隧道重启后地址会变——用新地址）；③ 成员地址是否带 `wss://` 前缀和 `/mqtt` 路径；④ 主机的 cloudflared 进程是否在跑（命名隧道模式）。

## 九、安全与隐私

- 中继进程只绑定 `127.0.0.1`，外网唯一入口是 Cloudflare 隧道（TLS 加密到边缘）
- 中继只见 `{发送者, 帧类型, 密文, 去重号}`——内容、身份公钥对应关系之外的元数据极少
- 安全码核验、消息删除、历史同步等所有产品行为与公共链模式完全一致
- 运行状态（连接数、日志）只在设置页本机展示，不上报任何遥测

---

*实现与测试细节：`electron/hub.js`（中继与隧道托管）、`renderer/src/relay.mjs addBroker()`（动态并链）、`test/hub-live.mjs` / `test/hub-tunnel-live.mjs`（实测脚本）。*
