# P0-02 协议与生命周期验收

日期：2026-11-07。结论：P0-02 在本机 macOS / arm64 验收通过。M0 尚未完成，下一项为 P0-03 的仓库 fixture、首屏读取与基线测量。

## 范围与版本

- 主代理编写 [代码级计划](../implementation/p0-02-protocol.md)，两个 gpt-6-luna 代理分别实现 Rust 服务端与桌面客户端，主代理审查并独立复测。
- 应用与核心仍为 `0.1.0`，协议版本为 `1`；工作区尚无本次 Git 提交。依赖沿用锁文件，没有为协议引入新运行时框架。
- 本项提供握手、关联请求、真实运行信息分块、取消、超时、背压与进程回收。`getRuntimeInfo` 返回实际核心 PID / 版本，并重新探测本机 Git 版本；尚不读取 Git 仓库。
- Rust 类型同时生成三份 draft-07 schema 和 TypeScript。nullable 字段必须出现并显式传 null；禁止未知字段，缺字段和畸形消息拒绝进入查询。
- renderer / preload 仍只有核心状态接口。通用 transport 与上下文门控留在 main，不暴露到页面。

## 环境

沿用 [P0-01 的实测环境](p0-01-bootstrap.md)：macOS 27.0.1 / arm64，构建 Node 26.0.0、pnpm 10.28.1、Rust 1.95.0；Electron 45.2.3 内置 Node 24.22.2。main / preload 编译目标为 Node 24。本项使用 debug Rust 二进制，不是发布性能测量。

## 检查结果

| 命令 / 场景 | 主代理实际结果 |
| --- | --- |
| `pnpm protocol:check` | 通过，三份 schema / TS 与 Rust 导出一致 |
| `cargo fmt --all -- --check` | 通过 |
| `cargo test --workspace --locked` | 通过，2 个 core 单元测试、8 个 daemon 单元测试、8 个真实 daemon 集成测试，共 18 个 |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过，真实 daemon 与桌面资源均重新构建 |
| `pnpm test:protocol` | 通过，13 个测试；主代理另在 Electron 内置 Node 24.22.2 下执行相同协议测试，13 个全部通过 |
| `pnpm test:smoke` | 通过，真实窗口、安全隔离、错误状态、关窗和启动器 SIGTERM / SIGINT 回收均通过 |
| 慢 Git 运行中实际关窗 | 通过，关闭前确认 Git 仍存活；捕获的 Electron、三个辅助进程、Rust daemon 与 Git 共 6 个进程全部退出 |

Rust 测试验证握手与真实双分块、协议版本不匹配、未握手与重复握手、握手超时、重复活动 requestId、请求级错误不关闭健康连接、最多两个交互请求、真实慢 Git 进程取消 / 超时 / EOF 回收，以及 UTF-8、CRLF、超长与截断帧。

桌面协议测试验证真实核心信息、逐字节握手、同一数据块中的重复 hello、版本错误、畸形 / 超长 / 非法 UTF-8、分块序号与上下文不匹配、取消与超时后的迟到结果、单个回调异常不影响其他请求、背压队列上限与 listener 清理、stdout EOF、stop 和 daemon SIGKILL 后的实际 Git 进程回收。

上下文测试同时覆盖门控单元和真实 pending 生命周期：观察新版本后原请求仍能完成；显式切换后旧请求返回 `STALE_CONTEXT`、迟到分块不再交付；已判旧的请求不写入 stdin；切回有效上下文后可继续请求。这里使用受控协议 peer，不伪称已经建立真实仓库快照。

主代理另用真实 daemon 独立验证，四项均通过：

1. JSON 恰好 1 MiB，先写 CR、另一个输入块再写 LF，握手成功。
2. 请求省略必填的 nullable 字段，返回协议错误并退出。
3. 客户端关闭 stdout 读取端但保留 stdin，daemon 能观察输出失败并退出。
4. 客户端停止读取 stdout 并持续提交请求，有界输出队列饱和后连接退出，不因阻塞 writer 永久挂起。

## 审查中修复的边界

- 帧上限排除 CRLF 两个换行字节，覆盖 CR / LF 恰好跨读取块；非法 UTF-8 后同一块里的后续消息不得继续交付。
- 写阻塞期间也要处理握手超时；重复 hello 不能在异步继续执行后把错误状态覆盖为 ready。
- 取消立即移除 pending，再通知核心；上下文注册时即判旧的请求不能在 cancel 之后又写出原请求。
- 输出失败需唤醒服务端退出；无效上下文错误不回显超长输入；重复活动 requestId 不能覆盖原任务或产生两个独立终止结果。
- 核心 leader 已退出时仍须清理它所属的已知进程组；等待 `close` 或仅检查 leader 是否存活不足以证明 Git 已退出。
- 测试端也须立即处理预期的 Promise rejection，并在失败路径回收 child。首轮桌面复测遇到正在修改的 framing 测试中缺少 async 声明，修正后完整复跑通过；握手超时使用明确不回复 hello 的 peer，不依赖机器启动速度。
- 窗口回归的旧错误文案断言在新增 stdout EOF 检测后失效，改为验证 `CORE_EXITED` 与可见错误状态；实际核心退出仍能被用户看到。

## 证据与剩余范围

本机证据保存如下；这些产物被忽略，不要求随仓库分发：

- `output/playwright/p0-02-rust-checks.log`：Rust 独立检查。
- `output/playwright/p0-02-desktop-checks.log`：生成一致性、类型、构建、协议与窗口检查。
- `output/playwright/p0-02-electron-node-checks.log`：Electron 内置 Node 版本与全部协议测试。
- `output/playwright/p0-02-parent-protocol.json`：主代理服务端异常检查。
- `output/playwright/p0-02-parent-window.json`：慢 Git 运行中关窗、实际捕获进程树与无残留结果。
- `output/playwright/p0-02-ready.png`、`output/playwright/p0-02-closing-during-git.png`：已检查的真实窗口截图。

复现 Electron Node 运行时检查（macOS）：

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/test-protocol.mjs
```

当前与最新已观察上下文的规则仅由门控 / 协议测试验证。真实仓库 handle、固定 tip 快照、引用变化通知和用户点击刷新尚未实现，不能将本项视为这些产品能力的验收。

没有 Git 历史、分页、搜索、图、diff 或统计能力；未测首屏、深页、RSS、CPU 与长期运行，不对性能预算作达标声明。Windows 的进程树回收、安装包、Finder 启动与分发验收仍在后续阶段。
