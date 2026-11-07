# P2-01：图布局与跨页检查点代码级计划

日期：2026-11-08。状态：已实现并于本机 macOS 通过技术验收，见[验收记录](../validation/p2-01-history-graph.md)与[宽图测量](../benchmarks/p2-01-history-graph-scroll.md)；发布性能尚未验收。基线 `19f6ad2`（P1-06）。沿用已确认的 Claude 界面与无系统标题栏窗口。

## 交付与边界

历史页由 Rust 生成确定性图布局，renderer 只将有界数值转换为可见 SVG。替换 `renderer/lib/graph.ts` 的临时父关系布局；不依赖元数据索引，不增加 Git 写操作、图形定位、拖宽、展开或悬停高亮。搜索结果继续使用独立列表。

同一固定 tips / 拓扑顺序 / 历史边界内，布局不依赖页大小、缓存命中、前后翻页、DOM 可见范围或六列裁剪。更改范围或主动刷新产生新图上下文，不承诺不同快照间 lane 不变。

## 遍历事实

- `history::start_stream` 改为 `rev-list --topo-order --parents <冻结 tips> --`，继续禁用 commitGraph 和隐式执行 / 网络路径。流解析为 `{oid, parents}`，逐项验证当前对象格式与最多 128 个父；行字节上限覆盖 SHA-256 octopus，不再沿用 80 字节 OID 上限。
- 图使用遍历的有效父列表；`CommitSummary.parents` 仍保留 cat-file 对象中的原始父列表。两者不同标记边界，浅克隆不向不存在于遍历的父节点继续画线，grafts 使用实际有效关系。Git 官方语义见 [rev-list](https://git-scm.com/docs/git-rev-list.html) 和 [shallow](https://git-scm.com/docs/shallow)。
- 每次读取前后（含缓存命中）继续核对 shallow / grafts 指纹。变化返回 `SNAPSHOT_CHANGED`；对象缺失不伪造根节点。冻结引用变化本身不改变现有图。

## 协议合同

保持协议 v1，增加桌面必需 capability `historyGraph`。每个 `HistoryCommit` 增加必需的 `graph`；旧预览与搜索摘要仍是 `CommitSummary`，不附图。不新增 IPC 方法。

```ts
type HistoryGraph = {
  lane: number;          // 真实逻辑槽位，0..16383，不因隐藏而压缩
  color: number;         // lane % 6，沿用现有六色 token
  parents: string[];     // 有序有效父 OID，最多 128；原始父仍在 commit.parents
  boundary: boolean;     // 有效父列表与原始父列表不同
  above: number;         // 0..63 bit mask，行顶部的可见活跃槽位
  below: number;         // 0..63 bit mask，行底部的可见活跃槽位
  hiddenLaneCount: number; // 本行前/后及节点占据的隐藏槽位并集大小
  segments: Array<{
    kind: "through" | "incoming" | "outgoing";
    fromLane: number;
    toLane: number;
    color: number;
  }>;
};
```

`through` 从顶部到底部，`incoming` 从顶部到节点，`outgoing` 从节点到底部。只发送至少一个端点在 0..5 的段（最多 256 段）；两端都隐藏则不发送。跨可见边界的曲线由 SVG 裁剪，保留真实端点槽位，不挤成另一条可见分支。段颜色使用其连续槽位：through / incoming 为 fromLane % 6，outgoing 为 toLane % 6。mask 的颜色同为槽位 % 6。

原有页元数据和游标 envelope 不变，整个请求的 sequence 从 0 连续递增：普通历史先发 repository（0），历史块从 1 开始；refresh / scope 先发 session（0）、repository（1），历史块从 2 开始。真实编码字节继续参与 512 KiB 目标分块与 1 MiB 硬上限。main 验证图字段、数量、数值范围、段种类和对应端点 / mask，不接受缺图或不一致的历史页；required capability 防止旧核心被误当作支持新字段。

## 确定性布局与恢复

新增 `crates/daemon/src/graph.rs`，提供无 IO 的布局状态与单行推进。槽位保存下一待见 OID，保留空位。节点优先取已有 incoming 槽位，否则取最左空位；第一父若已在其它槽位则连接它，否则继承节点槽位；其余父按 Git 顺序连接已有槽位或取最左空位。相同父只分配一次。through 仅表示本行前后同一目标的连续槽位，不能把已复用槽位连成同一条线。处理真实全部槽位后再裁剪 wire。

活跃槽位最多 16384，状态估算上限 2 MiB，超限返回明确 `RESOURCE_LIMIT`，保留已经显示的历史。完成遍历后不应遗留未解析的活跃父；不把失败遍历解释为正常终点。单次推进和重放期间检查取消 / deadline。

检查点属于当前 `HistoryState::Query`，每 200 条保存一次：`nextOrdinal`、上一条 `boundaryOid` 与完整有序 active slots（含空位）。隐式起点为空。最多 64 点 / 8 MiB，按实际字符串和容器估算计费；单点超预算可不保存，淘汰不影响结果。页缓存仍最多 8 页 / 16 MiB，计入图载荷。页大小改变仍创建新 query 并废弃旧游标 / 检查点；从起点重算所得图必须相同，无需为跨页大小共享缓存再引入一层生命周期。

顺序页续用 Git 流与布局状态。旧页缓存未命中或取消后重试时，选择最近 `nextOrdinal <= offset` 检查点；从冻结 tips 重启 Git 流，跳过到检查点仅解析 / 核验边界 OID，然后恢复 active slots 并布局至目标页。检查点只减少布局重算，不提供 Git 随机访问，也不承诺旧页常数时间。

页处理使用局部布局状态和有界待提交检查点；摘要读取、标记、边界复核、取消检查和全部帧输出成功后，才发布该页的布局状态、检查点和完成页缓存。失败丢弃当前增量并回收流，已完成页 / 检查点仍有效。lookahead 记录不提前推进布局。会话关闭、范围切换与刷新释放旧查询资源。

## 桌面接入

- `graph.ts` 改为数值到 SVG 路径的纯几何转换，不再遍历 / 推断父关系。只为当前可见提交与缓冲构建路径，继续沿用 60px 行高、节点中心和六色 token。
- 历史图区固定六列，右侧保留 `+n` 区域；每行按真实 hiddenLaneCount 显示，节点位于隐藏列时用提示说明其位置，不画成第六列的节点。边界节点有可见区别和可读提示。
- 日期分组和“上次看到这里”分隔线用下一提交的 `graph.above` 桥接，首条深页也如此；图高度与插入的分组 / 分隔行一致。虚拟窗口裁剪和返回不重新布局。
- 不改变历史 / 搜索的有界摘要预算、取消、选择意图或锚点恢复契约。保留后端尚未接入区域的占位标记。

## 文件与分工

主代理负责本计划、契约审查、文档、release 构建、最终验证与性能结论。继续按用户授权由轻量模型实现，共享工作区；不覆盖他人编辑，不自行提交 / 推送。

1. 核心代理：`crates/core`、`crates/daemon`、协议生成产物；图算法、流父关系、检查点、资源与取消、Rust 行为测试。不要编辑桌面 / JS 测试。
2. 桌面代理：`apps/desktop/src`、手写协议桥接类型、`tests/protocol`、`tests/renderer`、`scripts/test-renderer.mjs`；字段校验、图显示、分组桥接及受影响测试 fixture。不要编辑 Rust / 生成产物。
3. 验证代理：`tests/graph`、`scripts/test-graph.mjs`、`tests/smoke/history-graph-smoke.mjs`、`scripts/benchmark-history-scroll.mjs` 及必要 benchmark fixture helper、package scripts。复用既有 Git / daemon / 进程树辅助，不复制主算法作为 oracle。实窗和性能由主代理协调串行。

## 验收

- Rust 单元验证线性、分叉 / 汇合、三父及多父 merge、长边、多根、重复父、隐藏投影、资源上限、取消与检查点丢弃；独立 Git 集成核对有效父和遍历顺序，并通过可见连接连续性证明图没有错边。
- 同一固定图跨 pageSize 1 / 2 / 7 / 200 / 500、next / previous 往返、超过 8 页和超过检查点缓存的淘汰重读，比较逐 OID 图签名；至少一组长边跨越 200 行检查点。SHA-256、shallow merge 边界、grafts、边界变化、冻结 refs、取消后重试及完整仓库只读快照。
- Electron 真实窗口验证图来源、六列及 +n、隐藏节点、边界、日期 / 查看分隔线桥接、虚拟页淘汰返回、选择 / 锚点、缩放与深浅色，保留截图。搜索与历史恢复做受影响回归。
- release 构建后在 10 万提交、约 1000 refs 的独立 fixture 测量 30 秒滚动及整个进程树；保留多分支图和 refs 清单，不能用单条线加标签冒充宽图负载。通过真实索引控制暂停后台任务并等待停止（若已完成则保留完成状态），每轮记录状态和已处理量，避免索引构建混入图专项测量。暂停索引时的 RSS 仅作实测，不判定“索引完成后空闲 RSS”预算。记录帧 p95 / 最大间隔、DOM、保留窗口、布局 / 深页成本与 RSS。正式三轮在脚本预检后执行，不重复无关矩阵；未达预算明确保留，不把本阶段称作发布验收。
