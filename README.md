# CommitScope

面向 Agent 高频提交场景的桌面 Git 历史浏览器。快速看清最近提交了多少、谁提交的、改了什么，以及分支之间的关系。

**当前状态：只读 MVP 功能已齐全，M3 本机小规模主流程通过，UI-01 至 UI-03 已接入。** 可打开本地 Git 仓库、按固定 HEAD、分支、标签或 worktree 快照连续浏览，默认每页 200 条，主列表最多保留 1800 条摘要，另为当前 merge 页预留 200 条；支持双向预取、键盘选择、复制、取消、错误重试和手动刷新，并按 Git 可达性显示上次查看后的新增标记。刷新保留选择及可恢复的滚动锚点。界面沿用 Claude 的 v3 设计，未接入区域明确标注“占位”。10 万提交三轮名义 60Hz 滚动的帧间隔 p95 为 17.3–17.8 ms，DOM 峰值 35 行；全进程树短时空闲 RSS 为 540–541 MiB，超过当时的 500 MiB 目标；现行内存预算已放宽，见下文。详见[P1-03 基线](docs/benchmarks/p1-03-history-scroll.md)，不作为发布性能验收。分支 / worktree 导航与按需“已合入”状态已接入，切换范围不 checkout。可恢复 SQLite 元数据索引已接入，支持真实进度、暂停、继续、取消和重建；索引故障保留历史。元数据搜索已接入：完整消息默认不区分大小写，可组合 Author / Committer、日期、OID 与当前范围；部分结果持续更新并保持选择和滚动锚点。大仓搜索延迟尚未验收，详见[P1-06 验收](docs/validation/p1-06-metadata-search.md)。Rust 图布局与有界检查点已接入：跨页 / 淘汰回读保持连线与颜色，默认显示六列，点击图区 +N 可展开当前范围的全部图线并横向滚动，支持收起；明确标记浅克隆等历史边界。十万提交 / 千条引用宽图三轮帧间隔 p95 均为 18.6 ms，暂停索引时短时空闲整树 RSS 为 580–583 MiB；详见[P2-01 基线](docs/benchmarks/p2-01-history-graph-scroll.md)，未验收索引完成后的内存预算。完整消息 / trailer、父提交文件比较、merge 带入分页与自动加载包含分支已接入，见 [P2-02 验证记录](docs/validation/p2-02-commit-details.md)；完整实窗检查未跑完。P2-03 已接入点击文件展开只读 diff，支持父提交切换、行号、二进制 / LFS / gitlink 提示和截断说明，见[实现及检查记录](docs/implementation/p2-03-readonly-diff.md)。P2-04 已接入搜索结果的历史定位与返回，恢复原查询、选择和滚动锚点，并提供快捷键说明，见[实现记录](docs/implementation/p2-04-history-location.md)。P3-01 已接入文件 / 目录字面路径筛选、当前快照路径补全和 merge 命中父说明，见[实现记录](docs/implementation/p3-01-path-history.md)。P3-02 活动统计、P3-03 外部变化提示与 P3-05 可编辑 Agent 提示词已接入；P3-04 的 8 步实窗流程和当前项目只读数据对照通过，见[M3 记录](docs/validation/m3-mvp.md)。尚未完成 M4 性能、长期稳定性与发行验收。`CommitScope` 是暂定工作名。

P4-01 已交付首批查询和内存优化：十万提交 OID 搜索中位数约 1.3 ms；同口径整树空闲 RSS 从约 603 降至 566 MiB，查询阶段采样峰值从约 690 降至 623 MiB。这些是旧预算下的优化结果，长期稳定性和发布验收仍待完成，详见[查询报告](docs/benchmarks/p4-01-interactive-performance.md)与[内存报告](docs/benchmarks/p4-01-memory.md)。

历史列表右缘是时间滑轨：显示当前位置附近、按提交数自动缩放的一段时间，拖动时列表实时跟随，可以定位到某天的某个时段；列表顶部固定显示当前日期，点它打开按提交数着色的日历，不在最新处时可一键回到最新。保持当前范围和分支图。详见[实现与检查记录](docs/implementation/history-date-navigation.md)。

快速导航已加入当前快照的日期 / 拓扑缓存、按滚动速度提前预取和滑轨预览请求合并。十万提交定向实测中，后续不同日期定位中位数约 903 → 38 ms，拖动松手后等待约 1.46 → 0.11 秒；首次扫描仍约 0.52 秒。连续拖动后的 renderer 内存仍需优化，完整条件和限制见[快速导航报告](docs/benchmarks/p4-01-fast-history-navigation.md)。

日期定位进一步复用已载页面和固定快照引用。同页定位中位数 10.6 → 0.5 ms，响应从约 352 KB 降至 145 字节；同一 UI 下拖动后整树 RSS 单点 802 → 788 MiB，renderer 常驻内存尚未明显下降。见[页面复用报告](docs/benchmarks/p4-01-history-page-reuse.md)，其中 500 MiB 为当时目标。

随后根据分配采样移除了关闭的分支菜单反复构造，并让普通分页复用引用对象。三轮操作的 JS 分配估算减少约 39%；新一组同口径比较中，拖动后整树 RSS 780 → 757 MiB，第五秒 748 → 729 MiB，定位结果与速度保持。该轮定向优化已收尾，见[分配与内存报告](docs/benchmarks/p4-01-renderer-retention.md)。2026-11-09 按用户要求放宽内存预算：空闲整树 RSS 目标 800 MiB，交互阶段观察目标 1 GiB，保留长期运行不持续增长的要求。短时值已处于新目标内，完整验收仍待完成，见[当前验收口径](docs/VALIDATION.md)。随后实现并验收了 P4-09 至 P4-12（工作区、文件页、diff 显示增强、逐行追溯）。

列表与详情之间的分隔线可以拖动调整列宽，历史与搜索共用宽度；支持左右键调整和双击复位。

图区右缘也可拖动，调整为 4–12 列，左右键逐列调整、双击恢复默认六列；`+N` 展开全部，收起恢复自定义宽度。悬停提交突出其主线，移开后恢复选中提交的高亮，日期分隔连线同步变化。见 [P4-05 实现记录](docs/implementation/p4-05-expand-graph.md)。十万提交的[图交互测量](docs/benchmarks/p4-05-graph-interactions.md)已归档，宽图前台焦点条件及发布验收仍留给 P4-01。

窗口窄于 1100px 时列表占满，点击提交或在列表按 Enter 打开右侧详情抽屉，顶部可切换前后提交；Esc、关闭按钮或点遮罩返回列表。搜索结果同样适用，调整窗口宽度会保留选择和滚动位置。见 [P4-06 实现记录](docs/implementation/p4-06-narrow-window.md)。

## 已确定的方向

- 独立新建项目，不 fork GitComet，不引入或复制其后端及状态层代码。
- Electron 桌面外壳，React + TypeScript 界面（Tailwind CSS 4 + shadcn 风格组件），Rust 承担 Git 读取、查询、缓存和后台任务。
- 第一版聚焦历史、搜索、分支、近期提交统计和按需查看 diff。
- 点击分支改变浏览范围，不切换工作区；先实现只读闭环，适配 Agent 同时操作仓库。
- 当前浏览固定引用快照，外部变化只提示有更新，用户点击刷新后才切换快照。
- 历史分页稳定后即交付元数据搜索：消息搜索框配合明确字段筛选；部分结果自动合并并保持选择和滚动锚点。
- 性能通过同仓库、同硬件的测量验收，不用语言或框架名称代替结果。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [产品范围](docs/PRODUCT.md) | 用户需求、主界面、搜索与统计口径、第一版边界 |
| [界面设计稿](https://claude.ai/artifact/LssQVaEeGiqB1WdCRn2jDa) | 已确认的「v3 · B 细化」画板（示例数据；默认仅所有者可见；以产品范围的文字为准） |
| [界面规范](docs/DESIGN.md) | 颜色、字体、间距、组件与状态的实现规范（以此为准） |
| [交给 Agent 模板](docs/HANDOFF.md) | 各场景 prompt 的文案、变量与防注入规则 |
| [UI-01 验收记录](docs/validation/ui-01-foundation.md) | 界面基础的实现范围、真实数据与占位划分、测试与未验证项 |
| [UI-02 验收记录](docs/validation/ui-02-sessions.md) | 界面接入仓库会话、最近打开与查看记录 |
| [UI-03 窗口外壳](docs/validation/ui-03-window-chrome.md) | 隐藏系统标题栏、保留原生窗口按钮与顶部拖动区域 |
| [技术架构](docs/ARCHITECTURE.md) | Electron / Rust 分工、通信、Git 读取、分页、索引与刷新 |
| [路线图](docs/ROADMAP.md) | 从技术验证到可日用版本的阶段和验收关卡 |
| [实施计划](docs/PLAN.md) | 可直接开始执行的任务、依赖、交付物和完成条件 |
| [性能与正确性验收](docs/VALIDATION.md) | 测试仓库、性能预算、测量方式和关键边界 |
| [P0-01 代码级计划](docs/implementation/p0-01-bootstrap.md) | 文件、接口、进程边界、命令与代理分工 |
| [P0-01 验收记录](docs/validation/p0-01-bootstrap.md) | 实测环境、检查结果、修复记录和未验证范围 |
| [P0-02 代码级计划](docs/implementation/p0-02-protocol.md) | 协议契约、调度、上下文判旧、生命周期与代理分工 |
| [P0-02 验收记录](docs/validation/p0-02-protocol.md) | 双端测试、Electron 运行时复测、异常与进程树回收证据 |
| [P0-03 代码级计划](docs/implementation/p0-03-repository-preview.md) | 真实 Git 读取契约、fixture、桌面预览与测量分工 |
| [P0-03 验收记录](docs/validation/p0-03-repository-preview.md) | 独立 Git 对照、只读边界、取消与真实窗口验证 |
| [P0-03 首屏基线](docs/benchmarks/p0-03-first-screen.md) | 10 万提交、10 次启动与整个进程树资源采样 |
| [P0-04 代码级计划](docs/implementation/p0-04-reader-comparison.md) | 独立 CLI / gix 实验、数据契约与代理分工 |
| [P0-04 验收记录](docs/validation/p0-04-readers.md) | 深页、原始字节、兼容性、只读与取消验证 |
| [读取路线决策](docs/decisions/0001-git-reader.md) | 保留 Git CLI，gix 暂仅用于实验 |
| [M0 汇总基线](docs/benchmarks/m0-baseline.md) | 180 项读取对比、参考硬件、冻结预算与限制 |
| [P1-01 代码级计划](docs/implementation/p1-01-repository-sessions.md) | 固定 HEAD 会话、持久身份、查看记录与非视觉桥接契约 |
| [P1-01 验收记录](docs/validation/p1-01-repository-sessions.md) | 真实会话、存储降级、取消竞态与双运行时协议验证 |
| [P1-02 代码级计划](docs/implementation/p1-02-history-pagination.md) | 固定快照分页、游标、缓存、取消与手动刷新的跨层契约 |
| [P1-02 验收记录](docs/validation/p1-02-history-pagination.md) | 独立 Git 对照、翻页与刷新行为、界面检查及范围限制 |
| [P1-02 分页基线](docs/benchmarks/p1-02-history-pagination.md) | 10 万提交三轮完整遍历、缓存命中、淘汰重读与核心进程树采样 |
| [P1-03 代码级计划](docs/implementation/p1-03-virtual-history.md) | 有界窗口、虚拟滚动、查看标记与分隔线证明 |
| [P1-03 验收记录](docs/validation/p1-03-virtual-history.md) | 独立 Git 对照、竞态恢复、真实窗口与验证边界 |
| [P1-03 滚动基线](docs/benchmarks/p1-03-history-scroll.md) | 10 万提交三轮 30 秒滚动、整个进程树资源与待修复目标 |
| [P1-04 代码级计划](docs/implementation/p1-04-scope-navigation.md) | 分支 / worktree 范围、冻结 tips、按需合入状态与只读验证 |
| [P1-04 验收记录](docs/validation/p1-04-scope-navigation.md) | 范围隔离、独立 Git 对照、失败恢复与真实窗口验证 |
| [P1-05 代码级计划](docs/implementation/p1-05-metadata-index.md) | 可恢复 SQLite 元数据索引、快照 coverage、后台控制与配额 |
| [P1-05 验收记录](docs/validation/p1-05-metadata-index.md) | SQLite 数据对照、恢复与安全边界、桌面控制和故障重建验证 |
| [P1-06 代码级计划](docs/implementation/p1-06-metadata-search.md) | 字面搜索语义、组合筛选、版本化结果分页与锚点保持 |
| [P1-06 验收记录](docs/validation/p1-06-metadata-search.md) | 搜索的数据对照、动态分页、桌面试用及当前验证状态 |
| [P2-01 代码级计划](docs/implementation/p2-01-history-graph.md) | Rust 图布局、有效父关系、跨页检查点与可见图绘制 |
| [P2-01 验收记录](docs/validation/p2-01-history-graph.md) | 跨页确定性、边界、取消与实窗恢复验证 |
| [P2-01 宽图滚动基线](docs/benchmarks/p2-01-history-graph-scroll.md) | 十万提交、千条引用的图滚动与全进程树测量 |
| [P2-02 代码级计划](docs/implementation/p2-02-commit-details.md) | 提交全文、文件页、merge 带入提交与快照引用关系 |
| [P2-02 验证记录](docs/validation/p2-02-commit-details.md) | 自动验证结果、部分实窗检查与未完成边界 |
| [P2-03 代码级计划](docs/implementation/p2-03-readonly-diff.md) | 点击文件读取 unified diff、内容边界与最小检查 |
| [P2-04 代码级计划](docs/implementation/p2-04-history-location.md) | 搜索结果定位到历史、返回锚点与快捷键 |
| [P3-01 代码级计划](docs/implementation/p3-01-path-history.md) | 字面文件 / 目录筛选、冻结快照补全与命中父说明 |
| [M3 功能批次](docs/implementation/p3-02-05-mvp-batch.md) | 统计、外部更新和 Agent 提示词的代码计划 |
| [M3 主流程记录](docs/validation/m3-mvp.md) | 定向检查、实窗闭环与未验证范围 |

建议按产品范围 → 技术架构 → 路线图 → 实施计划阅读。2026-11-08 确认的后续规划 `P4-09` 工作区状态与改动展示、`P4-10` 文件二级页面，以及随后拆出的 `P4-11` diff 显示增强、`P4-12` 逐行追溯，已于 2026-11-09 实现并验收。切分支、fetch、stash 等的执行方式留待讨论。`M4 / P4-01` 性能达标、边界恢复与发行验收继续保留，具体范围和完成条件见[实施计划](docs/PLAN.md)。

## macOS 本机打包

在当前架构的 Mac 上执行 `pnpm package:mac`，会先构建 release Rust 核心与桌面代码，再生成 `release/mac-arm64/CommitScope.app` 和 `release/CommitScope-0.1.0-arm64.dmg`（Apple Silicon）。只需要应用目录时可执行 `pnpm package:mac --dir`。打开 DMG 后将 CommitScope 拖到 Applications，或直接打开生成的 `.app`。

运行应用只需兼容的系统 Git，不依赖 Node、pnpm、Rust 或项目源码。使用当前 PATH 查找 Git，找不到时尝试 `/usr/bin/git`；Git 必须支持 `--no-lazy-fetch`。本机包使用 ad-hoc 签名，尚未做公开分发的 Developer ID 签名与公证，也未验证 Intel 或干净系统安装。默认应用数据位于 `~/Library/Application Support/commitscope/`，其中 `repository-state/` 存放仓库缓存与查看记录。

打包后可运行 `pnpm test:smoke:package` 检查包内核心、系统 Git、真实提交加载与退出清理。具体配置、试用范围和证据见 [P4-02 本机打包记录](docs/implementation/p4-02-macos-package.md)。

## 本地运行

按 `⌘K`（Windows 快捷键为 `Ctrl+K`）或点击顶栏的快速跳转按钮，可输入提交 hash、分支、标签、worktree，或搜索打开仓库、切换页面、复制提交等命令。短 hash 至少 4 位，直接在当前快照范围内定位；不需要等待索引完成。

范围菜单会识别普通 merge，以及 squash、rebase、cherry-pick 后的等价补丁，分别显示“已合入”和“内容已在 {基准分支}”。计算使用当前固定快照，未匹配或超过计算上限不显示否定标签；可交给 Agent 重新核查后清理。见 [P4-08 实现记录](docs/implementation/p4-08-patch-equivalence.md)。

当前验证环境为 macOS 27.0.1 / Apple Silicon，使用 Node 26.0.0、pnpm 10.28.1、Rust 1.95.0；版本分别由 `.node-version`、`packageManager` 和 `rust-toolchain.toml` 固定。准备这些工具后，在项目根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 先构建 Rust、生成协议类型并构建前端，再打开窗口；本项没有 HMR。首次启动可能需要下载已锁定版本的 Electron 二进制。可通过“选择目录”或绝对路径输入打开仓库；列表默认展示 Committer 时间（本地时区），详情分别显示 Author / Committer 及其原始时间偏移。关闭窗口会退出应用；终端中断会回收本次启动的进程。已构建后可用 `pnpm start` 直接打开，或用 `pnpm start --repository=/绝对路径/仓库` 直接进入预览。当前只读本地对象，系统 Git 必须支持 `--no-lazy-fetch`；不支持时返回错误，不自动降级补拉。

搜索命中后，在详情点击“在历史中定位”（⌘]），可在同一范围和快照下查看前后提交与分支图；点击横幅“返回 N 个结果”（⌘[）恢复原筛选、选择和滚动位置。顶部键盘按钮显示已接入的快捷键，⌥⌘R 刷新仓库历史；Windows 对应 Ctrl / Alt 组合。

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
pnpm test:renderer
pnpm test:repository
pnpm test:smoke
pnpm test:smoke:history
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

`test:renderer` 用假接口测试会话、翻页与刷新状态（判旧、取消、记录时机），不启动 Electron。`test:sessions` 只构建 daemon，使用临时 Git fixture 与独立应用数据目录验证会话 / 查看记录；`test:history` 验证真实游标完整遍历、淘汰重放、取消和刷新，这些检查不启动 UI。`test:navigation` 使用临时真实仓库对照多范围历史、默认基准、合入状态、worktree 和失败恢复。`test:smoke:history` 使用已构建的 Electron 应用验证翻页、刷新、选择与锚点；`test:smoke:virtual-history` 验证 2205 条正反向遍历、1800 条主列表上限、虚拟 DOM、键盘、复制及只读快照；`test:smoke:scope-navigation` 验证真实选择器、多范围切换、失败保留与恢复、原生窗口内容边界；先运行 `pnpm build`。滚动测量命令和 release 标记诊断见 [P1-03 基线](docs/benchmarks/p1-03-history-scroll.md)，应与构建、测试串行执行。旧预览的纯 headless 回归可运行 `node scripts/test-repository.mjs`。应用通过 main 把 `userData/repository-state` 传给核心；直接运行 daemon 时，未配置 `COMMITSCOPE_APP_DATA_DIR` 会禁用持久化，仍可浏览。存储不会因打开仓库就标记已读，调用方需在真实内容展示后显式记录查看。

`test:indexing` 使用真实 Git 对照 SQLite 的完整元数据与固定快照成员，并验证暂停 / 取消、强退续建、缓存故障、配额和只读边界；`test:smoke:metadata-index` 验证实际窗口中的索引状态与控制。直接运行 daemon 可用 `COMMITSCOPE_INDEX_QUOTA_BYTES` 调整每库配额，范围为 256 KiB 至 2 GiB，默认 2 GiB；该配额包含数据库与事务侧文件。暂停和取消保留已提交批次，重建只清理当前仓库的应用缓存。

`test:search` 对照真实 Git fixture 验证完整消息、Unicode 大小写、身份组合、日期、OID、部分结果版本和双向分页；实际项目仓库试用通过显式 `pnpm test:search -- --real-repository` 运行。`test:smoke:metadata-search` 检查真实窗口中的搜索和筛选流程。大仓搜索延迟仍需后续测量，每页扫描当前已索引前缀。

`test:graph` 对照独立 Git 验证有效父关系、六列连接、跨页大小与检查点淘汰重放、浅克隆 / grafts / SHA-256、取消和只读边界；`test:smoke:history-graph` 验证真实图、分隔线桥接、搜索返回、虚拟窗口淘汰与缩放主题。宽图 fixture 生成与串行 release 测量命令见 [P2-01 基线](docs/benchmarks/p2-01-history-graph-scroll.md)。

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

2026-11-07 根据[《Git客户端替代方案》对话](chatgpt-conversation://6aee1e91-eb04-83e9-b710-302e29850b14)及本次要求整理。以对话后半段对需求的收敛为准：历史和搜索优先，merge 与 review 次要。本次明确选择 Electron，并取消此前“评估复用 GitComet 后端”的候选路线。

同日用户通过四项选择确认：固定快照并点击刷新、提前交付元数据搜索、消息搜索框配合明确字段筛选、部分结果自动合并并保持选择和滚动锚点。随后授权由主代理制定代码级计划与验收、轻量模型代理实现；截至 2026-11-08，P0-01 至 P0-04、P1-01 至 P1-06 已完成，后续任务按实施计划推进。

同日用户在设计画布上比较多个方向后确认界面 v3：提交列表 + 详情双栏，分支与 worktree 收进范围选择器，文件改动放到详情第二层；并新增分支合入状态（对比 origin/main，识别 squash / rebase 合并）、按需计算的包含分支和按 Author 的活动分布。随后补充上次查看后新增标记、更新明细、merge 带入的提交、trailer、宽分支图、窄窗口、筛选弹层、定位横幅与 ⌘K 命令面板。产品、架构、计划与验收文档已同步。

公开发布名称、项目许可证和分发渠道尚未决定，不影响本地开发。
