# P1-03 虚拟历史验收记录

日期：2026-11-07。状态：P1-03 本机技术验收完成；三轮滚动及未达标 RSS 见[基线](../benchmarks/p1-03-history-scroll.md)，不是发布验收。实现基于 `11ae57b` 之后的本地改动，按[代码级计划](../implementation/p1-03-virtual-history.md)实施。

## 实现范围

- 保留现有界面设计，历史改为最多 2000 条摘要的连续窗口，另保留至多一条旧选择摘要；DOM 仅挂载可见项与前后各 12 项缓冲。日期行和新增分隔行计入高度索引。
- 双向有限预取，整页淘汰和游标反向重读。显式翻页先导航窗口内相邻页，边缘才读 Rust；键盘、详情上下条和完整 OID 复制沿用同一选择状态。
- 新增标记由 Rust 正向读取旧 tips 的可达历史判定。首次无标记、曾查看空仓库全部新增；全局新增计数和已验证前缀共同决定分隔线。损坏记录、旧链缺失、比较预算超时均明确降级，不妨碍历史读取；显式取消仍返回 CANCELLED。
- 比较基准在打开/刷新时冻结；刷新候选页与最终 session 使用同一份 previousView。中途记录查看不改变当前比较。过期翻页、切仓和选择意图分别判旧。

## 已完成检查

| 检查 | 结果 |
| --- | --- |
| Rust test | core 3、daemon unit 21、startup 12，共 36 项通过 |
| Rust fmt / Clippy | `cargo fmt --all -- --check`；`cargo clippy --workspace --all-targets --locked -- -D warnings` 通过 |
| schema | `pnpm protocol:generate` 与 `pnpm protocol:check` 通过 |
| TypeScript | `pnpm typecheck` 通过 |
| renderer | `pnpm test:renderer`：30 项通过 |
| 协议 / main | `pnpm test:protocol` 与 Electron Node 模式各 26 项通过 |
| 会话回归 | `pnpm test:sessions`：10 项通过 |
| 历史集成 | `pnpm test:history`：16 项通过、1 项大仓诊断按计划跳过；日志 `output/test/p1-03-history-r2.log` |
| release 大仓标记 | 独立 Git 与 daemon 均为 100 条新增，单次首次页 API 1197.01 ms；`pnpm test:history --release-marker-only` 通过，见滚动基线 |
| 查询期间 GC | 已缓存新增计数后删除旧链中间对象，下一页降级并清除第一页缓存标记：定向 1 项通过，`output/test/p1-03-marker-missing-intermediate-final-r2.log` |
| 启动 / 隔离 | `pnpm test:smoke` 通过，验证真实核心、sandbox/contextIsolation、关闭窗口及 SIGTERM/SIGINT 回收 |
| 刷新窗口 | `pnpm test:smoke:history` 通过：有效锚点恢复、失效锚点提示、旧选择保留、新增圆点与分隔线；`output/test/p1-03-history-smoke-valid-anchor.log` |
| 虚拟窗口 | `pnpm test:smoke:virtual-history` 通过：2205 条正反向遍历、2000 上限、键盘/复制/只读、活动页导航与淘汰锚点；`output/test/p1-03-virtual-history-smoke-active-page.log` |

双运行时命令：

```sh
pnpm test:protocol
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-protocol.mjs
```

历史集成对照独立 Git，涵盖首次查看、空 tips、快进跨页、改写、旧 tip GC、拓扑中新旧交错、分页/刷新只读、取消与比较超时。分隔线在首次证明之后返回，重读早页也返回同一 OID；比较不可用时清除当前查询的缓存标记。

## 审查与修复证据

1. 真实临时仓库复现：old tip 存在而旧链中间对象缺失时，Git 负 tip 查询可能成功退出并误把共同祖先列为新增。实现改为正向旧历史流，不依赖负集合“成功退出”判断完整性；Rust 和独立集成都覆盖这一情况。
2. shallow/grafts 指纹在标记计算后失配时，禁用 query 的标记派生状态并清缓存，避免边界恢复后重试沿用临时计数或分隔线。
3. 切仓先取消并排空旧页请求；打开失败保留可交互旧窗口。异步边界导航应用选择前检查 session 和选择意图，用户的新选择不会被旧 Promise 覆盖。
4. 真实窗口复现快速拖到底后淘汰页的锚点丢失。修复使用 scrollTop 与高度索引即时求锚点、RAF 读取最新模型，并区分程序补偿与用户的新滚动，关闭原生 scroll anchoring。最终 2205 条 smoke 在每次追加/淘汰前后断言同一可见 OID 与像素位置（容差 4 CSS px），通过。
5. 最初测试夹具存在 mktree 标准输入等待、GC 仍受 reflog 保留、虚拟 DOM 的旧定位假设；分别修正后历史集成通过。旧 UI smoke 的外部 fixture commit 触发异步 auto-gc，禁用 fixture 自身自动维护后只读快照稳定；这些失败不作为通过证据。
6. 截图审查发现选中 HEAD 后活动页仍停在旧页，导致上一页错误可用。现点击/键盘选择会同步活动页；store 与真实窗口断言 HEAD 的上一页禁用，已载入相邻页导航不新增 RPC / 保留条数。

最终行为验收使用 release 构建，renderer 产物为 `index-DsWRAPrG.js`。主代理检查了 `output/playwright/p1-03-virtual-history.png` 与刷新标记截图，界面保留原设计和未接入区域的占位标识；刷新最终截图为 `output/playwright/p1-03-history-refresh.png`。这些工程构建不是签名安装包。

## 当前边界

本项仍仅支持 HEAD 范围。多范围导航、SQLite 搜索索引、跨页 Rust 图和 diff 依次属于后续任务。刷新只准备新首屏，任意深页锚点不在返回窗口时保留旧摘要并明确提示，不能据此判定提交不可达。历史图仍为前端有界窗口的临时布局。

10 万提交三轮、每轮 30 秒的名义 60Hz 滚动观测完成：帧间隔 p95 17.3–17.8 ms，无 >100 ms 间隔，DOM 峰值 35 行、保留摘要峰值 2000。所有已观察进程自然退出。短时空闲整树 RSS 540–541 MiB 超过 500 MiB 目标，P4-01 保留修复；普通翻页精确 RPC 到绘制、反向深页性能、1 分钟空闲 CPU 和发布验收未完成。
