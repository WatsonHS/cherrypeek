# P2-04：历史定位与交互

日期：2026-11-08。状态：实现完成。前置详情与 diff 已提交为 `bd2343c`。本项优先功能接通，只做少量定向检查和一次最终构建。

## 用户路径

1. 搜索结果的详情提供“在历史中定位”。点击后保存原查询、所选 OID、视口顶部 OID 与行内偏移、已发现结果数和当前会话标识。
2. 暂停搜索及部分结果轮询，移除全部字段筛选，只保留原浏览范围和冻结快照。释放不可见的搜索摘要，按目标 OID 加载一页真实拓扑历史并滚到目标；详情沿用已有组件。
3. 横幅说明哪些条件暂时移除，提供“返回 N 个结果”。部分搜索明确称为“已发现 N 个结果”。定位期间可取消，失败显示原因并可返回，不自动换分支或刷新。
4. 返回时释放历史窗口，恢复原查询、选择和滚动锚点，通过原有 anchor 查询恢复结果页。索引推进可能改变结果数，仍按 OID 保持位置；原锚点不可用时明确提示。
5. 仓库、范围或快照改变后清除旧定位上下文，不把旧返回点混入新会话。定位期间编辑查询即使用编辑后的新查询回到搜索，只有“返回”按钮恢复原查询；不新增通用导航栈或保留两套摘要列表。

## 接口与核心

```ts
type LocateCommitParams = { oid: string; pageSize: number };
// Rust method: locateCommit；复用 historyPagination capability。
// wire: 沿用 historyPage 分块、coverage、nextCursor；页内必须含目标 OID。
// preload: locateCommit(oid: string, pageSize?: number): Result<HistoryPage>
// cancel: 沿用 cancelHistoryRead。
```

- `crates/core/src/lib.rs` 增加请求类型；不新增响应结构或错误码。OID 按当前仓库格式检查；范围外返回 `SCOPE_UNAVAILABLE`，说明目标不在当前冻结范围内。
- `crates/daemon/src/history.rs` 在冻结 tips 的拓扑顺序中定位页起点，只扫描 OID / 父边，不逐页读取完整提交元数据。目标页复用既有布局 / 检查点、摘要读取和分页游标；不积累全仓摘要，不破坏已发行游标。
- 深页定位沿用已证明的“上次看到这里”分隔线；尚未证明连续前缀时不补画分隔线，逐提交新增标记仍正常计算，不为此额外扫描全库。
- `crates/daemon/src/server.rs` 接入既有历史 worker、分块与取消规则。定位沿用现有截止时间和边界指纹检查，不增加后台任务框架。
- main / preload 复用历史页聚合器、会话判旧和取消域；成功页必须包含所请求的 OID，不复制一套字段校验器。

## 桌面状态与交互

- `repository-session-store.ts` 添加定位入口，复用页载入、选择及锚点恢复逻辑。定位请求与翻页互斥，换仓 / 范围 / 刷新后迟到结果无效。
- `metadata-search-store.ts` 保存小型返回点，暂停查询时清除有界结果窗口；返回用已有搜索 anchor 参数恢复。主历史 / 搜索仍共用 1800 条摘要预算，merge 页最多 200 条。
- `app.tsx` 串联定位、取消、返回与会话变化；搜索结果详情增加按钮，图上使用现有选中高亮。
- 加入快捷键说明卡，仅列已实现动作。`⌘F` 聚焦搜索，`⌘[` 返回搜索，`⌘]` 从搜索选择定位，`⌘1` / `⌘2` 切换概览 / 文件；浏览、范围和刷新复用既有入口。Windows 对应 Ctrl；不实现 M4 命令面板。
- 仓库刷新使用 `⌥⌘R`（Windows 为 Ctrl+Alt+R），避开 Electron 的窗口重载快捷键；保留标准编辑和缩放行为。
- 输入框 / 可编辑文本和输入法组词期间不抢占浏览快捷键；全局操作也跳过 composition / keyCode 229。使用现有深浅主题 token 和可缩放布局，不改 Claude 的整体设计。

## 分工与检查

核心代理负责 core / daemon / 生成协议；桌面代理负责 apps/desktop、手写协议和少量状态用例；主代理负责计划、集成及构建。共享工作区，保留彼此修改。

仅做定位相关 Rust 定向用例、少量 renderer 返回 / 取消 / 判旧用例、TypeScript 检查和 release 构建。只有实际失败才重跑相关项；不做全量协议 / Electron 实窗 / 大仓性能矩阵，不把未测项写成通过。本项实现改动暂不自动提交。

## 实际检查

- `cargo test -p commitscope-daemon locate_ -- --nocapture`：2 项通过。覆盖已发行游标位置之外的定位及前后翻页、范围外目标和取消后保留旧游标。
- `pnpm protocol:check` 通过；上述 Rust 定向测试完成受影响核心编译，无 warning。

- 最终 `pnpm typecheck` 通过；两项新增 renderer 定向用例 2/2 通过，覆盖搜索窗口释放与 query / 选择 / anchor 恢复，以及取消定位后忽略迟到页。首次类型检查缺少 Button import，补齐后通过；最终针对受影响改动重跑同两项检查。
- `pnpm build:release` 通过，已生成可用 `pnpm start` 启动的 Rust release 二进制与桌面资源；Vite 提示主 bundle 为 514.79 kB，拆分留待性能阶段。
- 同步现有 Electron smoke 的 preload 业务接口白名单，但未运行实窗 smoke、全量回归、中文输入 / 深浅主题 / 缩放矩阵或大仓定位性能测量；完整 M2 用户路径验收仍未完成。
