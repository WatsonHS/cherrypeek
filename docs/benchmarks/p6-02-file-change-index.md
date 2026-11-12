# P6-02 文件改动索引测量

日期：2026-11-12。这是同机、同 fixture 的单次对照，不是发布性能验收。目标是记录 schema 2 的实际成本，并确认本 fixture 在既有每库 2 GiB 配额内；本项没有预先设定构建耗时增幅目标。

## 环境与方法

- macOS 27.0.1，MacBookPro18,3，Apple Silicon；Git 2.54.0（Apple Git-157），项目锁定的 Node / Rust 工具链。
- 两个 `cargo build --release --locked` daemon：修改文件索引前保存的 schema 1 基线，以及 schema 2 实现。二进制 SHA-256 和原始指标见 [JSON](p6-02-index-data.json)。后续修复浅克隆补深的标记重试，不改变本完整 fixture 的执行分支。
- `tests/benchmarks/create-change-fixture.mjs` 用 fast-import 创建 100000 个线性提交：每个提交实际改动一个文本文件，8 位 Author，独立的 Committer。两次运行使用同一个对象库、各自全新的应用缓存目录；先 schema 1，后 schema 2。没有清除 OS 文件缓存。
- `tests/benchmarks/index-build.mjs` 从启动 daemon、打开仓库、读首屏开始计时，直到索引报告 complete。停止 daemon 后统计 SQLite 文件大小及应用缓存文件总字节数。
- 每轮请求 100 ms 间隔的 `ps` 采样，按 PPID 递归汇总 **daemon 及所有子孙进程** RSS；包含 Git，不包含测试驱动 Node、Electron 或无关进程。实际间隔还包含 `ps` 耗时，可能漏过短命子进程峰值；不是操作系统高水位测量。两轮分别获得 446 / 1186 个样本，最多同时观测到 4 个进程。
- 构建结束独立查 SQLite：100000 个提交、100000 条第一父改动、100000 条路径匹配记录。元数据覆盖完整。

## 实测

| 指标 | schema 1 | schema 2 | 变化 |
| --- | ---: | ---: | ---: |
| 冷应用缓存构建耗时 | 57.61 s | 156.33 s | +171.4%（2.71 倍） |
| SQLite 大小 | 73.33 MiB | 97.73 MiB | +33.3% |
| 全部应用缓存文件 | 76,890,761 B | 102,474,377 B | +33.3% |
| daemon 进程树 RSS 采样峰值 | 90.53 MiB | 98.55 MiB | +8.9% |

构建时间增加明显。文件比较、Git 子进程与额外写入构成新增工作；本轮消除了按批从头扫描待补记录的问题，使用 ordinal 游标继续，但尚未做多轮回归或大仓交互延迟验收。没有把这组结果标记为“满足发行性能目标”。

## 复现与边界

```sh
node tests/benchmarks/create-change-fixture.mjs /临时目录/changes-100k
node tests/benchmarks/index-build.mjs /保存的schema1-daemon /临时目录/changes-100k /临时目录/new-cache-v1 /临时目录/v1.json
node tests/benchmarks/index-build.mjs target/release/commitscope-daemon /临时目录/changes-100k /临时目录/new-cache-v2 /临时目录/v2.json
```

fixture / cache 目标目录必须不存在，缓存不能放进被查看仓库。原始完整采样保留在本机忽略目录 `output/benchmarks/p6-02/files-baseline.json` 与 `files-changes.json`，保存二进制为 `daemon-v1` 和 `daemon-v2-final`。

此前也探索过已有的十万提交空树 fixture；它没有真实文件改动，不用作此处的成本结论。这里仍然只覆盖一个很简单的线性历史：不代表大量 merge、重命名、大文件或历史 `.gitattributes` 的成本。有历史属性文件时逐提交读取属性来源，构建可能明显更慢。v1 升级保留元数据，但补文件记录仍需承担比较成本。

配额、暂停 / 取消 / 强退续建与浅克隆补深的正确性证据见 [后端验证记录](../validation/m5-m6-backend.md)，与这项性能测量分开。
