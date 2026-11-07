# M3 功能批次：统计、更新通知与交给 Agent

日期：2026-11-08。范围：P3-02、P3-03、P3-05；随后做一次有界主流程检查，记录 P3-04 尚未覆盖的部分。P3-01 已提交为 `1ba4b15`。本批沿用现有界面，不重做视觉设计。

## 数据与协议

三项能力都绑定当前 `repoId` / `generation`，使用既有 requestId 取消机制；统计、观察与 handoff 分别拥有取消域，不能相互取消。仓库事实只由 Rust 返回，renderer 不从已有页面推断总数、合入状态或实际检出的 worktree。

- `getActivityStats({ query })` 接收完整 `SearchQuery`，复用 `search.rs` 的元数据、路径谓词与固定索引前缀。返回已覆盖匹配数、按所选时间字段及本地时区分日的桶、原始 Author 姓名/邮箱分布、coverage 与索引状态。只有固定快照索引完整且扫描正常结束才显示完整总量；路径超时明确报错并保留已读统计。聚合列表有界且截断显式，不传全量提交摘要。
- `observeRepository({})` 复核本地引用和 worktree，只替换当前会话独立保存的 latest-observed 槽。返回观察时间、观察代号与变化数量，不更换浏览 session、history 或索引。只保留一个最新观察状态，不为连续提交累积查询会话。
- `diffRefSnapshots({})` 在展开更新详情时比较浏览快照与最新观察快照。新建/删除按引用是否存在；旧尖端可从新尖端到达为快进，其他为改写。快进附有界新增摘要；改写用 `rev-list old --not new` 计数；失败或缺对象给出未知状态。响应标明两个快照，避免稍晚返回的旧详情覆盖新观察。
- `getHandoffFacts(...)` 接收可选分支、提交和失效 worktree 目标，事实取自浏览快照。W1 是本窗口位置，B1 是浏览/指定分支，T1 必须由实际检出 B1 的 worktree 唯一确定。领先/落后、分叉后路径交集、分支独有提交、merge 全部父分组按 [HANDOFF](../HANDOFF.md) 返回有界数据；缺失与失败不得写成零。

具体线协议由 `crates/core/src/lib.rs` 定义并生成 schema/TypeScript；手写 API 仅负责窄桥接，不重复保存仓库事实。

## 文件与实现分工

| 所有者 | 文件 / 职责 |
| --- | --- |
| Rust 实现代理 | `crates/core/src/lib.rs`、`crates/daemon/src/`：统计扫描、最新观察槽、引用比较、路由及生成协议（`handoff.rs` 除外） |
| 桌面实现代理 | `packages/protocol/src/repository-session.ts`、desktop main/preload、app、top-bar、commit-list/detail：独立取消域、观察触发、真实统计/更新 UI、统一 handoff 入口 |
| handoff 实现代理 | 新建 `renderer/lib/handoff-prompt.ts`、必要状态模块及 `components/handoff-dialog.tsx`：模板、数据编码、编辑预览与复制；完成后接手独立 `crates/daemon/src/handoff.rs` 事实查询 |
| 主代理 | 本计划、跨模块契约协调、最终集成、简短检查和文档证据 |

主进程监听 gitDir/commonDir 的引用相关事件并合并，窗口聚焦复核，可见时约每 5 秒兜底。通知仅作线索，实际状态重新读取；后台观察与统计在交互空闲时开始，不抢占正在进行的搜索或详情。索引推进时，统计最多在当前请求完成后补一次最新前缀，避免反复取消长路径扫描。

统计替换 `ActivityPlaceholder`，支持点击日期/Author 加筛选、同步 Author/Committer 时间口径。更新替换 `UpdatesPlaceholder`，显示真实数量、观察时间和引用分类，刷新沿用现有保留选择/锚点流程；失效范围明确提示。

handoff 入口覆盖详情头部、分支更多菜单、merge 概览和相关 worktree 状态。五类模板及失效 worktree 核查变体使用同一可编辑预览；只通过 `copyText` 写剪贴板。仓库来源文本只在 JSON 参考数据里，正文使用存在的固定编号；随机分隔标记检查碰撞。保留完整 OID/ref/路径，压缩可选摘要后仍超 64 KiB 则明确拒绝复制。清理分支只在可达合入、非本窗口 HEAD、非基准的条件下可选；补丁等价仍留 P4-08。

## 有限检查与完成口径

遵循用户“少点验证、少点防御性代码，优先实现功能”：每项只补关键数据/状态检查，随后统一类型检查及一次 release 构建。最终尝试一次小仓库主流程（统计→路径→定位→diff→外部变更提示→手动刷新→复制 handoff），不追加主题/缩放/大仓性能矩阵。

实现与验收分开记录。功能具备且定向检查通过可更新 P3-02/03/05；P3-04 只有完成记录中的真实主流程才算通过。长时稳定性、性能预算和跨平台发行仍属于 M4。

## 实际结果

本批已完成。桌面集成、release 构建、8 步实窗主流程及当前项目只读数据对照通过，详见[M3 记录](../validation/m3-mvp.md)：

- `cargo check -p commitscope-daemon`、`cargo fmt --all -- --check`、`pnpm protocol:check` 通过。
- Rust 定向 3 项通过：`activity_buckets_use_iana_dst_and_raw_author_identity`、`observe_and_diff_preserve_browse_generation_and_report_fast_forward`、`handoff_facts_distinguish_window_and_branch_worktrees_without_faking_missing_base`。
- Prompt 定向 3 项通过：不可信文本只在 JSON 参考段、无仓库自定义与缺失编号、多父 merge 分组及清理条件。
- 日桶最多 3660 项、Author 分组最多 500 项，超出显式标记截断。路径统计超时返回错误，不声称完整结果。
- 引用差异本版在展开时重算，尚未加入按快照对缓存；后续由实际耗时决定。外部观察只保留一个最新状态。
- 未运行全量 Rust/协议/Electron 检查、主题缩放矩阵、大仓性能或长时稳定性检查。
