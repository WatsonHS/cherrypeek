# P4-12：逐行追溯

日期：2026-11-09。状态：接口已定义，main / preload / renderer 已按接口接入；daemon 实现待做。daemon 声明 `blame` 之前，“逐行追溯”按钮置灰并标“占位”。

## 能力与方法

新增 capability `blame` 和 session 方法 `readBlame { commit, pathHex }`，响应是多个 `blameChunk` 块，最后一块 `done = true`：

```ts
type BlameChunk = {
  commit: string; path: GitPath;
  totalLines: number;          // 文件在 commit 里的总行数，每块相同
  blocks: BlameBlock[];        // 每块最多 5,000 个
  commits: BlameCommit[];      // 本块里第一次出现的提交
};
type BlameBlock = {
  startLine: number; lineCount: number;   // 当前文件里的行，从 1 开始
  oid: string;                            // 最后修改这些行的提交
  originalStartLine: number;              // 在那个提交里的行号
  originalPath: GitPath | null;           // 那个提交里的路径与当前不同（整文件改名）时给出
};
type BlameCommit = { oid; summary; summaryTruncated; authorName; authorEmail; authorTime /* Unix 秒 */; textLossy };
```

所有块的行数加起来必须正好覆盖 `totalLines`，块之间不重叠。

## daemon 要求（Codex）

- 参数数组执行 `git blame --incremental --no-textconv --ignore-revs-file= <commit> -- <path>`（加 `--literal-pathspecs`）：按 OID 读取，只跟随整文件改名，不开 `-M` / `-C`，不读取仓库配置的忽略提交列表。边读边按块推送，可取消，取消后及时回收子进程。
- 文件超过 1 MiB 或 20,000 行时不执行，返回 `RESOURCE_LIMIT`；二进制文件返回 `INVALID_REQUEST`。
- 结果按（提交 OID，路径）缓存在应用数据目录，有总量上限并按最近使用淘汰；缓存命中时一次推送全部块。不写被查看仓库。
- 完成后在 `CoreReady.capabilities` 里加入 `blame`。

## main / preload / renderer（已实现）

- main 按块校验并通过 `commitscope:files:blame-chunk` 事件推给 renderer，事件带 renderer 生成的 `streamId`；全部到齐后 `readBlame` 返回总行数。超过 60 秒未完成按超时处理。
- renderer：内容页“逐行追溯”开关（⌥B），左侧 212 宽追溯栏按块显示日期和作者，5 档新旧底色；悬停卡片给出摘要、行范围、该提交在本文件的增删（若已在文件历史里）和改名前路径。单击定位到「历史」里的这次修改，只展开包含该行的那处改动并标出该行，顶部“回到第 N 行”返回；来自改名之前的行打开旧路径的历史。卡片上另有“在提交历史中定位”。
