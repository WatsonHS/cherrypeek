# 发布流程（macOS）

日期：2026-11-10。适用于公开发布的 macOS 版本：Apple 芯片（arm64），Developer ID 签名、hardened runtime、Apple 公证，通过 GitHub Release 分发。第一版不上 Homebrew，有需要时再建自己的 tap。

## 一次性准备

1. Apple Developer Program 账号。
2. **Developer ID Application** 证书装进登录钥匙串（Xcode → Settings → Accounts → Manage Certificates，或开发者网站生成后导入）。检查：`security find-identity -v -p codesigning` 能看到 `Developer ID Application: …`。
3. 公证凭据存进钥匙串，二选一：
   - App Store Connect API key（推荐，不依赖个人 Apple ID 密码）：`xcrun notarytool store-credentials <配置名> --key <AuthKey_XXXX.p8> --key-id <Key ID> --issuer <Issuer ID>`
   - Apple ID 与 app 专用密码：`xcrun notarytool store-credentials <配置名> --apple-id <邮箱> --team-id <Team ID>`（按提示输入 app 专用密码）

   之后只需要配置名；密钥和密码留在钥匙串里，不写进仓库、命令历史或环境变量文件。
4. 安装 GitHub CLI 并登录：`gh auth login`。

## 每次发布

1. 改版本号：根目录与 `apps/desktop` 的 `package.json`、两个 crate 的 `Cargo.toml` 保持一致。
2. 写发行说明 `docs/releases/v<版本>.md`（中英两段：变化、要求、已知限制、数据位置）。
3. 依赖有变化时运行 `pnpm licenses:third-party`，提交更新后的 `THIRD_PARTY_LICENSES.md`。
4. 完整跑一遍测试矩阵（类型检查、协议、Rust、renderer 与各 Electron 冒烟），提交所有改动。
5. 构建并签名、公证：

   ```sh
   APPLE_KEYCHAIN_PROFILE=cherrypeek pnpm release:mac
   ```

   （若保存在钥匙串中的配置名就是 `cherrypeek`，也可省略环境变量直接运行 `pnpm release:mac`。）脚本依次：检查 Apple 芯片、证书与钥匙串公证凭据；重新生成第三方许可证清单并要求工作区干净；构建、签名、公证应用（electron-builder 装订票据）；对 DMG 签名、公证并装订；用 `codesign --verify --deep --strict`、`stapler validate` 和 `spctl --assess` 按用户机器的方式检查应用与 DMG；写出 SHA-256。任一步失败即停止，不会产生“半签名”的发布物。
6. 打标签并上传（脚本最后会打印同样的命令）：

   ```sh
   git tag v<版本> && git push origin v<版本>
   gh release create v<版本> release/CherryPeek-<版本>-arm64.dmg release/CherryPeek-<版本>-arm64.zip \
     release/CherryPeek-<版本>-arm64.sha256 --title "CherryPeek <版本>" --notes-file docs/releases/v<版本>.md
   ```

7. 在另一台（或新用户账户下的）Mac 上从 Release 页下载 DMG，确认双击打开、拖入“应用程序”、首次启动都没有 Gatekeeper 拦截。

## 说明

- 平时的 `pnpm package:mac` 仍是本机试用包（临时签名、不公证），与发布模式由 `COMMITSCOPE_RELEASE=1` 区分，见 `electron-builder.config.cjs`。
- 发布模式的 entitlements 只放开 V8 JIT 所需的两项（`build/entitlements.mac.plist`）。应用不在 App Sandbox 里，以后加 fetch 等功能不需要额外的 entitlement。
- 应用内附带 `LICENSE`、`THIRD_PARTY_LICENSES.md`（npm 运行时依赖、Electron、macOS 构建用到的 Rust crate）与 Chromium 的 `LICENSES.chromium.html`。
- 应用数据（缓存与索引）在 `~/Library/Application Support/CherryPeek`。
- 应用图标的源文件是 `docs/brand/icon/cherrypeek.svg`；改动后运行 `pnpm icon:mac`（需要 `brew install librsvg`）重新生成 `build/icon.icns` 与 README 用的 `docs/brand/icon/cherrypeek-256.png`，两者都提交。
- Intel Mac、通用包、自动更新、Homebrew tap 与 CI 自动发布暂不做；需要时在此补充。
