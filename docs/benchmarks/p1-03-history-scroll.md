# P1-03：虚拟历史滚动基线

日期：2026-11-07。实现为 `11ae57b` 之后的 P1-03 本地改动。结论：有界窗口和本轮名义 60Hz 滚动观测通过；短时空闲进程树 RSS 超过 500 MiB 目标，留给 P4-01 修复。本报告不是发布验收。

## 环境与口径

- MacBookPro18,3 / Apple M1 Pro，10 核、32 GiB，macOS 27.0.1。构建 Node 26.0.0；运行 Electron 45.2.3、Node 24.22.2、Chromium 156.0.8078.80。
- `pnpm build:release` 工程构建；renderer 为 `index-DsWRAPrG.js`，SHA-256 `c68c8e00e687d9b36ccdbc9bf61aad969b440651fb260599f751a68d5868285f`。dist 与 target/release 的 daemon 哈希一致：`2570cf28179bcc6c999b9873db7f08d2f7ac86ca614aae8f0a10cce6ecfe6df9`。不是签名安装包。
- 冻结 fixture：`output/fixtures/p0-03-seed-20261107/large`，100,000 条线性历史，HEAD `91081e9df378d40ab325f9c04b9cc4774b2c33ee`；本轮没有修改仓库。
- 每轮新 userData，首次查看无新增比较。窗口移到已存在的显示器 2，API 报告开始/结束均为 **59.9967003 Hz**；没有修改系统显示设置。另两块屏约 120Hz。每轮 300 个采样点均 visible、focused，结束仍是同一显示器。
- 三轮，每轮静置约 2 秒后固定滚动 30 秒：向下 23 秒、向上 7 秒，速度 8000 CSS px/s，以帧时间差增量滚动。没有并发项目构建或测试；OS page cache 未清空，不能称冷磁盘缓存。
- 每帧记录 RAF timestamp 间隔，每 100ms 记录 DOM、保留数据和进程树；每轮 1800 个帧间隔。RSS 为 Electron main / renderer / GPU / helpers / Rust / Git 总和，可能重复计入共享页；短 Git 进程可能漏采样。CPU 是 ps 累计时间差估计，涵盖启动、短时静置、滚动与退出。

## 实测

| 指标 | 第 1 轮 | 第 2 轮 | 第 3 轮 | 判断 |
| --- | ---: | ---: | ---: | --- |
| RAF 间隔 p95 | 17.3 ms | 17.8 ms | 17.8 ms | 本轮低于 20 ms 目标 |
| 最大 RAF 间隔 | 35.2 ms | 35.0 ms | 33.5 ms | 没有 >100 ms 间隔 |
| >20 ms 的间隔数 | 1 | 1 | 1 | 每轮 1800 个样本 |
| renderer 长任务 | 0 | 0 | 0 | PerformanceObserver 观测 |
| DOM 提交行峰值 | 35 | 35 | 35 | 可见项加 overscan，非全窗口 DOM |
| 保留摘要峰值 | 2000 | 2000 | 2000 | 达到上限并淘汰旧页 |
| 加载状态到窗口更新 p95 | 50.1 ms | 54.6 ms | 56.2 ms | 每轮 15 个前向加载样本，见下方限制 |
| 短时空闲进程树 RSS 峰值 | 541.11 MiB | 540.14 MiB | 541.36 MiB | **超过 500 MiB 目标** |
| 全程进程树 RSS 峰值 | 652.98 MiB | 653.86 MiB | 653.23 MiB | 与空闲值分别记录 |
| 全程累计 CPU 估计 | 8.92 s | 9.17 s | 9.05 s | 不是空闲 CPU 百分比 |
| 已观察进程退出 | 13/13 | 11/11 | 13/13 | 全部自然退出，无强制清理或采样错误 |

加载耗时从 renderer 的 loading 状态可见，到载入窗口属性变化后下一次 RAF，**不是精确的 RPC 请求开始到合成器绘制时间**。因此不能据此宣布“普通翻页 p95 ≤200ms”发布关卡通过。三轮共 45 个前向样本；7 秒回滚仍在已保留窗口内，没有反向 RPC 样本，反向淘汰重读的正确性由 2205 条 Electron smoke 验证。

本轮约 2 秒的空闲 RSS 仅为短窗口观测；一分钟空闲 CPU、30 分钟持续运行、索引完成后的内存、复杂多分支图和大引用集合均未验收。P4-01 应先按同一全进程树口径定位 RSS 超额，再复验完整发布预算，不能改用单一进程或另一种内存口径宣称达标。

## 有旧记录时的单次观测

独立应用数据目录中模拟 previous tip 为当前 HEAD 的第 100 个祖先，不修改冻结仓库；release daemon 读取首批 200 条，独立 Git 预期 100 条新增，返回也是 100 条，分隔线为旧 tip，状态 ready。

首次页 API 耗时 **1197.01 ms**（请求至完整响应），包括主历史读取、计数与正向旧历史判定。它是单次诊断，不是 p95，也不能和没有比较记录的普通预取混为一组。旧历史正向扫描的成本是本项为缺失对象正确性付出的代价；超出比较预算时明确降级。

## 原始证据与派生修正

- 原始三轮数据：`output/benchmarks/p1-03-history-scroll.json`。
- 派生评估：`output/benchmarks/p1-03-history-scroll-assessment.json`，记录原始文件 SHA-256 与修正原因。
- marker 单次诊断：`output/test/p1-03-history-100k-marker-release.log`。
- 实现/测量脚本：`scripts/benchmark-history-scroll.mjs`；每次输出使用新文件路径，不覆盖旧结果。

原始数据里的 `sixtyHzModeConfirmed=false` 及受它影响的帧预算布尔值，来自脚本将浮点频率与整数 60 做精确等值比较。测量的频率、帧间隔和前台记录没有改变；脚本已改为名义 60Hz 的 ±0.5Hz 容差，并要求同一显示器及持续前台。派生评估重新计算这两个布尔判断，保留原 JSON；没有为这项判断修复重复三轮测量。物理面板扫描与合成器实际呈现时间仍不由 RAF 直接证明。

复现命令（先完成构建，测量时不要并行测试）：

```sh
pnpm build:release
pnpm test:history --release-marker-only
pnpm benchmark:history-scroll --repository="$PWD/output/fixtures/p0-03-seed-20261107/large" --runs=3 --output="$PWD/output/benchmarks/p1-03-history-scroll-local.json"
```
