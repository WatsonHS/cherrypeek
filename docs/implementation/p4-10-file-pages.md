# P4-10：文件二级页面

日期：2026-11-09。状态：已验收（2026-11-09，证据见 PLAN 对应任务的“验收”）。接口、main / preload / renderer 与 daemon 均已实现，核心声明 `fileBrowsing`（`crates/daemon/src/files.rs`）。核心未声明该能力时，文件页显示“占位 · P4-10”。

分工与 P4-09 相同：Claude 定义接口并实现 main、preload、renderer；daemon 也由 Claude 实现（2026-11-09 用户改派）。产品口径见 [PRODUCT](../PRODUCT.md)「文件二级页面」，界面见 [DESIGN](../DESIGN.md) 第 11 节「文件页」。

## 能力与方法

新增 capability `fileBrowsing`。四个 session 方法都按完整提交 OID 读取，不按引用名，所以与浏览范围的快照无关；只要对象还在就可以读。

| 方法 | 参数 | 响应 section | 用途 |
| --- | --- | --- | --- |
| `listTree` | `{ commit, pathHex \| null, offset, limit: 1..500 }` | `treePage` | 一个目录的直接子项 |
| `readFileContent` | `{ commit, pathHex, maxLines: 1..5000 }` | `fileContent` | 「内容」标签页 |
| `readFileHistory` | `{ commit, pathHex, kind, message, cursor, pageSize: 1..200 }` | `fileHistory` | 「历史」标签页 |
| `readFileChange` | `{ oid, parentIndex, pathHex, oldPathHex, fullFile? }` | `fileDiff` | 历史里一次修改的 diff |

每个方法只返回一个终态块，`coverage.complete = true`、`processed = 1`、`nextCursor = null`（历史的翻页游标在 `FileHistoryPage.nextCursor` 里）。

## 数据

```ts
type TreePage = {
  commit: string; path: GitPath | null;      // null 表示根目录
  entries: TreeEntry[];                       // 目录在前，再按原始名字节排序
  offset: number; total: number; hasMore: boolean;
};
type TreeEntry = { name: GitPath; path: GitPath; kind: "directory" | "file" | "symlink" | "submodule"; mode: string; oid: string; size: number | null };
type FileContent = {
  commit: string; path: GitPath;
  kind: "text" | "binary" | "lfs" | "submodule" | "symlink" | "tooLarge" | "missing";
  text: string;               // kind 为 text 时的前 lines 行；schema 上限 1 MiB，daemon 实际按 JSON 编码后约 400 KiB 截断
  lines: number; totalLines: number | null; truncated: boolean;
  size: number | null; textLossy: boolean; symlinkTarget: GitPath | null; blobOid: string | null;
};
type FileHistoryPage = { commit: string; path: GitPath; entries: FileHistoryEntry[]; nextCursor: string | null };
type FileHistoryEntry = { commit: CommitSummary; change: FileHistoryChange };
type FileHistoryChange = {
  status: ChangedFileStatus;  // 相对第一父提交；根提交与空树比较
  oldPath: GitPath | null;    // 这次提交里从哪个路径改名而来
  additions: number | null; deletions: number | null; binary: boolean;
  files: number;              // 目录：这次提交改动了其下多少个文件；文件为 1
};
// readFileChange 返回现有的 FileDiff（与提交详情相同）。
```

## 规则

- `listTree` 的 `pathHex` 必须是该提交里的目录，否则返回 `MISSING_OBJECT`。每页最多 500 项；`total` 是这个目录的直接子项总数。路径很长时一页的 JSON 累计到约 400 KiB 也会提前结束，`hasMore` 照常反映，下一页从 `offset + entries.length` 读。
- `readFileContent`：超过 `maxLines` 或约 400 KiB（按 JSON 编码后的字节计，控制字符等转义字符按转义后长度算）时截断并设 `truncated`；daemon 拒绝超过 512 KiB 的响应，所以没有用满 schema 的 1 MiB。8 MiB 以内的 blob 整个读取，`totalLines` 精确；更大的只读开头，`totalLines` 为 null；`totalLines` 尽量给出（流式数换行即可），给不出时为 null。前 8 KiB 含 NUL 判为 `binary`；≤ 1 KiB 且符合 LFS 指针格式判为 `lfs`；gitlink 为 `submodule`；mode 120000 为 `symlink`，`symlinkTarget` 是链接内容，不跟随。路径在该提交里不存在时返回 `kind: "missing"`，不报错（删除的文件可以从旧版本打开）。
- `readFileHistory`：从 `commit` 出发、按字面路径（`git log <commit> -- <path>`，不加 `--follow`）列出修改过它的提交；`kind = "directory"` 时包括目录下任何文件的修改，`pathHex` 为空字符串表示整个仓库。`message` 非空时只保留提交消息包含它的提交（字面、不区分大小写，与元数据搜索一致）。第一页 `cursor = null`；游标只对相同的 commit / path / kind / message 有效，否则返回 `INVALID_CURSOR`。merge 提交的 `change` 相对第一父提交计算。实现：`git log --raw --numstat --no-renames`，列出的提交与 `git log <commit> -- <path>` 相同；`git log` 不为 merge 输出 diff，本页的 merge 再用一次 `git diff-tree --stdin`（每行“merge 第一父提交”）相对第一父提交计算（2026-11-09 验收时修正：此前加了 `--diff-merges=first-parent`，它也会改变列出哪些 merge，多出相对第一父提交没有改动该路径的 merge）。游标为 `v1:<偏移>:<查询指纹>`；消息过滤用 Git 的 `--fixed-strings --regexp-ignore-case`，在 `LC_ALL=C` 下只对 ASCII 字母忽略大小写，与元数据搜索的 Unicode 大小写折叠略有差别。文件在某次提交里表现为“新增”时，再对该提交做一次 50% 相似度的改名检测，命中则给出 `oldPath`。条目 JSON 累计到约 400 KiB 时提前结束本页并给出游标。
- `readFileChange`：在 `oid` 与指定父提交（`parentIndex` 为 null 表示根提交与空树比较）之间只比较这一个路径；`oldPathHex` 给出时按改名处理。与 `readDiff` 共用 patch 上限：2000 行 / 128 KiB；`fullFile` 见 [P4-11](p4-11-diff-display.md)。
- 都是只读查询：参数数组、`--literal-pathspecs` 加 `--`、禁用外部 diff 与 textconv、不套用 clean / smudge 过滤器（读的是提交里的对象）。可取消，迟到结果不覆盖新请求，沿用 15 秒截止。
- 已在 `CoreReady.capabilities` 里加入 `fileBrowsing`。

## main / preload / renderer（已实现）

- main 对目录、内容、历史、修改各用一个请求通道，新请求取代同通道的旧请求；打开、刷新、切换范围时取消。核心同时最多处理两个请求，renderer 的文件页 store 遇到 `BUSY` 会短暂重试。
- 目录树版本默认是浏览范围的最新提交（全部分支时用 HEAD），可以从版本选择器换成任一分支或标签，不会 checkout。只有打开过文件页才开始读取。
- 入口：提交详情的文件行和工作区页的“文件历史”打开对应路径的历史；文件页的“查看完整提交”回到提交页并定位。
- 「内容」里的 ⌘F 只在已加载的行里查找；文件被截断时计数和空结果都注明“前 N 行”。
