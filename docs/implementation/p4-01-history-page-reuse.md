# P4-01：复用日期定位页面

日期：2026-11-09。状态：已实现并完成定向检查与本机对比，P4-01 整体仍未达标。上一批导航与内存修改已提交为 `2ec7457`。

## 本批问题与范围

热日期查询已降至几十毫秒，但每次请求仍重复发送仓库信息、全部引用和 200 条记录。renderer 又把历史窗口替换成单页并重建数组、日期索引和引用映射。优先减少这些重复工作，保留当前定位速度与 1800 条摘要上限；本批不同时做首次扫描预热或检查点淘汰策略。

## 代码方案

1. `LocateHistoryDateParams` 增加可选 `knownCursors`（最多九个，每个不超过 512 字节）。省略时沿用原协议；新桌面端始终发送数组，包括空数组。Rust 在固定 Query 内确定真实目标 OID 和页游标，只有完整游标匹配才复用，不能根据 renderer 的局部时间推断全局落点。
2. 新模式先返回 `{ section: "historyDateLocation", location: { oid, cursor, offset, pageSize } }`。已载页命中时该块即终结，processed 为零；未命中先发位置块，再发原 `historyPage` 分块。不重复发送 repository / refs。继续执行取消和 shallow / grafts 指纹检查，错游标回退读取，不扩大缓存预算。
3. main / preload 的日期 API 返回 `HistoryDateLocation`，其中 `page` 为不含仓库与引用的页内容或 null。仍使用原取消、排空、过期会话守卫；其他历史接口不变。
4. renderer 请求附带当前有界窗口的游标。命中时保留页面、commits / refs 数组和窗口 revision，只更新选中 OID、活动页和定位状态；未命中时用当前快照的仓库 / 引用补齐新页。目标 OID 由 Rust 返回，避免再次从页面推算。

## 分工与检查

核心代理负责 core 类型 / history / server；主进程代理负责手写 API / preload / controller；renderer 代理负责状态仓库及受影响用例。主代理统一生成协议、集成和测量，禁止各代理覆盖其他人的文件或在测量期间构建。

只检查新返回契约、已载页不替换数组 / 窗口、错游标回退、乱序时间、取消与过期响应。用同一个十万提交完整索引 profile 和相同滑轨轨迹比较页面传输量、定位时间、整树 RSS；单点内存与五秒采样仍不当作长期预算验收。不重复完整主题 / 平台矩阵。

## 完成记录

- Rust 日期定位定向用例通过，覆盖乱序时间、已载页省略、失效游标回退；controller 协议 21 项和 renderer 状态 38 项通过，包含真实 daemon 往返与数组身份 / 有界窗口保持。TypeScript 与 release 构建通过。
- 实窗集成时发现 transport 的手写参数校验漏接 `knownCursors`，已修复并把真实 compact 往返加入原有集成用例。测量脚本遇到日期请求失败即停止，失败样本不计性能结果。
- 同页定位中位数 10.6 → 0.5 ms，IPC value 的 JSON 大小 352,111 → 145 字节；六个跨页结果与实际拖动落点一致。拖动后整树 RSS 单点 802.0 → 788.0 MiB，renderer 本身未显著下降。详见[实测报告与限制](../benchmarks/p4-01-history-page-reuse.md)。
