# P1-06：元数据搜索代码级计划

计划日期：2026-11-07。状态：2026-11-08 已实现并通过本机验收，证据见[验收记录](../validation/p1-06-metadata-search.md)。实现基线为 `05a2f7c`（P1-05）。

## 交付边界

接入现有消息输入框、筛选入口与详情区，提供完整消息、OID、Author、Committer、日期和当前分支 / worktree 范围内的组合搜索。结果使用独立的时间排序列表，不画过滤后的父子连线。保留历史模式、Claude 视觉与无边框外壳。路径筛选仍标注 P3-01；完整详情 / 图中定位仍属 P2，不把搜索当作完整 MVP。

搜索直接扫描 P1-05 已事务提交的快照成员及完整元数据，后台索引逐步补齐范围。部分索引和完整索引使用同一个 Rust 谓词，不增加另一套 Git 搜索器、FTS、持久结果库或通用调度框架。暂停 / 取消索引时可以搜索已有覆盖；进度停止时明确提示继续索引，不能显示最终空结果。缓存不可用时搜索明确报告，历史保持可用。

## 冻结搜索语义

- 2026-11-07 用户通过提问工具确认：默认不区分大小写，可显式打开“区分消息大小写”。使用锁定的 `caseless = 0.2.2` 的 Unicode default full case folding，再做字面子串匹配；敏感模式直接 `str::contains`。依据[官方 API](https://docs.rs/caseless/0.2.2/caseless/fn.default_case_fold_str.html)及[实现](https://docs.rs/caseless/0.2.2/src/caseless/lib.rs.html)。不额外做 Unicode 规范化、去重音或 locale 定制；`Straße` / `STRASSE`、Greek sigma、Turkish I 和组合字符分别测试，不能用 SQLite 默认 NOCASE / lower 替代。
- 消息只匹配完整提交消息（标题与正文）；不按空格拆词，不解释正则、SQL、Git revision，不自动把看似 hash 的消息转成 OID。空字符串表示不限制消息；非空空白仍是字面内容。请求消息最多 4096 UTF-8 字节。
- 身份是原始 `{name,email}` 的精确二元组，不应用 mailmap；Author 与 Committer 分开。字段间 AND，同一身份数组内 OR，空数组不限制。每个字段最多 50 个身份；单个 name / email 最多 4096 UTF-8 字节。大小写开关只影响消息，不改变所选身份的精确相等语义。
- `oidPrefix` 为空表示不限制；否则必须为 4 至当前对象格式长度的十六进制，规范为小写后匹配完整 OID 前缀。歧义显示候选，不擅自选择首项。只有完整覆盖后才可称唯一或无匹配；部分覆盖仍可能发现更多候选。
- 默认 `timeField=committer`，可选 author，排序与日期条件同时使用这个字段。按 Unix 整数秒降序、完整 OID ASCII 升序稳定排序；不得按字符串时间排序或拓扑日期提前终止遍历。
- 时间范围是 `[fromTimestamp,toTimestamp)`；null 表示无该端边界。UI 提供今天、最近 7 天、最近 30 天和自定义起止日（包含两天）。用设备本地日历的开始日零点、结束日下一天零点转换，不能直接加固定 86400 秒；保存 IANA `timeZone` 供查询身份与显示。两端必须为安全整数且 from < to，timezone 最多 128 字节。跨 DST 与原始提交 offset 不同的例子单独验证。
- 分支条件复用当前范围选择器，沿用 session 冻结 tips；切范围不 checkout，活跃搜索条件在成功切范围 / 刷新后应用到新 session。条件改变不刷新仓库快照。
- 无消息且无身份 / OID / 日期条件，默认 timeField 时回到历史；仅大小写开关不激活搜索。选择 author 时间允许查看按作者时间排序的整个范围。清空搜索恢复历史选择与视口，不偷偷改变 scope。

## 冻结跨层接口

protocolVersion 仍为 1，新增 capability `metadataSearch`。Rust 为字段与响应的唯一生成源；手写 TypeScript 只组合生成类型。

```ts
type SearchIdentity = { name: string; email: string };
type SearchTimeField = "author" | "committer";
type SearchQuery = {
  message: string;
  caseSensitive: boolean;
  authors: SearchIdentity[];
  committers: SearchIdentity[];
  oidPrefix: string;
  timeField: SearchTimeField;
  fromTimestamp: number | null;
  toTimestamp: number | null;
  timeZone: string;
};
type SearchCommitsParams = {
  query: SearchQuery;
  cursor: string | null;
  anchorOid: string | null;
  pageSize: number; // 默认 200，1..500
};
type SearchPage = {
  queryKey: string;
  snapshotKey: string;
  resultVersion: string;
  commits: CommitSummary[];
  pageOffset: number;
  previousCursor: string | null;
  nextCursor: string | null;
  matchedCount: number; // 当前结果版本内的命中数，partial 时不是范围最终总数
  coverage: { processed: number; complete: boolean };
  anchorFound: boolean | null; // 未请求锚点为 null
  index: MetadataIndexStatus; // 当前索引状态，与冻结页版本的 coverage 分开
};
type SearchIdentitiesParams = {
  field: "author" | "committer";
  text: string; // <= 1024 UTF-8 字节；建议项检索一律 default case fold
  limit: number; // 默认 50，1..100
};
type SearchIdentities = {
  field: "author" | "committer";
  identities: SearchIdentity[];
  truncated: boolean;
  coverage: { processed: number; complete: boolean };
  index: MetadataIndexStatus;
};
```

- daemon 方法为 `searchCommits` 和 `listSearchIdentities`，都绑定当前 repoId / generation，分别返回 `section:"searchPage"` / `section:"searchIdentities"`。响应 envelope 的 coverage 表示本页响应完成（processed 为本页条数），内部 coverage 表示被搜索的索引前缀。
- searchPage 沿用有界分块：sequence 从 0 开始连续递增，身份建议的单帧同样从 0 开始；帧目标 512 KiB、硬上限不变；各块 queryKey / resultVersion / 页边界 / matchedCount / 内部 coverage 一致，main 合并后最多 pageSize 条。`data.page.previousCursor` 和 `data.page.nextCursor` 属于页元数据，每一块均保持相同值。envelope 的 processed 累计已发条数，complete=done；只有终态的 **envelope.nextCursor** 携带游标（等于 page.nextCursor），非终态 envelope.nextCursor 为 null。不发送完整消息或全量命中数组。身份建议限制返回条数；超出帧预算明确报 RESOURCE_LIMIT。
- preload 暴露 `searchCommits(params)`、`listSearchIdentities(params)`、`cancelSearch()`；取消方法只取消并排空本次 main 持有的搜索 / 建议请求，复用协议 cancel，不增加 daemon 常驻搜索任务。参数不允许携带 repoId、generation、SQL、路径或任意方法名。
- 错误复用 INVALID_REQUEST / INVALID_CURSOR / STALE_CONTEXT / SNAPSHOT_CHANGED / BUSY / CANCELLED 及 INDEX_*。索引尚在 queued / 初始化且无库时返回空的 partial 页；索引故障时可以查询仍然可信的持久前缀，并把原因放在 index.error。损坏 / 不兼容 / 被替换的缓存不得重新信任，返回 INDEX_*，界面保留旧结果及错误提示。

## Rust 查询与版本

1. 在 `metadata_index.rs` 提供窄的只读快照读取入口，复用路径 / 类型 / 硬链接和文件身份校验；搜索不能调用会创建或配置写连接的 `IndexStore::open`。只读连接在 worker 创建，设置 query_only、trusted_schema=OFF、有界 SQLite cache 与短 busy timeout，不做每次全库 quick_check，不加载扩展。
2. 一次只读事务捕获 `snapshots.processed/complete`，只读取 `snapshot_commits.ordinal < watermark` 对应成员。按 ordinal 的索引顺序逐行读取，再由 Rust 统一匹配；索引中存在但不在当前快照的提交不能命中。仅对有界候选保留摘要，完整 message 用完即释放。
3. 以有界有序容器 / heap（最多 pageSize 条）选取当前窗口。不能为了深页保存全部 OID、全部 metadata 或 `offset+pageSize` 条；不要用无界 SQL ORDER BY 临时结果规避显式内存边界。统计当前前缀的匹配数与窗口 rank，采用 keyset 边界前 / 后分页；每次请求可能重扫前缀，作为本阶段明确的性能限制，不声称已达到发布搜索延迟预算。
4. queryKey 由规范化条件（身份集合排序去重、OID 小写、时间字段 / 边界 / timezone / case 开关）与当前 session 派生。resultVersion 包含 snapshotKey、queryKey、缓存文件身份、重建 epoch、watermark、complete。显式重建前递增 epoch，查询前后复核，避免文件 inode 被复用后接受旧游标；普通索引追加不改变旧前缀结果。
5. 游标为有界、不透明、版本化编码，最多 1024 字节，绑定以上字段、pageSize、方向及边界 `{timestamp,oid}`；严格验证长度 / schema / 范围与边界属于该查询前缀。不能信任调用者声明的 complete：只有 DB 当前 complete 且 watermark 等于当前 processed 才可接受完整版本。旧 partial watermark <= 当前 processed 时可稳定分页；缓存重建、成员淘汰、watermark 回退、查询 / session 改变时拒绝旧游标。
6. `cursor=null` 读取最新前缀。`anchorOid`（与 cursor 互斥）匹配时返回从该 OID 开始的窗口及其新 rank；找不到返回首窗、anchorFound=false，前端明确提示。已有选择可作为至多一条保留摘要，不能因新结果插入而默选另一条。
7. 每次读取前后核对文件身份和 shallow / grafts 指纹，未知状态、缺对象、索引中断不能谎报完整。取消 / deadline 在连接准备、逐行解码、Unicode 匹配之间检查，超时不提交响应；只读事务及时释放，不让状态查询阻塞 server 主循环。
8. `listSearchIdentities` 也只扫描当前快照前缀，返回按原始 name/email 排序的前 limit 个唯一身份，最多持有 limit 项；text 同时匹配 name 或 email，选中后仍使用原始二元组。截断时提示输入缩小范围；partial 时明确建议项尚未完整。它不受当前消息 / 身份筛选限制，避免条件互相隐藏可选项。

## 桌面状态与用户流程

- 新增独立 `SearchStore`，不复用历史的拓扑游标或覆盖状态。输入 debounce 250 ms，IME composition 中不发请求；新条件、隐藏、取消、切仓、scope / refresh 都处理旧响应意图，main 在会话变更前取消 / 排空搜索及建议请求。
- partial 时可见窗口每约 1 秒请求最新前缀，携带当前视口顶部 OID。新版本替换整个有界窗口与游标，绝不直接拼接不同版本页；保留选中摘要、顶部 OID / 行内像素偏移。完成后停止自动搜索轮询；暂停 / 取消索引时降低频率，显示“部分结果 · 索引已暂停 / 已取消”。BUSY 延后重试，不进入全局核心错误。
- 搜索 / 建议 / 历史翻页 / 导航 / 索引控制协调现有两个交互请求额度。partial 搜索活跃轮询或搜索 / 建议请求在途时暂停独立 index status 轮询，从搜索响应的 index 更新底栏；搜索完成 / 停止 / 失败后恢复低频 index 轮询，避免最后一次响应捕获到的 queued 状态一直滞留。索引重建先取消 / 排空只读搜索连接。recordView 不因搜索轮询反复写入。
- 搜索保留有界窗口和至多一条旧搜索选择摘要；窗口与历史返回摘要共用 2000 条预算（保存一条历史选择摘要时窗口最多 1999 条，实际按整页淘汰），总计最多 2001 条摘要。进入搜索先保存历史返回游标、选择与视口锚点，再释放隐藏的历史页缓存；回到历史按保存游标恢复，返回点保留到恢复成功，避免隐藏历史 + 搜索共存突破预算。
- 搜索结果列表复用虚拟窗口工具和现有行风格，不画图边 / 新增分隔线；可选择结果并将真实摘要交给现有详情区。未知完整消息等仍按 P2 占位，不把 renderer 的过滤或高亮当作匹配事实来源。
- 顶栏沿用消息框，显式大小写开关；筛选弹层提供添加条件、Author / Committer 多选与建议文本、Hash、时间字段 / 预设 / 自定义日期。每个条件可移除，清空返回历史。分支 / worktree 筛选沿用顶部范围选择器。
- 结果状态明确区分：搜索中、已找到 N 条（部分）、最终 N 条 / 最终空、暂停、失败保留旧结果、重试。未完整且 0 命中时显示“尚未找到，索引仍在构建”；暂停 / 故障时说明实际原因，不显示仍在工作的假进度。Hash 前缀有多候选时给可选择列表；部分覆盖即使只有一条也不称唯一。

## 实现分工

- 核心代理：`crates/core`、`crates/daemon`、Cargo 与生成 schema/TS。新增 `search.rs` 承担匹配、窗口、游标与身份建议，metadata_index 只暴露必要只读入口；server 接入两个短 worker 方法。先生成协议并通知其余代理，再实现与 Rust 检查。
- 桌面代理：`apps/desktop`、protocol 手写 TS、`tests/protocol`、`tests/renderer` 及已有 preload 白名单 smoke。新增 search store / 搜索控件 / 结果列表，修改必要的历史挂起恢复和详情输入。保持视觉及窗口外壳。
- 验证代理：`tests/search`、`scripts/test-search.mjs`、搜索 Electron smoke 和 package scripts。复用已有 Git fixture / client / snapshot 工具，独立 oracle，不修改生产源。
- 主代理：本计划与产品 / 架构 / 验收文档、契约和实现审查、release 构建、实窗协调。共享工作区，各自不覆盖无关编辑，不自行 commit / push；实窗串行。

## 验收

- Rust / generated protocol / TypeScript / renderer / 双 Node 协议，以及受影响的索引、历史 / 会话 / 导航回归。测试围绕行为，不为简单文案加镜像测试。
- 独立 Git 对照完整消息、中文短词、标点、正文、Unicode casefold 两态、双身份 AND/OR、SHA-256、前缀歧义、选定时间乱序和日期日界。全部结果通过实际游标走完，不能只验证首窗。
- 门控索引：空前缀、部分命中、较新时间的迟到命中插到前面、旧版本可完整遍历无重复遗漏、最新 anchor 窗口稳定、完成前后查询最终集合一致。索引暂停 / 故障不假报最终空；重建 / 淘汰使旧游标失效且可恢复。
- 取消长扫描 / identity 查询、条件和范围切换、迟到响应隔离、恶意输入与只读仓库前后对照；renderer 总摘要上限、选择及像素锚点用有意义的状态测试与实窗验证。
- 实窗操作消息、筛选、身份组合、日期、OID，检查 partial 更新与锚点、清空返回历史、刷新 / 切范围、错误重试及退出清理。再在本项目真实仓库只读试用搜索，并与独立 Git 对照，记录结果。
- 记录查询扫描成本与尚未验收的大仓延迟边界；不重复 P1-03 滚动性能矩阵，不将 M1 完成等同于完整 MVP / 发布验收。
