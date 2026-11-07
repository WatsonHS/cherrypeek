# P2-01：宽图历史滚动基线

日期：2026-11-08。基线 `19f6ad2` 之后的 P2-01 本地改动。结论：十万提交 / 千条引用宽图的三轮名义 60Hz 滚动观测通过；每轮帧间隔 p95 为 18.6 ms、最大不超过 33.5 ms，摘要与 DOM 保持有界。本报告是实现基线，不是发布性能验收。

## 环境与构建

- MacBookPro18,3 / Apple M1 Pro，10 核、32 GiB，macOS 27.0.1。构建 Node 26.0.0；运行 Electron 45.2.3 / Node 24.22.2 / Chromium 156.0.8078.80。
- 最终 `pnpm build:release` 日志：`output/test/p2-01-build-release-r2.log`。renderer 为 `index-Db2BtSRx.js`，SHA-256 `f69640757a031516eeeb829e98aae3908516fe7875f56841741b1eb2618147da`。
- dist 与 target/release 的 daemon 哈希一致：`a87948270fe2899eb4b71935deaf60d58483c45e0dd7c125f71b94bad100a6c3`。这是优化工程构建，尚非安装包。
- 三轮使用独立 userData。窗口位于既有显示器 2，开始与结束 API 报告均为 59.9967003 Hz；每轮 300 次前台检查均 visible / focused，没有改变系统显示设置。

## 数据形状与采样口径

独立 fixture 为 `output/fixtures/p2-01-wide-graph-20261108/wide-history`，HEAD `d97a306fb4b8b27a1ff8754bd32b45e753cd6c25`。生成器与测量前的独立 Git 预检均确认：100000 个可达提交、1000 个本地引用、8 条长分支、一个 9 父 octopus、共享根；最长父边跨 99999 行，前 2000 行最大活跃父目标数为 9。相邻 `manifest.json` 保存全部 refs 和数据形状。它不是仅增加引用标签的线性历史；原 P1-03 fixture 未替换。

每轮先通过真实索引控制暂停后台任务，结果均为 `paused`、processed=0。静置约 2 秒后滚动 30 秒：向下 23 秒、向上 7 秒，速度 8000 CSS px/s。测量与构建 / 测试串行；OS page cache 未清空。每帧记录 RAF timestamp 间隔，每 100ms 记录 DOM / 图节点与整个 Electron 子进程树，覆盖 main、renderer、GPU / helper、Rust 和捕获到的 Git。RSS 求和可能重复计入共享页；100ms 采样可能遗漏短命进程的峰值，CPU 是 ps 累计时间差估计。

## 三轮实测

| 指标 | 第 1 轮 | 第 2 轮 | 第 3 轮 | 说明 |
| --- | ---: | ---: | ---: | --- |
| RAF 间隔 p95 | 18.6 ms | 18.6 ms | 18.6 ms | 本轮低于 20 ms 目标 |
| 最大 RAF 间隔 | 18.8 ms | 33.5 ms | 33.4 ms | 均无 >100 ms 间隔 |
| >20 ms 间隔数 | 0 | 1 | 1 | 样本数分别 1801 / 1800 / 1800 |
| renderer 长任务 | 0 | 0 | 0 | PerformanceObserver 观测 |
| DOM 提交行 / 图行峰值 | 35 | 35 | 35 | 仅可见项与 overscan |
| 保留摘要峰值 | 2000 | 2000 | 2000 | 10 页窗口，发生旧页淘汰 |
| 有隐藏线的图行峰值 | 35 | 35 | 35 | 采样到实际 +n，最大节点 lane 为 7 |
| 当前 DOM 图路径峰值 | 210 | 210 | 210 | 不包含未挂载行 |
| 加载状态到窗口更新 p95 | 67.0 ms | 54.0 ms | 54.3 ms | 每轮 15 个前向样本 |
| 暂停索引时短时空闲整树 RSS 峰值 | 580.89 MiB | 583.47 MiB | 580.13 MiB | 非索引完成后的空闲口径 |
| 全程整树 RSS 峰值 | 692.11 MiB | 691.70 MiB | 722.56 MiB | 含启动、暂停操作与滚动 |
| 全程累计 CPU 估计 | 13.34 s | 13.57 s | 13.52 s | 非空闲 CPU 百分比 |
| 已观察进程退出 | 16/16 | 17/17 | 18/18 | 自然退出，无强制回收或采样错误 |

加载耗时从列表 loading 状态被观察到开始，到窗口 offset / count 改变后的下一次 RAF；不是精确 RPC 开始到合成器呈现时间。三轮共 45 个前向样本，7 秒反向滚动仍处于保留窗口内，无反向 RPC 样本。跨页 / 淘汰恢复正确性另由 2217 条真实窗口 smoke 和超过 64 检查点的 13k headless 用例验证，见[验收记录](../validation/p2-01-history-graph.md)。

## 检查点回读与未验收范围

13k fixture 的独立单次 debug daemon 诊断：被淘汰旧页回读 176.63 ms，晚近页回读 72.66 ms，包含 Git 重放、布局与 IPC；不是纯布局耗时或 release p95。检查点减少布局重算，Git 仍从冻结 tips 重放，不提供常数时间随机访问。日志：`output/test/p2-01-graph-checkpoint-timing.log`。

暂停索引时短时空闲整树 RSS 已为 580–583 MiB，数值高于 500 MiB 目标，但不能据此给“索引完成后空闲 RSS”作通过 / 失败判定。JSON 的对应预算为 null、`completeIndexRssBudgetApplicable=false`。原 P1-03 的 RSS 待修项保留，P4-01 需定位整树资源并补索引完成后的同口径测量；两个 fixture、引用数量和索引状态不同，不能把差值归因于图布局。

本轮未测一分钟空闲 CPU、30 分钟持续运行、精确 RPC 到绘制、十万提交反向深页 p95 或一千条同时活跃的图线。RAF 也不直接等于物理屏幕呈现时间。P2-01 的“满足预算或留下测量”条件已有证据，完整发布预算仍未验收。

## 证据与复现

- 原始三轮 JSON：`output/benchmarks/p2-01-history-graph-scroll.json`。
- 原始文件 SHA-256：`62cff75eec786a6f7797929bd6ce0d21c8c266c3e013e6d1a2df3426041b2b8a`。
- 运行日志：`output/test/p2-01-history-graph-benchmark.log`；fixture 日志：`output/test/p2-01-graph-fixture-generation.log`。
- 图专项复用 `scripts/benchmark-history-scroll.mjs`，通过 `--graph-manifest` 显式启用；原 P1-03 profile 保留。每次输出必须使用新文件名，不覆盖旧结果。

```sh
pnpm fixtures:graph-benchmark --output="$PWD/output/fixtures/local-p2-01-wide"
pnpm build:release
pnpm benchmark:history-scroll:graph --repository="$PWD/output/fixtures/local-p2-01-wide/wide-history" --graph-manifest="$PWD/output/fixtures/local-p2-01-wide/manifest.json" --runs=3 --output="$PWD/output/benchmarks/local-p2-01-history-graph-scroll.json"
```

fixture 生成和 release 构建完成后再测量，期间不要并行运行项目构建或测试。生成的仓库、JSON 和截图位于已忽略目录；源码保留生成器、测量脚本和本报告。
