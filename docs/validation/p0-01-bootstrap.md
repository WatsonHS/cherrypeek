# P0-01 最小工程验收

日期：2026-11-07。结论：P0-01 在本机 macOS / arm64 验收通过。M0 尚未完成；仓库读取、通用查询协议与性能预算尚未验收。

## 范围与实现版本

- 主代理编写 [代码级计划](../implementation/p0-01-bootstrap.md)，两个 gpt-6-luna 代理分别实现 Rust / schema 与 Electron / React / 构建链；主代理审查后独立复跑验证。
- 应用与核心版本为 `0.1.0`。当前工作区尚无本次 Git 提交，依赖由 `pnpm-lock.yaml` 与 `Cargo.lock` 固定，不虚构 commit 标识。
- Electron main 启动复制到构建资源目录的真实 Rust daemon；Rust 类型生成 draft-07 JSON Schema 与 TypeScript，main 校验版本、结构和实际 child PID。
- renderer 仅通过 `getCoreStatus` 与 `onCoreStatusChanged` 获取状态。启动失败和运行中核心退出均可见；尚未打开或查询任何 Git 仓库。

## 验收环境

| 项目 | 实测 / 锁定版本 |
| --- | --- |
| OS / 架构 | macOS 27.0.1（26A434）/ arm64 |
| 构建工具 | Node 26.0.0、pnpm 10.28.1、Rust / Cargo 1.95.0 |
| Electron | 45.2.3 |
| Electron 内置运行时 | Node 24.22.2、Chromium 156.0.8078.80 |
| 前端与构建 | React / React DOM 19.3.1、TypeScript 7.0.2、Vite 8.3.6、esbuild 0.28.2 |
| 协议与检查 | schemars 1.2.3、serde 1.0.228、serde_json 1.0.149、json-schema-to-typescript 16.0.0、Ajv 8.20.0 |
| 窗口自动化 | Playwright 1.65.0，显式 `chromiumSandbox: true` |
| Git | 2.54.0（Apple Git-157）；本项未使用它读取仓库 |

工具脚本使用 Node 26，main / preload 的编译目标为 Node 24，Node 类型为 24.19.2。Rust 为 debug 构建，renderer 使用 Vite 构建资产；不是安装包或发布性能构建。

## 实际验证结果

| 命令 / 场景 | 结果与证据边界 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，依赖安装与锁文件一致；Electron 二进制首次下载后实际运行成功 |
| `pnpm protocol:check` | 通过，从 Rust 类型重新生成后与已保存 schema / TS 一致；检查不改生成文件，Cargo 使用 `--locked` |
| `pnpm typecheck` | 通过，main、preload、renderer 与共享类型检查成功 |
| `pnpm build` | 通过，编译真实 daemon、复制资源，构建 renderer 与 main / preload |
| `cargo fmt --all -- --check` | 通过 |
| `cargo test --workspace --locked` | 通过，2 个核心测试与 1 个真实 daemon 启动 / EOF 退出测试 |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过，无警告 |
| `pnpm test:smoke` | 通过；下列窗口、失败与退出场景均执行成功 |
| 独立窗口复核 | 主代理另行启动真实窗口，确认版本、实际 PID、renderer 无 Node、窄 API 和实际安全偏好，并检查截图 |
| 构建期间 SIGTERM / SIGINT | 主代理实际观察到本次 Cargo 构建进程后中断 `node scripts/launch.mjs --build`；捕获的启动器、构建及 Cargo 进程均退出 |

Smoke 实际覆盖：

1. 窗口显示核心就绪、`0.1.0` 和真实活进程 PID。
2. 实际 webPreferences 为 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`、`webviewTag: false`；启动参数没有 `--no-sandbox`。
3. renderer 中无 `require`、Node `process` 与裸 IPC；preload API 只有两个约定方法；子 frame 无该 API；内联脚本被 CSP 阻断。
4. 找不到核心可执行文件时显示错误；仅终止本次核心 PID 后窗口显示“核心不可用”和退出原因。
5. 直接关闭健康的 BrowserWindow 后，Electron 与仍在运行的 daemon 均退出。
6. 已启动后的启动脚本收到 SIGTERM / SIGINT，等待本次进程树中出现 daemon 后捕获 PID；Electron、辅助进程和 daemon 全部退出。

主代理最终命令输出保存在本机 `output/playwright/p0-01-final-checks.log`，构建中断记录在 `output/playwright/p0-01-build-signals.log`。实际截图为 `output/playwright/p0-01-ready.png`，独立复核截图为 `output/playwright/p0-01-parent-review.png`。这些本地产物被忽略，不作为必须随仓库分发的文件。

## 验证中发现并修复的问题

- 本机精确 Rust 1.95.0 工具链安装缺少 manifest，按同一精确版本恢复安装后验证通过；未改全局默认工具链。
- 桌面初始打包目标误用了工具 Node 26；实际窗口确认 Electron 内置 Node 24 后，修正编译目标与 Node 类型。
- 启动失败、超时、提前退出和迟到状态可能导致子进程残留或错误状态被覆盖；补齐回收路径、启动 / 停止守卫和 revision 处理。
- Rust 启动测试原本可能无限等待输出，失败时可能遗留 child；增加读取超时与异常路径的 kill / wait。
- 首轮 Electron smoke 将主进程 evaluate 用于 DOM，导致 `window is not defined`；修为页面上下文后复跑通过。成功日志也移至全部关闭回收断言之后。
- SIGINT 构建中断的首轮采样错过了短暂的缓存构建，未计为通过；重试使用独立空 `CARGO_TARGET_DIR`，观察真实 Cargo 进程后中断并确认回收。SIGTERM 场景正常通过。

## 剩余限制

- 完整版本握手、查询请求 / 响应、取消、分块及协议异常矩阵留给 P0-02；目前只有启动事件及必要的长度、超时和生命周期保护。
- UI 当前加载本地构建的 `file://` 资产，严格 CSP 与导航 / 新窗口限制已启用；main 的窗口、顶层 frame、精确 URL 校验已经实现，但尚未执行直接伪造 IPC 消息的完整对抗测试。
- Windows / Linux、分发包、Finder 安装后启动、签名公证、长期稳定性未验证；进程树 smoke 使用本机 `ps`，不是 Windows 验收脚本。
- Git 首批历史、fixture、搜索、diff、统计尚未实现。未测首屏 / 深页 / 搜索 / RSS / CPU，不对 VALIDATION 中的性能目标作达标声明。
