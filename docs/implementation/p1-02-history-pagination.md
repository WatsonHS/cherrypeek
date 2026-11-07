# P1-02：固定快照历史分页与手动刷新

日期：2026-11-07。状态：已完成本机技术验收，见[验收记录](../validation/p1-02-history-pagination.md)与[分页基线](../benchmarks/p1-02-history-pagination.md)。基于 `3113902`（UI-02 会话接入）推进；主代理定义契约与验收，小模型实现。保留现有视觉设计，本项接通分页与刷新，不提前完成 P1-03 虚拟列表、P1-04 多范围导航或 P2-01 Rust 图布局。

## 行为与范围

- 仍仅支持当前 worktree 的 `head` 范围。打开捕获完整 HEAD OID，所有页均从此 OID 遍历，不重新解释移动中的 HEAD。空仓库是一页空结果。
- 一次 `git rev-list --topo-order <captured OID> --` 持续输出 OID，按需读取并施加背压；每页复用已有 cat-file 批量解码。连续下一页不执行 `--skip=N`，不保留全库 OID / commit 数组。
- 顺序定义为同一 Git 版本、冻结 tip 与相同历史边界下的 Git topo 顺序，保留原始父顺序，不在 renderer 按时间重新排序。Git 的 topo 顺序不同于时间顺序，依据[官方顺序说明](https://git-scm.com/docs/rev-list-options)。history 命令显式禁用 commitGraph 加速，避免外部重写该文件改变重算路径。
- shallow 文件会改变遍历的根，见[Git shallow 说明](https://git-scm.com/docs/shallow)。发现时记录 commonDir 下 shallow / info/grafts 的有界内容指纹，历史读取前后复核；边界变化返回 `SNAPSHOT_CHANGED`，保留已显示内容并要求刷新，不拼接另一套历史。replace refs 继续禁用。普通提交、分支移动不触发此错误。
- 本项 UI 使用当前一页（默认 200、最大 500），上一页 / 下一页替换页面；虚拟滚动和自动预取留到 P1-03。不能把本页计数称作仓库总数；临时前端分支图只表示本页，跨页布局仍待 P2-01。

## 所有权

| 实现代理 | 文件 / 职责 |
| --- | --- |
| Rust | `crates/core` 协议、生成 schema / TS；daemon 的 `git_command.rs`、`repository.rs`、新增 `history.rs`、`session.rs`、`server.rs`、`main.rs`；必要 Rust 测试 |
| 桌面 | main controller / transport / IPC、preload、共享业务类型；renderer session store、现有 App / TopBar / CommitList 的最小接线、错误文案；protocol / renderer 测试、对应脚本、smoke 对新接口与分页行为的断言 |
| 独立验证 | `tests/history/**`、`scripts/test-history.mjs`、`scripts/benchmark-history.mjs`；package.json 对应 scripts；测试及性能产物（只写新 output 路径） |
| 主代理 | 本计划与架构 / 产品 / README / PLAN 同步、审查、验收记录、性能结论 |

共享目录，所有代理保留其他人的改动，不覆盖文件的新版本。接口变动先协调；不提交、不改视觉 token、样式或无关示例区域。

## Wire 契约

协议版本仍为 1，新增 capability `historyPagination`，保留既有方法和 section。以下两方法均要求当前 repoId / generation；envelope 始终回显请求上下文。

| 方法 | params | 响应 |
| --- | --- | --- |
| `readHistoryPage` | `{cursor: string|null, pageSize: number}`；pageSize 为 1–500 的整数 | `repository` 头 + 一个或多个 `historyPage` 块 |
| `refreshRepository` | `{pageSize: number}`；1–500 | `repositorySession` 头（新 session）+ `repository` 头 + `historyPage` 块 |

`historyPage` section 字段：`commits:CommitSummary[]`、`offset:u32`、`pageSize:u16`、`cursor:string`、`previousCursor:string|null`、`hasMore:bool`。所有块重复相同页元数据；`nextCursor` 仅在终块 envelope 给出（没有下一页为 null）。非终块 `done/coverage.complete=false`；终块二者为 true，`coverage.processed` 为本页累计提交数。完整仅指该页，不代表全部历史；`hasMore` 必须与终块 nextCursor 一致。

第一页请求 cursor=null；返回的 cursor 是该页可重试句柄，第一页也有。默认调用 pageSize=200。新错误码：`INVALID_CURSOR`（语法、页大小、query 绑定不符、未到达的位置），`SNAPSHOT_CHANGED`（shallow / grafts 边界不再匹配）。已关闭 / 旧 generation 的请求仍为 `STALE_CONTEXT`；对象缺失保留 `MISSING_OBJECT`；资源、取消、超时复用现有码。

## 遍历、缓存和游标

- 每个 RepositorySession 持有一个 HistoryState，里面只有一个活动 query / 一个 rev-list stream。query 绑定固定 head、pageSize、排序版本与随机 query ID。cursor 有版本、query ID 和页起点；严格长度 / 格式 / 数值 / 页对齐校验，页起点不可超过已经发出的连续 frontier。不接受用户 revision 表达式。
- cursor=null 重读同 query 的第一页；改变 pageSize 时创建新 query 并使旧 query 游标失效。缓存淘汰不使当前 query 的合法游标失效：从冻结 HEAD 重放 OID 到目标位置，再读取该页。重放仅用于旧页未命中、取消后恢复等场景，必须可取消并单列成本。
- 页缓存最多 8 页，估算提交载荷最多 16 MiB；不缓存超限单页。明确这个限额不是整个进程 RSS，Git 内部遍历与临时对象缓冲单独统计。保留至多一条 lookahead OID 判断 hasMore，不把全部历史物化。
- 一次 query 同时只执行一个页请求（try-lock / 明确 BUSY，不无界排队）；锁覆盖构造及分块输出，避免取消旧页输出时误杀下一请求的遍历。main/renderer 对快速翻页取消旧请求并等待终态，再发新页。
- 已完成页缓存可用于幂等重试。取消、超时、解析或对象读取失败时终止当前 stream、kill/wait 并回收管道线程；保留已完成页和 query 身份，下一次同 cursor 可重放恢复。取消后的部分块不能发布成页面。
- 安全命令构造提取为共享函数，stream 与现有 run 使用同样的 argv / 环境隔离。stdout 使用有界队列和有界行缓冲；stderr 保持上限并持续排空。Drop 的顺序必须先停进程和断开队列，再 join，不能在满队列上死锁。EOF 需检查退出码，非零退出不得假装正常末页。
- 保留固定数量的 stream reader 线程；会话关闭 / 替换 / daemon EOF 回收闲置 stream。stream 的 idle 生命周期不绑定上一页请求的 cancel flag。不得持有 SessionManager / 请求表锁等待 Git 或输出背压。

## 刷新提交

刷新是受控会话变更，复用最新 open intent 的顺序和取消规则：以当前已发现路径重新发现，核对仍是原对象库 / worktree，准备新 HistoryState 和完整第一页，全部成功后才发布新 session（新 repoId / generation）。候选失败或提交前取消保留旧 session、游标与页面；旧历史查询在成功发布时才取消。recent / previousView 规则沿用 P1-01，刷新不自动标已读。

提交后分块返回新 session 与第一页；迟到 cancel 不把已提交成功改报失败。使用有界、可检测连接失败的输出机制，不能在普通 500 行页面超过队列长度时静默丢帧或关闭健康连接。core 与 main 均须同步已提交终态。刷新准备阶段按 15 秒预算，main 请求 20 秒；变更结果超时仍使连接失败并回收核心。

## 桌面与界面

共享类型增加 `HistoryPage`（repository / refs / refsTruncated、commits 与上述页元数据、nextCursor），`RefreshedRepository {session,page}`。新增 preload 方法：`readHistoryPage(cursor: string|null, pageSize?:number)`、`cancelHistoryRead()`、`refreshRepositorySession(pageSize?:number)`；沿用 `RepositorySessionResult<T>`。main 持有实际上下文，不接收 renderer 任意 repoId。

controller 对页请求拥有 AbortController，只取消本次 history read，不关闭仓库。transport 增加仅供历史查询使用的 cancel-and-drain：取消后等核心终态再释放槽位，丢弃取消页的载荷；若排空超时则关闭连接，避免泄漏未知任务。刷新沿用 mutation 的终态排空和超时规则，并在完整 session + page 验证后切换 gate。旧 session preview 仍可调用，legacy daemon preview 保留给基准。

renderer 首屏改读 history page；只保存一页和必要选择状态。翻页期间保留旧页，显示加载 / 取消；失败显示可重试错误，重试相同 cursor。请求按 operation 与 session 判旧，跨代结果不得拼接。刷新先记录当前真正显示过的 tips，再请求刷新；候选成功后一次发布新 session 和第一页，失败仍显示旧页。

`recordRepositoryView` 的窄 API 增加 expected generation（仅用于核验，不能选择另一个会话），renderer 传当前显示 session.generation，main 不匹配即返回 STALE_CONTEXT；防止刷新 / 切仓成功但旧 UI 尚显示时，把新快照误标为已读。记录请求与核心仍绑定 main 已持有的当前 context。

保留现有 TopBar 样式，接通单独手动刷新按钮；自动更新通知仍是 P3-03 占位。列表底部加上一页 / 下一页和已加载位置，不宣称总数。换页是显式导航；刷新按 OID 保留选择和列表顶部 OID + 行内偏移。选择 / 锚点不在新页时明确提示“当前页未载入”，不误称已删除或静默选另一条；最多保留一个旧 CommitSummary 供详情并标明旧观察状态。不同仓库打开仍可选新第一页首条。

页尾刷新可能因页大小固定而没有足够滚动距离：只补恢复锚点所需的临时尾部空白，上限为一个可视区高度，显式翻页或新请求时清除。空白不计作提交、统计或额外缓存。刷新重试与刷新按钮共用锚点捕获路径，旧恢复帧在视图切换时取消。

## 验证

1. 小 fixture 按不同 pageSize 完整遍历，对照独立 Git topo 序列；相同时间、merge / octopus、空、detached、bare、linked、shallow、SHA-256。游标重读、缓存淘汰重放无重复遗漏；有界缓存通过 wrapper 观察重放而不是暴露产品调试接口。
2. 外部推进 / 改写 HEAD 后继续旧 cursor；手动刷新原子切到新 tip，旧 cursor/context 被拒绝，失败刷新保留旧 session。shallow/grafts 改变时不混入新边界。
3. 恶意 cursor / 超限 pageSize、取消 rev-list / cat-file / 分块输出、重试同 cursor、close与切仓的闲置/活动stream回收、EOF / 非零退出 / missing object、不触发网络 / hooks、仓库目录前后只读快照。
4. renderer 翻页 / 刷新 / 取消 / 失败保留、迟到响应、record expected-generation、选择与锚点；协议 Node 26 / Electron Node 24、Rust fmt/test/clippy、schema / typecheck。构建并运行真实 UI smoke 验证下一页、上一页、刷新，保留设计和占位标识。
5. 10 万提交实测真实 daemon API：连续走至 10k / 50k / 90k，各目标页耗时、同游标缓存命中、淘汰后重读、到达深页总耗时；至少 3 次完整遍历（功能正确性优先，样本数透明），测量单独串行运行，整个 daemon + Git 进程树 CPU / RSS 和原始采样落新文件。不得用手工 offset 绕过游标，把重读当首次连续页；不将这项测量称作发布性能验收。
6. 更新 PLAN、README、架构、`docs/validation/p1-02-history-pagination.md` 与基线记录；未验证范围明示，P1-03 / P1-04 仍不勾选。
