# 版本号与发布策略

## 版本号方案（语义化版本 SemVer）

单一事实来源：**`package.json` 的 `version` 字段**（当前 `1.0.0`）。所有平台的安装包版本都从这里派生，禁止手工在各处各写一份：

| 平台 | 版本来源 | 说明 |
|------|----------|------|
| 桌面（mac/win/linux） | `package.json` → electron-builder 自动读取 | 安装包文件名自动带版本，如 `OrayChat-1.0.0-arm64.dmg` |
| Android | `scripts/sync-version.mjs` 写入 `android/app/build.gradle` 的 `versionName` / `versionCode` | versionCode = 主版本*10000 + 次版本*100 + 修订号（如 1.0.0 → 10000），只增不减 |
| iOS | `scripts/sync-version.mjs` 写入 `ios/App/App/Info.plist` 的 `CFBundleShortVersionString` / `CFBundleVersion` | 同上规则 |
| 应用内展示 | 登录页左下角 `v{version}`（主进程 `app.getVersion()` 注入） | 与安装包版本必然一致 |

`versionCode = major*10000 + minor*100 + patch`，保证 SemVer 递增 ⇒ Android 版本号单调递增（覆盖安装不报错）。

## 版本递增规则

- **修订号 +0.0.1**：缺陷修复、性能优化，无行为变化
- **次版本 +0.1.0**：向后兼容的新功能（如：大厅、口令门禁、记住口令）
- **主版本 +1.0.0**：不兼容的协议/数据变更（如共享日志格式重写、信令协议破坏性改动）

预发布版本：`1.1.0-beta.1`（tag `v1.1.0-beta.1`）。

## 发布流程

1. 确认 `package.json` 版本号（发布即打 tag 的依据）
2. `npm test && npm run test:relay && npm run test:lobby` 全绿
3. `git tag vX.Y.Z && git push origin vX.Y.Z`
4. GitHub Actions（`.github/workflows/release.yml`）按 tag 自动构建全平台安装包并上传到 GitHub Release：
   - macOS：`OrayChat-X.Y.Z-arm64.dmg` / `.zip`（Apple Silicon；未签名，首次打开需右键→打开）
   - Windows：`OrayChat Setup X.Y.Z.exe`（NSIS 向导）/ portable 版
   - Linux：`OrayChat-X.Y.Z.AppImage` / `.deb`
   - Android：`OrayChat-X.Y.Z-debug.apk`（未签名 release 调试包）
   - iOS：模拟器构建产物（上架 App Store 需 Apple 开发者账号签名，见下）

## 签名现状（如实说明）

- macOS：`identity: null` —— 未做 Developer ID 签名/公证，用户首次打开需绕过 Gatekeeper
- Windows：未做 Authenticode 签名，SmartScreen 会提示
- iOS：需要 Apple 开发者账号 + 证书才能出可安装到真机的 ipa；CI 产物为模拟器包
- Android：debug 签名 APK 可直接安装；正式发布需生成 release keystore

这些是"无付费开发者账号"前提下的产物形态；配置好证书后，在 CI 中补充对应签名环境变量即可，无需改代码。
