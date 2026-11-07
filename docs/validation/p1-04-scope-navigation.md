# P1-04 分支与 worktree 导航验收记录

日期：2026-11-07。状态：P1-04 本机 macOS 技术验收完成；不是完整 MVP 或发布性能验收。实现基于 `11ae57b` 之后的本地改动，保留 P1-03 / UI-03 工作；没有提交或推送。契约见[代码级计划](../implementation/p1-04-scope-navigation.md)。

## 实现范围

- 范围选择器接入真实 HEAD、全部分支、本地分支、远端跟踪分支、标签与 worktree。全部分支仅包括 heads/remotes 可达历史，使用冻结的去重 tips，不并入 stash、reflog 或仅 tag 可达提交。
- 切范围先准备首屏再原子替换会话。另一个 worktree 只改变浏览范围，本窗口目录和身份保持不变。刷新继续解析原 scope；引用删除、非 commit 标签、不可用 worktree 明确失败，保留原内容。
- 导航清单及合入判断绑定冻结快照。默认基准依次为有效 origin/HEAD 目标、origin/main、origin/master、本地 main、本地 master；没有基准不显示合入状态。可见本地分支按需计算，只有正向祖先证明才标“已合入”，不对不可达分支给“未合入”结论。
- 显示 worktree 路径、检出分支、主 / linked、本窗口、detached / unborn、锁定及不可用事实；列表与详情标识其他 worktree 的 HEAD。远端明确为本地引用快照，fetch 时间未知，应用不 fetch。
- 新增窄业务 IPC 与 `repositoryScopes` capability；renderer 仍只持有有界页及视图状态。每次范围变更清理旧页 / 导航 / 合入查询，分别判定会话与选择意图；失败信息在弹层外可见。

## 已完成检查

| 检查 | 结果与证据 |
| --- | --- |
| Rust workspace | core 4、daemon unit 27、startup 12，共 43 项通过；`output/test/p1-04-rust-final.log` |
| Rust 格式 / Clippy | `cargo fmt --all -- --check`；`cargo clippy --workspace --all-targets --locked -- -D warnings` 通过 |
| schema | `pnpm protocol:check` 通过；`output/test/p1-04-protocol-check.log` |
| TypeScript / renderer | `pnpm typecheck` 通过；`pnpm test:renderer` 38 项通过 |
| 协议 / main | Node 26 与 Electron Node 24 各 31 项通过，含真实 daemon → transport → controller；`output/test/p1-04-protocol-electron-node-final.log` |
| 真实导航 | `pnpm test:navigation` 9 组通过；`output/test/p1-04-navigation.log` |
| 会话回归 | `pnpm test:sessions` 10 项通过；`output/test/p1-04-sessions.log` |
| 历史回归 | `pnpm test:history` 16 项通过、1 项大仓诊断按计划跳过；`output/test/p1-04-history.log` |
| release 构建 | `pnpm build:release` 通过；`output/test/p1-04-build-release-ui-final.log` |
| 启动 / 隔离 | `pnpm test:smoke` 通过，真实核心、安全隔离、失败状态、关闭及 SIGTERM / SIGINT 回收；`output/test/p1-04-basic-smoke.log` |
| 历史实窗回归 | `pnpm test:smoke:history` 通过，选择保留、刷新锚点与新增标记；`output/test/p1-04-history-smoke-r2.log` |
| 虚拟历史回归 | `pnpm test:smoke:virtual-history` 通过，2205 条正反向遍历、2000 条上限、键盘 / 复制 / 只读；`output/test/p1-04-virtual-history-smoke.log` |
| 范围实窗 | `pnpm test:smoke:scope-navigation` 通过；`output/test/p1-04-scope-smoke.log` |

导航测试使用临时真实 Git 仓库，以独立 Git 命令对照完整分页顺序、去重和祖先方向，覆盖：多 tip、远端独有提交、annotated / lightweight tag、仅 tag / stash / reflog 排除、detached、SHA-256、unborn 窗口下其他非空分支、空 linked worktree、prunable、默认基准全部回退层级、按 scope 隔离查看记录、目标失效与取消迟到响应。导航 / 合入 coverage 条数也有明确断言。文件快照验证只读边界，fixture 内主动的引用变动单独纳入对照基线。

最终实窗使用 release daemon 与 renderer `index-BVmUDxxZ.js`。主代理审查了 `output/playwright/p1-04-scope-picker.png` 和 `p1-04-scope-error.png`：本窗口与浏览范围分开、worktree 路径与主分支名可辨、合入徽标与基准可见，远端说明包含观察时间及未 fetch；未接入区保留占位编号。无效标签与删除引用后的失败均在关闭弹层时可见，旧范围和旧摘要保留，可显式切回 HEAD 恢复。错误附带原始英文核心诊断，但中文标题和保留状态完整。窗口 bounds 与 content bounds 起点相同，未重新引入系统标题栏。smoke 结束后 Electron / daemon 已退出。

## 审查与修复

1. 默认基准和标签解析使用捕获的 OID，避免在准备过程中重读移动中的引用名称。worktree 捕获使用 NUL porcelain，明确主目录、本窗口与缺失路径；macOS 规范化路径比较不能把两个失败结果视为相同目录。
2. 多 tip 扩展保留 P1-03 的正向旧历史遍历。缺失旧链中间对象时，即使 Git 的负 tip 查询成功，也必须降级新增标记；真实集成回归通过。
3. 导航获取失败不会阻止基础 HEAD 浏览；截断或超大响应不会被当作完整成功，也不会静默丢帧。
4. 范围切换与刷新 / 页读取互斥；取消可关闭并排空会话，等待期间的新选择优先于旧异步结果。合入查询错误不能由可见性观察器无限重试。
5. 联调审查发现 desktop 仍按 `processed=1` 校验导航 / 合入结果，与 Rust 的条目计数契约不一致。补充真实 daemon + controller 测试后，又发现通信层的手写方法允许列表未登记新方法；这类问题必须覆盖 controller → transport → daemon 整条路径，不能只依赖两侧模拟测试。
6. 初轮导航测试失败来自 fixture / harness：stdin 等待、远端路径环境映射、分支尚未实际合入、macOS `/var` 与 `/private/var`、stash 预期集合。修正后 9 组通过；早期失败日志保留，不作为通过证据。
7. 实窗发现范围切换同帧触发最近仓库、记录查看、导航三个请求，超过 transport 的两个 pending 上限，导航加载受到阻塞。最近仓库自动刷新改为只依赖本窗口身份；切换范围只重新请求新会话导航，不复用旧快照。分支检出关系移到第二行，确保主分支名不被徽标挤没。
8. 实窗脚本最初将 async 函数传给当前 Playwright 的 `waitForFunction`，Promise 被当作真值导致等待提前结束，开仓前查询误报“核心尚未就绪”。对照本地 Playwright 实现及 starting → ready 事件确认不是核心退出；脚本改为 Node 侧等待异步 IPC，再同步断言 DOM / OID，并复用返回的会话。旧历史 smoke 的文案断言同步为“当前已加载窗口 / 不推断整个范围的可达性”，保留原有选择与锚点行为断言，复跑通过。

## 验收边界

本项不实现 SQLite 索引、元数据搜索、Rust 分支图、diff、更新监测、包含分支查询或 squash / rebase 补丁等价识别；相应占位继续保留任务编号。范围变更只返回新首屏，旧选择不在已加载窗口时保留摘要并明确提示，不推断其是否仍被整个范围包含。

本次不重复性能测量。P1-03 的整树空闲 RSS 超过 500 MiB 目标仍留待 P4-01；既有帧率数据不能当作本次多范围导航的性能结果。只验收本机 macOS，未验证 Windows / Linux，也不是签名安装包或完整 MVP 验收。
