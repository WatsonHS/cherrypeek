# P0-04：读取实验验收

日期：2026-11-07。本项只增加独立 Cargo example、测量脚本和 headless 测试。生产查询、协议、桌面源码及桌面构建产物未修改；UI 设计继续由 Claude 负责。

## 实现边界

`crates/daemon/examples/reader_bench.rs` 接收有界 JSON job，在新进程中执行 CLI 或 gix 的历史页、已知 OID 对象读取、可取消遍历。CLI 复用生产 `ReadOnlyGit`；gix 0.90.0 仅作为 dev-dependency，隔离配置、禁用 replace refs，使用 8 MiB 对象缓存和 8 MiB pack 缓存。两条路径均限制单对象 1 MiB、对象批次 32 MiB、一次最多 200 个对象、任务截止 30 秒。

`scripts/reader-bench-client.mjs` 提供独立 Node / Git 对照、进程树采样和退出验证。`scripts/benchmark-readers.mjs` 区分预检与正式矩阵，拒绝覆盖结果，保留失败任务；采样错误、未观察到 reader 根进程、对象 / OID 不一致、取消失败或强制回收均不计成功。

`scripts/test-readers.mjs` 仅构建优化的 reader example，生成临时边界仓库，复用已存在的 10 万提交 fixture。可用 `--large-repository` 指定绝对路径；缺失时明确提示生成命令，不静默跳过。失败时保留临时仓库和 stdout / stderr 诊断，成功后清理临时测试数据。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `cargo fmt --all -- --check` | 通过 |
| `cargo test --workspace --locked` | 22 项通过；未新增生产功能 |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过，包含 example |
| `cargo build --release --locked -p commitscope-daemon --example reader_bench` | 通过 |
| `cargo tree -p commitscope-daemon -e normal --locked` | 生产依赖树不含 gix / sha2 / libc |
| `pnpm test:readers --large-repository=…` | 主代理独立复跑 4 组通过，0 跳过 |
| `node --test tests/repository/benchmark-process-tree.test.mjs` | 2 项通过，保持 macOS 短命令名与 PID 复用回归 |

主代理的 headless 日志：`output/benchmarks/p0-04-headless-20261107.log`。正式测量前的源码 / 二进制 / fixture 哈希记录于 `output/benchmarks/p0-04-artifacts-before.json`；正式矩阵与结束后的复核尚在进行。

## 数据与只读验证

- 固定 100,000 条提交：offset 0、10,000、50,000、90,000、99,900、100,000；对照独立 `rev-list --topo-order`，检查顺序、条数、尾页与 `hasMore`。同序时逐页比较原始对象字节数和摘要，空页摘要为 null。
- merge / octopus fixture：检查完整提交集合和父子拓扑约束；两条实验路线本次均与 Git 同序，没有顺序差异诊断。这不证明任意 DAG、时间并列或多 tip 都同序。
- 原始对象：包含 NUL 与非法 UTF-8 的提交必须成功，并与独立 `cat-file --batch` 的字节摘要相同。使用字符数不足 1 MiB、实际字节超过 1 MiB 的对象，确认两条路线都返回 `RESOURCE_LIMIT`。
- bare、linked worktree、SHA-256：两条路线均成功。浅克隆：CLI 成功，实验中的 gix 底层 topo 路径明确返回 `UNSUPPORTED_SHALLOW`，避免越过 shallow 边界；这不是对整个 gix 库的兼容结论。
- 缺失 promisor 对象：两条路线均返回 `MISSING_OBJECT`；配置外部 remote helper 的哨兵未触发，无网络补拉。污染的继承 `GIT_*` 和 replace refs 不改变相应后端在干净环境下的 OID / 对象摘要。
- 所有上述仓库在读取前后比较文件内容、mode、符号链接及 commonDir；固定大 fixture 也在正常读取和取消后比较，均未发现变更。测试中的造仓库 / 写特殊对象仅发生于可丢弃的临时数据。
- 真实遍历启动后发送取消，两条路线均返回 `cancelled`、非负整数 `completedScans` / `visitedCount`；观察到的进程树正常退出，无强制回收。没有用人工 sleep 模拟工作负载。

## 复核中修正的问题

首轮 18 项预检的 16 个 page / objects 任务通过，两个取消任务因 `completedScans: null` 被拒绝。原因是完成第一轮前没有初始化计数；现已在 scan 入口初始化为 0，测试增加非负整数断言。失败记录 `output/playwright/p0-04-reader-preflight-20261107.json` 原样保留；修复后二次预检 `output/playwright/p0-04-reader-preflight-20261107-r2.json` 为 18/18，通过后才运行正式矩阵。

同时修正了测量时刻与失败归类：在 stdout 收到事件时记录时间；自然非零退出与强制清理分开记录；退出后仍存在的已观察子进程按身份清理并判失败；汇总只接纳没有校验失败的任务。空页的独立 oracle 统一返回 null 摘要。gix 构造 topo walker 时也执行取消 / 截止与对象大小检查，构造时间计入 walkMs；pack 缓存同时覆盖 gix 和 Git 两个优先级不同的配置键。

## 本项不证明的内容

没有执行桌面构建、UI 测试或设计验收。未实现仓库 session、最终分页游标、元数据索引 / 搜索、图或 diff。性能结论限于本机 macOS、固定线性 pack 数据和本次有界配置；复杂 DAG 性能、百万提交、Windows、长时间运行、空闲 CPU / RSS 与安装包验收仍待后续完成。

本次先提交可复核的实验工具与测试证据。P0-04 仍在进行，正式结果和路线决策将随后写入 `docs/benchmarks/m0-baseline.md` 与 `docs/decisions/0001-git-reader.md`；当前不勾选 M0 完成。
