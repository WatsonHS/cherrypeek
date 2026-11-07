# P1-04：分支与 worktree 导航代码级计划

日期：2026-11-07。状态：本机技术验收完成，见[验收记录](../validation/p1-04-scope-navigation.md)。前置 P1-03 / UI-03 已完成；本任务保留全部现有未提交改动，不自动提交或推送。

## 行为与边界

- 打开默认仍为 HEAD。可切换 HEAD（detached 时明确标记）、全部分支、本地分支、远端跟踪分支、标签及某个 worktree 的 HEAD。全部分支仅取 heads/remotes 可达集合，去重，不包含 stash、reflog、仅标签可达提交。
- `repository`、`repositoryKey`、`worktreeId` 始终代表本窗口打开的目录及对象库。选择别的 worktree 不调用打开目录，不 checkout，不更改窗口身份。浏览范围另存为 scope 与冻结 tips。
- 每次切换范围重新捕获引用/worktree快照，准备首个历史页后原子提交新会话。旧内容在准备期间可读；失败保留原范围，明确显示目标与错误。点击刷新沿用 scope 身份重新解析；目标引用/worktree删除、不可用或标签不是 commit 时返回明确错误，不退回 HEAD。
- 选择与滚动锚点按完整 OID 保留；新首屏中找不到时保留旧摘要及观察时间，并只提示“不在当前已加载窗口”，不能据此推断不在整个范围。禁止新旧范围拼页，取消、重试、迟到响应规则沿用 P1-03。
- 基准依次为有效 origin/HEAD 的目标、origin/main、origin/master、本地 main、本地 master。只比较快照中的 OID；`git merge-base --is-ancestor <分支 tip> <基准 tip>` 返回 0 才标“已合入”，1 不显示标签，其他错误为不可用。不可交换两个参数。浅克隆的正向证明可展示，不能把无法证明显示成否定结论。无基准不显示合入标签。
- 合入状态在打开选择器后按可见本地分支请求，每批最多 50 项，关闭/切仓/切范围可取消。禁止启动时遍历全部分支的祖先关系。
- 远端信息写明“本地引用快照”观察时间及“未 fetch”；不把 commit 日期或本次观察时间冒充 fetch 时间。没有可靠 fetch / 引用更新时间时显示未知。

命令语义依据 [Git worktree porcelain 文档](https://git-scm.com/docs/git-worktree)和 [merge-base 祖先判断文档](https://git-scm.com/docs/git-merge-base)。

## 冻结协议契约

继续 protocolVersion=1，新增 `repositoryScopes` capability 并由桌面声明依赖。Rust 是类型与 schema 单一来源。

`RepositoryScope` 使用兼容已有 `"head"` 的 serde 外部标记枚举：

```ts
type RepositoryScope = "head" | "allBranches" | { ref: string } | { worktree: string };
```

- `ref` 为完整引用名（仅 heads/remotes/tags），由 Rust 在捕获的引用清单中解析；不接收任意 rev 表达式。`worktree` 是导航清单返回的 opaque ID，由 Rust 解析，不接受 renderer 自行指定目录。
- `RepositorySessionInfo` 增加 `tips: string[]`，最多 2000 个唯一 OID，表示当前冻结范围；原 `repository.headOid/headReference` 保持本窗口 HEAD。原 head wire/storage 格式仍可读取；LastViewedSnapshot 上限同步提高，既有文件 1MiB/最多100条限制继续生效，超限降级而不静默截断 tips。
- `WorktreeInfo`：`id, path, headOid, headReference, isMain, isCurrent, isBare, isDetached, lockedReason, prunableReason, available`；nullable 字段必须显式返回 null。`id` 用对象库身份 + 规范化列出路径生成，不等同于窗口会话的 gitDir 身份 `worktreeId`。本窗口由 Rust 按路径匹配；不可用目录依然可列出事实，但不能切为活动范围。
- `RepositoryNavigation`：`refs: RefInfo[], refsTruncated: boolean, worktrees: WorktreeInfo[], worktreesTruncated: boolean, defaultBase: { name, oid } | null, observedAtUnixMs: number`。它来自当前会话冻结快照，不随弹层打开静默重查最新 refs。
- `RefMergeStatusResult`：`defaultBase: { name, oid } | null, statuses: { name, oid, status: "merged" | "notMerged" | "unavailable" }[]`。仅支持当前快照中本地分支；renderer 只给 merged 画标签，失败/未完成有独立重试提示。
- 新请求：`getRepositoryNavigation {}` 返回 `section: repositoryNavigation, navigation`；`selectRepositoryScope { scope, pageSize }` 的成功分块/提交顺序完全复用 refreshRepository；`refMergeStatus { refNames: string[] }` 返回 `section: refMergeStatus, result`。全部绑定 main 当前 session，renderer 不能提供 repoId/generation。
- 导航与合入状态均单个终态响应，`coverage.complete=true`；`processed` 分别为 `refs.length + worktrees.length` 与 `statuses.length`。超过单帧字节上限返回 `RESOURCE_LIMIT`，不能静默丢帧或标成部分成功。
- 新错误 `SCOPE_UNAVAILABLE` 区分不存在/不可用的范围。超限 `RESOURCE_LIMIT`；标签无法 peel 为 commit 给可理解错误，不能当作空历史。
- preload/shared API：`getRepositoryNavigation()`；`selectRepositoryScope(scope, pageSize?) -> RefreshedRepository`；`getRefMergeStatus(refNames)`；`cancelRefMergeStatus() -> {cancelled:boolean}`，全部沿用 RepositorySessionResult。取消方法只中断该类查询，不能意外关闭仓库。

## 核心实现单元

1. `core/src/lib.rs` 定义上述类型/capability/参数/响应并导出 schema。保留旧 preview 摘要接口；测试 schema 的严格字段和范围参数。
2. 新 `daemon/src/navigation.rs` 承担 worktree NUL porcelain 解析、默认基准选择、范围解析和按需祖先查询；复用 ReadOnlyGit，不添加 shell/hook/fetch。worktree 列表 128 条/有界输出，引用沿用 2000 条上限。分支/标签解析最终使用 commit OID，包含 annotated tag 递归 peel 的正确性。worktree 路径含空格/换行不截断，锁定、prunable、bare、unborn 单独表达。
3. `DiscoveredRepository` 保留本窗口事实，附带捕获的导航快照与范围 tips。在 open / refresh / scope prepare 阶段捕获，读取图指纹的现有检查继续有效；refs/worktree读取非原子时至少重验所选根及相关HEAD，有限重试/明确 SNAPSHOT_CHANGED，不能拼出互相矛盾的检出关系。
4. `history.rs` 遍历起点改为冻结 tips，多 tip 去重；空 tips 直接空页。新增标记正向旧 tips 证明和总新增计数改为集合范围，保持预算、缓存/游标隔离及缺对象降级。
5. `session.rs/server.rs` 复用 begin_open + worker prepare + 主循环 commit 事务；scope/refresh基于旧上下文校验窗口身份，候选先完成首屏再发布，新generation使用新历史缓存。取消后已提交的成功终态必须同步到 main，不得单纯丢弃导致两端分叉。
6. `session_store.rs` 按 repoKey + 本窗口worktreeId + 完整scope 保存/读取冻结tips。选择其他worktree不写它的工作区，亦不替换 recent 的窗口目录。保留 head 旧记录；多tip文件超限保持明确持久化降级。
7. refs/worktree截断时选择器标注不完整；全部分支在 refs 截断时明确失败，不能把部分根作为全部历史。缺失范围刷新继续保留旧快照供读。

## 桌面实现单元

1. `repository-session-controller.ts`、main/preload/shared接口：严格校验 scope/refs 数量和长度；复用原子 refresh 接收器，序列化 open/refresh/scope冲突；scope请求完成前禁止新页混入，取消并排空历史/关系查询。关系请求的迟到结果以 session+request 判旧，缓存有界并按generation清空。
2. renderer store 增加 scope切换和导航数据/状态，复用刷新选择与锚点保留逻辑。导航失败不清除历史；错误重试不暗中变更scope；核心断开清除活动请求状态但保留已读内容。
3. TopBar 范围弹层分组展示范围/worktree/本地/远端/标签，标出正在浏览、本窗口 HEAD、worktree检出、默认基准；保留 UI-03 拖动区与原生按钮避让。工作区入口显示本窗口身份、HEAD 与 worktree 数量。
4. 可见本地分支使用 IntersectionObserver 或等价明确可见集合分批请求合入状态，关闭弹层取消，错误可重试。导航清单有界，不扩大为提交索引。
5. CommitList / CommitDetail 的“HEAD 可达”等硬编码文案改为实际scope；本窗口HEAD标签与浏览分支标签不可混淆。按 Rust 导航事实标出其他worktree检出的提交。全部未完成占位仍保留任务编号。

## 分工与验证

- Rust代理负责 crates/core、crates/daemon（含对应 Rust测试）及一次协议生成产物；先落冻结类型并生成，再实现daemon。
- 桌面代理负责 apps/desktop、packages/protocol手写桥接类型、tests/protocol、tests/renderer及必要runner。不编辑 Rust/schema/generated 文件。
- 验证代理负责 tests/navigation（新）、对应脚本、Electron scope smoke、README命令/package脚本的小范围登记；等契约生成后开始集成。文档由主代理维护。
- 所有代理共享目录，保留现有 P1-03/UI-03 和其他代理修改，禁止reset/覆盖。只运行自己影响的检查，构建与实窗由主代理协调，性能不在本项重复测量。
- 验证：独立 Git 对照 HEAD/多分支/远端/annotated tag/worktree/detached 的完整分页及去重；不含仅tag/stash历史；各scope上次查看隔离；本窗口身份稳定；基准顺序与祖先参数方向；引用删除/非commit标签/不可用worktree；取消、迟到成功与范围切换竞态；原始仓库index/HEAD/refs/worktree快照前后不变。包含 SHA256、特殊路径以及真实Electron选择器切换/刷新/错误恢复。
- 完成后更新 PLAN/PRODUCT/ARCHITECTURE/README 和专属验收记录。未经运行不得将检查或整个 P1-04 标为已完成。
