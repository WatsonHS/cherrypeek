# P2-02：提交详情与文件列表代码级计划

日期：2026-11-08。状态：实现与自动验证完成；实窗仅完成部分检查，按用户要求停止补跑，详见[验证记录](../validation/p2-02-commit-details.md)。基线 `1160146`（已提交 P2-01）。由主代理制定契约与验收，轻量模型代理实现；沿用 Claude 界面与无系统标题栏窗口。

## 交付行为与边界

选中历史或搜索中的提交后读取完整消息、双身份 / 时间、原始父列表、固定快照引用与 worktree；拆出的 trailer 在“附加信息”展示，正文不重复它。概览显示按默认第一父比较的改动数量、增删与一级目录分布；根提交按空树语义。文件改动页可切换原始父提交、查看有界文件页。merge 概览按非第一父分组展示带入提交及按原始 Author 姓名 / 邮箱汇总的作者分布，组可分页。包含分支只在点击后计算。

新增查询不依赖索引完成，不改变历史 / 搜索结果；Git 不 checkout、不 fetch、不写对象或仓库缓存。文件 diff、LFS 内容探测、图形定位、完整外部更新通知仍留 P2-03 / P2-04 / P3-03，相关占位保留明确任务号。

详情选中与窗口重新聚焦时可复核当前浏览 scope 的最新 tips。只有原快照包含该提交且最新范围明确不再包含它，或所看的引用 / worktree 已不可用，才提示受更新影响并注明旧内容的观察时间。快进后仍可达、无关分支更新不提示；浅边界、对象缺失、超时等无法证明时返回 unknown。此复核不更换 generation、不合并新引用标签，不建立 watcher / 定时扫描；允许显式重试。

## 协议合同

继续协议 v1，新增 capability `commitDetails`。四个方法均要求当前 repoId / generation，OID 必须是当前对象格式的完整十六进制；不接受 rev 表达式、路径或任意 Git 参数。desktop main 持有上下文，renderer 不指定会话。全部返回一个完整终态，sequence=0、coverage.complete=true 仅指本次请求完整；文件 / merge 是否还有页由结果字段表达。单个序列化 data 目标上限 512 KiB，硬帧 1 MiB；超限明确 RESOURCE_LIMIT，不返回伪完整或静默截断。

1. `getCommit { oid }` → section `commitDetails`, 字段 `details: CommitDetails`。
2. `listChangedFiles { oid, parentIndex: number | null, offset, pageSize }` → section `changedFiles`, 字段 `page: ChangedFilesPage`。
3. `readMergeCommits { oid, parentIndex, offset, pageSize }` → section `mergeCommits`, 字段 `page: MergeCommitsPage`。
4. `branchesContaining { oid }` → section `branchesContaining`, 字段 `result: BranchesContainingResult`。

页大小默认由 main 传 200，允许 1..200；offset 为非负整数且不大于本次有界集合。parentIndex 从 0 起：普通提交 / merge 文件页默认 0，根提交只能 null；merge 带入组只能 1..parents.length-1。结果回传请求键，main 校验 OID / 父序号 / 分页、数量、类型和总数一致性。页仅替换当前页，不无限追加。

```ts
type Trailer = { key: string; value: string };
type CommitUpdate = {
  state: "unaffected" | "affected" | "unknown";
  reason: "scopeUnavailable" | "noLongerReachable" | null;
  checkedAtUnixMs: number;
};
type CommitDetails = {
  commit: CommitSummary; // 原始有序 parents，双身份、双时间、textLossy
  message: string; // 完整解码消息，沿用已有 UTF-8 lossy 标记
  messageWithoutTrailers: string; // 保留标题和正文，仅去除 Git 确认的末尾 trailer 区
  trailers: Trailer[]; // 保留顺序、重复项与 unfold 后的值
  refs: RefInfo[]; worktrees: WorktreeInfo[]; // 只含直接指向此 OID 的捕获关系
  observedAtUnixMs: number; refsTruncated: boolean; worktreesTruncated: boolean;
  update: CommitUpdate;
};
type GitPath = { display: string; rawHex: string; textLossy: boolean };
type ChangedFile = {
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "typeChanged";
  oldPath: GitPath | null; newPath: GitPath | null;
  oldOid: string | null; newOid: string | null;
  oldMode: string; newMode: string; // Git 六位 mode，缺失侧 000000
  similarity: number | null; // 0..100，rename/copy
  additions: number | null; deletions: number | null;
  binary: boolean; gitlink: boolean;
};
type ChangeCounts = { added: number; modified: number; deleted: number; renamed: number; copied: number; typeChanged: number };
type ChangeOverview = {
  totalFiles: number; counts: ChangeCounts; additions: number; deletions: number;
  binaryFiles: number; gitlinkFiles: number;
  directories: Array<{ path: GitPath | null; totalFiles: number; additions: number; deletions: number }>;
};
type ChangedFilesPage = {
  oid: string; parentIndex: number | null; parentOid: string | null;
  offset: number; pageSize: number; totalFiles: number; hasMore: boolean;
  files: ChangedFile[]; overview: ChangeOverview;
};
type MergeCommitsPage = {
  oid: string; parentIndex: number; parentOid: string; firstParentOid: string;
  offset: number; pageSize: number; totalCommits: number; hasMore: boolean;
  commits: CommitSummary[];
  authors: Array<{ name: string; email: string; count: number }>;
};
type BranchesContainingResult = {
  oid: string; branches: RefInfo[]; observedAtUnixMs: number;
  complete: boolean; refsTruncated: boolean; boundaryLimited: boolean;
};
```

`GitPath.rawHex` 保留字节身份，不能用 lossy display 当键或后续 Git 输入；控制字符在 UI 转义展示。目录汇总按路径第一段，根目录为 null，rename 归目标目录、delete 归源目录，每文件只计一次。行数沿用 Git numstat；binary 的 additions / deletions 为 null，汇总排除未知数，并单列 binary / gitlink 数量。gitlink 显示旧新对象引用，不读取子模块工作区。

详情和包含分支的 `observedAtUnixMs` 使用会话捕获时间，因为它们携带冻结的引用关系；仅 `update.checkedAtUnixMs` 表示本次实时复核时间。不能用查询返回时间把旧引用标成最新观察。

## Rust 实现与只读约束

新增 `crates/daemon/src/details.rs`，复用 `read_commit_metadata` / `read_commit_summaries`、ReadOnlyGit、Session 与冻结导航。新增 core 类型 / request params / response variants / capability，补 server 的方法识别、上下文要求、worker 与取消注册；协议生成物只由核心代理生成。

- `getCommit` 读取单对象（沿用 1 MiB object 上限），不等待文件统计或祖先遍历。原始消息保留，trailer 解析与隔离配置的 `git interpret-trailers --parse --no-divider` 一致。parser 不读当前仓库的 trailer 配置，不执行 trailer command/cmd；使用禁仓库配置的 Git 调用（例如 null git-dir，平台相应空设备）并保持系统 / 全局配置隔离。正文拆分必须有 Git 解析证据，不用正则删除中间形似 trailer 的行；无法识别分割边界不得静默删正文。对应[官方 trailer 文档](https://git-scm.com/docs/git-interpret-trailers)。
- `listChangedFiles` 用两个明确 tree-ish 做普通 / merge 比较；根用 `diff-tree --root`，不硬编码 SHA-1 空树、不写空树对象。使用 `--raw --numstat -z -r --no-commit-id --no-ext-diff --no-textconv --ignore-submodules=none`，明确 `--find-renames=50%`、有界 rename limit 与 diff 算法 / 配置，按 NUL 解析两条 rename 路径与 stats。使用 Git 全局选项 `git --attr-source=<commitOid> diff-tree ...` 固定被比较提交的 tracked attributes，禁止用户全局 attributes / external diff / textconv / filter 执行。不支持所需 Git 参数时明确错误，不悄悄换语义。对应[官方 diff-tree 文档](https://git-scm.com/docs/git-diff-tree)。
- 文件扫描上限 20000 个变化、16 MiB stdout、单路径 16 KiB，完整扫描后按 offset/pageSize 投影当前页并给精确 overview；超限 / 失败保留基础详情，局部展示错误。第一版每页可重新读取同一不可变 tree 对，不引入持久列表缓存，不能宣称常数时间翻页。
- `readMergeCommits` 使用 `rev-list --topo-order <parentN> --not <firstParent>`，按每个非第一父独立分组；共享祖先可在不同组出现，不把组数相加当去重总数。限 10000 个带入提交 / 1000 个作者 / 16 MiB 临时元数据，分批 decode，返回当前页与该组全量作者分布；超限明确错误。验证缺失父与浅克隆 / grafts，不能把不完整祖先遍历称作全量，必要时明确 UnsupportedRepository / MissingObject。新方法不借用主历史 Query / 图检查点，避免负 tip 差集破坏主列表 frontier；复用取消、读取和解码 helper。
- `branchesContaining` 只遍历冻结的本地 / 远端 refs，按冻结 tip 的祖先关系判断，不重新解释移动中的 ref 名。最多 2000 refs；去重 tip 后使用单次 `rev-list --ancestry-path=<oid> <tips...> --not <oid>` 流，把命中的 tip 还原成引用；等于所选 OID 的 tip 直接命中。只持有有界 tip 集合，不物化祖先矩阵，遍历输出限 16 MiB。只有全部 tip 已证实命中或正常 EOF 才可结束完整判断；浅 / grafts 的否定不可确证，complete=false，refs 被截断也明确不完整。UI 不能把部分结果显示成确定的“没有包含分支”。
- 可达计算前后验证 shallow / grafts 指纹。引用移动不使固定结果变动，缺失对象明确报错。更新提示另用窄的当前 scope tips 查询，不改 session；复核预算约 1 秒，失败返回 unknown，显式取消必须继续传播。只比较 captured scope 与 live 同范围，确认旧范围包含所选 OID 后再给受影响结论；AllBranches 不逐个启动数千个进程。
- 普通请求 Git deadline 15 秒 / desktop 20 秒，沿用全局两个交互请求限制；循环 / batch 间检查取消，失败不发布成功终态。不开新的后台线程池或缓存框架。

## 桌面状态与展示

main / preload 新增四个窄 API 和独立 `cancelCommitDetails` 取消域。详情请求不得使用 cancelSearch/cancelHistory；会话变更取消详情并排空，当前视图按 repoId + generation + OID + 父序号 + 页 offset + 请求意图判旧。主进程校验 capability、参数、响应 section/键/数量与 byte path，不接受任意路径或通用 RPC。

新增 `commit-detail-store.ts` 管理有界详情状态，基础、文件、merge、包含分支分别有 idle/loading/ready/error 与重试。一个选中 OID 的自动查询按基本详情→文件概览→默认非第一父 merge 页执行，branchesContaining 只响应点击；通过有界串行详情通道避免与历史 / 搜索争抢超过两个全局并发。快速切换选中项 / 父 / 组 / 页清理过期的对应任务，不让已取消结果覆盖新内容；显式用户动作优先于自动附加查询，不无限排队。

历史 / 搜索主列表保留上限改为 1800 条，给当前 merge 页预留 200 条摘要，合计仍不超过原 2000 条摘要预算（外加既有至多一条旧选择摘要）；不用新名字掩盖额外缓存。父列表沿用 OID 与已加载摘要 / 冻结引用，不另缓存最多 128 个完整父摘要。文件页最多 200 行，详情仅保留一个 OID 的完整消息和一页文件 / merge；引用 / worktree 显式有界。

CommitDetail 接入新 store，保留标题、身份、两 tabs、复制、上一 / 下一和当前设计。正文与 trailer 作为文本显示，不解释 HTML。overview 与文件 tab 使用同一当前对比父并显示基准，初始为第一父，文件 tab 改父后统计同步变化；文件行显示状态、rename 双路径、mode / gitlink / binary 说明和真实 numstat。文件 diff 区仍明确“占位 · P2-03”，不以文件数据冒充 patch。merge 组选择显示父序号 / 短 OID / 捕获分支标签，作者分布说明当前组，分页替换当前页。

焦点回到窗口或显式重试可调用 getCommit 复核受影响提示；该操作不刷新文件页 / 主历史，不自动重新启动全部查询。范围刷新后旧选择若保留，已读旧详情保留并显示其旧观察时间，不将旧 refs/文件页归入新 generation；重新载入必须明确当前上下文。窗口外父提交仍不承诺定位（P2-04）。

## 文件责任与验收

- 主代理：本计划、契约审查、必要架构修订、最终 release 构建、串行实窗验证协调、验收文档。不得自行提前勾选。
- 核心代理：crates/core、crates/daemon、生成的 protocol schema/TS、Rust 测试。先落冻结类型并生成，通知桌面 / 验证代理，再实现查询。
- 桌面代理：apps/desktop/src、packages/protocol 的手写桥接、tests/protocol、tests/renderer、scripts/test-renderer；状态竞态 / IPC 校验、当前详情接入、1800+200 摘要预算及受影响断言。
- 验证代理：tests/details、scripts/test-details.mjs、tests/smoke/commit-details-smoke.mjs、package scripts；独立 Git fixture / oracle，不复制生产解析器。Electron 只在 root 明确安排且 release 就绪后运行。

所有代理不是独占代码库，保留他人编辑，不提交 / 推送；发现契约缺口先报告，协议字段不自行分叉。

验证：Rust 单元 / 受影响集成、双运行时 Node 协议、renderer 状态；真实 Git 对照 root / merge / octopus、消息 / 重复折叠 trailer / 正文中间伪 trailer、双身份、SHA-256、rename / delete / Unicode / 换行 / 非 UTF-8 / gitlink / typechange / binary、作者分布、offset 分页、scope / frozen refs / 更新提示、浅边界 / 缺失对象 / 上限 / 取消 / 旧结果与外部执行哨兵，仓库前后只读快照。实际 Electron 验证选择、全文 / trailer、概览、切父文件页、merge 分组分页、按需包含分支、快速选择、搜索结果详情、深浅色、只读及退出回收。新增 1800+200 总摘要预算通过状态与实窗验证；不无故重跑十万提交性能矩阵，不将未测详情延迟写为达标。
