# P0-03：真实仓库首屏验收

日期：2026-11-07。任务 P0-03；由主代理制定[代码级计划](../implementation/p0-03-repository-preview.md)，三个轻量模型代理分别实现 Rust、桌面、fixture / 测量，主代理复核和独立运行验收。当前仍在 M0，尚非 MVP。

## 交付行为

- 输入绝对路径、选择目录或传入 `--repository=<绝对路径>`，显示当前 HEAD 最多 200 条真实提交及引用。超过首批时明确提示仍有更多历史。
- 单击提交显示完整 OID、父 OID、原始 Author / Committer 身份和双时间；列表默认 Committer 时间，并标注本地时区。摘要是消息第一行，不将正文合并到标题。
- Rust 固定一次解析得到的 HEAD OID，以一个 `rev-list` 和一个 `cat-file --batch` 批量读取；不统计全库条数，不加载 diff，不启动索引。
- 取消、重新打开和核心退出会结束当前读取。已被替代请求的迟到数据或错误不能覆盖新结果；本次部分数据可以保留，但状态不冒充完整。
- 普通仓库、子目录、unborn / detached HEAD、bare、linked worktree、shallow 和 SHA-256 均有真实 Git fixture。缺对象明确失败，不隐式补拉。

## 环境与构建

本机 Apple M1 Pro，10 个物理 / 逻辑核心，32 GiB 内存；macOS 27.0.1（26A434），Git 2.54.0（Apple Git-157）。构建 Node 26.0.0、pnpm 10.28.1、Rust / Cargo 1.95.0；Electron 45.2.3 内含 Node 24.22.2、Chromium 156.0.8078.80。锁文件保留，未创建 Git commit；构建产物哈希见[首屏报告](../benchmarks/p0-03-first-screen.md)。

`pnpm build:release` 构建优化后的 Rust 二进制及桌面资源，尚未制作签名安装包。最终检查记录位于 `output/playwright/p0-03-verification.json`，逐项日志为同目录 `p0-03-verification-*.log`。最终仓库复测日志为 `p0-03-final-repository.log`，对应 `p0-03-final-repository.json`。

| 检查 | 结果 |
| --- | --- |
| `pnpm protocol:check`、`pnpm typecheck` | schema / 生成类型一致，类型检查通过 |
| `pnpm build:release` | 真实 daemon 和桌面资源构建成功 |
| `pnpm test:protocol` | 18 项通过，含换仓后迟到响应和核心退出时保留部分结果 |
| `cargo fmt --all -- --check` | 通过 |
| `cargo test --workspace --locked` | 22 项通过：core 2、daemon 单元 8、真实进程集成 12 |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过 |
| `pnpm test:repository` | 7 组独立仓库对照与真实 Electron UI smoke 通过 |
| `node --test tests/repository/benchmark-process-tree.test.mjs` | 2 项通过，验证 macOS 退出短名称与 PID 复用的分类边界 |
| `pnpm test:smoke` | 正常启动、失败状态、隔离 / 沙箱、窗口退出与信号回收通过 |

## 正确性与只读证据

`scripts/generate-fixtures.mjs` 使用固定种子 20261107、固定身份和时间生成真实对象；大集合通过流式 fast-import 创建。正常提交用独立 Git log / show 输出作为对照，不调用 Rust 解析器生成预期。

`tests/repository/preview.test.mjs` 的七组检查覆盖：

1. 拓扑仓库的 OID / 父序、摘要、双身份、双时间与偏移、引用及完成状态。
2. 原始消息中的 NUL、无效 UTF-8 和 4 KiB 摘要截断，确认不拆坏 UTF-8 字符并标记损失。
3. 子目录根路径、detached、bare、linked worktree 各自 HEAD / 共享 commonDir、浅克隆和 64 字符 SHA-256 OID。
4. 空 HEAD、无效路径、含空格 / 中文 / 换行路径、缺失 promisor 父对象。
5. 继承的 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_CONFIG_COUNT` 不能重定向读取；外部执行哨兵不触发。
6. 在受控慢 `rev-list` 已启动后取消，收到 CANCELLED 且该 Git 子进程结束。
7. 被发现的 Git 无法启动时返回 GIT_UNAVAILABLE；使用临时可执行文件和不存在的解释器模拟，不修改系统 Git。

读取前后比较整个 fixture 根目录的文件内容、模式和 symlink，包含 linked worktree 的 commonDir；忽略 atime。pager、fsmonitor、外部 diff、textconv、hooks 和 remote helper 配置哨兵未执行。缺失对象查询同样经过文件快照检查，没有 FETCH_HEAD 等补拉副作用。该结论覆盖这些受测读取路径，不外推到尚未实现的 diff / 路径搜索。

主代理另用最终 release daemon 对冻结的 100,000 提交仓库逐条校验前 200 条，独立 `git log` 对照 OID、父关系、摘要、双身份及时间偏移均一致。返回 1 个 repository 帧和 8 个提交帧，每提交帧 25 条、所有帧不超过 512 KiB；最终 `processed=200`、`hasMore=true`。证据：`output/playwright/p0-03-parent-100k-oracle.json`。

## 既有界面验证与审查修复

以下界面证据取自本项已构建版本。用户随后将 UI 设计交给 Claude，本项停止界面调整和进一步视觉验收；这里不评价其后续设计，也不代表新版界面已验证。

UI smoke 实际打开小拓扑仓库，确认 HTML 样式的提交摘要完整出现为字面文本，未生成 img / script 元素；选择 merge 提交后，独立 Git 父列表和双身份出现在详情。继续打开空仓库及不存在路径，确认旧提交不会残留为新结果。窗口关闭后 Electron / daemon 结束；原 smoke 继续覆盖核心崩溃和 SIGINT / SIGTERM。

主代理独立打开 10 万提交仓库，确认渲染 200 行、首行 OID 正确、第二行可选、hasMore 为 true，并检查实际截图布局。证据：`output/playwright/p0-03-parent-preview-final.json`、`p0-03-parent-preview-final.png`。UI smoke 截图：`p0-03-repository-preview.png`、`p0-03-empty-repository.png`。

审查中补齐了 HEAD 状态与 Git 退出码处理、缺失父对象错误映射，修复了路径换行剥离、摘要对照中的正文折叠、Author / Committer 时间显示混用，以及长引用 JSON 帧预算的括号和布尔字段长度误差；新增回归确认旧请求结束不能覆盖新视图。真实 daemon 的 1,800 个长引用测试确认按编码长度截断并保持首屏可读。

测量脚本同时修复首次 CPU 样本遗漏、未等待进行中的采样、Git 进程分类和强制清理被算作成功等问题；失败保留记录，强制清理只用于善后。

## 范围与下一步

10 次启动、进程树 RSS / CPU 原始采样与解释见[首屏基线](../benchmarks/p0-03-first-screen.md)。这些数据不等于发布性能验收。P0-04 继续比较 CLI / gix 局部读取、深页与取消成本，并冻结参考预算。

当前没有分页、持久仓库 session、搜索、图、完整消息 / 文件 diff、统计或外部更新通知；refs 和 HEAD 来自独立命令，不宣称跨命令原子快照。详情展示的是首屏已有元数据。系统 Git 必须支持显式禁用 lazy fetch；较旧 Git 不作允许补拉的降级。此次未验收 Windows、Finder 安装包启动、原生目录面板人工交互、中文输入法实机操作、30 分钟资源稳定性或三个日用仓库。
