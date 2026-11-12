# M5 / M6 后端接口约定

日期：2026-11-12。状态：Rust 后端已实现，必跑四项检查通过；完整验证记录见 [后端验证](../validation/m5-m6-backend.md)，桌面接线由 Claude 负责。用途：界面（Claude）和核心（Codex）并行开发时对齐接口。产品口径见 [PRODUCT](../PRODUCT.md)「基础操作」「统计页」，执行层约束见 [ARCHITECTURE](../ARCHITECTURE.md)「基础操作执行层」，任务与完成条件见 [PLAN](../PLAN.md) 的 M5、M6。

## 分工（2026-11-12 用户确认）

- **Codex**：`crates/core`、`crates/daemon`、`pnpm protocol:generate` 生成物，以及对照独立 Git 的 daemon 测试。
- **Claude**：`apps/desktop/src/main`（transport、controller、IPC）、preload、renderer、`packages/protocol/src` 里手写的接口类型。
- 方法名和字段可以在实现时调整，调整后请更新本文件；界面按本文件的形状准备，接入时以生成的类型为准。
- 两边都会改到的只有生成物。改 `main` / preload 前先看对方有没有未提交的改动。

已有的基础：`repositoryOperations` capability、`fetchRepository`、操作模式的 Git 运行器（`ReadOnlyGit::for_operation`，只在 `operations.rs` 使用）、操作的独立请求额度，见 PLAN 的 P5-01 进展。

## M5：基础操作

### `getBranchSync`（只读，占普通读取额度）

界面用它显示领先 / 落后数，并决定行尾显示“更新”还是“交给 Agent”。

- 参数：`{ refNames: string[] }`，本地分支的完整引用名，最多 50 个。
- 结果：`{ branches: BranchSync[], lastFetchUnixMs: number | null }`。`lastFetchUnixMs` 取 `FETCH_HEAD` 的修改时间，没有则为 null。
- `BranchSync`：`{ refName, oid, upstream: { refName, oid } | null, ahead: number | null, behind: number | null, state, checkedOutBy: string[] }`。
  - `state`：`upToDate` / `behind`（可快进）/ `ahead` / `diverged` / `noUpstream` / `unavailable`（超限或失败，不当作任何结论）。
  - `checkedOutBy`：检出该分支的 worktree 路径。
- 按冻结的浏览快照计算，绑定 generation。

### `checkOperation`（只读）与 `runOperation`（占操作额度）

两者参数相同：`{ operation }`。

| `operation.kind` | 字段 | 行为 |
| --- | --- | --- |
| `fastForward` | `refName`、`expectedOid`、`upstreamOid` | 把本地分支快进到上游。是当前分支时更新工作区；不是时只移动引用，不 checkout |
| `switch` | `target: { refName }`（本地分支）或 `{ remoteRefName }`（新建同名跟踪分支后切换）、`expectedHeadOid`、`expectedOid`（目标引用） | 切换本窗口工作区 |
| `createBranch` | `name`、`startOid`、`switchAfter: boolean`、`expectedHeadOid` | 新建本地分支，可选随即切换 |

- **2026-11-12 修订**：移除 `fetchFirst`。main 对当前分支先显式调用 `fetchRepository`，再刷新引用并用新的 OID 调用 check / run；快进拒绝的零写入保证从快进阶段开始。`switch` 增加目标 `expectedOid`，`createBranch` 增加 `expectedHeadOid`。本地写入开始后不取消。
- 结果 section 分别为 `branchSync` / `operationCheck` / `operationRun`，结果字段为 `result`。
- `checkOperation` 结果：`{ allowed: boolean, blockers: Blocker[], preservedDirtyCount: number }`。`preservedDirtyCount` 是与目标不冲突、会保留的未提交改动文件数；ignored 条目仅参与防覆盖检查，不计入该数字，重命名计一项。
- `runOperation` 在 Rust 内重新检查。被拒绝时返回 `{ outcome: "rejected", blockers }`，不作为协议错误；执行成功返回 `{ outcome: "done", headOid, headReference, updatedRef: { refName, oldOid, newOid } | null }`。
- 执行中途 Git 失败：返回协议错误 `GIT_ERROR`，`message` 是 Git 的原始输出（有长度上限）。界面随后重读会话和工作区状态来显示实际状态。
- `expectedOid` / `expectedHeadOid` 与当前不符时，blocker 为 `refChanged`，不按旧事实执行。

`Blocker`（按 `kind` 区分）：

| `kind` | 附带字段 |
| --- | --- |
| `diverged` | `ahead`、`behind`、`localCommits`、`upstreamCommits`（各最多 10 条 `{ oid, summary }`，另给 `localCommitsTruncated` / `upstreamCommitsTruncated`）、`overlapPaths`（最多 20 条）和 `overlapPathsTruncated`|
| `dirty` | `paths`：最多 50 条 `{ path: GitPath, staged: boolean, unstaged: boolean, untracked: boolean }`，另给 `pathsTruncated` |
| `checkedOutElsewhere` | `worktreePath` |
| `inProgress` | `operation`：`merge` / `rebase` / `cherryPick` / `revert` / `bisect` / `sequencer` |
| `unsafeState` | `message`；未解决 index 冲突、skip-worktree / assume-unchanged 等无法证明安全的状态 |
| `noUpstream`、`notFastForward`、`refChanged`、`nameInvalid`、`nameExists`、`bare` | 无 |

### 远端地址

`getRepositoryNavigation` 还增加 `branchUpstreams: {refName, upstreamRefName}[]` 与 `lastFetchUnixMs`，随浏览快照捕获。结果增加 `remotes: { name, webUrl: string | null }[]`。`webUrl` 只由可识别的 `https://` 或 `git@host:owner/repo` 形式生成（去掉 `.git` 和凭据），识别不了为 null；界面据此拼出提交和分支的网页地址。

## M6：统计

新增 capabilities：`activityOverview`、`changeStats`、`notableStats`、`evolution`。所有方法绑定现有 repoId / generation，切换范围后旧结果应丢弃。只有 estimate / analyze 会按需读 Git 对象，其他统计从 SQLite 读取。

活动 / 改动 / 观察项参数带现有 `SearchQuery`，外加 `range: {startUnix, endUnix}`（半开区间）和 `bucket: "tenMinutes" | "hour" | "day" | "week" | "month"`。页内 range 与 query 的日期条件取交集；previousTotals 使用紧邻的上一个等长周期，也保留 query 条件。一天 / 周 / 月按 IANA 本地边界；周从周一开始，最多 3660 桶，跨度最多 3660 天。首桶可早于 range.startUnix，只统计 range 内提交。

统计占一个独立辅助额度；历史、搜索、详情等交互请求到来会取消统计，前端可稍后重试。超过计算预算返回 `RESOURCE_LIMIT`，不返回半算完的排名。结果 `coverage: {processed, complete}` 是实际索引覆盖，不提供未知总量百分比；活动按元数据覆盖，改动和观察项按已完成的文件索引覆盖。浅克隆缺失第一父的文件统计保留为未覆盖。

路径筛选用索引中的原始路径，保留原有“命中任意父比较”的语义；文件记录尚未补完时该查询返回 `INDEX_UNAVAILABLE`，不能静默忽略路径条件。根目录路径为 `rawHex: ""`。

### getActivityOverview

请求 `{query, range, bucket}`，响应 `{section: "activityOverview", stats}`。`stats`：

- `coverage`；`buckets: {startUnix, count}[]`（包含空桶）。
- `totals`、`previousTotals`：`{commits, activeDays, authors}`。
- `rhythm: {longestStreakDays, longestGapDays, busiestDay: {day, count} | null}`；gap 是相邻活跃日之间的空白天数，不包括区间两端。
- `weekHour: number[][]`（7 × 24，周一为第 0 行）；`types: {prefix, count}[]`，merge 单独计入 `mergeCount`，不重复放入 types；`revertCount`、`fixupCount`。
- `authors: ActivityAuthor[]`（最多 500），`authorsTruncated`。
- `branches: {refName, count, lastCommitUnix: number | null, complete}[]`（最多 200），`branchesTruncated`。count 为周期内，lastCommitUnix 为索引中符合 query 的最近提交；complete 为该分支祖先是否已全部在当前索引覆盖中。不能把 complete=false 且 count=0 解释为“不活跃”。
- `sessions: {startUnix, endUnix, count, authors: string[]}[]`，`sessionsTruncated`。仅范围 ≤ 24 小时时返回，最多 50 段；相邻提交间隔 ≤ 600 秒，endUnix 为最后提交时间加一秒，可直接用作半开筛选。

### getChangeStats

请求 `{query, range, bucket, directoryPrefix?: string}`，directoryPrefix 是原始路径的 hex 编码，空为根。响应 `{section: "changeStats", stats}`：

- `coverage`；`totals`、`previousTotals`：`{additions, deletions, filesChanged, filesAdded, filesDeleted, filesRenamed}`。文件数累计每次提交的文件条目，不是去重文件数；merge 不计，二进制仅计文件数。
- `excluded: {lines, lockFiles, mergeCommits}`：lines 为排除的增删行之和，lockFiles 为命中当前排除列表的文件改动条目数（不只限默认锁文件），mergeCommits 为本周期排除的 merge 数。排除列表只从行数移除，文件数保留。
- `buckets: {startUnix, additions, deletions, netGrowth}[]`，netGrowth 为本周期从起点累计的净增行数。
- `sizeHistogram`：5 档（1–10、11–50、51–200、201–1000、>1000），零行提交不入档；`largest: {oid, summary, author: SearchIdentity, additions, deletions}[]`（最多 5）。
- `directories: {path: GitPath, lines, commits}[]`（directoryPrefix 下一级目录，最多 50）、`directoriesTruncated`。
- `files: {path: GitPath, additions, deletions, commits}[]`（最多 20）、`filesTruncated`；按行数降序，平局按原始路径稳定排序。
- `authorDirectories: {author: SearchIdentity, cells: {directory: GitPath, lines}[]}[]`（最多 100 作者，行数前 5 个顶层目录）、`authorDirectoriesTruncated`。
- `kinds: {code, test, docs}`（行数）；`extensions: {extension, additions, deletions, filesChanged}[]`（最多 100）、`extensionsTruncated`。无扩展名为 `(none)`。
- `sessions: {startUnix, endUnix, count, authors, additions, deletions, directories: GitPath[]}[]`、`sessionsTruncated`；与活动时段相同时间规则，merge 的行数为零。

### getStatsExclusions / setStatsExclusions

- get 参数 `{}`；set 参数 `{patterns: string[]}`。均返回 `{section: "statsExclusions", result: {patterns, defaults}}`，保存只写应用数据目录，与 repositoryKey 绑定。
- 无 `/` 的规则精确匹配 basename；含 `/` 的规则匹配完整路径；尾部 `/` 匹配目录前缀；`hex:<原始路径 hex>` 精确匹配非 UTF-8 路径。不解析 glob。最多 100 项、每项 1024 字节，编码后 64 KiB；空数组表示不排除。
- defaults 含 pnpm-lock.yaml、Cargo.lock、package-lock.json、npm-shrinkwrap.json、yarn.lock、Gemfile.lock、poetry.lock、Pipfile.lock、uv.lock、composer.lock、go.sum、bun.lock、bun.lockb、Package.resolved。

### getNotableStats

请求 `{query, range, bucket}`，响应 `{section: "notableStats", stats}`：

- `coverage`；`churnFiles: {path, commits, authors, days: number[]}[]`、`churnFilesTruncated`。至少改动两次，days 与当前桶一一对应，值为 0/1。
- `pairs: {a: GitPath, b: GitPath, together, shareOfAPerMille}[]`、`pairsTruncated`；shareOfAPerMille 为整数千分比（草案 shareOfA 的替代）；`pairCommitsSkipped` 为超过 50 文件而未参与文件对的提交数。
- `soloDirectories: {path, author, lines, commits}[]`、`soloDirectoriesTruncated`：仅一位作者且行数大于零的顶层目录，按行数排序，不引入“维护质量”判断。
- `untested: {count, total, commits: {oid, summary, author, additions, deletions}[], commitsTruncated}`；total 是改过代码的非 merge 提交数，count 是其中没改测试的数量。
- 排除列表命中的文件不参与观察项。每类最多返回 50 项；只截断显示，计算必须完成。当前计算上限为 250000 个索引提交、2000000 条文件记录、500000 次文件对组合。

### getStatsCommits（新增：图表回查）

请求 `{query, range, selection, offset, limit}`（limit 1–200），响应 `{section: "statsCommitPage", page: {coverage, total, commits: {oid, summary}[], nextOffset: number | null}}`。按所选时间字段降序，OID 作稳定次序。

selection 为 `{kind: "file", pathHex}` / `{kind: "directory", pathHex}` / `{kind: "pair", aHex, bHex}` / `{kind: "untested"}`。对应的文件、目录、文件对或未改测试列表不依赖 UI 里截断的排名 / 示例提交。文件与目录回查保留排除文件（其行数为零）；pair / untested 依照观察项排除。

### estimateEvolution / analyzeEvolution

请求均为 `{commit, pathHex, range: {startUnix, endUnix} | null}`，commit 为完整 OID，pathHex 为空表示整棵树；非空为一个文件或目录。无 SearchQuery，按指定版本与字面路径分析。range 按 Author 时间筛选存活分子 / 分母，不影响当前年龄与归属。

- estimate 响应 `{section: "evolutionEstimate", estimate: {files, totalFiles, lines, bytes, fileLimit, skipped}}`。files / lines / bytes 是本次可分析文件的实际值；totalFiles 为路径下枚举条目数，不是仓库未知总量估算。fileLimit 当前为 200；最多枚举 10000 个条目。
- analyze 流式响应 `{section: "evolutionChunk", chunk: {progress: {filesDone, filesTotal, currentPath: GitPath | null}, result}}`。每完成一文件推送累积结果；仅最后一个消息 done=true。result 含：
  - `asOfUnix`（开始时系统时间）；`age: {within7d, within30d, within90d, within1y, older}`，按最后修改 Author 时间划分互斥档，365 天为一年。
  - `ownership: {author: SearchIdentity, lines, commits}[]`（去重归属提交数）。
  - `survival: {coverage, weeks: {startUnix, added, kept}[], byAuthor: {author, added, kept}[]}`。周按 UTC 周一，新增来自 P6-02 第一父文件记录且排除 merge；只计算目标 commit 的祖先。重命名会追踪旧路径；所选目录中已删除文件的新增仍纳入，跳过文件不纳入。coverage 描述索引分母，不与 blame 的 covered 混淆。
  - `covered: {files, lines}`、`skipped: {path: GitPath, reason}[]`、`complete`（本次枚举出的可分析文件是否全部完成；不代表 skipped 也有结果）。
- skipped.reason 为 `excluded` / `notRegularFile` / `byteLimit` / `lineLimit` / `binary` / `fileLimit`。沿用每文件 1 MiB / 20000 行限制；只跟随整文件重命名，不做跨文件复制追踪。
- 取消返回 `CANCELLED`，main / renderer 应保留已经收到的 chunk；完成文件已写入原有 blame-cache-v1。第二次分析同版本复用缓存。Git 错误保留已发送结果，不把失败文件算成完成。
- 存活展示 added / kept，不推断工作量；merge 解决产生的归属行可能使分子与排除 merge 的新增分母不完全对应，不能强行钳制成百分比。

### 与最初草案的差异汇总

- M5 移除 fetchFirst，switch / createBranch 补 OID 前提；增加 unsafeState、分叉 overlapPathsTruncated；navigation 暴露冻结 upstream 映射和 fetch 时间。
- M6 增加明确的 capability、section、截断字段与分支 complete；新增扩展名、累计净增长与提交回查；directoryPrefix / directory 都保留原始路径信息。
- shareOfA 改为 shareOfAPerMille；排除规则语法与持久化接口定稿；演化增加准确估计范围、asOfUnix、单独的 survival.coverage 以及累积结果结构。

M5 限制：重叠脏路径保守拒绝（即使某些相同内容 Git 可以接受）；当前分支快进有暂存改动时保守拒绝。执行后的 hook / I/O 失败是 GIT_ERROR，不能声称未写入。预检后任意外部 Git 进程仍可能竞态；其他分支 update-ref 使用旧 OID CAS，工作区操作依赖 Git 的最终锁与检查。

M5 写入通过应用数据目录内的 OS 文件锁跨 daemon / linked worktree 串行，崩溃自动释放；目前 Unix/macOS 支持，其他平台拒绝写入。系统配置读取沿用操作运行器，但没有改动本机系统配置做验证。
