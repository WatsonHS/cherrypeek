# P0-01：最小工程代码级计划

日期：2026-11-07。状态：已实现并通过本机 macOS 验收，见 [验证记录](../validation/p0-01-bootstrap.md)。范围由用户确认开始，代码实现交给两个 gpt-6-luna 代理，主代理负责计划、审查、集成验证和证据。

## 交付边界

执行开发命令后打开真实 Electron 窗口，由 Electron main 异步启动真实 Rust daemon，React 通过窄 preload API 显示核心启动状态、版本和 PID。关闭窗口或终止开发命令后回收本次进程。页面明确说明当前仅为运行链路验证，尚未读取 Git 仓库。

本项仅为 P0-01，不交付仓库浏览、模拟提交列表、通用 RPC、后台索引、图布局、安装包或性能达标声明。P0-02 再扩展请求握手、分块、取消、超时和完整协议恢复；P0-03 才读取真实仓库。这里的真实启动事件不是完整握手已经验收的证明。

## 环境与依赖

本机已确认 macOS 27.0.1 / arm64、Node 26.0.0、pnpm 10.28.1、Rust 1.95.0、Git 2.54.0。Node 与 Rust 精确版本写入 `.node-version`、`rust-toolchain.toml`，pnpm 写入根 `package.json` 的 `packageManager`，不修改全局工具链。

实际启动后确认 Electron 45.2.3 内置 Node 24.22.2 / Chromium 156.0.8078.80。工具脚本仍运行于本机 Node 26，main / preload 的 esbuild target 按 Node 24，Node 类型采用兼容的 24.19.2，不能把工具链版本当作应用内置运行时版本。

从 npm registry 核实的候选版本：Electron 45.2.3、React / React DOM 19.3.1、TypeScript 7.0.2、Vite 8.3.6、esbuild 0.28.2、Playwright 1.65.0、json-schema-to-typescript 16.0.0、Ajv 8.20.0。依赖用精确版本，最终兼容性以实际构建和运行决定；如果需调整，在证据中记录原因。提交 pnpm 和 Cargo lockfile。Rust 的 serde、serde_json、schemars 使用实际可获得且兼容的版本锁定；网络失败可以使用已缓存包，不关闭 TLS 校验。

pnpm 使用仓库级 `onlyBuiltDependencies` 明确允许 Electron 与 esbuild 必要的安装脚本，不全局开放任意依赖脚本。

## 文件与责任边界

| 路径 | 内容 | 执行者 |
| --- | --- | --- |
| `Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml` | workspace、精确工具链和锁文件 | Rust 代理 |
| `crates/core/Cargo.toml`、`crates/core/src/lib.rs` | 核心版本、启动事件类型与构造函数 | Rust 代理 |
| `crates/core/src/bin/export-protocol.rs` | 从真实 Rust 类型生成 JSON Schema 到 stdout | Rust 代理 |
| `crates/daemon/Cargo.toml`、`crates/daemon/src/main.rs` | 启动事件、flush、stdin EOF 退出 | Rust 代理 |
| `packages/protocol/schema/core-ready.schema.json` | 自动生成并纳入版本管理的 schema | Rust 代理 |
| 根 `package.json`、`pnpm-workspace.yaml`、`.node-version`、`pnpm-lock.yaml` | JS workspace 与固定命令入口 | 桌面代理 |
| `packages/protocol/package.json`、`packages/protocol/src/` | 从 schema 生成 TS 类型、桌面状态与 API 类型 | 桌面代理 |
| `apps/desktop/package.json`、`tsconfig*.json`、`vite.config.ts` | 桌面项目与构建配置 | 桌面代理 |
| `apps/desktop/src/main/index.ts`、`core-process.ts` | 窗口、IPC 校验、核心子进程与状态 | 桌面代理 |
| `apps/desktop/src/preload/index.ts` | 仅暴露两个核心状态业务接口 | 桌面代理 |
| `apps/desktop/index.html`、`src/renderer/` | React 启动状态界面、外部 CSS、严格 CSP | 桌面代理 |
| `scripts/*.mjs`、`tests/smoke/` | 协议生成、构建、启动、进程回收和 Electron 验证 | 桌面代理 |
| README、PLAN、验收证据、本计划 | 状态与命令说明、最终验证结论 | 主代理 |

两名代理共享工作区，不回滚彼此或用户已有文件。不得提交 Git commit；不要更改既有产品决策。除必要的 `.gitignore` 增补外，桌面代理不改规划文档。

## Rust 启动协议

Rust 类型作为单一来源，建议 `CoreReady` 字段如下，JSON 字段使用 camelCase：

```json
{"protocolVersion":1,"coreVersion":"0.1.0","pid":12345}
```

`protocolVersion` 为整数，`coreVersion` 取核心 crate 的实际版本，`pid` 来自运行进程。Rust derive Serialize / Deserialize / JsonSchema，拒绝未知字段；导出 draft-07 schema，避免 Node 验证器方言不一致。通过生成器生成 `CoreReady` TypeScript 类型，不手写第二份消息字段表。

daemon 启动后只输出一行有效 UTF-8 JSON 并立即 flush，stdout 保持协议专用，日志写 stderr；随后等待 stdin EOF 正常退出。没有占用 CPU 的自旋，也不调用 Git、不写被查看仓库。Node 校验消息结构、协议版本和 PID 与实际 child.pid 一致，错误必须成为 UI 可见状态。

基础验收覆盖 daemon 启动字段、stdout JSON、stdin EOF 后退出以及生成结果一致性。完整异常帧矩阵属于 P0-02，但本项不能无界缓存启动输出：首帧上限 1 MiB，启动等待上限 5 秒，失败时回收子进程。

## main、preload 与 renderer

`CoreProcess` 只承担本项生命周期：`start()`、`getStatus()`、状态订阅与幂等 `stop()`。状态为 `starting | ready | error | stopped`，带单调递增 `revision`；ready 携带 `CoreReady`，error 携带可展示信息。子进程缺失、启动失败、异常退出不能展示为连接成功。

main 使用异步 `spawn` 和参数数组，不经 shell。运行已构建 daemon，不在窗口进程内执行 Cargo；二进制从应用确定的资源目录解析，不接受 renderer 提供路径。将 daemon 复制到桌面构建资源中，避免窗口依赖偶然的工作目录。可保留仅供本地验证使用的命令行 / 环境故障注入，但不得通过 preload 暴露。

关闭窗口采用本阶段明确的单窗口退出行为，包括 macOS。退出先关闭 daemon stdin，等待正常退出；超时再发送 TERM / KILL，并等待 exit。进程退出或错误后更新状态，不自动重启。启动脚本收到 SIGINT / SIGTERM 时清理自身启动的 Electron，禁止使用宽泛的 `pkill`。停止期间出现迟到启动帧不得重新标成 ready。

窗口固定启用 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`、`webviewTag: false`。拒绝非应用导航、新窗口和权限请求。仅加载本地构建资产；本项 `pnpm dev` 可采用先构建再启动，无需 HMR 服务，因此开发与验收均不需要放宽 CSP 或加载远程脚本。

preload 打包为单文件 CommonJS，运行时仅 external `electron`；沙箱 preload 不依赖本地 `require` 链。只暴露：

```ts
interface CommitScopeApi {
  getCoreStatus(): Promise<CoreStatus>;
  onCoreStatusChanged(listener: (status: CoreStatus) => void): () => void;
}
```

main 校验 IPC 发送窗口、顶层 frame 与准确应用 URL，不使用字符串前缀信任；不暴露原始 ipcRenderer、文件系统、任意通道或进程 API。事件订阅包装回调，不把 Electron event 传入 renderer，并提供可靠的 unsubscribe。

renderer 使用 React，呈现真实启动中 / 就绪 / 失败 / 停止状态与核心版本、PID。订阅后读取状态，按 revision 忽略迟到结果，effect 卸载后清理订阅。无假仓库、假提交、视觉占位功能。样式使用外部 CSS，CSP 至少包含 `default-src 'none'`、`script-src 'self'`、`style-src 'self'`、`connect-src 'none'`、`object-src 'none'`、`base-uri 'none'`、`form-action 'none'`，不使用 unsafe-inline / unsafe-eval。

## 构建与命令契约

本项由简单 Node ESM 脚本编排；不引入额外应用框架。Vite 构建 renderer（相对 asset base），esbuild 打包 main / preload；所有异步子进程失败向上传递退出码。

| 命令 | 行为 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 从已锁依赖安装 |
| `pnpm protocol:generate` | 导出 Rust schema，再生成 TypeScript 类型 |
| `pnpm protocol:check` | 在临时位置生成并比对已提交产物，不悄悄改文件 |
| `pnpm typecheck` | 检查 main、preload、renderer 和共享类型 |
| `pnpm build` | 生成协议、编译 Rust、复制 daemon、构建桌面资产 |
| `pnpm dev` | 先构建，再启动真实 Electron；信号可回收本次子进程 |
| `pnpm start` | 启动已构建的桌面窗口，清除继承的 ELECTRON_RUN_AS_NODE |
| `pnpm test:smoke` | 启动真实 Electron，验证状态、隔离和退出回收 |
| `cargo fmt --all -- --check` | Rust 格式检查 |
| `cargo test --workspace --locked` | Rust 行为测试 |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | Rust 静态检查 |

构建输出到既有忽略的 `dist/`、`target/` 等目录。截图等本地证据放 `output/playwright/` 并忽略；最终可读报告放 `docs/validation/p0-01-bootstrap.md`。不要把机器绝对路径写进可移植构建配置。

## 验收脚本与主代理检查

使用 Playwright Library 的 `_electron` API 运行脚本，不需要 Playwright Test 或安装额外浏览器。关闭 `ELECTRON_RUN_AS_NODE` 后以项目锁定的 Electron 可执行文件启动，并明确设置 `chromiumSandbox: true`（该 API 默认关闭 Chromium 沙箱）；检查实际启动参数未含 `--no-sandbox`，不能只检查 BrowserWindow 声明。必须实际执行以下验证：

1. 打开窗口，看到 core ready、真实 coreVersion 和 PID，PID 对应活着的 Rust 子进程。
2. 主进程读取 BrowserWindow 的实际 webPreferences，验证隔离、沙箱、Node 禁用；renderer 中 `require`、Node `process` 与裸 IPC 不可用，窄 API 存在，CSP 生效，未意外加载外部网页。
3. 记录启动失败和运行中核心退出时的可见错误，禁止静默成功或自动重启；测试只操作本次记录的 child PID。
4. 关闭窗口，等待 Electron 和 daemon 退出，检查本次捕获的进程树 PID 无残留。另验证启动命令收到 SIGTERM / SIGINT 后的清理。
5. 保存一次真实窗口截图和命令结果；不把该最小窗口宣称为 MVP，不宣称首屏 / 内存预算达标。

主代理完成代码审查与独立验证后更新 README、PLAN 和验收记录。只有上述 P0-01 完成条件通过才勾选 P0-01；其他 M0 任务保持未开始。

## 参考依据

- [Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)：隔离、沙箱、导航限制与 IPC 来源校验。
- [Electron 沙箱 preload 约束](https://www.electronjs.org/docs/latest/tutorial/sandbox)：受限 require 与 renderer 权限边界。
- [Vite 官方指南](https://vite.dev/guide/)：当前 Node 兼容范围与构建入口。
- [Playwright Electron API](https://playwright.dev/docs/api/class-electron)：真实 Electron 窗口的自动化验证。
