# M5 / M6 后端验证记录

日期：2026-11-12。实现版本：当前工作区 Rust 与生成协议改动，尚未提交。验证环境：macOS 27.0.1 / Apple Silicon / Git 2.54.0，项目锁定工具链。

范围为 Rust 核心、daemon、生成协议和测试。没有修改桌面 main / preload / renderer 的手写实现或协议手写接口；已有并行界面改动保留。任务中的桌面接线、图表交互、实窗与发布验收不在本次完成声明内。

## 接口与任务结果

完整请求、响应、可空字段、枚举、截断与 coverage 语义见 [最终接口约定](../implementation/m5-m6-backend-contract.md)，生成的 Rust schema / TypeScript 是类型来源。

| 任务 | 后端实现及最终字段摘要 | 对照证据 |
| --- | --- | --- |
| P5-02 | `getBranchSync` 返回 branches / lastFetchUnixMs；`checkOperation` 返回 allowed / blockers / preservedDirtyCount；`runOperation` 返回 rejected 或 done / headOid / headReference / updatedRef。fastForward 传 refName / expectedOid / upstreamOid | 当前分支与独立 `merge --ff-only` 对照；其他分支只更新引用，HEAD 与 index 不变；SHA-1 / SHA-256；冻结同步结果；分叉计数与双方示例 |
| P5-03 | switch 传 target / expectedOid / expectedHeadOid；createBranch 传 name / startOid / switchAfter / expectedHeadOid。navigation 增加 remotes / branchUpstreams / lastFetchUnixMs | 与独立 `switch` 对照；创建、远端同名跟踪、无冲突 staged / unstaged / untracked 保留；本地及全局 hooksPath 执行；远端凭据移除 |
| P6-01 | `getActivityOverview`：coverage、当前 / 前周期、时间桶、节奏、星期小时、类型、merge / revert / fixup、作者、分支和时段 | 独立 Git 提交信息对照；纽约春季缺失小时和秋季重复小时、乱序时间、共享祖先、Author / Committer 分离、无索引部分覆盖、仓库快照不变 |
| P6-02 | schema 1 → 2；第一父文件记录保留原始 BLOB 路径、旧路径、状态、增删行、binary；`changes_complete` 区分未补 / 完成 / 浅边界。另存任意父路径并集以保持原搜索语义 | 每个提交与独立 `diff-tree --numstat -M` 对照，含根、merge、重命名、二进制、非 UTF-8；v1 迁移保留元数据；浅克隆补深后完整；文件阶段暂停 / 取消 / 强退续建；旧索引回归 9 项 |
| P6-03 | `getChangeStats`、`getStatsExclusions`、`setStatsExclusions`；含文件数、行数、排除行数、目录 / 作者目录、扩展名、粒度、净增长和时段 | 独立 numstat 汇总；merge 不计文件 / 行，二进制不计行；锁文件 100 行排除后可重新纳入；路径筛选；排除配置写应用目录，仓库快照不变 |
| P6-04 | `getNotableStats` 与 `getStatsCommits`；churnFiles / pairs / soloDirectories / untested 以及回查分页 | 固定真实历史的反复修改、文件对、代码与测试计数及分页；410 个提交 × 50 文件触发 500000 次组合预算，明确 RESOURCE_LIMIT，不返回部分排名 |
| P6-05 | `estimateEvolution` 返回实际 files / totalFiles / lines / bytes / fileLimit / skipped；`analyzeEvolution` 累计推送 progress / result，分离 covered 与 survival.coverage | 独立 `blame --line-porcelain` 汇总归属、年龄与存活；重命名新增分母；binary / excluded / lineLimit / byteLimit / notRegularFile / fileLimit；第二次 gate 证明无新 blame；取消和交互抢占均回收子进程并保留已完成文件 |

M5 共 8 项新增 daemon 测试。拒绝用例在 check 和 run 前后比较整个临时仓库目录树（含 `.git`、工作区、文件内容哈希、权限与 symlink 目标），覆盖脏文件、ignored 冲突、分叉、OID 变化、worktree 占用、进行中操作、无上游、无效 / 已存在 / 父子前缀冲突名称。两个真实 daemon 共用应用数据时，fetch 持锁使另一个写入返回 BUSY，取消释放后可继续操作。快进阶段不执行 fetch；因此拒绝快进的零仓库写入边界明确。

P6 共 10 项新增 daemon 测试。统计走单独的辅助额度；历史请求抢占演化分析的测试同时检查 CANCELLED、已发送的 filesDone=1 累计结果和 Git 子进程退出。其余聚合循环有取消检查，但未逐一对每个聚合阶段施加人为停顿。

## 与草案的主要差异

- 移除 `fetchFirst`：显式 fetch → 刷新引用 → check / run，避免 fetch 已写入后仍把快进拒绝称为零写入。switch 增加目标 expectedOid，createBranch 增加 expectedHeadOid。
- 增加 unsafeState、分叉信息截断字段、navigation 的冻结 upstream 映射；旧测试夹具补齐新增导航字段和 capability。
- 统计增加 capability、section、各列表截断标志、分支 complete、扩展名、累计净增长；新增 `getStatsCommits`。directoryPrefix 使用原始路径 hex，shareOfA 改为整数 shareOfAPerMille。
- 演化结果增加 asOfUnix、skipped、独立 survival.coverage 和累计 chunk。取消后由调用方保留已收到的结果。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `cargo test --workspace --locked` | 通过：5 core + 99 daemon + 12 startup |
| `pnpm protocol:check` | 通过，schema、TypeScript、standalone validators 一致 |
| `pnpm test:pages` | 通过：36 项（原 18 + M5 8 + P6 10） |
| `pnpm test:protocol` | 47 项通过 |
| `pnpm test:indexing` | 9 项通过，含 quota、故障、暂停、取消、强退恢复与浅边界 |
| 本次 Rust 改动文件 `rustfmt --check` | 通过；未格式化无关的 history.rs |
| `cargo clippy --workspace --locked --message-format=short` | 命令完成，有既有 8 条 warning：core 大枚举及 handoff / history / search / updates；未声称 `-D warnings` 通过 |

完整日志在本机忽略目录 `output/validation/m5-m6/`。首次全量检查发现 startup capability 和协议导航夹具落后于新 schema，已修正；同时运行多组回归时启动重试时序用例失败，单独完整重跑 protocol 后通过，没有放宽断言。

没有运行本次 UI 的 `typecheck`、renderer 测试、Electron build、实窗 smoke 或打包验收，不沿用并行界面的结果冒充本次检查。

## 性能实测与限制

- P6-02：十万真实文件改动提交，SQLite 73.33 → 97.73 MiB（+33.3%），冷应用缓存构建 57.61 → 156.33 s（+171.4%），daemon 整树 RSS 采样峰值 90.53 → 98.55 MiB。详见 [索引报告](../benchmarks/p6-02-file-change-index.md)。构建耗时增加明显，尚未发布性能验收。
- P6-05：本仓库真实已提交目录 21 文件 / 25505 行，估计 554 ms、冷分析 2.27 s、热分析 1.94 s；整树 RSS 采样峰值分别 17.66 / 18.22 / 16.44 MiB。详见 [演化报告](../benchmarks/p6-05-evolution.md)。采样可漏过短命进程，只有单次、非独占主机测量。
- M5：当前 Unix/macOS 有跨 daemon 文件锁，其他平台拒绝写入；没有修改本机系统 Git 配置做验证。未验证任意外部 Git 在最终预检后的竞态；update-ref 用旧值 CAS，工作区命令依赖 Git 的最终锁和检查。Git / hook / I/O 执行失败不能承诺零写入。重叠脏路径、当前分支快进含 staged、隐藏 index 标志等保守拒绝。
- P6-01：未覆盖历史时区中所有非一小时跳变 / 整日跳变；UI 的时间选择和图表回跳未验收。
- P6-02：非 UTF-8 路径通过 Git index / tree 对象构造，未依赖 macOS 文件系统创建该路径。历史 attributes 的逐提交分支与极大重命名集合未单独做规模测量。
- P6-03 / P6-04：排名预算明确；最多 250000 索引提交、2000000 文件记录、500000 文件对组合。超过预算报错；不估算未知总量。超预算之外的最坏规模延迟未验收。
- P6-05：200 文件是保护上限，最坏规模完整 blame 未性能验收；只跟随整文件重命名，不做跨文件复制归属。merge 的归属行可使 kept 与排除 merge 的 added 口径不完全对应，返回原值而不强行转成百分比。
