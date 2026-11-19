# 开发说明

开发进度、文档索引、本地运行与测试。面向使用者的介绍见 [README](../README.md)（[English](../README.en.md)）。

## 开发进度

2026-11-20 发布前收口与 CherryPeek 0.1.0 品牌 / 发行准备：
- 品牌图标与原生界面补齐：将欢迎页 `OpenScreen`（`apps/desktop/src/renderer/components/open-screen.tsx`）残留的旧版 CommitScope 蓝橙方块图标替换为定稿的 CherryPeek 矢量图标（`docs/brand/icon/cherrypeek.svg`），新增 `apps/desktop/public/icon.svg` 与 `index.html` 图标声明；`scripts/build.mjs` 同步复制 `cherrypeek-256.png` 至 `dist/resources/icon.png`，主进程（`apps/desktop/src/main/index.ts`）在 macOS 开发态设置 Dock 图标并补齐原生「关于 CherryPeek」面板信息；`ShortcutGuide` 补充 `⌘O` 打开仓库说明，移除未引用的早期 `placeholder-widgets.tsx`。
- 打包脚本与发行文档同步：`scripts/package-macos.mjs` 清理历史 `CommitScope-*` 产物并补齐包元信息，`scripts/release-macos.mjs` 在构建前前置校验 `notarytool` 钥匙串凭据（默认配置名 `cherrypeek`），`scripts/third-party-licenses.mjs` 改为直接从本地 `pnpm -r list --prod` 解析依赖以免全局 pnpm store 索引裁剪阻断发布；同步更新 `docs/releases/v0.1.0.md`、`README.md` 与 `README.en.md`（纳入 M5–M8 安全收口、三栏轻量合并与批次审阅完整口径），重新生成 `build/icon.icns` 与 `THIRD_PARTY_LICENSES.md`。
- 全套验证（本机 arm64）：`pnpm icon:mac`、`pnpm licenses:third-party`、`pnpm protocol:check`、`pnpm typecheck`、`cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`（0 告警）、`cargo test --workspace --locked`（5 + 125 项及集成测试全过）、`pnpm test:renderer`、`pnpm test:protocol`、`pnpm test:pages`（55 项）、Electron 实窗冒烟（`test:smoke`、`test:smoke:pages`、`test:smoke:batch-review`、`m7-review-gate-smoke`、`m8-three-pane-merge-smoke`）以及 `pnpm package:mac` + `pnpm test:smoke:package` 全部通过（并复核 `output/playwright/p0-01-ready.png` 新欢迎页图标）。

2026-11-18 高频提交批次追踪、细粒度时间筛选与交给 Agent 扩容改进：
- 上次更新 / 自上次查看新增批次追踪与 `excludeTips` 拓扑过滤：`HistoryPage` 与 `OperationRun::Done`（快进更新、快进合入、合并同步）在后端流式测量完整新增总数与 `[minUnix, maxUnix]` 时间跨度（不写被查看仓库）；`SearchQuery` 支持可选 `excludeTips`（数量上限 2000，仅非空时以只读 Git `rev-list --not` 解析），统一驱动 `searchCommits`、`activityStats` 与统计页（`with_stats_rows`）。前端在更新回执、超首屏未读顶部提示条、分界线、筛选芯片条与统计页提供一键“筛选 / 查看统计 / 交给 Agent”。
- 小时级与精确到时分筛选：提交页搜索加入近 1 / 3 / 6 / 12 小时预设及“按天 / 精确到时分（`datetime-local`）”模式，并新增实时条件芯片条 `ActiveSearchChips`；统计页同步加入 3 小时 / 12 小时预设与自定义精确到时分模式。
- 交给 Agent 突破 200 条与 64 KiB 限制：`GetHandoffFactsParams` 支持可选 `rangeExcludeTips` / `rangeHeadTips` / `rangeOldestOid`，`getHandoffFacts` 返回全量 `HandoffRangeSummary`（精确总数、完整端点、前 80 与末 20 条代表性提交摘要）；剪贴板与 prompt 上限提升至 256 KiB，并支持多级收缩及提交详情任意非顶点位置“审阅从这里到最新”。
- 验证（本机源码版）：新增 `tests/renderer/update-batch.test.mjs` 与 `tests/smoke/batch-review-smoke.mjs`（`pnpm test:smoke:batch-review`），扩展 Rust 单元测试与 `tests/renderer/{search-date,stats-store,handoff-prompt}.test.mjs`、`tests/pages/stats-git.test.mjs`。

2026-11-18 基于 3 万+ 提交 / 9.34 GiB 真实仓库压测暴露瓶颈的专项性能优化：
- 文件改动回填优化（`crates/daemon/src/{change_index.rs,metadata_index.rs}`）：通过 `git log --full-history -m --raw -z` 发现历史 `.gitattributes` 路径后按 `cat-file --batch-check=%(objectname)` 指纹分组复用 `--attr-source` 执行 `diff-tree --stdin`，合并提交非第一父路径改用纯 `--raw --no-renames` 批量比对，启用 `core.bigFileThreshold=2m` 控制超大文本对象 Myers diff 内存飙升，并在多 chunk 时受控并行 + `prepare_cached` 批量写入 SQLite。
- 查询内存、全文匹配与多引用延迟优化（`crates/daemon/src/{search.rs,change_stats.rs,stats.rs,evolution.rs,details.rs}`）：`with_stats_rows` 与 `change_stats::collect` 取消全表排序临时 B-Tree 与未命中行全字段反序列化，按命中 OID 走主键查询 `commit_changes`；`searchCommits` 消息过滤零分配直接比对 SQLite UTF-8 切片及 ASCII+CJK 组合；`branchesContaining` 去除冗余 `--topo-order` / `read_commit_metadata` 并在完整历史上放开已有 commit-graph 读取。

2026-11-18 修复历史列表右缘时间滑轨在顶部悬空与交互遮挡的问题：
- 边界与全局进度对齐（`apps/desktop/src/renderer/lib/time-track.ts` / `apps/desktop/src/renderer/components/history-time-slider.tsx` / `apps/desktop/src/renderer/components/commit-list.tsx`）：新增 `timeTrackBounds`、`followProgressFor` 与 `viewportReadingSeconds`，滑轨上下界贴合会话已知最新/最早提交时刻（不再补当天 `24:00` 空白时段），不足一屏不可滚时隐藏滑轨；跟随列表时用行间/底部插值与累计进度驱动滑块从顶端 `0%` 平滑走到最底 `100%`（顶底严格贴边）。
- 窄轨热区与标签错位：交互热区保持右缘 16px 窄轨，展开的 140px 日期标签与渐变底设为 `pointer-events-none`、不再拦截列表滚轮或点击，列表滚动立即解除悬停冻结，并为顶部半截日期与相邻标签错位避让。
- 定向验证（本机源码版）：更新 `tests/renderer/time-track.test.mjs`（6 项）与 `tests/smoke/history-date-navigation-smoke.mjs`（覆盖凌晨 `01:06` 最新提交在 `scrollTop = 0` 与 `Home` 返回时滑块贴顶、移至左侧 40px 后列表正常滚轮滚动、月历/滑轨拖拽/键盘导航及只读快照），`pnpm typecheck`、`pnpm build`、`pnpm test:renderer`（235 项）、`node tests/smoke/history-date-navigation-smoke.mjs`、`pnpm test:smoke:history` 与 `git diff --check` 全部通过（并目视复核 `output/playwright/history-date-navigation/{collapsed,slider-hover}.png`）。

2026-11-18 已提交 M7 及收尾改动（`a7eb488`），并完成 **M8「分叉同步与 JetBrains 式三栏轻量合并」（`P8-01`–`P8-03`）** 全链路实现与实窗验收：
- 协议与后端（`crates/core` / `crates/daemon` / `apps/desktop/src/main`）：新增只读可取消查询 `previewMerge`（借助 `ReadOnlyGit::run_with_env` + 独立临时 `GIT_OBJECT_DIRECTORY` / `GIT_ALTERNATE_OBJECT_DIRECTORIES` 运行 `git merge-tree --write-tree -z`，被查看仓库零写入）以及 `CompleteMerge` 操作（支持干净分叉的 `MergeCommit` 与保留原 `GIT_AUTHOR_*` 的无冲突 `SingleCommitRebase`，以及通过临时 `GIT_INDEX_FILE` + `hash-object -w` + `commit-tree` + 原子 `read-tree -m -u` / `update-ref` 完成的冲突合并；无共同祖先、criss-cross、结构性/二进制冲突及超过 `10 文件 / 128 KiB / 512 KiB` 上限返回 `Unsupported`）。
- 桌面端与三栏双边箭头视图：`RefusalDialog`（`update` / `push` / `mergeInto` 的分叉场景）与 `ScopePicker` 行菜单新增「同步 / 解决冲突…」，进入 `DivergedSyncDialog` 预演分叉同步；存在普通文本冲突时继续保留「交给 Agent…」为主入口，同时提供「顺手解决冲突…」打开全宽 `ThreePaneMergeView`（左本分支只读 ｜ 左 `»` / `×` 连接带 ｜ 中可编辑结果与块内微调 / `↺` 重置 ｜ 右 `«` / `×` 连接带 ｜ 右合入源只读，支持 `»` 后接 `«` 等双边点击按顺序拼入、词级差异高亮、三栏同步滚动与勾选完成后立即非强制推送）。中途按 `Esc`、取消或「交给 Agent…」退出零残留、无 `.git/MERGE_HEAD` 或 `rebase-merge` 中间态。
- 全量验证（本机源码版）：新增 `tests/renderer/three-way-merge.test.mjs` 与 `pnpm test:smoke:m8`（`tests/smoke/m8-three-pane-merge-smoke.mjs`），连同 `cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`（0 告警）、`cargo test --workspace --locked`（5 + 116 + 12 = 133 项）、`pnpm protocol:check`、`pnpm typecheck`、`pnpm build`、`pnpm test:protocol`（63 项）、`pnpm test:renderer`（232 项）、`pnpm test:pages`（54 项）与全套 Electron smoke（`test:smoke`、`test:smoke:pages`、`test:smoke:update-current`、`test:smoke:operations`、`test:smoke:m7`、`test:smoke:m8`）及 `git diff --check` 全部通过。

2026-11-17 完成 **M7「审阅收口与推送」（`P7-01`–`P7-04`）** 全链路实现与端到端实窗验收：
- 协议与后端（`crates/core` / `crates/daemon` / `apps/desktop/src/main`）：新增可取消的 `pushRepository`（严格非强制推送与首次 `--set-upstream`、远端拒绝返回 `RemoteRejected`）、`DeleteBranch`（仅祖先合入且未在任何 worktree 检出）、`FastForwardMerge`、`WorkspaceStage` / `WorkspaceUnstage`（含 rename 双路径与 unborn `HEAD`、越界路径拦截）、`WorkspaceDiscard`、`WorkspaceCommit`（`--cleanup=whitespace` 保留 `#` 正文行）以及 `WorkspaceStatus.draftCommitMessage`（读取 `MERGE_MSG` / `SQUASH_MSG` / 异于 `HEAD` 的 `COMMIT_EDITMSG`）。
- 桌面端与工作区收口关口：顶栏保留「更新 {分支}」，检出分支领先上游或无上游且有远端时并列「推送 ↑N / 发布分支」与取消控制；范围菜单、仓库弹层与 `⌘K` 同步接入推送、快进合入与直接删除已合入本地分支；工作区页接入「交给 Agent ▾」（只读审阅 / 整理提交）、单文件与全量暂存撤回、二次确认单文件丢弃与草稿自动载入（保留 hook 失败已输入说明并提示不用 `--no-verify`）。
- 实窗与全套验证（本机源码版）：新增 `pnpm test:smoke:m7`（`tests/smoke/m7-review-gate-smoke.mjs`），连同 `cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked`（5 + 114 + 12 项）、`pnpm protocol:check`、`pnpm typecheck`、`pnpm build`、`pnpm test:protocol`（62 项）、`pnpm test:renderer`（226 项）、`pnpm test:pages`（53 项）与全部实窗 smoke（`test:smoke`、`test:smoke:pages`、`test:smoke:update-current`、`test:smoke:operations`、`test:smoke:m7`）全部通过。后续按 [路线图](ROADMAP.md) 待排期 M8（分叉同步与 JetBrains 式左-中-右三栏双边箭头零中间态轻量合并）。

2026-11-17 收尾 M5 / M6 桌面功能缺口、Rust 代码卫生与 macOS 原生体验并补全端到端实窗测试：
- Rust 与协议稳定：清理 `crates/core` 与 `crates/daemon` 的全部 Clippy 告警和格式差异，把测试子模块移至文件末尾；放宽 `tests/protocol/transport.test.mjs` 的并发握手超时，使协议套件稳定通过（60 项）。
- 统计页与快捷键（P6-01 / P6-03）：顶栏下拉菜单支持多远端下选择单个远端 Fetch 并保留失败重试参数；`ShortcutGuide` 补充 `⌘4` 统计页说明；统计页时间柱状图（活动频率与增加/删除行）支持鼠标拖动框选区间以在统计页放大查看或带入提交页筛选，并可一键重置缩放。
- 预检与交接缺陷修复：`OperationsStore` 为只读预检 `checkOperation` 增加瞬态 `BUSY` 短暂退避重试（写入 `runOperation` 仍不重试）；修正 `OperationRefusal` 点击“交给 Agent…”时先关闭拒单导致 `refusalHandoff()` 读空而不打开 `HandoffDialog` 的顺序问题。
- macOS 原生桌面体验：在保持 `contextIsolation: true`、`sandbox: true` 和严格 CSP 的前提下，新增应用菜单（含 `⌘O` 打开仓库）、`webUtils.getPathForFile` 拖入仓库文件夹打开、`app.on("open-file")` Dock/Finder 打开仓库，以及将窗口位置和最大化状态保存到用户数据目录 `window-state.json`。
- 实窗测试与验证：新增 [M5 基础操作实窗测试](../tests/smoke/m5-operations-smoke.mjs)（`pnpm test:smoke:operations`）与 [统计页实窗测试](../tests/smoke/stats-page-smoke.mjs)（`pnpm test:smoke:stats`）；连同 `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test --workspace --locked`、`pnpm protocol:check`、`pnpm typecheck`、`pnpm test:renderer`（223 项）、`pnpm test:pages`（50 项）、`pnpm test:smoke`（含安全与 preload API 白名单检查）、`pnpm test:smoke:pages`、`pnpm test:smoke:fetch-history` 与 `pnpm test:smoke:update-current` 全部通过，构建产物为本机源码版。

2026-11-15 顶栏只在当前页面提供查找或筛选时显示搜索入口和 ⌘F 提示。统计页在宽、窄窗口都隐藏入口，切回提交页后 ⌘F 恢复聚焦。文件页在显示文本或目录历史时提供相应搜索。通过 `pnpm typecheck`、`pnpm build` 和 `pnpm test:smoke:pages`，实窗使用本机 Rust 核心。

2026-11-15 同名未跟踪文件支持“丢弃并更新…”。确认页列出文件和数量，默认焦点在“返回”。快进回执用一行显示结果，详情显示相同文件数和备份目录。慢 Fetch 在顶栏显示已用时间和取消按钮，远端请求结束后切换到刷新状态。

本机验证通过 `pnpm typecheck`、`pnpm build`、`pnpm protocol:check`、Rust workspace（129 项）、renderer（221 项）、P5-06 定向 Git 测试（10 项）和更新 / Fetch 历史两项 Electron 实窗测试。更新实窗使用临时本地远端，核对确认返回、丢弃后的上游内容、无关文件和既有备份，另用延迟远端验证计时和取消。协议测试并发首轮的 80 ms 握手重试计数断言失败，单独重跑 60 项全过。构建产物为本机源码版。

2026-11-15 完成 P5-06。Rust 核心和桌面协议已接入同名文件比较、备份和失败恢复，忽略目录按文件处理。真实仓库只读预检识别到 18 个相同文件和 1 份不同草稿。实仓场景、边界和执行命令见[代码级计划与验证](implementation/p5-06-untracked-update.md)。手动合并编辑器见[路线图](ROADMAP.md)。

2026-11-13 大仓库更新预检超时修复已通过回归：路径覆盖检查改为排序后的原始字节查找，每条本地路径只解码一次；CPU 检查循环遵守取消与截止时间，保留 20 秒桌面请求超时。真实 `ai-native-workspace` 的只读预检从 38.3 秒降到三次 0.51–0.58 秒，返回相同的两处覆盖风险。大批快进禁用 Git diffstat，避免成功写入期间因输出超限被打断。Rust workspace（121 项）、完整 pages（40 项）、协议（60 项）、schema 一致性、构建及更新入口实窗测试通过；Clippy 因仓库既有告警未通过，详见[更新预检验证](validation/update-current-preflight.md)。

2026-11-13 顶栏更新入口已实现并通过本机定向验证：主按钮显示“更新 {当前工作区分支}”，先 Fetch 再快进；下拉保留 Fetch 和清理失效远端跟踪引用。目标与浏览范围独立；无更新、领先、无上游和 Fetch 后拒绝快进分别说明结果，拒绝提示及 Agent prompt 不再把已完成 Fetch 描述为零写入。Fetch 可取消；取消、刷新失败或 Fetch 期间外部切换分支时不继续快进。保留同期分支同步查询的有界重试，显式更新会等待重试结果，并修订旧的“失败后本代不再请求”测试。

验证：`pnpm typecheck`、`pnpm build`、`pnpm test:renderer`（215 项）、`pnpm test:smoke:update-current`、`pnpm test:smoke:fetch-history` 和 `git diff --check` 通过。新实窗测试使用临时本地远端，独立 Git 对照当前分支 OID、其他本地分支、工作区文件及被拒绝时的 index；覆盖浏览其他分支时更新当前工作区、快进 / 已是最新 / 领先、独立 Fetch / prune、分叉 / 未提交改动 / 无上游、取消 / 远端失败、Fetch 中外部 checkout、detached / 裸仓库、linked worktree，以及 1440 / 900px 布局。截图在 `output/playwright/update-current/`。本轮未测试真实网络凭据和其他平台，未打包安装版；没有新增性能达标声明。

2026-11-13 fetch 后历史滚动修复：在列表顶部刷新时显示新快照的最新提交；原滚动锚点不在刷新后的第一页时回到顶部，锚点仍在页内则保持位置。`pnpm build`、`pnpm typecheck`、`pnpm test:smoke:fetch-history` 和 `pnpm test:smoke:virtual-history` 通过；fetch 测试使用真实 Electron 窗口及本地远端，验证全部分支的 fetch、顶部 / 页内 / 缺失锚点、双向滚动，以及本地 HEAD 不变。回退顶部锚点处理后该实窗测试无法看到新提交。`pnpm test:renderer` 212 / 213 项通过；已有的 `operations-store.ts` 未提交改动改变了失败后重试行为，与现有「每代只请求一次」测试断言不一致，本次未修改该改动。未测真实网络和其他平台；性能测量不适用于此修复。

**当前状态：只读 MVP 功能已齐全，M3 本机小规模主流程通过，UI-01 至 UI-03 已接入。** 可打开本地 Git 仓库、按固定 HEAD、分支、标签或 worktree 快照连续浏览，默认每页 200 条，主列表最多保留 1800 条摘要，另为当前 merge 页预留 200 条；支持双向预取、键盘选择、复制、取消、错误重试和手动刷新，并按 Git 可达性显示上次查看后的新增标记。刷新保留选择及可恢复的滚动锚点。界面沿用 Claude 的 v3 设计，未接入区域明确标注“占位”。10 万提交三轮名义 60Hz 滚动的帧间隔 p95 为 17.3–17.8 ms，DOM 峰值 35 行；全进程树短时空闲 RSS 为 540–541 MiB，超过当时的 500 MiB 目标；现行内存预算已放宽，见下文。详见[P1-03 基线](benchmarks/p1-03-history-scroll.md)，不作为发布性能验收。分支 / worktree 导航与按需“已合入”状态已接入，切换范围不 checkout。可恢复 SQLite 元数据索引已接入，支持真实进度、暂停、继续、取消和重建；索引故障保留历史。元数据搜索已接入：完整消息默认不区分大小写，可组合 Author / Committer、日期、OID 与当前范围；部分结果持续更新并保持选择和滚动锚点。大仓搜索延迟尚未验收，详见[P1-06 验收](validation/p1-06-metadata-search.md)。Rust 图布局与有界检查点已接入：跨页 / 淘汰回读保持连线与颜色，默认显示六列，点击图区 +N 可展开当前范围的全部图线并横向滚动，支持收起；明确标记浅克隆等历史边界。十万提交 / 千条引用宽图三轮帧间隔 p95 均为 18.6 ms，暂停索引时短时空闲整树 RSS 为 580–583 MiB；详见[P2-01 基线](benchmarks/p2-01-history-graph-scroll.md)，未验收索引完成后的内存预算。完整消息 / trailer、父提交文件比较、merge 带入分页与自动加载包含分支已接入，见 [P2-02 验证记录](validation/p2-02-commit-details.md)；完整实窗检查未跑完。P2-03 已接入点击文件展开只读 diff，支持父提交切换、行号、二进制 / LFS / gitlink 提示和截断说明，见[实现及检查记录](implementation/p2-03-readonly-diff.md)。P2-04 已接入搜索结果的历史定位与返回，恢复原查询、选择和滚动锚点，并提供快捷键说明，见[实现记录](implementation/p2-04-history-location.md)。P3-01 已接入文件 / 目录字面路径筛选、当前快照路径补全和 merge 命中父说明，见[实现记录](implementation/p3-01-path-history.md)。P3-02 活动统计、P3-03 外部变化提示与 P3-05 可编辑 Agent 提示词已接入；P3-04 的 8 步实窗流程和当前项目只读数据对照通过，见[M3 记录](validation/m3-mvp.md)。尚未完成 M4 性能、长期稳定性与发行验收。产品名为 CherryPeek（2026-11-10 定名，取 cherry-pick 的谐音，意为挑着看一眼；早期文档与记录里的 CommitScope 是原工作名，代码内部标识仍沿用 `commitscope`）。

P4-01 已交付首批查询和内存优化：十万提交 OID 搜索中位数约 1.3 ms；同口径整树空闲 RSS 从约 603 降至 566 MiB，查询阶段采样峰值从约 690 降至 623 MiB。这些是旧预算下的优化结果，长期稳定性和发布验收仍待完成，详见[查询报告](benchmarks/p4-01-interactive-performance.md)与[内存报告](benchmarks/p4-01-memory.md)。

历史列表右缘是时间滑轨：显示当前位置附近、按提交数自动缩放的一段时间，拖动时列表实时跟随，可以定位到某天的某个时段；列表顶部固定显示当前日期，点它打开按提交数着色的日历，不在最新处时可一键回到最新。保持当前范围和分支图。详见[实现与检查记录](implementation/history-date-navigation.md)。

快速导航已加入当前快照的日期 / 拓扑缓存、按滚动速度提前预取和滑轨预览请求合并。十万提交定向实测中，后续不同日期定位中位数约 903 → 38 ms，拖动松手后等待约 1.46 → 0.11 秒；首次扫描仍约 0.52 秒。连续拖动后的 renderer 内存仍需优化，完整条件和限制见[快速导航报告](benchmarks/p4-01-fast-history-navigation.md)。

日期定位进一步复用已载页面和固定快照引用。同页定位中位数 10.6 → 0.5 ms，响应从约 352 KB 降至 145 字节；同一 UI 下拖动后整树 RSS 单点 802 → 788 MiB，renderer 常驻内存尚未明显下降。见[页面复用报告](benchmarks/p4-01-history-page-reuse.md)，其中 500 MiB 为当时目标。

随后根据分配采样移除了关闭的分支菜单反复构造，并让普通分页复用引用对象。三轮操作的 JS 分配估算减少约 39%；新一组同口径比较中，拖动后整树 RSS 780 → 757 MiB，第五秒 748 → 729 MiB，定位结果与速度保持。该轮定向优化已收尾，见[分配与内存报告](benchmarks/p4-01-renderer-retention.md)。2026-11-09 按用户要求放宽内存预算：空闲整树 RSS 目标 800 MiB，交互阶段观察目标 1 GiB，保留长期运行不持续增长的要求。短时值已处于新目标内，完整验收仍待完成，见[当前验收口径](VALIDATION.md)。随后实现并验收了 P4-09 至 P4-12（工作区、文件页、diff 显示增强、逐行追溯）。

列表与详情之间的分隔线可以拖动调整列宽，历史与搜索共用宽度；支持左右键调整和双击复位。

图区右缘也可拖动，调整为 4–12 列，左右键逐列调整、双击恢复默认六列；`+N` 展开全部，收起恢复自定义宽度。悬停提交突出其主线，移开后恢复选中提交的高亮，日期分隔连线同步变化。见 [P4-05 实现记录](implementation/p4-05-expand-graph.md)。十万提交的[图交互测量](benchmarks/p4-05-graph-interactions.md)已归档，宽图前台焦点条件及发布验收仍留给 P4-01。

窗口窄于 1100px 时列表占满，点击提交或在列表按 Enter 打开右侧详情抽屉，顶部可切换前后提交；Esc、关闭按钮或点遮罩返回列表。搜索结果同样适用，调整窗口宽度会保留选择和滚动位置。见 [P4-06 实现记录](implementation/p4-06-narrow-window.md)。

2026-11-12 后端批次：P5-02 / P5-03 已有分支同步、预检 / 执行和净化远端地址；P6-01 至 P6-05 已有统计、schema 2 文件索引及按需演化分析。桌面接线与实窗验收由并行界面工作继续。最终字段、回归结果与未验证范围见 [接口约定](implementation/m5-m6-backend-contract.md) 和 [后端验证](validation/m5-m6-backend.md)。十万实际文件改动提交的索引体积增加 33.3%，构建耗时增加 171.4%，属于本次实测成本，不作为发布性能通过结论。

2026-11-12 统计调度修复：统计页四个读取在线程低优先级下完成；演化分析与统计独立计额，在文件边界等待交互读取并扣除暂停时间。随后按用户要求同步拆分 main transport 额度，移除演化分析的 615 秒总超时，统一使用 daemon 工作预算；取消排空增加 5 秒失败保护。旧顶栏统计的 main 抢占与索引让路规则保持原样。验证进度、平台限制及真实仓库性能见[调度记录](validation/stats-scheduling.md)。

## 已确定的方向

- 独立新建项目，不 fork GitComet，不引入或复制其后端及状态层代码。
- Electron 桌面外壳，React + TypeScript 界面（Tailwind CSS 4 + shadcn 风格组件），Rust 承担 Git 读取、查询、缓存和后台任务。
- 第一版聚焦历史、搜索、分支、近期提交统计和按需查看 diff。
- 点击分支改变浏览范围，不切换工作区；先实现只读闭环，适配 Agent 同时操作仓库。
- 2026-11-12 起加入白名单内的基础操作：只做一步完成、不产生冲突、不丢数据的，由用户显式触发；做不到时不执行并提示交给 Agent。见[产品范围](PRODUCT.md)「基础操作」。2026-11-17 确认后续规划（M7 审阅收口与推送、M8 分叉同步与 JetBrains 式三栏双边箭头零中间态轻量合并），待排期，见[路线图](ROADMAP.md)「后续线路：审阅收口与三栏轻量合并」。
- 当前浏览固定引用快照，外部变化只提示有更新，用户点击刷新后才切换快照。
- 历史分页稳定后即交付元数据搜索：消息搜索框配合明确字段筛选；部分结果自动合并并保持选择和滚动锚点。
- 性能通过同仓库、同硬件的测量验收，不用语言或框架名称代替结果。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [产品范围](PRODUCT.md) | 用户需求、主界面、搜索与统计口径、第一版边界 |
| 界面设计稿 | 已确认的「v3 · B 细化」画板，在未公开的设计画布里（示例数据）；以产品范围和 [DESIGN](DESIGN.md) 的文字为准 |
| [界面规范](DESIGN.md) | 颜色、字体、间距、组件与状态的实现规范（以此为准） |
| [交给 Agent 模板](HANDOFF.md) | 各场景 prompt 的文案、变量与防注入规则 |
| [UI-01 验收记录](validation/ui-01-foundation.md) | 界面基础的实现范围、真实数据与占位划分、测试与未验证项 |
| [UI-02 验收记录](validation/ui-02-sessions.md) | 界面接入仓库会话、最近打开与查看记录 |
| [UI-03 窗口外壳](validation/ui-03-window-chrome.md) | 隐藏系统标题栏、保留原生窗口按钮与顶部拖动区域 |
| [技术架构](ARCHITECTURE.md) | Electron / Rust 分工、通信、Git 读取、分页、索引与刷新 |
| [路线图](ROADMAP.md) | 从技术验证到可日用版本的阶段和验收关卡 |
| [实施计划](PLAN.md) | 可直接开始执行的任务、依赖、交付物和完成条件 |
| [发布流程](RELEASE.md) | macOS 签名、公证、检查与 GitHub Release 上传；第一版说明见 [v0.1.0](releases/v0.1.0.md) |
| [性能与正确性验收](VALIDATION.md) | 测试仓库、性能预算、测量方式和关键边界 |
| [P0-01 代码级计划](implementation/p0-01-bootstrap.md) | 文件、接口、进程边界、命令与代理分工 |
| [P0-01 验收记录](validation/p0-01-bootstrap.md) | 实测环境、检查结果、修复记录和未验证范围 |
| [P0-02 代码级计划](implementation/p0-02-protocol.md) | 协议契约、调度、上下文判旧、生命周期与代理分工 |
| [P0-02 验收记录](validation/p0-02-protocol.md) | 双端测试、Electron 运行时复测、异常与进程树回收证据 |
| [P0-03 代码级计划](implementation/p0-03-repository-preview.md) | 真实 Git 读取契约、fixture、桌面预览与测量分工 |
| [P0-03 验收记录](validation/p0-03-repository-preview.md) | 独立 Git 对照、只读边界、取消与真实窗口验证 |
| [P0-03 首屏基线](benchmarks/p0-03-first-screen.md) | 10 万提交、10 次启动与整个进程树资源采样 |
| [P0-04 代码级计划](implementation/p0-04-reader-comparison.md) | 独立 CLI / gix 实验、数据契约与代理分工 |
| [P0-04 验收记录](validation/p0-04-readers.md) | 深页、原始字节、兼容性、只读与取消验证 |
| [读取路线决策](decisions/0001-git-reader.md) | 保留 Git CLI，gix 暂仅用于实验 |
| [M0 汇总基线](benchmarks/m0-baseline.md) | 180 项读取对比、参考硬件、冻结预算与限制 |
| [P1-01 代码级计划](implementation/p1-01-repository-sessions.md) | 固定 HEAD 会话、持久身份、查看记录与非视觉桥接契约 |
| [P1-01 验收记录](validation/p1-01-repository-sessions.md) | 真实会话、存储降级、取消竞态与双运行时协议验证 |
| [P1-02 代码级计划](implementation/p1-02-history-pagination.md) | 固定快照分页、游标、缓存、取消与手动刷新的跨层契约 |
| [P1-02 验收记录](validation/p1-02-history-pagination.md) | 独立 Git 对照、翻页与刷新行为、界面检查及范围限制 |
| [P1-02 分页基线](benchmarks/p1-02-history-pagination.md) | 10 万提交三轮完整遍历、缓存命中、淘汰重读与核心进程树采样 |
| [P1-03 代码级计划](implementation/p1-03-virtual-history.md) | 有界窗口、虚拟滚动、查看标记与分隔线证明 |
| [P1-03 验收记录](validation/p1-03-virtual-history.md) | 独立 Git 对照、竞态恢复、真实窗口与验证边界 |
| [P1-03 滚动基线](benchmarks/p1-03-history-scroll.md) | 10 万提交三轮 30 秒滚动、整个进程树资源与待修复目标 |
| [P1-04 代码级计划](implementation/p1-04-scope-navigation.md) | 分支 / worktree 范围、冻结 tips、按需合入状态与只读验证 |
| [P1-04 验收记录](validation/p1-04-scope-navigation.md) | 范围隔离、独立 Git 对照、失败恢复与真实窗口验证 |
| [P1-05 代码级计划](implementation/p1-05-metadata-index.md) | 可恢复 SQLite 元数据索引、快照 coverage、后台控制与配额 |
| [P1-05 验收记录](validation/p1-05-metadata-index.md) | SQLite 数据对照、恢复与安全边界、桌面控制和故障重建验证 |
| [P1-06 代码级计划](implementation/p1-06-metadata-search.md) | 字面搜索语义、组合筛选、版本化结果分页与锚点保持 |
| [P1-06 验收记录](validation/p1-06-metadata-search.md) | 搜索的数据对照、动态分页、桌面试用及当前验证状态 |
| [P2-01 代码级计划](implementation/p2-01-history-graph.md) | Rust 图布局、有效父关系、跨页检查点与可见图绘制 |
| [P2-01 验收记录](validation/p2-01-history-graph.md) | 跨页确定性、边界、取消与实窗恢复验证 |
| [P2-01 宽图滚动基线](benchmarks/p2-01-history-graph-scroll.md) | 十万提交、千条引用的图滚动与全进程树测量 |
| [P2-02 代码级计划](implementation/p2-02-commit-details.md) | 提交全文、文件页、merge 带入提交与快照引用关系 |
| [P2-02 验证记录](validation/p2-02-commit-details.md) | 自动验证结果、部分实窗检查与未完成边界 |
| [P2-03 代码级计划](implementation/p2-03-readonly-diff.md) | 点击文件读取 unified diff、内容边界与最小检查 |
| [P2-04 代码级计划](implementation/p2-04-history-location.md) | 搜索结果定位到历史、返回锚点与快捷键 |
| [P3-01 代码级计划](implementation/p3-01-path-history.md) | 字面文件 / 目录筛选、冻结快照补全与命中父说明 |
| [M3 功能批次](implementation/p3-02-05-mvp-batch.md) | 统计、外部更新和 Agent 提示词的代码计划 |
| [M3 主流程记录](validation/m3-mvp.md) | 定向检查、实窗闭环与未验证范围 |
| [M5 / M6 后端接口](implementation/m5-m6-backend-contract.md) | 最终方法、字段、协议差异与预算，供桌面接线 |
| [P5-02 / P5-03 后端计划](implementation/p5-02-03-backend.md) | 预检、快进、切换、新建、配置与拒绝零写入 |
| [P6-01 计划](implementation/p6-01-activity-overview.md) | 元数据活动统计与辅助调度 |
| [P6-02 计划](implementation/p6-02-file-change-index.md) | schema 升级、第一父文件记录与续建 |
| [P6-03 / P6-04 计划](implementation/p6-03-04-change-statistics.md) | 改动量、排除列表、观察项与提交回查 |
| [P6-05 计划](implementation/p6-05-evolution.md) | 按需估计、blame 累计结果、覆盖与缓存 |
| [M5 / M6 后端验证](validation/m5-m6-backend.md) | 各任务对照证据、完整检查与未验证范围 |
| [更新预检验证](validation/update-current-preflight.md) | 大仓库路径覆盖检查的超时修复、真实仓库只读对照及回归 |
| [P6-02 索引测量](benchmarks/p6-02-file-change-index.md) | 十万实际改动提交的 schema 1 / 2 成本 |
| [统计调度验证](validation/stats-scheduling.md) | 统计抗读取干扰、演化暂停 / 取消、线程优先级与超时口径 |
| [统计调度测量](benchmarks/stats-scheduling.md) | 大型真实仓库三个范围的统计耗时、历史读取干扰与整树采样 |
| [P6-05 演化测量](benchmarks/p6-05-evolution.md) | 真实仓库的估计、冷 / 热分析与整树内存 |

建议按产品范围 → 技术架构 → 路线图 → 实施计划阅读。2026-11-08 确认的后续规划 `P4-09` 工作区状态与改动展示、`P4-10` 文件二级页面，以及随后拆出的 `P4-11` diff 显示增强、`P4-12` 逐行追溯，已于 2026-11-09 实现并验收。2026-11-12 确认加入基础 Git 操作（fetch、快进更新、切换分支、新建分支、复制与打开），排为 M5 的 `P5-01` 至 `P5-05`；其中手动 Fetch（P5-01）和复制、在 Finder / 终端 / 编辑器中打开（P5-05）已接入但未完成验收，快进更新、切换与新建分支后端已实现，桌面接线另记；冲突、分叉等情况不由 App 处理，提示交给 Agent。同日确认把统计做深并改为独立页面，排为 M6 的 `P6-01` 至 `P6-05`，后端已实现并完成对照，整体任务仍需桌面验收。`M4 / P4-01` 性能达标、边界恢复与发行验收继续保留，具体范围和完成条件见[实施计划](PLAN.md)。

## macOS 本机打包

在当前架构的 Mac 上执行 `pnpm package:mac`，会先构建 release Rust 核心与桌面代码，再生成 `release/mac-arm64/CherryPeek.app` 和 `release/CherryPeek-0.1.0-arm64.dmg`（Apple Silicon）。只需要应用目录时可执行 `pnpm package:mac --dir`。打开 DMG 后将 CherryPeek 拖到 Applications，或直接打开生成的 `.app`。

运行应用只需兼容的系统 Git，不依赖 Node、pnpm、Rust 或项目源码。使用当前 PATH 查找 Git，找不到时尝试 `/usr/bin/git`；Git 必须支持 `--no-lazy-fetch`。本机试用包（`pnpm package:mac`）使用 ad-hoc 签名；公开发布包使用 `pnpm release:mac` 完成 Developer ID 签名与 Apple 公证（见 [发布流程](RELEASE.md)）。打包版默认应用数据位于 `~/Library/Application Support/CherryPeek/`（源码直接启动时位于 `@commitscope/desktop/`），其中 `repository-state/` 存放仓库缓存与查看记录。

打包后可运行 `pnpm test:smoke:package` 检查包内核心、系统 Git、真实提交加载与退出清理。具体配置、试用范围和证据见 [P4-02 本机打包记录](implementation/p4-02-macos-package.md)。

## 本地运行

按 `⌘K`（Windows 快捷键为 `Ctrl+K`），可输入提交 hash、分支、标签、worktree，或搜索打开仓库、切换页面、复制提交等命令。短 hash 至少 4 位，直接在当前快照范围内定位；不需要等待索引完成。

范围菜单会识别普通 merge，以及 squash、rebase、cherry-pick 后的等价补丁，分别显示“已合入”和“内容已在 {基准分支}”。计算使用当前固定快照，未匹配或超过计算上限不显示否定标签；可交给 Agent 重新核查后清理。见 [P4-08 实现记录](implementation/p4-08-patch-equivalence.md)。

当前验证环境为 macOS 27.0.1 / Apple Silicon，使用 Node 26.0.0、pnpm 10.28.1、Rust 1.95.0；版本分别由 `.node-version`、`packageManager` 和 `rust-toolchain.toml` 固定。准备这些工具后，在项目根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 先构建 Rust、生成协议类型并构建前端，再打开窗口；本项没有 HMR。首次启动可能需要下载已锁定版本的 Electron 二进制。可通过“选择目录”或绝对路径输入打开仓库；列表默认展示 Committer 时间（本地时区），详情分别显示 Author / Committer 及其原始时间偏移。关闭窗口会退出应用；终端中断会回收本次启动的进程。已构建后可用 `pnpm start` 直接打开，或用 `pnpm start --repository=/绝对路径/仓库` 直接进入预览。当前只读本地对象，系统 Git 必须支持 `--no-lazy-fetch`；不支持时返回错误，不自动降级补拉。

搜索命中后，在详情点击“在历史中定位”（⌘L），可在同一范围和快照下查看前后提交与分支图；点击横幅“返回 N 个结果”（⌘[）恢复原筛选、选择和滚动位置。顶部键盘按钮显示已接入的快捷键，⌥⌘R 刷新仓库历史；Windows 对应 Ctrl / Alt 组合。

在筛选菜单添加“路径”，选择文件或目录，目录默认包含子目录；输入后点击“应用路径”，或直接选择补全项。补全只列当前冻结快照中的路径，已删除路径可手动输入。搜索区分路径大小写、不解释通配符、不跨重命名追溯；merge 命中会显示对应父序号。

常用检查：

```sh
pnpm protocol:check
pnpm typecheck
pnpm build
pnpm test:protocol
pnpm test:sessions
pnpm test:history
pnpm test:navigation
pnpm test:indexing
pnpm test:pages
pnpm test:renderer
pnpm test:repository
pnpm test:smoke
pnpm test:smoke:pages
pnpm test:smoke:history
pnpm test:smoke:fetch-history
pnpm test:smoke:update-current
pnpm test:smoke:operations
pnpm test:smoke:m7
pnpm test:smoke:m8
pnpm test:smoke:stats
pnpm test:smoke:batch-review
pnpm test:smoke:virtual-history
pnpm test:smoke:scope-navigation
pnpm test:smoke:metadata-index
pnpm test:search
pnpm test:smoke:metadata-search
pnpm test:graph
pnpm test:smoke:history-graph
node --test tests/repository/benchmark-process-tree.test.mjs
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
```

`pnpm protocol:generate` 从 Rust 类型导出三份 schema 和 TypeScript，`protocol:check` 只校验产物一致性。`test:protocol` 覆盖真实 daemon、受控故障协议和慢 Git 子进程回收。Smoke 会启动并关闭真实 Electron 窗口，覆盖正常启动、失败状态、隔离与进程退出；本地截图写入已忽略的 `output/playwright/`。`test:repository` 自动生成临时真实 Git 仓库，完成独立字段对照、只读快照与 Electron 界面验证。性能实测见首屏基线；发布预算尚未验收。

P5-06 的同名文件验证可运行 `pnpm test:pages --test-name-pattern=P5-06` 和 `pnpm test:smoke:update-current`。M5 / M6 / M7 / M8 daemon 对照已并入 `pnpm test:pages`（可用 `--test-name-pattern=M8` 定向运行），M7 与 M8 实窗验收命令分别为 `pnpm test:smoke:m7` 与 `pnpm test:smoke:m8`（自动先构建再运行）。修改后端提交前运行 `cargo test --workspace --locked`、`pnpm protocol:check`、`pnpm test:pages`、`pnpm test:protocol`；涉及索引再运行 `pnpm test:indexing`。`tests/benchmarks/` 的测量命令与目标目录规则见上述两份性能报告。

统计调度定向验证可运行 `pnpm test:pages --test-name-pattern='statistics survive|evolution pauses|generation replacement'`，默认构建 debug daemon；其中 SQLite 统计等待点仅存在于 debug 构建，不能用 release daemon 跑这一等待点测试。桌面 transport / 控制器回归已并入 `pnpm test:protocol`，修改 main 时另跑 `pnpm typecheck`。真实仓库性能使用 release 构建，命令和进程树口径见[统计调度测量](benchmarks/stats-scheduling.md)。

`test:renderer` 用假接口测试会话、翻页与刷新状态（判旧、取消、记录时机），不启动 Electron。`test:sessions` 只构建 daemon，使用临时 Git fixture 与独立应用数据目录验证会话 / 查看记录；`test:history` 验证真实游标完整遍历、淘汰重放、取消和刷新，这些检查不启动 UI。`test:navigation` 使用临时真实仓库对照多范围历史、默认基准、合入状态、worktree 和失败恢复。`test:smoke:history` 使用已构建的 Electron 应用验证翻页、刷新、选择与锚点；`test:smoke:virtual-history` 验证 2205 条正反向遍历、1800 条主列表上限、虚拟 DOM、键盘、复制及只读快照；`test:smoke:scope-navigation` 验证真实选择器、多范围切换、失败保留与恢复、原生窗口内容边界；先运行 `pnpm build`。滚动测量命令和 release 标记诊断见 [P1-03 基线](benchmarks/p1-03-history-scroll.md)，应与构建、测试串行执行。旧预览的纯 headless 回归可运行 `node scripts/test-repository.mjs`。应用通过 main 把 `userData/repository-state` 传给核心；直接运行 daemon 时，未配置 `COMMITSCOPE_APP_DATA_DIR` 会禁用持久化，仍可浏览。存储不会因打开仓库就标记已读，调用方需在真实内容展示后显式记录查看。

`test:indexing` 使用真实 Git 对照 SQLite 的完整元数据与固定快照成员，并验证暂停 / 取消、强退续建、缓存故障、配额和只读边界；`test:smoke:metadata-index` 验证实际窗口中的索引状态与控制。直接运行 daemon 可用 `COMMITSCOPE_INDEX_QUOTA_BYTES` 调整每库配额，范围为 256 KiB 至 2 GiB，默认 2 GiB；该配额包含数据库与事务侧文件。暂停和取消保留已提交批次，重建只清理当前仓库的应用缓存。

`test:search` 对照真实 Git fixture 验证完整消息、Unicode 大小写、身份组合、日期、OID、部分结果版本和双向分页；实际项目仓库试用通过显式 `pnpm test:search -- --real-repository` 运行。`test:smoke:metadata-search` 检查真实窗口中的搜索和筛选流程。只读查询经 `commit_path_changes(path, oid)` 索引、延迟摘要物化及会话级 `excludeTips` 缓存避免重扫未命中行与重复 `diff-tree`。

统计与索引优化（2026-11-19 第二至四轮）另包含：`repository::discover_repository_probe` 合并多项 `rev-parse` 探测、非 shallow/grafted 仓库默认放行 commit-graph、`metadata_index` 采用 1024 批次先落库元数据再以 4096 批（ASCII 快速折叠）追平 `message_fts_rowid` 的无内容 FTS5 `trigram` 候选索引、根据本机物理内存与核心/性能核数自适应决定 `2..=12` worker、Git pack 缓存限额与 SQLite `cache_size`/`mmap_size`（保留 `WITHOUT ROWID` 与 `-l20000`）、搜索使用窄列扫描 + 主键延迟构造 `CommitSummary`、统计采用 CSR 整数图 DFS / 字符串驻留、按 OID 排序的 64 批流式 `commit_changes` 扫描与请求后堆内存归还；工作区读取（`workspace::read_status`）保持 `core.fsmonitor=false` 与 `--no-optional-locks` 只读边界不变，按暂存/未暂存侧跳过空侧 `diff --numstat`、未暂存侧固定 `--no-renames`、将污路径在 `256` 路径 / `16 KiB` 上限内直传 `-- <pathspecs>`（包含重命名源路径，超限回退）并与 `COMMIT_EDITMSG` 草稿复核并发执行；回归仍以原有 `cargo test`、`test:indexing`、`test:search`、`test:pages` 及独立 release 进程树测量脚本验证。

`test:graph` 对照独立 Git 验证有效父关系、六列连接、跨页大小与检查点淘汰重放、浅克隆 / grafts / SHA-256、取消和只读边界；`test:smoke:history-graph` 验证真实图、分隔线桥接、搜索返回、虚拟窗口淘汰与缩放主题。宽图 fixture 生成与串行 release 测量命令见 [P2-01 基线](benchmarks/p2-01-history-graph-scroll.md)。

## 工程布局

```text
apps/desktop/               Electron main、preload、React renderer
crates/core/                Rust 协议类型与 schema 导出
crates/daemon/              Rust 常驻进程、查询调度、只读 Git 与首屏解析
packages/protocol/          生成的 schema / TypeScript、桌面状态接口
scripts/                    协议生成、构建、启动、fixture 与测量脚本
tests/smoke/                真实 Electron 集成检查
tests/protocol/             客户端协议、判旧与生命周期测试
tests/sessions/             仓库会话、查看记录、存储降级与取消集成测试
tests/history/              固定快照分页、游标、刷新与流回收集成测试
tests/graph/                图布局、有效父关系、检查点恢复与取消集成测试
tests/navigation/           多范围 / worktree、合入状态、只读与失败恢复集成测试
tests/indexing/             SQLite 元数据、快照成员、恢复、配额和安全路径集成测试
tests/renderer/             界面会话状态的单元测试（假接口，不启动 Electron）
tests/repository/           独立 Git 对照、只读快照和取消测试
tests/readers/              CLI / gix 实验的 headless 正确性与取消测试
tests/fixtures/             fixture 生成和使用说明
docs/                      产品、架构、路线图、计划与验收
```

可按以下命令生成独立的 10 万提交数据集并复测；输出目录必须是新目录，结果 JSON 不覆盖已有文件：

```sh
mkdir -p output/fixtures
pnpm fixtures:generate --output output/fixtures/local-100k --large --seed 20261107
pnpm build:release
pnpm benchmark:first-screen --repository="$PWD/output/fixtures/local-100k/large" --runs=10 --output=output/benchmarks/local-first-screen.json
```

读取实验可独立构建与测试，复用上面已生成的 10 万提交数据，无需构建桌面：

```sh
pnpm build:reader-bench
pnpm test:readers --large-repository="$PWD/output/fixtures/local-100k/large"
pnpm benchmark:readers --repository="$PWD/output/fixtures/local-100k/large" --preflight --output=output/benchmarks/local-readers-preflight.json
pnpm benchmark:readers --repository="$PWD/output/fixtures/local-100k/large" --runs=10 --output=output/benchmarks/local-readers.json
```

测量前等待所有构建 / 测试结束；预检与正式结果分开保存。gix 仅为实验 dev-dependency，不进入生产 daemon 依赖。`test:readers` 要求一个已生成的 10 万提交 fixture，缺失时会提示生成命令。

真实 daemon 分页测量复用同一 fixture，完整走完实际返回的游标后再测缓存与淘汰重读：

```sh
cargo build --release --locked -p commitscope-daemon
pnpm benchmark:history --repository="$PWD/output/fixtures/local-100k/large" --runs=3 --output=output/benchmarks/local-history.json
```

`build:release` 使用优化的 Rust 二进制和构建后的桌面资源，尚非安装包。生成数据、原始采样和截图保存在忽略目录；源码中保留生成器和验收报告。当前支持多范围固定快照分页、有界页缓存、Rust 图布局与内存检查点，以及可恢复 SQLite 元数据索引；持久搜索结果缓存尚未实现。当前仅验证本机 macOS；Windows 在跨平台阶段验收，Linux 后续评估。Electron 45.2.3 内置 Node 24.22.2，与用于构建的 Node 26 分开记录；锁文件已保留。

## 决策来源

2026-11-07 根据《Git客户端替代方案》对话（未公开）及本次要求整理。以对话后半段对需求的收敛为准：历史和搜索优先，merge 与 review 次要。本次明确选择 Electron，并取消此前“评估复用 GitComet 后端”的候选路线。

同日用户通过四项选择确认：固定快照并点击刷新、提前交付元数据搜索、消息搜索框配合明确字段筛选、部分结果自动合并并保持选择和滚动锚点。随后授权由主代理制定代码级计划与验收、轻量模型代理实现；截至 2026-11-08，P0-01 至 P0-04、P1-01 至 P1-06 已完成，后续任务按实施计划推进。

同日用户在设计画布上比较多个方向后确认界面 v3：提交列表 + 详情双栏，分支与 worktree 收进范围选择器，文件改动放到详情第二层；并新增分支合入状态（对比 origin/main，识别 squash / rebase 合并）、按需计算的包含分支和按 Author 的活动分布。随后补充上次查看后新增标记、更新明细、merge 带入的提交、trailer、宽分支图、窄窗口、筛选弹层、定位横幅与 ⌘K 命令面板。产品、架构、计划与验收文档已同步。

2026-11-10 定名 CherryPeek（原工作名 CommitScope），以 MIT 许可证开源，第一版通过 GitHub Release 分发 Apple 芯片版，见[发布流程](RELEASE.md)。
