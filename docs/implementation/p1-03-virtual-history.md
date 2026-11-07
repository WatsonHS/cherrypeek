# P1-03：有界虚拟历史与上次查看标记

日期：2026-11-07。状态：已完成本机技术验收，见[验收记录](../validation/p1-03-virtual-history.md)和[滚动基线](../benchmarks/p1-03-history-scroll.md)；RSS 未达标项保留给 P4-01。基于 `11ae57b`（P1-02）；主代理明确契约、审查和验收，小模型实施。保留 Claude 已完成的视觉设计，不增加多范围导航、搜索、SQLite 或 Rust 图布局。

## 前端实现契约

- `repository-session-store.ts` 保存连续的真实 `HistoryPage` 窗口，默认每页 200 条，提交摘要总数最多 2000；最多另存一条已选旧摘要。只保留窗口内页面的游标，不建立全历史游标表或未知总数的空行。
- 向下滚动到窗口末端约一屏内时请求下一页，向上同理。一次只读一页，只预取相邻页；没有滚动意图时不循环填充窗口。换方向、刷新、切仓使旧 intent 失效，沿用 main 的取消并排空终态。失败停下并提供显式重试，不自动无限重试。
- 合并前验证相同 session / generation、页大小、相邻 offset 和 OID 不重复。超出 2000 条从远离当前视口的一端整页淘汰，保留边界游标供反向重读。淘汰/前插必须按首个可见 OID 与行内像素偏移恢复位置，不能用固定页高假设忽略日期行。快速拖动时 DOM 可能仍是上一帧的片段，因此锚点从当前 scrollTop 与高度索引计算；更新时排除过期 RAF，并区分内部滚动补偿与新的用户滚动，不能整帧吞掉用户意图。
- `commit-list.tsx` 对有限窗口构建高度前缀和：提交行 60px、日期行 34px，新增分隔行使用明确固定高度。二分查找可见区，只挂载可见项及前后各至多 12 个 overscan 项；上下 spacer 只对应窗口内真实已载入的项。滚动使用 ref + requestAnimationFrame 合并更新，图和 entries 只随数据变化重算。
- 键盘选择独立于虚拟 DOM。窗口内按索引定位并让目标挂载；越界时读取邻页，成功后才选择邻项，失败/取消保留原选择。详情的上下条复用同一逻辑。Home / End 明确只到已载入窗口两端；输入法组词期间不触发快捷键。保持现有复制完整 OID 的窄接口。
- 翻页按钮保留为显式相邻页导航：在窗口内优先导航到已载入的相邻页，走到边缘才请求新页；活动页与窗口边缘游标分开保存，预取不擅自改变活动选择。自动预取与手动翻页不能互相覆盖，等待期间反向滚动或跳转要取消旧预取，防止响应到达后淘汰当前可见页。选择因淘汰离开窗口时保留一条摘要和原观察时间；刷新后锚点不在新首屏仍使用 P1-02 的“当前窗口未载入”提示，不暗中改选或推断不可达。
- 列表标注“已载入区间 / 已载入 N 条”，不声称仓库总量。临时图只对有界窗口布局，跨页 lane 连续性仍属于 P2-01。

## 新增标记契约

新增集合为当前冻结 HEAD 可达、上次查看 tips 不可达的 OID；与独立 `git rev-list <current> --not <previous>` 对照。首次记录缺失不标记，曾查看空仓库 `tips=[]` 则当前可达提交都属于新增。损坏记录或旧对象缺失应明确降级为标记不可用，历史仍可浏览，禁止补拉。记录当前已显示 tips 不得改变本次 session 捕获的比较基准。

Rust 在分页服务中提供标记事实，renderer 不推断 Git 可达性。页内新增状态与分隔线必须区分：只有证明所有新增是当前拓扑序的连续顶部前缀，才在第一条旧提交前显示“上次看到这里”；有交错、证明尚未完成或标记不可用时只显示已证明的圆点，不显示猜测的分隔线。空历史、零新增、全部新增均无分隔线。

### Wire 与算法（只读实验后冻结）

- 增加 capability `historyNewSinceLastSeen`，协议版本仍为 1。`historyPage.commits` 改为 `HistoryCommit[]`：保留扁平的 `CommitSummary` 字段并增加必填 `isNewSinceLastSeen:boolean`，legacy preview 的 `CommitSummary` 不改变。
- 每个 historyPage 块重复相同的 `newSinceLastSeenStatus: "ready" | "firstView" | "unavailable"` 与 `lastSeenDividerOid:string|null`；main 检查分块元数据一致，透传业务 `HistoryPage`。`firstView` 是没有记录，全部 false；`unavailable` 表示记录/旧对象/比较不可用，全部 false，界面明确说明，不能展示为“没有新增”。
- 对每页最多 500 个候选运行正向 `git rev-list <previous tips...> --`，流式读取，只保存本页候选的旧历史命中集合。全部候选已经命中时可提前 kill/wait 并将本页全部标为旧；否则必须正常 EOF，才把未命中的候选标为新增。遍历顺序不影响集合判定，不改变主 HEAD topo 遍历或物化全仓 OID。
- 最初验证过“本页正 tips 减旧 tips”方案，但反例实验发现：old tip 仍存在、旧链中间对象丢失、current 从共同祖先分叉时，Git 的负 tip 遍历可能静默跳过缺失旧祖先并成功退出，误报共同祖先为新增。因此改用上述正向旧历史读取，让缺对象的错误可见；不把 Git 成功退出等同于负集合完整。正常完整仓库仍对照 [Git rev-list 的集合语义](https://git-scm.com/docs/git-rev-list)。这会增加含新增候选的页及深页的旧历史扫描成本，保留测量，不提前承诺普通翻页预算已满足。
- 首次无记录全部 false；旧 tips 为空全部 true；旧 tip 等于当前 HEAD 全部 false。这些情况不另启比较遍历。有效旧 tip 与当前不同时，query 首次执行一次 `rev-list --count <current> --not <previous>` 获取全局新增数量（常量输出），用于证明分隔线。随后只对首次顺序发出的页累计从 offset 0 开始的新增前缀；第一条旧提交处若前缀数量等于全局新增数量且大于零，才记录其 OID 为分隔线。否则永久不显示分隔线。缓存重读/倒退重放不能重复累计；已证明的分隔线作为 query 元数据返回。
- 这比原架构描述多一次可取消的计数遍历，原因是单页无法证明后续没有交错新增；不构建额外全库索引。计数与页标记共享一个可选标记预算（每页至多 2 秒，且不超过原请求 deadline）；取消必须传播为 CANCELLED，标记预算超时或旧数据不可用则降级，保留正常历史。失败后本 query 标记设为 unavailable，缓存/renderer 已保留标记也随之清除，避免混用状态。单页成本与首次比较成本在验证中记录。
- 比较仍复用安全 Git 参数、环境、流背压和 kill/wait；历史边界指纹在整页前后复核。记录查看不会修改已捕获基准。刷新准备前只读捕获持久化 previousView 和状态，候选第一页与最终提交的新 session 使用同一份基准；不能在提交时另读不同值。持久化读取不更新 recent 或写入被查看仓库。

## 所有权与交付顺序

| 代理 | 文件 / 职责 |
| --- | --- |
| Rust | `crates/core/**`、`crates/daemon/**`，生成 schema / TS；有界新增判定、刷新准备时捕获基准、Rust 测试 |
| 桌面 | `apps/desktop/src/renderer/**`、main `repository-session-controller.ts`、`packages/protocol/src/repository-session.ts`、`tests/renderer/**`、controller 协议测试、`scripts/test-renderer.mjs` |
| 独立验证 | `tests/history/**`、历史集成 runner、`tests/smoke/history-pagination-smoke.mjs` 及新虚拟列表 smoke、滚动 benchmark、package.json 的对应 scripts |
| 主代理 | 本计划与 README / ARCHITECTURE / PLAN、代码审查、验收和基线文档 |

共享工作区，保留别人的改动，接口变更先协调；实现代理不提交。先窗口/虚拟化与 Rust 标记并行，再协议接线和集成测试，最后独占运行滚动测量。

## 验证与证据

1. Store 行为测试：双向预取、2000 条上限、淘汰反向重读、旧请求不回写、方向切换/取消/失败重试、边界选择、刷新及旧选择保留。虚拟高度测试覆盖日期/分隔行、边界和空列表。
2. 独立 Git：首次打开、曾查看空仓库、快进、amend/rebase、拓扑中新旧交错、旧 tip 丢失、shallow 边界；按 OID 检查标记和分隔线，包含跨页、淘汰重读和刷新。复用现有只读快照及取消/进程回收检查。
3. 真 Electron smoke：滚过多页并超过窗口上限，DOM 与保留数据有界，回滚可读，键盘跨页/复制、重试与刷新锚点正常；旧 P1-02 smoke 改用虚拟列表可见行语义，不依赖整页都在 DOM。
4. 复用冻结的 `output/fixtures/p0-03-seed-20261107/large`，不写该仓库。release 构建后独占测量；每轮真实前台 Electron 固定 30 秒滚动，记录 RAF 间隔、长任务、载入区间/条数、DOM 行峰值，以及整个 Electron + Rust + Git 进程树 CPU/RSS 和退出回收。原始产物写新路径，不覆盖失败样本。
5. 冻结目标：60Hz 时帧间隔 p95 ≤20ms、无 >100ms 停顿；页面请求到绘制 p95 ≤200ms；全进程树空闲 RSS ≤500MiB。记录样本数和实际刷新率；不能控制/证实 60Hz 时明确该关卡未验证，不用其他刷新率冒充通过。保留未达标测量及原因，不将本项等同于发布性能验收。
6. 运行受影响 Rust、schema/typecheck、controller/renderer、历史与 UI 测试。只有完成行为证据和测量记录后更新任务状态。
