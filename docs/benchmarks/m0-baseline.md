# M0：技术验证与读取基线

日期：2026-11-07。M0 的技术验证已完成，生产读取继续使用 **Git CLI**。正式 headless 矩阵 180/180 通过；本机 10 万提交历史页中，CLI 比本次 gix topo 配置快，gix 仅在已知 OID 的局部对象读取上有明显收益。详见[读取路线决策](../decisions/0001-git-reader.md)。本报告不是 MVP 或发布性能验收。

## 版本、数据与环境

- 实现提交：`a40828feb3798c3dbfdb5c47562f2c16d260a362`。测量启动时尚无提交，结束前按用户要求创建首次提交；被测二进制、实验源码和脚本全程未变，仅 Cargo.toml 末尾空行在提交前清理。产物哈希仍是本次运行的直接标识。
- Apple M1 Pro / MacBookPro18,3，10 个物理及逻辑核心、32 GiB 内存，APPLE SSD AP1024R 约 1 TB；macOS 27.0.1（26A434）。构建 Node 26.0.0、pnpm 10.28.1、Rust 1.95.0、系统 Git 2.54.0（Apple Git-157，`/usr/bin/git`）。
- gix 0.90.0 / gix-traverse 0.64.0，仅 dev-dependency；关闭默认 features，启用 `sha1,sha256,max-performance`。每个 handle 的 decoded-object cache 与 pack cache 各 8 MiB，空缓存开始；这个容量不是整个进程或遍历图状态的内存上限。
- 复用 P0-03 seed `20261107`：100,000 条线性提交、1 个引用、SHA-1，HEAD `91081e9df378d40ab325f9c04b9cc4774b2c33ee`。100,002 个对象、1 个 pack、size-pack 19,951 KiB、无 loose object。目录 `output/fixtures/p0-03-seed-20261107/large`，manifest 位于上一级。
- 每任务新进程 / 新 handle，不复用应用索引。OS page cache 未清理；独立 Git oracle 先读取同一范围，不称冷缓存。正常桌面后台负载未隔离；正式矩阵期间没有本项目构建或测试并行执行。
- 显示器实查：主内屏 3024×1964 / 逻辑 1512×982，120 Hz；外屏逻辑 1920×1080，60 Hz；另一外屏 4608×2592 / 逻辑 2304×1296，120 Hz。P0-04 是 headless 测量，未控制窗口所在屏幕；未来滚动关卡仍须在固定 60 Hz 下执行。硬件证据 `output/benchmarks/p0-04-hardware.json` 不含序列号。

## 测量口径

四个 offset（0、10,000、50,000、90,000），每页 200 条；page 与 objects 两种任务各为 4 × 2 后端 × 10 次，再加每后端 10 次取消，共 180 次。每组交替后端先后顺序，所有 160 次读取都逐项匹配独立 Node / Git oracle 的 OID 顺序、hasMore、原始字节数和 SHA-256 摘要。objects 使用各 offset 对应的同一组 200 OID，不遍历历史。

`totalMs` 是 Rust job 内部的打开、遍历及对象读取总时间；构造 gix topo walker 的预遍历计入 walkMs。Node job 写入到收到 result 的 wall time另外记录，不含启动 ready 之前、结果后采样和退出。CPU 为 getrusage SELF 与已 wait 的 CHILDREN 用户态 + 内核态增量之和；没有把 ps CPU 再相加。CLI 的进程启动、10 ms 状态轮询和批量 cat-file 开销属于被测实现。

每项 10 次；表中 p95 使用 nearest-rank，此时等于最大值。阶段各自的中位数不能相加冒充 totalMs 中位数。单分支数据限制了结论范围，不能推及复杂 DAG 或百万提交。

## 历史页（遍历 + 200 个对象）

| offset | 后端 | 内部总耗时中位 / p95 ms | walk 中位 ms | 对象读取中位 ms | 整树 CPU 中位 ms | 采样整树峰值 RSS 中位 / 最大 MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | cli | 437.0 / 586.2 | 411.2 | 25.80 | 417.9 | 36.18 / 36.94 |
| 0 | gix | 701.4 / 806.3 | 700.0 | 0.28 | 700.3 | 52.35 / 54.08 |
| 10,000 | cli | 449.3 / 464.6 | 424.2 | 25.87 | 426.6 | 35.44 / 36.11 |
| 10,000 | gix | 771.5 / 964.1 | 770.1 | 0.27 | 767.5 | 52.48 / 54.72 |
| 50,000 | cli | 445.2 / 618.4 | 419.7 | 25.27 | 426.6 | 36.11 / 39.06 |
| 50,000 | gix | 961.7 / 1226.2 | 959.9 | 0.29 | 950.5 | 52.35 / 53.77 |
| 90,000 | cli | 448.3 / 583.0 | 423.6 | 24.38 | 426.2 | 35.75 / 36.72 |
| 90,000 | gix | 1125.5 / 1148.1 | 1124.1 | 0.27 | 1120.8 | 52.06 / 52.55 |

CLI 的各 offset 都花约 0.44 秒：这表明本 fixture 下启动拓扑遍历的成本占主导，不能把“深页没有明显增长”理解为随机访问免费。gix 的 iterator 跳过前缀后耗时继续增加。`visitedCount` 只记录 CLI 输出行数或 gix iterator yield 数，不代表两者相同口径的内部访问节点数。

每页从 HEAD 重新计算已超过普通翻页 200 ms 的目标；这不是最终分页测量，也不因此调松目标。M1 必须复用固定快照的流式遍历会话、提供有界缓存与背压，再测完整 IPC / 绘制延迟。此证据不足以选择持久化图检查点格式，M0 不增加检查点存储系统。

## 已知 OID 的 200 对象读取

| OID 所在 offset | 后端 | 内部总耗时中位 / p95 ms | 整树 CPU 中位 ms | 采样峰值 RSS 中位 MiB（见限制） |
| --- | --- | --- | --- | --- |
| 0 | cli | 25.84 / 26.09 | 13.92 | 2.69 |
| 0 | gix | 1.97 / 2.16 | 1.96 | 3.48 |
| 10,000 | cli | 24.52 / 26.02 | 14.94 | 2.72 |
| 10,000 | gix | 1.97 / 2.06 | 1.94 | 3.50 |
| 50,000 | cli | 25.82 / 25.96 | 14.12 | 2.69 |
| 50,000 | gix | 1.96 / 2.35 | 1.95 | 3.50 |
| 90,000 | cli | 25.83 / 25.93 | 14.03 | 2.68 |
| 90,000 | gix | 1.81 / 2.09 | 1.81 | 3.48 |

gix 对象任务约 1.8–2.0 ms，CLI 约 24.5–25.8 ms。新 handle 打开计入总耗时；gix 在 page 任务中经过遍历后对象已部分热缓存，其约 0.3 ms 对象阶段不能当作新 handle 的独立对象成本。局部收益约 23–24 ms，而 CLI 历史遍历约 411–424 ms；本轮不为这项局部收益引入两套生产读取语义。

**短任务 RSS 不能用于两者内存优劣排名。** 100 ms 采样未捕获这 40 次 CLI objects 的短命 Git，表内只反映被观察到的 reader，显著低估整树峰值；getrusage 的子进程 CPU 仍覆盖已退出并 wait 的 Git。

## 取消与回收

在 started 后约 10 ms 发送 cancel，执行真实反复遍历（最多 100 轮 / 30 秒），没有人工延迟。20 次均在第一轮完成前取消，completedScans=0，返回 cancelled 并正常退出；没有将“先完成后收到取消”算作零延迟。

| 后端 | cancel → result 中位 / p95 ms | cancel → 进程 close 中位 / p95 ms | result 后采样中位 ms |
| --- | --- | --- | --- |
| cli | 2.42 / 12.96 | 55.24 / 64.38 | 51.83 |
| gix | 0.22 / 0.31 | 54.48 / 56.77 | 53.63 |

退出耗时包含结果后的额外 ps 采样，再发送 exit；不把这约 52–54 ms 归因于 Rust 取消本身。CLI 取消 result 发出前已终止并 wait Git。没有测 UI 反馈，不能用此表宣布 100 ms 可见反馈达标。

180 次均无采样错误、无强制清理，按 PID + 启动时间检查的 1–3 个进程 / 次均已退出。40 次 CLI page 都观察到 Git；其他 50 次 CLI 的 Git 太短未被采样捕获，回收结论同时依赖其同步 wait 路径及独立取消测试。每任务包含初始与结果后强制采样及 100 ms 定时采样，相邻样本间隔中位 98 ms、最大 235 ms。RSS 是同一时点进程 RSS 之和，可能重复计算共享页，也可能漏掉瞬时峰值；未测 physical footprint。

## 首屏与冻结预算

沿用 [P0-03 的 10 次真实 Electron 首屏基线](p0-03-first-screen.md)：中位 1468.5 ms，p95 1957.5 ms；启动到退出期间采样峰值 RSS 中位 490.82 MiB、最大 498.36 MiB。这是 Electron 45.2.3 / 内嵌 Node 24.22.2 / Chromium 156.0.8078.80 的先前版本，P0-04 未重建或复测 UI。上述内部历史页数据不能代替此端到端指标。

[VALIDATION](../VALIDATION.md) 的目标值在本项原值冻结，参考机器明确为以上 macOS 机器；Windows 另建基线。现有首屏与后台取消开发数据落在对应目标内，但没有安装包、30 次样本、复杂仓库或长期运行证据，仍不宣布发布通过。

有应用缓存首屏、最终翻页、搜索、diff、60 Hz 滚动、索引完成后的空闲 RSS / 一分钟 CPU、更新提示与刷新、30 分钟轨迹均未测。启动峰值接近 500 MiB 不能替代空闲 RSS 验收；gix 的小型 reader RSS 也不能代表整个 Electron 应用。

## 证据与复现

| 产物 | SHA-256 |
| --- | --- |
| reader_bench release example | `a0ce6734f62242e9478c0901f69123089a987d1c03b016d3c146bedb1fae5b6c` |
| benchmark-readers.mjs | `64e85ebc15784cdcef52ba6777e69e581afeb22b32fdf7e3d3fcb3e0cbba7e75` |
| reader-bench-client.mjs | `5668f386d69a15df17a8a75c8bcabe8480439741a73c137c48eb26ba03920e44` |
| process-tree-observation.mjs | `323e6a9400820338aa4caffb8a818d7322e4386a49182f51215de9c39fba1c36` |
| 正式原始 JSON | `a172b692b2e8cff3a052d8d8c5e7bdc9421a0f65f9864fd462f1df1ad63a8747` |

- 原始结果 / 独立 oracle / 每次采样：`output/benchmarks/p0-04-readers-20261107.json`；执行日志同名 `.log`，统计复核 `p0-04-summary-20261107.json`。
- 398 项产物前后哈希：`output/benchmarks/p0-04-artifacts-before.json` 与 `p0-04-artifacts-after.json`；397 项完全相同，唯一差异为 Cargo.toml 的末尾空行。固定 fixture、被测二进制 / 脚本和桌面 dist 均未变。
- 首轮失败预检、修复后 18 项预检与独立测试见[验收记录](../validation/p0-04-readers.md)。不合并预检与正式矩阵，不覆盖失败记录。
- 原始 JSON 和 fixture 在本地忽略目录；版本库保存生成器、测试、报告与哈希。

```sh
pnpm install --frozen-lockfile
mkdir -p output/fixtures
pnpm fixtures:generate --output output/fixtures/reproduce-readers --large --seed 20261107
pnpm build:reader-bench
pnpm test:readers --large-repository="$PWD/output/fixtures/reproduce-readers/large"
pnpm benchmark:readers --repository="$PWD/output/fixtures/reproduce-readers/large" --preflight --output=output/benchmarks/reproduce-readers-preflight.json
pnpm benchmark:readers --repository="$PWD/output/fixtures/reproduce-readers/large" --runs=10 --output=output/benchmarks/reproduce-readers.json
```

输出目录和结果文件须未使用；以上命令不会构建桌面。性能测量前等待所有构建 / 测试结束。M0 完成后进入 P1-01 仓库会话，再做 P1-02 历史游标；继续按已确认顺序在分页稳定后提前交付元数据搜索。
