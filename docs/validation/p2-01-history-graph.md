# P2-01 图布局与跨页检查点验收记录

日期：2026-11-08。状态：本机 macOS 技术验收完成；发布性能尚未验收。实现基线 `19f6ad2`，本项尚未提交。契约见[代码级计划](../implementation/p2-01-history-graph.md)。

## 实现范围

历史页附带 Rust 生成的图：有效父列表、真实槽位 / 颜色、六列边界连接、隐藏数量和逐行线段。原始提交父列表独立保留；浅克隆与 grafts 导致的差异明确标记。日期组与上次查看分隔线使用下一提交的顶部连接，不依赖当前窗口之前是否还保留摘要。

同一快照内布局与页大小、可见行和缓存命中无关。检查点每 200 行保存，最多 64 个 / 8 MiB；活跃状态最多 16384 槽位 / 2 MiB，历史页缓存仍为 8 页 / 16 MiB（包括图载荷）。失败或取消不发布当前未完成的布局增量。被淘汰页重读仍需要 Git 从冻结 tips 重放，检查点只减少布局重算，不代表随机访问。

## 已有验证证据

- Rust 全量 64 项通过（core 5、daemon 47、startup 12），格式检查、Clippy `-D warnings` 和 `protocol:check` 通过。新增覆盖第一父继承槽位、octopus、重复父、隐藏投影、超过 255 槽的颜色、资源上限、检查点以及响应回调失败不发布未完成状态。
- 桌面类型检查通过，renderer 状态 / 几何测试 51/51。主进程拒绝缺图、mask 与段不符、父边界标记不符、双隐藏端点、跨槽 through 及重复段。
- 完整协议在 Node 26 与 Electron 内置 Node 24 下各 41/41 通过，包含真实 daemon 与受控故障核心。日志：`output/test/p2-01-protocol-node.log`、`output/test/p2-01-protocol-electron.log`。
- 图集成第 3 轮 7/7 通过（约 36.5 秒）。小 fixture 为 251 个 HEAD 可达提交，含 11 父 octopus 与跨 200 行检查点的长边；大 fixture 超过 12800 行，实际经过 64 个检查点和 8 页缓存的淘汰，再比较旧页 / 近页重放签名。各 pageSize、独立多根、冻结引用移动、有效父 / 可见线段连续性、shallow / grafts、SHA-256、取消后同游标重试与只读快照通过。日志：`output/test/p2-01-graph-r3.log`。
- 早期图集成失败属于测试客户端遗漏 hello、把隐藏端点误纳入六列 mask 断言，以及 macOS 临时目录规范化后的 gate 路径不匹配；均已修复，失败轮次不作通过证据。fixture 写入路径在执行前收紧为临时仓库内的绝对路径，未改动项目 Git 元数据。
- 历史分页回归 16 项通过 / 1 项既有计划内跳过，包含固定快照、分页淘汰、取消、只读及新增标记。日志：`output/test/p2-01-history-regression.log`。
- 既有范围导航回归 9/9 通过，含冻结范围、worktree、失败恢复和取消后迟到结果。日志：`output/test/p2-01-navigation-regression.log`。
- `pnpm build:release` 通过；实窗发现隐藏节点误用了不存在的颜色变量，修正为已有 `fill-fg3` 后再次构建通过。最终构建日志：`output/test/p2-01-build-release-r2.log`。

## 真实 Electron 窗口

最终 release 的 smoke r3 通过，使用 2217 条提交的临时真实仓库验证：六列 SVG 裁剪、`+n` 和隐藏节点；日期与“上次看到这里”分隔线的像素连接；搜索后清空条件返回历史时的 OID / 选择 / 像素锚点和图签名；超过 2000 条窗口后的正反向淘汰与恢复；浅克隆边界。0.8 / 1.25 倍缩放与 light / dark 四组中，图高度和起点与提交行一致，图签名不变，隐藏节点使用与 `+n` 相同的主题颜色。浏览前后仓库快照一致，关闭后 Electron 与 daemon 进程 / 进程组退出。

r1 的失败是测试误要求“全部历史加载后的底部”仍有隐藏节点；fixture 的宽图节点实际位于头部。测试改为初屏明确核对隐藏节点，不放松六列、节点和只读断言。r2 通过后，r3 补入每组缩放 / 主题的计算样式断言并通过；未重复其它已通过矩阵。

日志：`output/test/p2-01-graph-smoke-r3.log`。截图位于 `output/playwright/`：`p2-01-history-graph-{0.8,1.25}-{light,dark}.png`、`p2-01-history-graph-last-seen.png`、`p2-01-history-graph-search-return.png`、`p2-01-history-graph-eviction-return.png`、`p2-01-history-graph-boundary.png`。主代理已目视检查深色、分隔线与浅边界截图。

## 读取成本与性能 fixture

13k 检查点用例的定向计时：被淘汰旧页回读 176.63 ms，晚近页回读 72.66 ms。使用 debug daemon，计入 Git 重放、图布局与 IPC；各一次观察，既不是纯布局耗时，也不构成发布翻页延迟验收。日志：`output/test/p2-01-graph-checkpoint-timing.log`。

独立性能 fixture 位于 `output/fixtures/p2-01-wide-graph-20261108/wide-history`，HEAD 为 `d97a306fb4b8b27a1ff8754bd32b45e753cd6c25`。独立 Git 预检确认 100000 个可达提交、1000 个本地引用、8 条长分支与一个 9 父 octopus；最长父边跨度 99999 行，前 2000 行的最大活跃父目标数为 9。清单为相邻的 `manifest.json`，生成日志为 `output/test/p2-01-graph-fixture-generation.log`。这些是数据形状预检，不是滚动性能结果。

## 宽图性能与阶段结论

十万提交 / 千条引用的最终 release 三轮 30 秒测量通过，名义 60Hz 下 RAF 间隔 p95 均为 18.6 ms，最大 33.5 ms，无 >100 ms 间隔；DOM 与图行峰值 35，保留摘要峰值 2000，实际观察到隐藏节点和 `+n`。采样覆盖整个 Electron / Rust / Git 进程树，三轮分别观察 16 / 17 / 18 个进程，均自然退出，无采样错误。详见[宽图滚动基线](../benchmarks/p2-01-history-graph-scroll.md)。

三轮索引均暂停于 processed=0；短时空闲整树 RSS 为 580.13–583.47 MiB，全程峰值 691.70–722.56 MiB。这不是索引完成后的空闲预算验收。反向深页 p95、精确 RPC 到呈现、一分钟空闲 CPU 和长时测量仍未完成，P4-01 的资源待修项保留。

P2-01 的实现、正确性与实窗验证通过，宽图测量已记录；本项完成。下一项为 P2-02 提交详情与文件列表。图形定位 / 返回、完整详情与 diff 不在本项范围，M2 与完整 MVP 尚未完成。
