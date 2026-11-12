# P6-05 真实仓库演化分析测量

日期：2026-11-12。同机单次实测；没有预先约定本项延迟目标，不作发布性能验收。

## 对象与口径

- 本仓库已提交版本 `1ffbf61eb8dc9042622ed5a73de27cc47bca7d0e`，选定 `crates/daemon/src`。不包含工作区尚未提交的本批实现和并行界面改动。
- 21 个文件、25505 行、883482 字节，全部可分析，无跳过文件；文件索引分母覆盖 67 个提交，complete=true。
- 使用 P6-02 报告中的 schema 2 release daemon，macOS 27.0.1 / MacBookPro18,3 / Git 2.54.0；应用缓存放在仓库外的新临时目录。先完成索引，再依次 estimate、冷 blame 缓存分析、同版本热缓存分析。
- `tests/benchmarks/evolution.mjs` 请求每 100 ms 用 `ps` 递归汇总 daemon 及全部子孙进程 RSS，各阶段单独取峰值。计入 Git，不计测试 Node、Electron；可能漏过短命子进程。测量期间有其他回归工作运行，主机不是独占环境。

## 实测

| 阶段 | 耗时 | 进程树 RSS 采样峰值 | 响应帧 |
| --- | ---: | ---: | ---: |
| estimateEvolution | 553.6 ms | 17.66 MiB | 1 |
| analyzeEvolution，冷 blame 缓存 | 2267.8 ms | 18.22 MiB | 43 |
| analyzeEvolution，热 blame 缓存 | 1941.0 ms | 16.44 MiB | 43 |

热缓存分析仍需枚举树、读取受限 blob 及索引分母，不是零 Git 命令。真实仓库测量只报告耗时；另有独立测试用 Git gate 证明已缓存文件不重跑 `blame`，并核对两次归属 / 存活结果。

本版采用 **每次 200 个文件**的保护上限，并沿用每文件 1 MiB / 20000 行限制；树枚举上限 10000 条。21 文件样本没有出现高内存占用，因此没有进一步压低该上限，但不能按比例推算 200 文件的延迟。200 文件估计和跳过行为有测试；最坏规模的完整 blame 分析尚未性能验收。用户可以选择更小目录；取消保留已完成文件的累计结果和缓存。

完整采样在本机忽略目录 `output/benchmarks/p6-02/evolution.json`；精简指标见 [JSON](p6-05-evolution-data.json)。

```sh
node tests/benchmarks/evolution.mjs target/release/commitscope-daemon /仓库路径 crates/daemon/src /仓库外的新缓存目录 /临时目录/evolution.json
```
