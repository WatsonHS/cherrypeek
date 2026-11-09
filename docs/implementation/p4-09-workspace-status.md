# P4-09：工作区状态与改动

日期：2026-11-09。状态：已验收（2026-11-09，证据见 PLAN 对应任务的“验收”）。接口、main / preload / renderer 与 daemon 均已实现，核心声明 `workspaceStatus`。核心未声明该能力时（旧核心），界面仍显示“占位 · P4-09”，不显示示例文件。

分工：Claude 定义接口并实现 main、preload、renderer（2026-11-09 用户确认）；daemon 原定由 Codex 实现，2026-11-09 用户改为由 Claude 一并实现（`crates/daemon/src/workspace.rs`）。产品口径见 [PRODUCT](../PRODUCT.md)「工作区状态与改动」，界面见 [DESIGN](../DESIGN.md) 第 11 节。

## 能力与方法

新增 capability `workspaceStatus`。三个 session 方法都使用当前会话的 `repoId` / `generation` 上下文；读取的是本窗口实际打开的目录，与浏览范围无关。浏览范围切换导致上下文过期时返回 `STALE_CONTEXT`，renderer 重新读取。

| 方法 | 参数 | 响应 section | 用途 |
| --- | --- | --- | --- |
| `readWorkspaceStatus` | `{ maxEntries: 1..2000 }` | `workspaceStatus` | 已暂存、未暂存、未跟踪、冲突文件清单 |
| `readWorkspaceDiff` | `{ side: "staged" \| "unstaged", pathHex, oldPathHex, fullFile? }` | `workspaceDiff` | 一个文件在一组里的 diff |
| `readWorkspaceFile` | `{ pathHex, maxLines: 1..5000 }` | `workspaceFile` | 未跟踪文件预览、冲突文件内容 |

`fullFile` 见 [P4-11](p4-11-diff-display.md)。每个方法只返回一个终态块，`coverage.complete = true`、`processed = 1`、`nextCursor = null`。取消沿用协议的 `cancel` 消息。

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
- 除 `maxEntries` 外，条目的 JSON 累计到约 400 KiB 时也停止并设 `complete = false`：daemon 拒绝超过 512 KiB 的响应，路径很长时 2,000 项可能放不下。
- `readWorkspaceDiff` 的 `pathHex` / `oldPathHex` 必须对应最近一次状态里的条目；文件不在对应组里时返回 `MISSING_OBJECT`。冲突条目不提供 diff，用 `readWorkspaceFile` 读带冲突标记的内容。gitlink（子模块引用）的 `kind = gitlink`，`oldSize` / `newSize` 为 null（子模块的提交不在本仓库的对象库里），`patch` 只有 `Subproject commit` 两行（`--submodule=short`），工作区页把它显示在说明下方（2026-11-09 验收时修正：此前读取 blob 大小时返回 `GIT_ERROR`）。
- `readWorkspaceFile` 读工作区里的文件本身：不跟随符号链接（返回 `symlink` 和目标）；路径必须在工作区内，否则返回 `INVALID_REQUEST`；超过 1 MiB 返回 `tooLarge` 且不读内容；含 NUL 的前 8 KiB 判为 `binary`。
- bare 仓库调用任一方法返回 `INVALID_REQUEST`（renderer 不会对 bare 发请求）。

## daemon（已实现）

- 全部是只读查询：`--no-optional-locks`（等同 `GIT_OPTIONAL_LOCKS=0`），不刷新 index、不写对象、不运行 hook。始终禁用 `core.fsmonitor`（`-c core.fsmonitor=false`，它可以是外部命令），diff 禁用外部 diff 和 textconv，参数数组调用，路径用 `--literal-pathspecs` 加 `--`。
- 状态：`git status --porcelain=v2 -z --untracked-files=all --ignored=no`，加两次 `diff --numstat -z`（`--cached` 与工作区）补增删数。从 git dir 里的 `MERGE_HEAD`、`rebase-merge/`、`rebase-apply/`、`CHERRY_PICK_HEAD`、`REVERT_HEAD`、`BISECT_LOG` 判断 `operation`。
- 过滤器（2026-11-09 用户决定）：工作区一侧的比较照常运行仓库配置的 clean / smudge / process 过滤器（例如 Git LFS），使状态和未暂存 diff 与终端里的 `git status` / `git diff` 一致，不额外标注。这是只读边界的一个明确例外：打开别人提供的目录时，会执行其 `.git/config` 里配置的过滤器命令。fsmonitor 不在此例外内，仍然禁用；外部 diff、textconv 也仍然禁用。
- 为此工作区的三个方法读取用户的全局与系统 Git 配置（`git lfs install` 把过滤器写在全局配置里）；其余读取仍忽略它们。固定参数照旧：`core.fsmonitor=false`、`diff.external=`、hooks 指向空目录、禁止网络与补拉、`--no-optional-locks`。diff 另外固定 `diff.suppressBlankEmpty=false`、`diff.noprefix=false`、`--unified`、`--diff-algorithm=myers`，免得用户配置改变 patch 形状。
- 实现细节：状态用 `status --porcelain=v2 -z --branch --untracked-files=all --ignored=no --find-renames`，`headReference` / `headOid` 取自 `--branch` 头；输出上限 64 MiB，超出返回 `RESOURCE_LIMIT`。已跟踪的改动超过 5,000 个路径时不再跑两次 `--numstat`，增删数为 null。`readWorkspaceDiff` 先对该路径重跑一次状态确认条目仍在对应组里，再按 HEAD / index 的 blob 大小与 LFS 指针判断种类，二进制取自 `--numstat`。`readWorkspaceFile` 拒绝含 `..`、`.`、空段、`.git` 段的路径，父目录经符号链接逃出工作区时返回 `INVALID_REQUEST`，读文件用 `O_NOFOLLOW`。
- 与终端一致的一个现象：大小变了、但经 clean 过滤后内容相同的文件，`git status` 仍报“修改”（Git 不为大小不同的文件跑过滤器），而 diff 为空。
- 可取消，迟到结果不覆盖新请求；单次查询沿用 15 秒截止。
- 实测（2026-11-09，本机 `~/Development/flutter`，15,361 个跟踪文件、2 个改动路径）：`readWorkspaceStatus` 中位 327 ms（5 次 475 / 309 / 305 / 358 / 327 ms），单独 `git status` 192 ms；daemon 进程树含 Git 子进程空闲 12.2 MiB、峰值 27.1 MiB。单点实测，不是预算验收。
- 边构建边重读（2026-11-09，同一仓库，87,701 个提交，`node scripts/benchmark-workspace-status.mjs --repository=<路径> [--interval=毫秒]`）：索引构建期间读取状态不变慢（中位 242–268 ms，空闲 242 ms）；构建变慢约等于读取的总耗时，每秒一次时 43.5–44.9 s → 58.6–58.7 s，每 5 秒一次时 43.8 → 46.7 s。详见 PLAN 的 P4-09 验收。
- 验收：`pnpm test:pages` 用真实 daemon 与独立 Git 命令逐项对照，并用持住指定子命令的 Git 包装验证取消后子进程被回收。

## main / preload / renderer（已实现）

- preload 暴露 `readWorkspaceStatus`、`readWorkspaceDiff`、`readWorkspaceFile`、`cancelWorkspace`，以及 `onWorkspaceChanged` 变化提示。main 对状态和内容各用一个请求通道，新的请求取代同通道的旧请求。
- main 用 `fs.watch` 递归监听当前工作区目录，作为“可能有变化”的线索，800 ms 去抖后通知 renderer；不依赖它判断干净与否。
- renderer 的工作区 store 在打开仓库、窗口聚焦、收到变化提示、进入工作区页和手动刷新时重新读取；切换浏览范围不触发读取（2026-11-09 修正：此前每次切换都读，和首页、导航同时发出时超过 main 的 2 个并发上限）。收到变化提示后、新结果到达前，角标保留上次数字并改为空心。
- 工作区页的“工作区干净”只在最近一次完成的读取完整、为空，且之后没有失败或过期时显示；重读进行中保留上次的确认结果，由角标显示读取中，页面不来回闪动（2026-11-09 验收时修正：此前重读失败后页面仍显示干净）。
- 工作区页与文件页在首次进入后保持挂载，切换到其他页时隐藏，保留选择和滚动位置（与提交页相同；2026-11-09 验收时补上）。
- 变化提示只在窗口可见时触发读取；窗口隐藏时只标记过期，重新显示或聚焦时再读。由提示触发的读取之间至少间隔 3 秒或上次读取耗时的 10 倍（最多 60 秒）；提示触发、但读到的结果和上次一样时，间隔翻倍，直到 60 秒，以免构建往被忽略的目录写文件时一直重读。手动刷新、聚焦和进入页面会清掉这段退避。大仓库上边构建边测一次的任务留到 daemon 实现之后。
