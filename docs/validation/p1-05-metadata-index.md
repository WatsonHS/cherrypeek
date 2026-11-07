# P1-05 元数据索引验收记录

日期：2026-11-07。状态：已完成本机 macOS 技术验收。前一阶段已提交为 `ba4a059`；本项改动暂未提交。契约见[代码级计划](../implementation/p1-05-metadata-index.md)。

## 实现范围

SQLite 索引位于应用数据目录，提交对象与固定快照的成员关系分开保存。保存完整消息、有序 parents、Author / Committer 及各自原始时间和偏移；不读取 patch，不实现搜索或 FTS5。索引任务在历史首屏之后低优先级运行，支持暂停、继续、取消和重建。只有正常完成固定 tips 遍历并提交全部成员后，coverage 才能标为完整。

桌面通过两个窄业务接口读取状态和控制任务；底栏显示真实已处理数量与状态，动作在小型弹层中。原搜索入口仍标注 P1-06 占位。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Rust | `cargo fmt --all -- --check`、workspace tests（core 5、daemon 33、startup 12）及 clippy `-D warnings` 通过；最后全套日志 `output/test/p1-05-rust-final.log` |
| 生成协议 | `pnpm protocol:check` 通过 |
| TypeScript | `pnpm typecheck` 通过 |
| renderer | `pnpm test:renderer` 39 项通过，含轮询失效不丢弃操作响应 |
| Node 26 协议 | `pnpm test:protocol` 33 项通过；真实 controller → transport → daemon 的索引状态 / 控制路径通过，`output/test/p1-05-protocol-node26-r2.log` |
| Electron Node 24.22.2 协议 | `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-protocol.mjs` 33 项通过，`output/test/p1-05-protocol-electron.log` |
| 原有会话 / 导航 | `pnpm test:sessions` 10 项、`pnpm test:navigation` 9 项通过 |
| 原有历史 | `pnpm test:history` 16 项通过；按计划跳过 1 项 10 万提交标记性能观测 |
| Release 构建 | `pnpm build:release` 通过；不是发行安装包 |
| 既有 Electron 实窗 | 基础启动 / 隔离、历史刷新、2205 条虚拟历史与 2000 条上限、范围 / worktree 导航四个 smoke 均通过 |
| 索引 Electron 实窗 | `pnpm test:smoke:metadata-index` 通过，日志 `output/test/p1-05-index-smoke-r4.log`；进度、暂停 / 继续 / 取消、范围隔离、重开复用、故障提示和按钮重建均通过 |
| 真实 SQLite 索引 | `pnpm test:indexing` 9 项通过，`output/test/p1-05-indexing-final-r2.log`；成员与完整元数据对照、恢复、配额和异常路径均通过 |

真实索引集成覆盖：完整消息 / Unicode / trailer、双身份与原始偏移、有序多父、SHA-256 OID；head 与 allBranches 的独立成员顺序；空仓完成 0 条与 8 快照淘汰 / 重建；浅克隆及对象删除后的部分覆盖；外部 refs 移动、刷新与旧控制隔离；缺失、损坏、未知 schema 与显式重建；symlink / hardlink、仓库内应用目录拒绝及相邻文件保留；运行中替换 DB 身份；配额回滚、暂停 / 取消的子进程回收和强退后持久前缀续建。索引前后比较真实仓库内容，确认应用只写自己的缓存。

实窗使用独立真实仓库（HEAD 可达 188 条、side 可达 136 条），让历史先显示，再门控索引批次观察已落盘 64 条的进度；暂停 / 取消返回后确认 Git 子进程退出，继续后完整数量与 Git 一致。同 profile 重开复用完整状态。关闭应用后损坏派生数据库，重开仍能读历史并看到 `INDEX_CORRUPT`；点击重建后恢复 SQLite 文件及 188 条完整覆盖。截图在忽略目录 `output/playwright/p1-05-index-{running,paused,cancelled,unavailable}.png`，主代理已检查状态弹层和故障提示。

## 审查与修复记录

- 状态响应 envelope 的 `processed=1` 只表示单条状态消息，索引实际计数使用 `status.coverage`；健康状态的 `error:null` 必须通过 Rust / schema / TypeScript 三端校验。
- 轮询和用户操作使用独立请求意图。操作引起 effect 清理时，不丢弃它自己的响应；隐藏状态进入组件也必须注册可见性监听，回到前台可以恢复轮询。
- 主控制器只在实际存在索引请求时等待其取消 / 排空，避免额外微任务改变既有打开 / 切仓请求的同步取消顺序。
- 索引按钮与 store 复用同一交互空闲判断；翻页、记录查看或刷新期间禁用，避免可点击按钮静默拒绝操作。
- SQLite pragma 的作用域、事务前配额、检查点顺序、快照淘汰及任务回收均纳入核心审查。数据库初始化 / 完整性检查必须留在后台，状态读取只使用内存与轻量文件检查，不能阻塞 server 主循环。
- 后台任务发布时原子复核当前会话，进度更新再次判旧；SQLite 连接保存打开时文件身份，运行中更换文件不能继续向旧句柄写入并宣称新路径完整。
- EOF 先撤销索引活动上下文，再取消 / 回收任务；历史页尾部或范围准备中迟到的 ensure 不得在 shutdown 之后重新启动。

## 验收边界

本项已完成本机 macOS 行为与正确性验收；测试窗口、daemon 和受控 Git 进程已清理。Windows / Linux、安装包与大仓索引性能尚未验收。

搜索语义与界面属于 P1-06；M1、MVP 和发行验收尚未完成。本项不重复 P1-03 的性能矩阵，也不据小型 fixture 的运行耗时声明大仓索引速度或恢复时延。
