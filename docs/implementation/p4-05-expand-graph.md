# P4-05：展开完整图线

日期：2026-11-08；2026-11-10 已补齐拖宽和高亮，新一轮宽图交互测量已归档。P4-05 按“满足预算或留下新一轮测量”收尾；严格发布性能验收仍归 P4-01。

## 2026-11-10 性能收尾计划

- 复用 `scripts/benchmark-history-scroll.mjs` 和既有十万提交 / 千引用宽图 fixture，增加 `--graph-interactions`：默认六列、鼠标拖到十二列、展开实际全部图线，每种一次 30 秒固定轨迹。
- 用 `COMMITSCOPE_PACKAGED_APP` 运行现有 macOS release 包，记录包、核心哈希和实际运行时；不修改系统显示设置，沿用现有 60 Hz 显示器。
- 拖宽 / 展开状态滚动时每 150 ms 移动真实鼠标触发高亮；满有界窗口后补 24 次悬停反馈采样。记录 RAF、长任务、有界摘要 / DOM、加载范围、整进程树资源与自然退出。
- 索引暂停时的 RSS 单列为观察值，不用于完整索引空闲内存验收；不重跑全量回归或 P4-01 的 30 分钟稳定性检查。发现实际瓶颈再修正，结果单独存档。

## 本轮代码级计划

- `lib/graph.ts`：可见列数改为可配置，补动态隐藏数量与有界图线追踪。沿提交第一父主线及真实连通段追踪换道，向上到分叉处停止，不按颜色或固定列号猜分支；只使用当前已载图数据。
- `components/commit-list.tsx`：图区右缘加拖动手柄，支持 4–12 列、左右键与双击恢复默认六列；`+N` 仍展开全部，收起恢复自定义宽度。拖宽只改变显示范围，不重新排 lane，不移动纵向锚点。
- SVG 高亮覆盖节点、普通曲线、隐藏直线和日期 / 上次查看分隔桥；悬停优先，离开恢复选中主线，其余透明度 0.4。悬停不改变提交选择，也不发查询。
- 沿用既有真实宽图 smoke，加拖动、键盘、悬停恢复与图签名断言；少量图逻辑测试和类型检查。不跑全量回归或完整大仓性能矩阵，完成后更新本机包。

## 产品行为

- `+N` 表示当前可见列之外的图线数量，随自定义列数更新，和引用标签旁的剩余引用数不同；图线也不与命名分支一一对应。
- 默认最多六列，手动拖宽 / 左右键支持 4–12 列，双击复位。点击图区 `+N` 展开当前浏览范围内的全部图线，收起恢复自定义列数；范围仍由顶栏选择器决定。
- 图宽超出列表时在列表内横向滚动；提交摘要保留可读宽度。展开与收起保留提交选择和纵向阅读位置。

## 文件与实现分工

1. `crates/daemon/src/graph.rs`、`crates/core/src/lib.rs`：保留原 lane 分配、颜色和检查点；补齐被过滤的隐藏连接，用紧凑范围表示隐藏直线，避免每条直线重复发送完整 segment。协议类型与 schema 同步生成。
2. `apps/desktop/src/renderer/lib/graph.ts`：按真实 lane 计算图宽和展开路径；日期与查看分隔使用真实上方连接，不把六位掩码扩充成猜测的图。
3. `apps/desktop/src/renderer/components/commit-list.tsx`：可访问的展开按钮、收起入口和横向滚动；保持提交行 60px、日期行 34px，继续使用有界窗口与虚拟列表。
4. 现有图用例适配完整连接契约，新增少量隐藏连线与展开几何断言。沿用 wide octopus fixture 做一次展开、跨页、收起的 Electron 定向流程。

## 2026-11-08 验证边界

只运行受影响的 Rust 图单元用例、renderer 图用例、类型检查与一条 Electron 流程。构建 Rust 核心和桌面资源后需重启应用。不将本次小规模检查计作大仓性能或完整 P4-05 验收。

## 2026-11-08 检查结果

- Rust 图布局定向 7/7：包含隐藏直线范围、双端隐藏的 incoming/outgoing 和原有布局检查点用例。`segments` 仍限 256，隐藏直线闭区间最多 8192，页缓存继续按序列化字节计量。
- 桌面 controller 定向 1/1：新字段及双端隐藏连接可通过原有业务校验；renderer 图几何 4/4：隐藏边端点、直线、日期桥和宽度。新增几何用例首次因浮点字符串精度断言失败，改用既有用例同样的数值格式容差后通过，生产绘图逻辑未为此改动。
- `pnpm typecheck`、`pnpm build:release` 通过；展开态提示和收起焦点的后续小修已补构建 renderer。构建仍有已知 bundle 大于 500 kB 的提示。
- `node tests/smoke/graph-expansion-smoke.mjs` 通过：431 条可达提交，11 父 octopus 展开显示 11 条图线，隐藏节点、直线和日期桥均绘制；外层窗口宽度不增加；从 200 条续载到 400 条后可收起，回顶后选中 OID 与图签名保持，查看仓库的只读快照不变。首次脚本错误地在虚拟化后查询已卸载的所选行，调整为回顶验证后通过。
- 实窗日志：`output/test/p3-05-graph-expansion-smoke-r2.log`；截图：`output/playwright/graph-expansion/{compact,expanded,expanded-next-page,collapsed}.png`。已适配现有 graph oracle 和旧 smoke 的展开按钮定位，本轮未运行旧的 2205 提交完整 smoke、13k 检查点矩阵或性能测量。

## 2026-11-10 交付与检查结果

- `graph-resize-handle.tsx` 提供视口内拖动手柄与键盘操作，复用原图列坐标；`commit-list.tsx` 处理自定义宽度、隐藏数量、高亮上下文、日期和查看分隔桥。未修改 Rust 布局、协议、分页和图颜色。
- `graphHighlight` 只追踪有界已载图的真实连通主线；同色的第 0 / 6 / 12 列不会一起高亮，列号复用后的不相连提交不会误亮。隐藏直线按颜色合并的路径保留，另绘单条高亮线，避免扩大 SVG 节点数量。
- `COMMITSCOPE_RENDERER_TEST_FILES=graph.test.mjs pnpm test:renderer`：6 项通过，覆盖动态隐藏数量、手动列数下的直线 / 日期桥裁切、第一父换道、分叉停止与列复用。
- `pnpm typecheck`、`pnpm package:mac` 通过，更新 `release/mac-arm64/CommitScope.app` 和 `release/CommitScope-0.1.0-arm64.dmg`。打包日志 `output/benchmarks/p4-05-interactions-package.log`。
- `COMMITSCOPE_PACKAGED_APP='/Users/huangsheng/Development/commitscope/release/mac-arm64/CommitScope.app/Contents/MacOS/CommitScope' node tests/smoke/graph-expansion-smoke.mjs` 通过：431 提交、1,000 refs、11 父 merge；鼠标拖宽、4 / 7 / 12 列键盘调整、双击复位，悬停与选中高亮切换、隐藏直线高亮、完整展开和跨 200 / 400 条分页后收起。选择、纵向锚点和后端图签名保持；仓库文件快照不变。
- 实窗发现横向滚动会清空刚设置的悬停高亮，已改为只在纵向滚动时清空，并在指针移动时恢复当前行。修复后同一流程通过。截图 `output/playwright/graph-expansion/resized-highlight.png`。

本轮未跑完整回归、Rust 测试、10 万提交性能矩阵、进程树资源采样或 Windows 检查；1,000 refs 的功能流程不作为滚动性能达标证据。未公开发布、未推送。

## 2026-11-10 性能收尾结果

已运行真实 macOS release 包的十万提交 / 千引用测量，详见[图宽与高亮交互报告](../benchmarks/p4-05-graph-interactions.md)。默认六列、拖宽十二槽、展开九条实际图线的最近完整采样 RAF p95 为 16.8 / 17.4 / 17.4 ms；满 1,800 条摘要后的悬停高亮最大 17.9 ms，DOM 峰值 37 行，交互整树 RSS 峰值 718.7–725.3 MiB（索引暂停口径）。

只有默认轮满足严格的开始 / 结束原生焦点条件；其他宽图轮次焦点变化，作为观察值保留。首轮默认状态一次 300.5 ms 停顿在两次复测中未再出现，未确定原因；R4 拖宽轮因测量前失焦提前结束。报告保留所有异常，不宣称全部 60 Hz 或发布关卡通过。

本次只改测量脚本、命令入口和文档，未修改应用渲染路径；`pnpm package:mac` 完成并更新本机 `.app` / `.dmg`。未重跑全量回归或 30 分钟稳定性检查。
