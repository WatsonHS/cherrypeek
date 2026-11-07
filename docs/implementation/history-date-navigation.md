# 左侧时间刻度与日期定位

日期：2026-11-08。状态：已实现并完成本机定向检查。

## 交互

- 历史列表左缘增加窄时间标尺，收起时仅显示刻度；点击展开具体日期，再点击日期跳转。展开层覆盖列表局部，不改变列表宽度；点击外部或 Esc 收起。
- 展开层提供日期输入，允许直接跳往未加载的历史。日期按设备本地自然日解释，使用 Committer 时间；当天无提交时定位到该日以前最近一次提交。该日及之前没有提交时保留现有列表并提示。
- 刻度跨度来自当前同快照、无筛选的提交时间活动统计，统计尚未就绪时使用已加载提交的日期。刻度只是日期导航，不能把部分统计或窗口边界当作完整历史边界。
- 保持当前分支范围、固定快照和分支图，不进入日期筛选。搜索结果列表不显示时间标尺。定位期间可取消，切换范围、刷新或新的选择不能被迟到结果覆盖。

## 代码与契约

```ts
// 复用 historyPagination 能力、historyPage 分块、cancelHistoryRead。
locateHistoryDate(beforeTimestamp: number, pageSize?: number): Promise<RepositorySessionResult<HistoryPage>>;
// wire params: { beforeTimestamp: number, pageSize: number }
```

1. Rust `core` 增加日期定位请求；`daemon/history.rs` 对冻结 tips 做有界流式扫描，仅读取 OID 与 Committer 时间，选择小于排他上界的最大时间，同时间保留拓扑序首次出现的提交。必须读完扫描才能确定目标，不能依赖时间单调、Git 时间剪枝或未完整的元数据索引。
2. 目标 OID 复用现有历史定位、图布局、检查点及游标路径；返回页包含该目标。无结果使用 `SCOPE_UNAVAILABLE` 与日期专用提示。不在 renderer 保存全仓摘要，也不新增后台索引。
3. main / preload 接入明确的业务接口，复用历史请求的取消域、聚合器与会话判旧。原 OID 定位行为保持不变。
4. renderer store 复用现有定位窗口替换逻辑；根据返回页选择满足上界的最大提交时间 OID。日期上界复用 `search-date.ts` 的本地日界转换，跨夏令时不假设一天固定 86400 秒。
5. 独立 `history-time-rail.tsx` 管理展开、具体日期和焦点；`CommitList` 提供视口日期，`app.tsx` 连接同会话统计、跳转与选择意图。跳转不触发刷新或 checkout。

## 分工和检查

核心代理负责 Rust、生成协议、手写协议及 main / preload；桌面代理负责 renderer；验证代理准备单个小型实窗场景；主代理维护计划和集成。保留并行引用标签修改。

只跑日期定位的少量 Rust 用例、类型检查、构建和一个跨页日期跳转实窗；不跑全量回归或大仓性能矩阵。实现改动暂不自动提交。

## 实际证据

- `pnpm protocol:generate` 成功。
- Rust 两项定向用例各 1/1 通过：`locate_history_date_selects_maximum_eligible_committer_time_in_topology_order` 覆盖非单调时间、同时间拓扑次序与跨页；`locate_scope_miss_and_cancellation_preserve_existing_cursor` 覆盖日期无结果、取消及已有游标可继续读取。
- `pnpm typecheck` 和 `pnpm build:release` 通过。初次集成发现缺少 `latestCommitBefore` 辅助函数，补齐后类型检查通过；Vite 的主 bundle 超过 500 kB 提示仍在，未扩展到性能优化。
- `node tests/smoke/history-date-navigation-smoke.mjs` 一次通过：450 条真实 Git 提交跨 3 个本地日历年，独立 Git 对照目标位于拓扑序第 351 条（零基序号 350）。确认默认收起、点击展开日期、点击外部 / Esc 收起、跨页精确定位、跳转后继续滚动，以及浏览前后仓库只读快照一致。
- 日志：`output/test/history-date-navigation-smoke.log`。截图：`output/playwright/history-date-navigation/{collapsed,expanded,located}.png`；已目视确认收起与展开状态。未运行完整回归、全主题 / 缩放矩阵或大仓定位性能测量。
