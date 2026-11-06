# P0-03：10 万提交首屏基线

日期：2026-11-07。结论：当前 release 工程构建在本机完成 10 次真实首屏启动，中位数 **1.47 秒**、p95 **1.96 秒**。这是一组开发基线，不是安装包或发布性能验收；本报告形成时 P0-04 尚未完成；后续读取路线与预算结果现已记录于 [M0 基线](m0-baseline.md)。

## 测量对象

- 机器：Apple M1 Pro / MacBookPro18,3，10 个物理及逻辑核心，32 GiB；macOS 27.0.1（26A434）。
- 工具：构建 Node 26.0.0、pnpm 10.28.1、Rust 1.95.0；运行 Electron 45.2.3 / 内嵌 Node 24.22.2 / Chromium 156.0.8078.80。Git 2.54.0（Apple Git-157）。
- 构建：`pnpm build:release`，优化 Rust 与 Vite / Electron 资源；未制作签名安装包。仓库尚未提交，因此以产物和测量脚本 SHA256 标识版本。
- 数据：固定 seed `20261107`，本地生成恰好 100,000 条线性提交、1 个分支引用，SHA-1。100,002 个对象位于 1 个 pack；`git count-objects -v` 的 size-pack 为 19,951 KiB，无 loose object。生成 / 打包不计入打开时间。
- HEAD：`91081e9df378d40ab325f9c04b9cc4774b2c33ee`；目录为 `output/fixtures/p0-03-seed-20261107/large`，manifest 在其上级目录。计数与对象状态由独立 Git 命令确认。

用户已将 UI 设计交给 Claude。本次只使用此前构建的桌面版本，不调整界面；`dist` 全部文件在测量前后哈希一致。结果不评价后续 UI 设计，界面实现变化后需要另记新基线。

| 产物 | SHA256 |
| --- | --- |
| Electron main | `85a33575436ba2111ddce8fc96c7435b15a4a2a24ba5d6c1e82baec0e70c9913` |
| 随桌面资源打包的 Rust daemon（与 target/release 一致） | `aee34fa1b6164ec49b3bf40f6ada15694fc674bcea6bf5b63b4c533517f338cf` |
| `scripts/benchmark-first-screen.mjs` | `651596680a8c3de11d3c1d9b9f97b6a364ea271739f6aabce33cc61c2fb6b19a` |
| `scripts/process-tree-observation.mjs` | `323e6a9400820338aa4caffb8a818d7322e4386a49182f51215de9c39fba1c36` |
| `scripts/generate-fixtures.mjs` | `fa9576bab6247780d4f3c883dcd866babcc62e522c8ccc1d8f99c0f4f073a125` |

## 口径

从 Node 调用 Playwright 启动真实 Electron 前开始，到 200 行真实提交出现、首行选择成功并完成两次 requestAnimationFrame 为止。每轮核对第一行 OID 与独立 Git 输出一致。该耗时包含自动化启动、检查和点击开销；不是纯 Rust 查询耗时，也没有把双 rAF 当作硬件显示延迟测量。

每次使用新的 userData 目录；尚未实现应用索引 / 缓存。OS page cache 未清理、未控制，正式运行前已读取过同一 fixture，所以不能称为磁盘冷缓存。常规桌面应用仍在运行，系统后台负载未隔离；正式运行期间没有并行执行本项目的构建或测试。

100 ms 定时启动 `ps` 采样，记录 Electron 及观察到的所有后代 PID、父 PID、启动时间、命令、RSS 与累计 CPU 时间；退出后按 PID 加启动时间复核。实际相邻样本间隔中位数 102.1 ms，最大 259.2 ms。每轮都捕获 Electron main、renderer / GPU / helper、Rust 和 Git，共 8–10 个 PID，采样无报错、无强制清理，所有捕获进程正常退出。

RSS 是各进程 RSS 同一采样时点之和，可能重复计算共享页。CPU 是各进程首次观察到的累计时间加后续增量，单位为 CPU 秒；资源采样持续到关闭窗口，包含退出阶段。短命 Git 可能在样本之间启动并退出，峰值和 CPU 都是采样估计，不能解释为精确总量；没有测量 physical footprint 或一分钟空闲 CPU。

## 10 次原始结果

| 次数 | 首屏可选择 ms | 进程树采样峰值 RSS MiB | 采样 CPU 秒 | 退出检查 PID 数 |
| --- | --- | --- | --- | --- |
| 1 | 1687.6 | 488.83 | 1.59 | 10 |
| 2 | 1368.0 | 491.31 | 1.47 | 9 |
| 3 | 1419.2 | 491.77 | 1.43 | 9 |
| 4 | 1408.6 | 490.66 | 1.40 | 9 |
| 5 | 1478.4 | 489.58 | 1.43 | 10 |
| 6 | 1957.5 | 496.66 | 1.44 | 8 |
| 7 | 1386.5 | 498.36 | 1.48 | 8 |
| 8 | 1458.7 | 488.83 | 1.40 | 9 |
| 9 | 1885.4 | 490.98 | 1.37 | 10 |
| 10 | 1637.3 | 489.48 | 1.43 | 9 |

| 指标 | 中位数 | p95 / 最大值 | 对应初始目标 |
| --- | --- | --- | --- |
| 首屏可选择 | 1468.5 ms | 1957.5 ms | 无应用缓存首屏 p95 ≤ 3 秒；本次 10 次非安装包数据不构成发布通过 |
| 启动至退出期间采样峰值 RSS | 490.82 MiB | 498.36 MiB | 当前没有对应峰值预算；不能与空闲 RSS ≤ 500 MiB 混用 |
| 采样累计 CPU | 1.43 CPU 秒 | 1.59 CPU 秒（最大） | 不适用空闲 CPU 百分比预算 |

p95 使用 nearest-rank；10 次时恰好为最大值。发布关卡仍需至少 30 次、安装包、固定硬件条件与长时轨迹。

分类采样峰值：Electron main 202.16 MiB，renderer / GPU / helper 合计 296.72 MiB，Rust 3.73 MiB，Git 合计 37.06 MiB。这些类别峰值发生时间可能不同，不相加充当进程树峰值；每个 PID 的原始数据保存在 JSON。

## 证据与复现

- 完整结果 / 原始采样：`output/benchmarks/p0-03-first-screen-20261107-r2.json`。
- 执行日志：`output/playwright/p0-03-benchmark-r2.log`；产物前后对照：`output/playwright/p0-03-benchmark-artifacts.json`。
- fixture 独立确认：`output/playwright/p0-03-fixture-check.json`。
- 最终 release daemon 前 200 条逐字段对照：`output/playwright/p0-03-parent-100k-oracle.json`。
- 功能检查与运行限制见[验收记录](../validation/p0-03-repository-preview.md)。原始数据与生成仓库在忽略目录中，本机可查；源码保留生成器、测试和本报告。

第一次正式尝试在首轮结束时被测量校验拒绝：macOS 将退出进程的命令名缩成 `(commitscope-daem)`，旧汇总代码用短名覆盖已知类别，误报没有采到 Rust。原始失败记录 `output/benchmarks/p0-03-first-screen-20261107.json` 和日志保留，不纳入以上统计。修复按 PID / 启动时间保留分类和完整命令后，用原始 20 个样本重放确认 Rust 存在，小回归 2/2 通过；重放证据为 `output/playwright/p0-03-benchmark-replay.json`。随后重新执行本报告的 10 次；没有重新解释失败数据为成功测量。

```sh
mkdir -p output/fixtures
pnpm fixtures:generate --output output/fixtures/reproduce-100k --large --seed 20261107
pnpm build:release
node --test tests/repository/benchmark-process-tree.test.mjs
pnpm benchmark:first-screen --repository="$PWD/output/fixtures/reproduce-100k/large" --runs=10 --output=output/benchmarks/reproduce-first-screen.json
```

输出目录和 JSON 路径应尚未使用，脚本拒绝覆盖已有结果。没有 UI 改动时可直接使用已构建版本；与其他人协作时先固定被测产物。

## 结论的范围

本次证明这个线性、单分支、已打包的 10 万提交集合可以不建立索引而直接取得首屏，进程树可回收。它没有覆盖分支密集或合并密集仓库的性能，也没有测深页、搜索、diff、缓存暖启动、30 分钟运行或 Windows。

P0-04 以同一数据比较 Git CLI / gix 的局部对象读取和遍历，增加深页、取消延迟与 CPU / RSS 对照，再确定读取路线和预算。该后续验证现已完成，见 [M0 基线](m0-baseline.md)；本页仍保留 P0-03 的原始测量口径。
