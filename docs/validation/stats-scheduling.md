# 统计与演化请求调度验证

日期：2026-11-12。范围：首批 Rust daemon 调度、对照测试、文档与性能脚本；随后用户授权解决桌面限制，追加 main transport / 控制器修改。renderer、preload、协议字段与索引让路规则不变。

## 行为与边界

- 删除普通请求准入时取消所有辅助请求的逻辑。四个统计读取 `getActivityOverview` / `getChangeStats` / `getNotableStats` / `getStatsCommits` 继续运行，仍可显式取消，仍受原来的 15 秒截止与计算 / 输出上限保护。
- 两条交互额度和一条操作额度不变。四个统计读取及 get / set 排除配置共用一条辅助额度；演化估算 / 分析共用另一条辅助额度。同额度重入返回 `BUSY`，长演化不再阻塞统计准入。交互活跃时也允许辅助任务准入。
- 只有四个统计读取的专用 worker 调整线程优先级；worker 不复用，结束即销毁。估算、配置、演化、交互、索引和操作线程不调用优先级设置函数。API 失败只在 stderr 记录，继续执行。
- 演化在文件预选边界、逐文件 blame 边界等待任何非辅助、非操作的活动请求；包括 `readWorkspaceStatus`、`readHistoryPage`、旧 `getActivityStats` 和短暂的 `getMetadataIndexStatus`。正在处理的单文件不会因新读取被中止。完成文件先累计、推送结果，再等待；等待不丢弃已完成结果或缓存。
- 取消、会话 / generation 替换、关闭、daemon EOF 的原路径未更改。索引的 `blocks_background` 定义和 TaskManager 未更改；辅助任务仍阻挡索引下一批，包括演化暂停期间。

## 优先级与超时

| 平台 | 本次实现 | 验证范围 |
| --- | --- | --- |
| macOS | 当前 pthread 调用 `pthread_set_qos_class_self_np(QOS_CLASS_UTILITY /* 0x11 */, 0)` | 本机单元测试读回 utility，并验证父线程优先级不变；真实 release daemon 实测无设置失败日志 |
| Linux / Android | 当前线程调用 `getpriority(PRIO_PROCESS, 0)`，再 `setpriority(PRIO_PROCESS, 0, max(原值, 10))`，不提升原本更低的优先级 | 有相同的条件编译单元测试；本机未编译或运行这些目标 |
| 其他 Unix、Windows 等 | 保持普通优先级；代码注明没有接入线程级后台 API，不调用可能影响整个进程的 POSIX nice | 未验证 |

API 依据：[Apple pthread QoS](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/PrioritizeWorkAtTheTaskLevel.html)、[Linux 每线程 nice](https://man7.org/linux/man-pages/man7/sched.7.html)。本轮不涉及整进程 nice，也不改变交互、索引或操作的线程优先级。

演化 daemon 的 **600 秒预算扣除文件边界的协作暂停时间**。等待时每 10 ms 检查取消并顺延截止；进入等待前若工作预算已耗尽，直接 `TIMEOUT`，不能用暂停复活超时任务。Git、SQLite、文件预选、聚合、缓存和输出的其余时间仍计入。估算不暂停，仍使用原 600 秒截止。

## 桌面跟进（同日用户授权）

main transport 与 daemon 使用相同额度：交互 2、统计 / 配置 1、演化 1、操作 1。四个统计读取及 get / set 排除配置互斥；estimate / analyze 互斥；这些任务不再占交互额度。同额度重入仍返回 `BUSY`，取消排空期间不提前释放额度，防止新请求抢进核心尚未释放的槽位。旧顶栏 `getActivityStats` 仍属于交互读取，保留原有 main 抢占行为。

控制器不再为 `analyzeEvolution` 设置 615 秒总超时，由 daemon 统一管理扣除暂停的 600 秒工作预算。内部 `RequestOptions.timeoutMs` 可取 `null`，但 transport 只允许 `analyzeEvolution` 且 `drainAfterAbort=true` 使用；没有修改 JSON Lines 请求或响应的任何字段。其他请求（包括统计 / 估算的 main 60 秒）沿用原超时。

显式取消 / 上下文替换时仍发送 cancel 并排空终态；若 5 秒内无终态，transport 报 `TIMEOUT` 关闭连接，由 CoreProcess 走现有失败回收。核心崩溃 / EOF / 应用退出仍结束待处理请求。上下文替换后的迟到完成帧也允许排空，但不交给 onChunk；保留取消或失效错误，清除计时器并释放额度。

分析进行中不再额外用总时间或无进度时间判断超时，因为长暂停也可能没有 chunk。若核心异常卡住但未退出，可显式取消触发上述有界回收；主进程不猜测核心实际暂停时间。性能报告仍是首批 daemon 实测，没有改写为桌面性能结论。


## 自动验证（首批 daemon）

环境：macOS 27.0.1，MacBookPro18,3，当前工作树；测试缓存和 fixture 在临时目录。

| 命令 | 实际结果 |
| --- | --- |
| `cargo test --workspace --locked` | 通过：core 5、daemon 102、startup 12，共 119 项；其余目标 / doc-test 0 项 |
| `pnpm protocol:check` | 通过，schema、TypeScript 类型、standalone validator 无漂移 |
| `pnpm test:pages` | 38 项通过，含 2 项新增调度测试和 1 项更新的演化生命周期测试 |
| `pnpm test:protocol` | 宿主 Node 55 项通过；当前脚本没有另跑 Electron 内置 Node |
| `cargo build --release --locked -p commitscope-daemon` | 通过；用于性能测量 |
| `rustfmt --edition 2024 --check crates/daemon/src/evolution.rs crates/daemon/src/stats.rs` | 通过，仅检查本轮已格式化的两个文件 |
| `git diff --check` | 通过 |

新增 / 更新的证据：

1. 四个统计方法逐一取得无干扰基线；在 debug 专用等待点持住 worker，连续三轮并行读取工作区与历史页，再观察仓库；统计始终保持活动，没有 `CANCELLED`，释放后结果与基线完整相等。同一统计额度的第二请求仍为 `BUSY`。统计路径纯 SQLite、没有 Git 子进程，故等待点只在 `debug_assertions` 构建中启用，release 不读取该测试环境变量。
2. 持住的统计分别由显式 cancel、刷新 generation、重开会话、关闭取消，均在 2 秒测试上限内结束。daemon EOF 也在 2 秒内正常退出；不要求退出前一定发出终态帧。
3. 三文件演化与独立缓存的无干扰基线对照。在第一个 blame 进行时启动并持住工作区读取；释放 blame 后第一文件完整结果已推送，持续等待 200 ms 不再产生后续文件或 complete 帧。Git 子进程已回收。释放工作区读取后，除 `asOfUnix` 外所有累积 chunk 与基线一致，最终 complete。运行中及暂停中均可完成活动统计。
4. 交互读取已被持住时启动热缓存演化，分析被准入并等待；不释放该读取，显式 cancel 仍在 1 秒测试上限内返回 `CANCELLED`。
5. 原来的演化交互抢占测试改为 generation 替换测试，仍验证取消 / 替换回收 Git，并保留已完成文件进度。
6. Rust 单元测试验证 100 ms 暂停超过原 40 ms 剩余预算后仍可继续、已耗尽的预算不复活、无限暂停可以取消。平台测试读回 worker 的线程优先级，同时检查创建它的线程保持原值。

等待测试使用状态 / Git gate 握手确定执行位置，时间上限仅作为失败保护，不把它们当生产延迟实测。完整性能数字和采样限制见[统计调度测量](../benchmarks/stats-scheduling.md)。

## 桌面跟进验证

新增 `tests/protocol/stats-scheduling.test.mjs` 共 5 项，更新 M5/M6 接线测试，验证：

- 全部六个统计 / 配置方法、两种演化方法按独立额度准入，同时保留两个交互和一个操作请求；超额请求不发给 daemon，旧顶栏统计仍计入交互额度。
- 虚拟时钟推进 700 秒，分析仍可接收累计结果并完成；daemon 发出的 `TIMEOUT` 仍传给调用方，其他方法不能关闭客户端截止。
- 显式取消、generation 替换保留额度到终态，迟到旧 chunk 不交给界面；迟到成功终态也能正确排空，结束后不残留计时器。无响应取消在虚拟时间 5000 ms 关闭连接；核心退出也能结束无总超时的分析。
- 使用真正的 RepositorySessionController → CoreProcess → ProtocolTransport → debug daemon 链路，在临时真实仓库上同时持住工作区读取、暂停演化、持住统计，再读取历史，结果与空闲基线一致；解除等待后统计结果与基线一致、演化 complete。暂停时通过 controller 取消分析后，核心仍可继续读取。
- 控制器实际为 analyze 传递 `timeoutMs:null` 与 `drainAfterAbort:true`，而其他请求保留已有截止；不是只测试一个未接线的 transport 选项。

本轮 `pnpm typecheck`、`pnpm protocol:check`、完整 `pnpm test:protocol`（宿主 Node **60 项全部通过**）及 `git diff --check` 通过。首批 Rust / pages 检查仍是上一节实测，本轮未改 Rust 或重跑该性能测量。没有运行桌面窗口，也没有实际等待 700 秒。

## 文件范围与未验证项

- daemon 实现：`crates/daemon/src/server.rs`（准入 / 独立额度 / 交互活动判定）、`stats.rs`（线程优先级 / debug gate / 平台测试）、`evolution.rs`（文件边界等待 / 工作预算 / 单元测试）。
- 测试：`scripts/test-pages.mjs`（第二个独立 Git gate）、`tests/pages/stats-scheduling.test.mjs`（新增对照）、`pages-git.test.mjs`（注册）、`stats-git.test.mjs`（取消测试改为 generation 替换）；性能脚本 `tests/benchmarks/stats-scheduling.mjs`。
- main 跟进：`apps/desktop/src/main/protocol-transport.ts`、`apps/desktop/src/main/repository-session-controller.ts`；测试 `tests/protocol/stats-scheduling.test.mjs`、`tests/protocol/m5-m6-wiring.test.mjs`。
- 文档：ARCHITECTURE、DEVELOPMENT、PLAN、M5/M6 接口约定、P6-01 / P6-05 计划、本验证记录及性能报告 / JSON。
- `apps/desktop` 的 renderer / preload、`crates/core`、`packages/protocol`、元数据索引实现无改动；未运行 stash、reset、checkout，也未修改既有品牌文件。
- 未做：Linux / Android / 其他平台运行或交叉编译、优先级 API 失败注入、桌面实窗验收、600 秒以上实际暂停、CPU 持续满载或长期稳定性验证。没有跑 workspace 全量格式 / clippy，也不宣称通过。
