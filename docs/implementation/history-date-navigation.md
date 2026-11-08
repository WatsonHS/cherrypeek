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

## 后续调整（2026-11-08）

按用户要求重做了交互，日期定位接口与 Rust 实现不变：左侧可展开的标尺改为列表右缘常显的日期刻度（代替纵向滚动条，按天 / 周 / 月 / 年分段，刻度长短表示提交数，悬停鱼眼放大并显示日期，点击或拖动松开即跳，支持键盘）；日期输入移到列表顶部的固定日期条，按回车或“跳转”才定位；跳转后目标提交位于固定日期下方。规则见 DESIGN「固定日期与日期刻度」，分段与放大计算见 `apps/desktop/src/renderer/lib/time-scale.ts` 及 `tests/renderer/time-scale.test.mjs`，实窗检查并入 `tests/smoke/history-date-navigation-smoke.mjs`。

## 再次调整（2026-11-08）：时间滑轨、日历与回到最新

用户在超大仓库和“历史只有几个月、提交有几万个”的仓库上试用后反馈：覆盖整段历史的密集刻度看不清、按年或按月的索引对短而密的历史没用；真正常用的是找到某一天、甚至某天某个时段（“10 天前下午改了什么”）。过程中试过 Dock 式放大的刻度和年份索引，最终改为：

- 右缘时间滑轨（`components/history-time-slider.tsx`）：只显示当前阅读位置附近的一段时间，每天等高；窗口长度由 `lib/time-track.ts` 的 `windowSpanFor` 按附近的提交数自动选取并取整到固定档位，避免滚动时比例尺抖动。拖动时列表跟随跳到该时刻之前最近的提交，同时只保留一个定位请求、新目标排队；拖到边缘窗口继续滚动；滚轮平移、⌘ 滚轮缩放。刻度层单独记忆化，指针移动按帧合并。
- 顶部日期日历（`components/history-date-calendar.tsx`）取代日期输入框：按提交数着色、可切到月份视图；以今天与最新提交日中较晚者为可选上限。
- 回到最新：日期条上的按钮、列表 Home 与 ⌘↑；最新一页已不在窗口时经 `restoreHistoryWindow` 重新读取第一页。
- 拖动期间不加载右侧提交详情，最后一次跳转落地后才加载，避免详情请求与定位抢核心。

试用中顺带修复三处已有问题：

- 列表预读会取消进行中的日期定位，导致连续跳转或跳转时滚动丢失结果；现在预读等定位完成。
- 元数据索引把 SQLite 的忙 / 锁错误判为损坏，大仓库建索引会失败；现在按可重试处理。
- 活动统计按天超出 3660 项时保留最早的日期，超过十年的仓库会丢掉最近的活动；现在保留最新的。

检查：`tests/renderer/time-track.test.mjs` 覆盖日期换算与窗口长度，`repository-session-store` 增加“预读不取消日期定位”，日期导航冒烟测试改为日历、回到最新、滑轨拖动、滑轨键盘与 Home 键，并核对选中提交与独立 Git 计算一致。实窗另在 87,701 个提交的 Flutter 仓库和自动生成的 3 个月 25,966 个提交仓库上检查：窗口长度分别随位置在 90 天到 1 年、10 天之间变化，拖动时列表跟随，松手后的提交与浮窗时刻一致。
