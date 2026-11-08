# P4-09：工作区状态与改动

日期：2026-11-09。状态：接口已定义，main / preload / renderer 已按接口接入；daemon 实现待做。daemon 在 `CoreReady.capabilities` 里声明 `workspaceStatus` 之前，界面显示“占位 · P4-09”，不显示示例文件。

分工（2026-11-09 用户确认）：Claude 定义接口并实现 main、preload、renderer；Codex 按本文实现 daemon。产品口径见 [PRODUCT](../PRODUCT.md)「工作区状态与改动」，界面见 [DESIGN](../DESIGN.md) 第 11 节。

## 能力与方法

新增 capability `workspaceStatus`。三个 session 方法都使用当前会话的 `repoId` / `generation` 上下文；读取的是本窗口实际打开的目录，与浏览范围无关。浏览范围切换导致上下文过期时返回 `STALE_CONTEXT`，renderer 重新读取。

| 方法 | 参数 | 响应 section | 用途 |
| --- | --- | --- | --- |
| `readWorkspaceStatus` | `{ maxEntries: 1..2000 }` | `workspaceStatus` | 已暂存、未暂存、未跟踪、冲突文件清单 |
| `readWorkspaceDiff` | `{ side: "staged" \| "unstaged", pathHex, oldPathHex }` | `workspaceDiff` | 一个文件在一组里的 diff |
| `readWorkspaceFile` | `{ pathHex, maxLines: 1..5000 }` | `workspaceFile` | 未跟踪文件预览、冲突文件内容 |

每个方法只返回一个终态块，`coverage.complete = true`、`processed = 1`、`nextCursor = null`。取消沿用协议的 `cancel` 消息。

## 数据

```ts
type WorkspaceStatus = {
  observedAtUnixMs: number;
  headReference: string | null;     // 读取时的实际 HEAD，可能已不同于会话打开时
  headOid: string | null;
  operation: "none" | "merge" | "rebase" | "cherryPick" | "revert" | "bisect";
  entries: WorkspaceEntry[];        // 最多 maxEntries 项，按路径字节序
  complete: boolean;                // false：改动路径超过 maxEntries，entries 被截断
  totalPaths: number;               // 去重后的路径数；complete 为 false 时是下限
  conflictCount: number;
};
type WorkspaceEntry = {
  path: GitPath;                    // 当前路径
  originalPath: GitPath | null;     // Git 报告为重命名 / 复制时的来源路径
  staged: WorkspaceChange | null;   // HEAD → index
  unstaged: WorkspaceChange | null; // index → 工作区
  untracked: boolean;
  untrackedSize: number | null;     // 字节；仅未跟踪文件
  conflict: "bothModified" | "bothAdded" | "bothDeleted" | "addedByUs" | "addedByThem" | "deletedByUs" | "deletedByThem" | null;
};
type WorkspaceChange = {
  status: ChangedFileStatus;        // 与提交详情相同的枚举
  additions: number | null;         // 二进制或未计算时为 null
  deletions: number | null;
  binary: boolean;
  gitlink: boolean;
};
type WorkspaceDiff = {
  side: "staged" | "unstaged";
  path: GitPath;
  oldPath: GitPath | null;
  kind: FileDiffKind;               // text / binary / gitlink / lfs / tooLarge，同提交 diff
  patch: string;                    // 与提交 diff 相同的上限：2000 行 / 128 KiB
  truncated: boolean;
  textLossy: boolean;
  oldSize: number | null;
  newSize: number | null;
};
type WorkspaceFile = {
  path: GitPath;
  kind: "text" | "binary" | "tooLarge" | "symlink" | "missing" | "notFile";
  text: string;                     // kind 为 text 时的前 maxLines 行，最多 256 KiB
  lines: number;                    // text 里的行数
  truncated: boolean;               // 文件还有更多行
  size: number | null;
  textLossy: boolean;
  symlinkTarget: GitPath | null;
};
```

规则：

- 同一路径只出现一次；同时有已暂存和未暂存改动时两个字段都有值。`totalPaths` 按路径去重，忽略的文件不列出、不计数。
- 只有一次完整、成功的读取且没有任何条目时，renderer 才显示“干净”；`complete = false` 时角标显示 `totalPaths+`。
- `readWorkspaceDiff` 的 `pathHex` / `oldPathHex` 必须对应最近一次状态里的条目；文件不在对应组里时返回 `NOT_FOUND`。冲突条目不提供 diff，用 `readWorkspaceFile` 读带冲突标记的内容。
- `readWorkspaceFile` 读工作区里的文件本身：不跟随符号链接（返回 `symlink` 和目标）；路径必须在工作区内，否则返回 `INVALID_REQUEST`；超过 1 MiB 返回 `tooLarge` 且不读内容；含 NUL 的前 8 KiB 判为 `binary`。
- bare 仓库调用任一方法返回 `INVALID_REQUEST`（renderer 不会对 bare 发请求）。

## daemon 要求（Codex）

- 全部是只读查询：`--no-optional-locks`（等同 `GIT_OPTIONAL_LOCKS=0`），不刷新 index、不写对象、不运行 hook。始终禁用 `core.fsmonitor`（`-c core.fsmonitor=false`，它可以是外部命令），diff 禁用外部 diff 和 textconv，参数数组调用，路径用 `--literal-pathspecs` 加 `--`。
- 状态：`git status --porcelain=v2 -z --untracked-files=all --ignored=no`，加两次 `diff --numstat -z`（`--cached` 与工作区）补增删数。从 git dir 里的 `MERGE_HEAD`、`rebase-merge/`、`rebase-apply/`、`CHERRY_PICK_HEAD`、`REVERT_HEAD`、`BISECT_LOG` 判断 `operation`。
- 过滤器（2026-11-09 用户决定）：工作区一侧的比较照常运行仓库配置的 clean / smudge / process 过滤器（例如 Git LFS），使状态和未暂存 diff 与终端里的 `git status` / `git diff` 一致，不额外标注。这是只读边界的一个明确例外：打开别人提供的目录时，会执行其 `.git/config` 里配置的过滤器命令。fsmonitor 不在此例外内，仍然禁用；外部 diff、textconv 也仍然禁用。
- 可取消，迟到结果不覆盖新请求；单次查询沿用 15 秒截止。大仓库（如 Flutter）上要测一次完整状态读取的耗时和整树内存。
- 完成后在 `CoreReady.capabilities` 里加入 `workspaceStatus`。

## main / preload / renderer（已实现）

- preload 暴露 `readWorkspaceStatus`、`readWorkspaceDiff`、`readWorkspaceFile`、`cancelWorkspace`，以及 `onWorkspaceChanged` 变化提示。main 对状态和内容各用一个请求通道，新的请求取代同通道的旧请求。
- main 用 `fs.watch` 递归监听当前工作区目录，作为“可能有变化”的线索，800 ms 去抖后通知 renderer；不依赖它判断干净与否。
- renderer 的工作区 store 在打开仓库、窗口聚焦、收到变化提示、进入工作区页和手动刷新时重新读取，两次读取至少间隔 3 秒。收到变化提示后、新结果到达前，角标保留上次数字并改为空心。
