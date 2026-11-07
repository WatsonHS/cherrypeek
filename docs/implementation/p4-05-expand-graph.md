# P4-05：展开完整图线

日期：2026-11-08。状态：展开与收起已实现并通过本机定向检查；拖宽、悬停或选中高亮仍留在 P4-05。

## 产品行为

- `+N` 表示当前行六列以外的图线数量，和引用标签旁的剩余引用数不同；图线也不与命名分支一一对应。
- 默认保留六列。点击图区 `+N` 展开当前浏览范围内的全部图线，提供收起入口；范围仍由顶栏选择器决定。
- 图宽超出列表时在列表内横向滚动；提交摘要保留可读宽度。展开与收起保留提交选择和纵向阅读位置。

## 文件与实现分工

1. `crates/daemon/src/graph.rs`、`crates/core/src/lib.rs`：保留原 lane 分配、颜色和检查点；补齐被过滤的隐藏连接，用紧凑范围表示隐藏直线，避免每条直线重复发送完整 segment。协议类型与 schema 同步生成。
2. `apps/desktop/src/renderer/lib/graph.ts`：按真实 lane 计算图宽和展开路径；日期与查看分隔使用真实上方连接，不把六位掩码扩充成猜测的图。
3. `apps/desktop/src/renderer/components/commit-list.tsx`：可访问的展开按钮、收起入口和横向滚动；保持提交行 60px、日期行 34px，继续使用有界窗口与虚拟列表。
4. 现有图用例适配完整连接契约，新增少量隐藏连线与展开几何断言。沿用 wide octopus fixture 做一次展开、跨页、收起的 Electron 定向流程。

## 验证边界

只运行受影响的 Rust 图单元用例、renderer 图用例、类型检查与一条 Electron 流程。构建 Rust 核心和桌面资源后需重启应用。不将本次小规模检查计作大仓性能或完整 P4-05 验收。

## 实际检查结果

- Rust 图布局定向 7/7：包含隐藏直线范围、双端隐藏的 incoming/outgoing 和原有布局检查点用例。`segments` 仍限 256，隐藏直线闭区间最多 8192，页缓存继续按序列化字节计量。
- 桌面 controller 定向 1/1：新字段及双端隐藏连接可通过原有业务校验；renderer 图几何 4/4：隐藏边端点、直线、日期桥和宽度。新增几何用例首次因浮点字符串精度断言失败，改用既有用例同样的数值格式容差后通过，生产绘图逻辑未为此改动。
- `pnpm typecheck`、`pnpm build:release` 通过；展开态提示和收起焦点的后续小修已补构建 renderer。构建仍有已知 bundle 大于 500 kB 的提示。
- `node tests/smoke/graph-expansion-smoke.mjs` 通过：431 条可达提交，11 父 octopus 展开显示 11 条图线，隐藏节点、直线和日期桥均绘制；外层窗口宽度不增加；从 200 条续载到 400 条后可收起，回顶后选中 OID 与图签名保持，查看仓库的只读快照不变。首次脚本错误地在虚拟化后查询已卸载的所选行，调整为回顶验证后通过。
- 实窗日志：`output/test/p3-05-graph-expansion-smoke-r2.log`；截图：`output/playwright/graph-expansion/{compact,expanded,expanded-next-page,collapsed}.png`。已适配现有 graph oracle 和旧 smoke 的展开按钮定位，本轮未运行旧的 2205 提交完整 smoke、13k 检查点矩阵或性能测量。
