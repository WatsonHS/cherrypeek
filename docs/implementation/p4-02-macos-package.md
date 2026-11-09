# P4-02 macOS 本机打包

状态：2026-11-09 本机 Apple Silicon 应用与 DMG 已生成，包内启动和 LaunchServices 安装试用通过。按用户要求先交付本机试用包；P4-01 剩余稳定性验收继续保留，不阻塞这一步。

## 交付与代码改动

- `package.json` / `pnpm-lock.yaml`：锁定 electron-builder 26.18.0，增加 `pnpm package:mac`。
- `scripts/package-macos.mjs`：先执行 release 构建，再生成最小应用 manifest，按当前 Mac 架构打包；默认生成 `.app` 与 `.dmg`，`--dir` 只生成 `.app`。
- `electron-builder.config.cjs`：应用代码放入 `app.asar`，仅包含已构建的 main、preload 和 renderer；Rust daemon 作为 `extraResources` 放在 `Contents/Resources`，避免依赖源码目录或开发工具链。采用应用标识 `app.commitscope.desktop` 和本机 ad-hoc 签名，关闭 hardened runtime，不调用开发者证书、不公证、不发布。
- `apps/desktop/src/main/index.ts`：打包后从 `process.resourcesPath` 找 Rust daemon，开发启动仍使用原来的 dist 路径。继续使用 Rust 现有的 PATH 查找和 `/usr/bin/git` 兜底，缓存仍写入 Electron userData。
- `tests/smoke/packaged-app-smoke.mjs`：只检查打包边界，使用精简 PATH 和独立用户目录，从真实仓库读取提交，检查实际资源路径、隔离配置与进程退出。

## 验证与完成边界

执行类型检查、release 打包和包内运行检查；同时通过 LaunchServices 打开从 DMG 复制出的应用，记录结果。产物留在忽略的 `release/`，不自动安装覆盖已有应用。

本轮不等于公开发行或完整 P4-02 验收：三个仓库五个使用日的试用、Intel 构建、公开分发的 Developer ID 签名 / 公证和干净系统安装尚需后续验证。打包配置依据 [electron-builder v26 macOS 文档](https://www.electron.build/v26/docs/mac/)，资源路径依据 [Electron process 文档](https://www.electronjs.org/docs/latest/api/process)。

## 实测记录

环境：当前 Mac / arm64，Electron 45.2.3、electron-builder 26.18.0、系统 Git `2.54.0 (Apple Git-157)`。本轮沿用已固定的构建工具版本。

| 项目 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm package:mac` | release 构建、ad-hoc 签名与 DMG 生成通过 |
| 应用 | `release/mac-arm64/CommitScope.app`；磁盘占用约 268 MiB |
| 安装镜像 | `release/CommitScope-0.1.0-arm64.dmg`；目录展开修复后重打包为 122,625,354 字节，约 117 MiB |
| `codesign --verify --deep --strict` | 通过；应用与 Rust daemon 均为 arm64 / ad-hoc |
| `pnpm test:smoke:package` | 精简 PATH 下加载当前真实仓库，首条 OID 与 Git HEAD 一致；运行实际包内 daemon；renderer sandbox / contextIsolation 开启、nodeIntegration 关闭；关闭后核心退出 |
| LaunchServices 安装试用 | 挂载 DMG，复制应用到含中文与空格的临时目录，卸载镜像，再用 `open -n -a` 启动；精简 PATH 下读取真实 HEAD 成功，退出后核心回收，临时副本清理 |

包内检查采用 `/usr/bin:/bin:/usr/sbin:/sbin`，独立 userData 位于含中文与空格的临时目录。首次检查发现测试把 macOS `/var` 与 `/private/var` 当作不同目录，已按实际路径比较后通过；应用不需要因此修改。LaunchServices 验证是实际系统启动流程，但未代替干净机器或用户手动 Finder 双击验收。

本地证据：`output/playwright/p4-02-packaged-app.json`、`p4-02-packaged-app.png`、`p4-02-launchservices.json` 和 `p4-02-launchservices.png`。应用名对应的默认 userData 为 `~/Library/Application Support/commitscope/`；包中暂沿用 Electron 默认图标。

三个仓库五个使用日试用尚未完成，P4-02 总项继续不勾选；本次未公开发布。
