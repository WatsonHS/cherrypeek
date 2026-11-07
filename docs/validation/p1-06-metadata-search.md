# P1-06 元数据搜索验收记录

日期：2026-11-07 至 2026-11-08。状态：已完成本机 macOS 技术验收，M1 主流程通过；不等同于完整 MVP 或发布性能验收。实现基线为 `05a2f7c`（P1-05）。契约见[代码级计划](../implementation/p1-06-metadata-search.md)。

## 范围与决定

当前冻结范围为完整消息子串、原始 Author / Committer 身份组合、显式 OID 前缀、日期及当前冻结分支 / worktree 范围。用户已确认默认不区分消息大小写；Unicode default full case folding 不附带规范化或去重音，敏感模式字面匹配。身份筛选不受消息开关影响。

搜索只扫描 P1-05 已提交的成员前缀；索引继续构建时自动更新结果窗口，已知覆盖内无命中不代表最终空结果。暂停或故障明确显示实际原因。旧结果版本保留固定 watermark 分页，最新版本围绕 OID 锚点替换有界窗口。此阶段逐页重扫前缀，不声称已经达到大仓搜索延迟目标。

## 当前证据

- P1-05 基线已提交，提交后工作区干净。
- 搜索协议类型由 Rust 生成，nullable 时间边界与游标在 TypeScript 中保留 null；桌面仅暴露三个明确的搜索 / 建议 / 取消接口。
- 独立 Git fixture 预检通过：2614 个 main 可达提交、真实四位十六进制 OID 前缀冲突（2 个候选）、cat-file 原始元数据解析，以及拓扑末尾但提交时间最晚的 root；预检前后 refs / status 未变化。这是测试数据预检，尚不代表搜索实现通过。
- Rust 检查通过：`cargo test --workspace` 共 55 项（core 5、daemon 38、startup 12）；`cargo fmt --check`、`cargo clippy --workspace --all-targets -- -D warnings` 和 `pnpm protocol:check` 通过。新增覆盖 Unicode folding、乱序锚点排名、游标大小、响应分块及空库初始化。
- `pnpm test:search -- --debug` 第 5 轮 6/6 通过（约 70.6 秒），见本地 `output/test/p1-06-search-headless-r5.log`。覆盖独立 Git 元数据对照、全文 / 身份 / 日期 / OID、超过 512 KiB 的跨帧页、旧 partial watermark 全部遍历、迟到高时间提交与锚点、重建 / LRU 淘汰、SQLite 锁期间取消、SHA-256。早期失败包含测试 helper 的分帧契约误读，已按累计 envelope coverage 与固定页元数据修正；不将失败轮次记为通过。
- 受影响后端回归通过：索引 9/9、历史 16 项通过 / 1 项既有计划内跳过、仓库会话 10/10、范围导航 9/9。日志为 `output/test/p1-06-{indexing,history,sessions,navigation}-regression.log`；未重复 P1-03 大仓滚动性能矩阵。
- 最终主进程协议在 Node 26 与 Electron 内置 Node 24 下均 39/39 通过；包含搜索替代 / 取消排空、范围切换与重建、多帧一致性和参数边界。日志为 `output/test/p1-06-protocol-{node,electron}-final.log`。
- 补充 partial 定向用例通过：暂停后仍可搜索已提交前缀，索引状态为 paused，零命中仍不称最终空；恢复后完成。首轮定向测试的 cwd 参数错位已修复，这属于测试 harness，不是搜索功能通过证据。
- TypeScript 与 renderer 状态测试通过，renderer 共 49 项，包含深页双向裁窗、查询改变清旧详情、IME、隐藏时取消 debounce、身份建议抢占后恢复搜索、快速清空 / 重输的历史返回点，以及春秋 DST 日界。release 构建成功。
- 实窗发现并修复搜索首帧 sequence 错用 1 的协议问题：搜索页和身份建议均从 0 开始；对应 Rust 定向测试与带独立序号断言的完整 metadata 集成用例通过，见 `output/test/p1-06-search-headless-seq-r1.log`。最终构建见 `output/test/p1-06-build-release-r2.log`。首次实窗的门控脚本误计历史批次、后续弹层定位假设也已修正，失败轮次不作为完整验收。

## Electron 实窗验收

`pnpm test:smoke:metadata-search` 第 7 轮完整通过，见 `output/test/p1-06-search-smoke-r7.log`。使用 release daemon 与 2614 个真实可达提交验证：

- 从未建索引开始显示 partial，暂停后可继续搜索，恢复后补齐结果；新增高时间提交改变排名时保留选择及像素锚点。
- 连续读取 10 个深页，DOM 虚拟化且缓存有界；双 Author 按 OR、与 Committer / 消息按 AND 组合，命中数与独立 Git 一致。
- Author 时间排序、包含结束日的本地日期、显式 OID、范围切换、手动刷新、清空返回历史及中文 IME。
- 损坏索引时错误可见且历史仍可浏览；显式重建后恢复完整搜索。范围切换和重建保留仍有效的视口锚点，不要求自动跳到排序第一条。

成功截图在 `output/playwright/p1-06-search-{partial,final,filters,history-restored,index-error}.png`，已检查真实搜索与占位区分。基础窗口 / 隔离 / 退出、元数据索引控制与故障恢复、范围 / worktree 导航三项既有 Electron smoke 也通过，日志为 `output/test/p1-06-smoke-{basic,index,scope}-regression.log`。实窗串行执行，临时 fixture / profile 与所启动的进程已清理。

## 本项目仓库试用

通过显式 `--real-repository` 入口只读试用当前项目：1 个冻结 tip、10 个可达且已索引提交。与独立 Git 元数据对照，全文 `metadata` 命中 1 条、精确 Author 命中 10 条、HEAD 前缀 `05a2` 命中 1 条，Author 建议 1 项。

debug daemon 请求至响应的端到端实测约 1–3 ms，具体四项值见 `output/test/p1-06-real-repository.log`。这是 10 条提交的小仓样本，包含协议开销，既不是 UI 延迟，也不是 release 或十万提交的性能验收。应用缓存位于临时应用数据目录，前后 HEAD / refs / index 摘要一致。项目同时有其他代理修改代码，因此不把真实项目工作树的前后快照作为只读证明；完整工作树对照由独立 fixture 测试承担。

## 未验收边界

每页可能重扫索引前缀；没有据此声明大仓搜索延迟已达到发布预算。本项没有重跑 P1-03 的十万提交滚动矩阵，也没有新增整树 RSS 达标证据；此前超出内存目标的记录仍留待 P4-01。Windows / Linux 实窗尚未验收。

路径搜索、完整消息详情、Rust 图、图形定位、diff、统计及真实外部更新通知仍在后续阶段；现有占位不能作为已完成能力。下一项为 P2-01。
