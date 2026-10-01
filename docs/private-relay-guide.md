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

## 三、暴露方式 B：命名隧道（稳定地址，推荐长期使用）

一次性设置约 5 分钟，完成后地址永久不变（`wss://mqtt.你的域名`）。

前提：一个 Cloudflare 账号 + 一个已托管在 Cloudflare 的域名。

1. **安装 cloudflared**（见第四节）
2. 在终端依次执行（`my-tunnel` 和 `mqtt.你的域名` 换成你的名字）：

   ```bash
   cloudflared tunnel login                          # 浏览器登录 Cloudflare，授权域名
   cloudflared tunnel create my-tunnel               # 创建隧道（得到一个 UUID）
   cloudflared tunnel route dns my-tunnel mqtt.你的域名   # 把域名指向隧道
   ```

3. 在 OrayChat 设置页确认中继服务已启动（端口 48883），然后运行：

   ```bash
   cloudflared tunnel run --url http://127.0.0.1:48883 my-tunnel
   ```

4. 把 **`wss://mqtt.你的域名`** 填进设置页的 **「对外公布地址」**，点 **复制接入地址** 分享给成员

> 也可以用 launchd / systemd / 计划任务把第 4 步设为开机自启，之后完全不用管。

## 四、安装 cloudflared

| 平台 | 方法 |
|---|---|
| macOS (Apple Silicon) | `brew install cloudflared`；或下载 [cloudflared-darwin-arm64.tgz](https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz)，解压出的二进制放入 `~/Library/Application Support/OrayChat/cloudflared/`（去扩展属性 `chmod +x`） |
| macOS (Intel) | 同上，下载 `cloudflared-darwin-amd64.tgz` |
| Windows | 下载 [cloudflared-windows-amd64.exe](https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe)，改名为 `cloudflared.exe` 放入 `%APPDATA%\OrayChat\cloudflared\` |
| Linux | 下载 [cloudflared-linux-amd64](https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64)，放入 `~/.config/OrayChat/cloudflared/` 并 `chmod +x` |

放在这些目录即可被自动识别；也可以装到系统 PATH（`brew install` 就是这种方式）。

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

## 七、常见问题

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

## 八、安全与隐私

- 中继进程只绑定 `127.0.0.1`，外网唯一入口是 Cloudflare 隧道（TLS 加密到边缘）
- 中继只见 `{发送者, 帧类型, 密文, 去重号}`——内容、身份公钥对应关系之外的元数据极少
- 安全码核验、消息删除、历史同步等所有产品行为与公共链模式完全一致
- 运行状态（连接数、日志）只在设置页本机展示，不上报任何遥测

---

*实现与测试细节：`electron/hub.js`（中继与隧道托管）、`renderer/src/relay.mjs addBroker()`（动态并链）、`test/hub-live.mjs` / `test/hub-tunnel-live.mjs`（实测脚本）。*
