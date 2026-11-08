# P4-10：文件二级页面

日期：2026-11-09。状态：接口已定义，main / preload / renderer 已按接口接入；daemon 实现待做。daemon 在 `CoreReady.capabilities` 里声明 `fileBrowsing` 之前，文件页显示“占位 · P4-10”。

分工与 P4-09 相同：Claude 定义接口并实现 main、preload、renderer；Codex 按本文实现 daemon。产品口径见 [PRODUCT](../PRODUCT.md)「文件二级页面」，界面见 [DESIGN](../DESIGN.md) 第 11 节「文件页」。

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
  text: string;               // kind 为 text 时的前 lines 行，最多 1 MiB
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

- `listTree` 的 `pathHex` 必须是该提交里的目录，否则返回 `MISSING_OBJECT`。每页最多 500 项；`total` 是这个目录的直接子项总数。
- `readFileContent`：超过 `maxLines` 或 1 MiB 时截断并设 `truncated`；`totalLines` 尽量给出（流式数换行即可），给不出时为 null。前 8 KiB 含 NUL 判为 `binary`；≤ 1 KiB 且符合 LFS 指针格式判为 `lfs`；gitlink 为 `submodule`；mode 120000 为 `symlink`，`symlinkTarget` 是链接内容，不跟随。路径在该提交里不存在时返回 `kind: "missing"`，不报错（删除的文件可以从旧版本打开）。
- `readFileHistory`：从 `commit` 出发、按字面路径（`git log <commit> -- <path>`，不加 `--follow`）列出修改过它的提交；`kind = "directory"` 时包括目录下任何文件的修改，`pathHex` 为空字符串表示整个仓库。`message` 非空时只保留提交消息包含它的提交（字面、不区分大小写，与元数据搜索一致）。第一页 `cursor = null`；游标只对相同的 commit / path / kind / message 有效，否则返回 `INVALID_CURSOR`。merge 提交的 `change` 相对第一父提交计算。
- `readFileChange`：在 `oid` 与指定父提交（`parentIndex` 为 null 表示根提交与空树比较）之间只比较这一个路径；`oldPathHex` 给出时按改名处理。与 `readDiff` 共用 patch 上限：2000 行 / 128 KiB；`fullFile` 见 [P4-11](p4-11-diff-display.md)。
- 都是只读查询：参数数组、`--literal-pathspecs` 加 `--`、禁用外部 diff 与 textconv、不套用 clean / smudge 过滤器（读的是提交里的对象）。可取消，迟到结果不覆盖新请求，沿用 15 秒截止。
- 完成后在 `CoreReady.capabilities` 里加入 `fileBrowsing`。

## main / preload / renderer（已实现）

- main 对目录、内容、历史、修改各用一个请求通道，新请求取代同通道的旧请求；打开、刷新、切换范围时取消。核心同时最多处理两个请求，renderer 的文件页 store 遇到 `BUSY` 会短暂重试。
- 目录树版本默认是浏览范围的最新提交（全部分支时用 HEAD），可以从版本选择器换成任一分支或标签，不会 checkout。只有打开过文件页才开始读取。
- 入口：提交详情的文件行和工作区页的“文件历史”打开对应路径的历史；文件页的“查看完整提交”回到提交页并定位。
- 「内容」里的 ⌘F 只在已加载的行里查找；文件被截断时计数和空结果都注明“前 N 行”。
