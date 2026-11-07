# P3-01：路径历史

日期：2026-11-08。状态：实现完成。前置 P2-04 已提交为 `6a3ddd8`。继续优先功能，只做必要的定向检查和构建。

## 行为与口径

- 搜索筛选增加单个路径条件，与消息、独立 Author / Committer、日期、OID 和冻结范围取交集。文件精确匹配；目录可选仅直接文件或包含子目录，按 `/` 分段边界匹配，区分大小写，不解释 glob / pathspec 魔法。
- 路径控件保存输入草稿，选择补全或点击应用才更新搜索。补全只来自当前冻结范围 tips 的树，显示文件 / 目录并保留原始字节；已删除路径可手输，不将当前补全误称完整历史路径清单。
- 原始路径以 rawHex 作为身份。用户手输按 UTF-8 编码，空格保留；目录 `.` 表示根，目录末尾 `/` 去除。拒绝绝对路径、NUL、`.` / `..` 点段；根目录的 rawHex 为空，文件路径不得为空。
- root 对空树，其他提交逐个原始父比较；任一父有匹配路径变化即命中，结果标明命中的父序号。差异只读取路径，不生成 patch。禁用 rename 跟随：旧名的删除和新名的新增可各自匹配，不跨名字追溯。
- 结果仍按既有时间 / OID 顺序，使用 metadata watermark、部分覆盖、版本化游标和 anchor。P2-04 定位时暂时移除路径条件，返回恢复完整查询及原锚点；默认 diff 仍比较第一父，路径命中父另作说明。

## 协议

```ts
type SearchPathKind = "file" | "directory";
type SearchPathFilter = {
  rawHex: string;
  kind: SearchPathKind;
  includeDescendants: boolean;
};
// SearchQuery 新增 required nullable 字段：path: SearchPathFilter | null。
type SearchPathMatch = { oid: string; parentIndices: (number | null)[] };
// SearchPage 新增 pathMatches: SearchPathMatch[]，仅含本页；无路径条件时 []。
// 分块时只携带当前块 commits 的命中，main 合并。
// 父序号从 0 开始；root 的空树比较为 [null]。
type SearchPathEntry = { path: GitPath; kind: SearchPathKind };
type SearchPaths = { entries: SearchPathEntry[]; truncated: boolean };
type ListSearchPathsParams = { text: string; limit: number }; // 最大 100
// listSearchPaths -> section: "searchPaths", paths: SearchPaths
```

沿用 `metadataSearch` capability 和 `cancelSearch`，main / preload 仅增加窄业务接口；路径进入 queryKey，补全结果也受会话和请求意图判旧。

## 文件与实现

- `crates/core/src/lib.rs`：新增上述类型并生成协议；不改普通历史 CommitSummary。
- `crates/daemon/src/search.rs`：元数据候选与路径谓词取交集；只为返回页附带命中父。路径比较按有界批次执行 `git diff-tree --stdin --root --raw -z --no-renames`，显式指定每个原始父，避免一条提交启动一个进程；复用只读 Git、取消和截止时间。
- 路径读取模块负责 NUL 分隔的原始路径、文件 / 目录匹配和固定 tips 的 tree 补全。不增加全库内容 / patch 索引或持久查询缓存。每次路径搜索扫描当前 metadata watermark，超过已有时间 / 输出限额明确失败并保留旧结果，不把未检查部分当无命中。
- `server.rs` 接入补全路由并向搜索传 Git executable。main 复用搜索请求调度和既有 response schema，不另建字段验证框架。
- `metadata-search-store.ts` 增加补全状态，复用搜索 / 身份请求的取消习惯。`pathMatches` 随页面合并与淘汰，主搜索窗口仍最多 1800 条摘要。
- `search-controls.tsx` 接入路径草稿、补全、文件 / 目录选项和递归开关；`search-result-list.tsx` 显示命中父；`app.tsx` 的定位横幅增加路径说明。

## 分工与检查

核心代理负责 core / daemon / 生成协议；桌面代理负责 apps/desktop / 手写协议和少量状态用例；主代理负责计划、集成、构建与实际结果记录。共享工作区，不回退彼此改动。本项新改动暂不自动提交。

仅做 2–3 项针对字面路径、删除 / root、merge 第二父的 Rust 用例，少量路径筛选 / 定位返回状态用例、TypeScript 检查和一次 release 构建。因新增必填协议字段需要同步旧 fixture 的默认 query，但不为此运行完整矩阵。未做的实窗和大仓路径搜索性能验收明确保留。

## 实际结果

- Rust 定向两项通过：`git_path_filter_matches_root_deletion_and_only_second_merge_parent` 使用真实 Git 仓库覆盖特殊字面路径、root、删除与 merge 仅第二父命中；`directory_matching_and_completion_keep_raw_path_boundaries` 覆盖目录直接 / 递归边界及补全限额。
- `cargo check -p commitscope-daemon`、`cargo fmt --all -- --check`、`pnpm protocol:check` 通过。
- `pnpm typecheck` 通过；renderer 仅运行 `history location|path suggestions` 定向用例，3/3 通过，覆盖路径条件随 query / anchor 恢复、旧会话补全迟到丢弃与 rawHex 保留。
- `pnpm build:release` 通过，生成 Rust release 二进制和 Electron 资源，可用 `pnpm start` 试用；Vite 主 bundle 为 522.61 kB，保留大于 500 kB 的拆分提示，未在本项扩展性能工作。
- 同步旧搜索 fixture 的 `path: null`、分块 `pathMatches` 聚合与 preload 白名单，未运行这些完整回归矩阵。
- 当前路径搜索每页仍扫描已索引 watermark；补全仅来自冻结 tips 当前树，不包含完整历史路径。未执行实窗、全量测试或大仓路径查询性能验收。
