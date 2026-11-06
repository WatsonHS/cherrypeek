# P0-04：读取路线与深页成本代码级计划

日期：2026-11-07。状态：已完成。正式 180 项矩阵与 4 组独立 headless 测试通过，见[验收记录](../validation/p0-04-readers.md)、[M0 基线](../benchmarks/m0-baseline.md)和[读取路线决策](../decisions/0001-git-reader.md)。以下保留执行时的代码级计划。主代理制定契约、独立复核和记录决策；轻量模型代理实现实验工具。保留现有 v3 产品设计，UI 由 Claude 负责，本项不修改或重新构建桌面。

## 要回答的问题

1. 在完全相同的固定 HEAD / OID 数据上，系统 Git 与 gix 读取原始 commit 对象的成本分别是多少？
2. 首批及 offset 10,000 / 50,000 / 90,000 的 200 条历史，各自遍历、对象读取、总查询时间及资源成本如何？重新从 HEAD 跳过前缀的成本必须显式记录，不将实验中的 `--skip` 作为最终分页设计。
3. 取消正在执行的真实历史遍历后，多久返回和退出？有没有残留进程或仓库写入？
4. gix 的拓扑顺序、SHA-256、bare / worktree / shallow 和缺对象行为是否满足现有语义？相同集合但不同顺序也要记录，不能只比较数量。

输出读取路线 ADR、M0 汇总基线与已确认的参考硬件 / 目标预算。不会在没有收益和兼容证据时切换生产后端，不建设第二套完整查询服务或分页系统。

## 代码边界与分工

| 执行者 | 文件所有权 |
| --- | --- |
| Rust 代理 | `crates/daemon/examples/reader_bench.rs` 及其同目录专用模块、`crates/daemon/Cargo.toml` 的 dev-dependencies、`Cargo.lock`：可取消的实验程序 |
| 测量代理 | `scripts/benchmark-readers.mjs`、`scripts/reader-bench-client.mjs`、必要的专用资源采样模块、根 package.json 的实验命令：独立 Git oracle、交替测量、进程树与原始结果 |
| 验证代理 | `tests/readers/**`、`scripts/test-readers.mjs`：真实对象与遍历对照、兼容矩阵、只读快照、取消与测量回归 |
| 主代理 | 本计划、`docs/decisions/0001-git-reader.md`、`docs/benchmarks/m0-baseline.md`、阶段状态与独立执行证据 |

共享工作区，不回滚其他人改动，不提交 Git。禁止改动 `apps/desktop/**`、现有协议 schema 和生产查询接口。实验通过 daemon 的 Cargo example 构建，gix 仅为 dev-dependency；生产 binary 不链接它。Git 进程复用现有 `git_command.rs`（example 内路径模块引用），不复制或弱化其只读选项。

锁定 `gix = 0.90.0`，MSRV 1.88 与现有 Rust 1.95 相容。关闭默认 feature，开启 `sha1`、`sha256`、`max-performance`，并使用公开 re-export 的底层 topo。已核对 0.90 源码：max-performance 仅展开 parallel 和 pack cache 能力，不启用 network / mutation；单开 pack-cache feature 不会激活 setup_objects 中被 max-performance 门控的缓存。gix 每个新 handle 显式设置 8 MiB decoded object cache、从空开始，并通过已核实配置将 pack cache 限制为 8 MiB；实际设置必须记录，避免将完全无缓存的变体当作合理性能上限。result 记录 `gixObjectCacheBytes`（CLI 为 null）。这是一种有界配置，不扩展多配置调优矩阵。依赖版本以实际锁文件为准；不启用网络、凭证、工作区写入或过滤器能力。SHA256 摘要计算可使用独立的小型 dev-dependency，禁止自写密码学散列。

## 实验程序契约

构建：`cargo build --release --locked -p commitscope-daemon --example reader_bench`。程序路径为 `target/release/examples/reader_bench`，仅供本地实验。

程序启动后输出一行 `{"event":"ready","protocolVersion":1}`；stdin 第一行是一个 JSON job。随后独立读取 stdin：收到 `cancel` 则设置 AtomicBool；EOF 同样取消。stdout 只输出 JSONL，stderr 为有界诊断。完成后输出 result，并等待 `exit` 或 stdin EOF（最多 2 秒）以允许采样，随后正常退出；不得用强制 kill 完成成功测量。

```text
Job {
  backend: "cli" | "gix",
  operation: "page" | "objects" | "scan",
  repository: string,       // 绝对 UTF-8 仓库根目录或 bare 目录
  gitExecutable: string,    // 绝对路径，仅 CLI 使用
  headOid: string,          // 外部 oracle 已固定的完整 OID
  offset: integer,          // 0..100000，本项不做任意深度服务
  limit: integer,           // 1..200
  oids: string[]            // objects 使用，最多 200；其他模式为空
}
```

输入最多 64 KiB；拒绝未知字段、非法 OID、相对路径及越界数值。固定单个 job，不引入通用服务协议。job 开始输出 `{"event":"started","backend":...,"operation":...}` 并 flush；由同一单调时钟计算时长。

result 至少包含：`event:"result"`、backend、operation、`status:"ok"|"cancelled"|"error"`、稳定 error code / 有界 message（可空）、`openMs`、`walkMs`、`objectsMs`、`totalMs`、`visitedCount`、`oids`、`hasMore`、`rawBytes`、`objectsDigest`（无对象读取时可空）。scan 还返回实际完成的遍历轮数。Unix 上以 getrusage 在 job 前后计算 `cpuSelfMs` / `cpuChildrenMs`（user + system；失败为 null），子进程已 wait 后采终值，避免短命 Git 漏采。此值与 ps CPU 是两种口径，不重复相加，也不以 ru_maxrss 充当整树 RSS。失败不得输出假成功或以空数组冒充空历史。

`visitedCount` 只记录实验程序实际观察到的 OID 行 / iterator item，不推算 Git 或 gix Builder 内部访问数：CLI 的 offset 在 Git 内处理，gix 的跳过由 iterator 推进完成，两者这个计数不用于比较内部遍历量。

对象摘要固定为 SHA256，按请求 OID 顺序输入：`OID ASCII + NUL + object size 十进制 ASCII + NUL + 原始 commit bytes`。CLI 的 cat-file 包装头和对象后的协议换行不参与摘要。Node oracle 独立从 Git 取原始对象并按此定义计算；Rust 两条路径不能互相充当 oracle。消息可能含 NUL / 无效 UTF-8，不解码后散列。

### page

CLI：固定 tip 的 `rev-list --topo-order --skip=<offset> --max-count=<limit+1> <oid> --`，取最多 limit 个 OID，用一次 `cat-file --batch` 读取原始 commit。gix：固定相同 tip，使用底层拓扑遍历 API，跳过同样前缀，再读取相同数量的对象。两者不读取完整 diff、不查询仓库总量。

分别测 open、walk、objects 和总时间。CLI 的仓库打开成本包含在 Git 子进程中，`openMs=0` 只表示没有单独的打开步骤；不能由此宣称零成本。gix 打开和 iterator 初始化均计时，不能把预遍历藏在计时之前。返回实际 OID 序列以校验次序和父子拓扑。

### objects

给两个后端相同的、由独立 Git 确认的 200 个 OID，直接读取对象并生成摘要。此操作隔离对象库成本，不包含历史遍历；用于判断是否有局部替换对象读取的价值。每个对象上限 1 MiB，一次合计 32 MiB，与生产预览边界一致；超限明确报错。

### scan 与取消

不断从固定 HEAD 遍历真实历史（每轮至多 100,001 个 OID，最多 100 轮、总期限 30 秒），仅累加计数 / 摘要，不储存无界历史。CLI 每轮使用一次有界 `rev-list`；gix 在每次 iterator 推进前后检查取消。此饱和读取工作负载是取消实验，不冒充正常一页查询。

测量端收到 started 后等待 10 ms，发送 `cancel\n`；记录发送至 cancelled result、发送至整树退出的时间。ready 之前的启动开销不计入取消延迟。若请求已完成、超时或被强制杀死，单独记为失败 / 竞争情况，不纳入成功取消的零时延。

所有操作在阻塞 Git 调用、迭代和对象循环检查取消及 30 秒总截止；CLI kill + wait。gix 若 iterator 初始化存在不可中断段，要从实测和源码明确说明，不宣称完全可抢占。

## 只读与语义约束

- CLI 继承既有受限执行器：绝对可执行文件、argv、清除 GIT_*、禁用 lazy fetch / 外部协议 / pager / fsmonitor / hooks / 自动维护；无 shell。
- gix 只打开明确路径；关闭全局 / 系统 / 安装级配置及环境覆盖，禁用 replace refs，保留仓库对象格式和 commonDir 必需配置。仅用对象库、引用解析和遍历 API，不调用网络、过滤器或写入 API。
- 普通 `rev_walk()` 的 BreadthFirst 不是 Git `--topo-order`。优先验证 gix 暴露的底层 topo API；不能通过事后排序掩盖区别，也不为此实现自研图遍历框架。
- shallow 必须尊重浅边界；如果底层 API 不能直接满足，明确记录不支持并阻止冒充完整。缺失对象报错且无隐式补拉。SHA-256 必须真实读取或标出能力缺口，不能统一截成 40 字符。
- 用原始对象散列验证读取完整性，不新增 Author / Committer 解析器。生产字段正确性沿用 P0-03 的独立测试证据。

相关依据：[gix 0.90.0](https://docs.rs/crate/gix/0.90.0)、[默认遍历次序说明](https://docs.rs/gix/0.90.0/gix/revision/walk/enum.Sorting.html)、[底层 gix-traverse](https://docs.rs/gix-traverse/latest/gix_traverse/commit/topo/index.html)。API 细节以下载到本机并编译的固定版本源码为准，不依赖 search 中不同版本的混合摘要。

## 独立验证与测量矩阵

复用 P0-03 固定 100,000 提交目录，运行时只读，不重新生成或 pack 原始基线。小 fixture 由既有生成器产生临时目录，可添加小型时间倒序 / merge 测试仓库，但不改旧数据目录。验证成功、失败和取消前后所有 fixture 文件内容 / 模式 / symlink，覆盖 commonDir。

测试至少覆盖：线性首批 / 深页及越界末页；小拓扑含 merge / octopus 的实际 OID 次序（允许记录 gix 差异，但不称其等价）；相同对象字节摘要（包括 NUL / 非 UTF-8）；bare、linked worktree、shallow、SHA-256；缺对象 / 环境污染 / 外部 helper 哨兵；取消及所有自有进程结束。只比较集合不够；只比较两后端也不够。

正式矩阵：offset `[0, 10000, 50000, 90000]`、limit 200，page 和 objects 各 10 次、每轮交替 CLI / gix 先后顺序。cancel scan 两个后端各 10 次。每个 job 独立新进程与新 gix handle，OS page cache 不清空；说明此前已读过 fixture。可先用 1 次预检，但不能把预检混入 10 次结果。

Node 测量端握手后先采进程，再发 job；收到 result 后再采样，然后发送 exit。记录内部阶段时间与启动至退出墙钟时间，两者不可混称；以内部 totalMs 比较读取路径。持续采样整个 reader_bench + Git 后代树的 RSS / 累计 CPU / PID 与启动身份，包含首次累计 CPU；短命进程可能漏采时明确限制。CPU 主比较使用 getrusage 的 SELF + CHILDREN 差，ps 累计 CPU 作为辅助采样；[Apple getrusage 说明](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getrusage.2.html)。采样从 job 前持续至退出，正常退出后按身份检查，强制清理只作善后并标失败。采样身份合并复用已修复的 `process-tree-observation.mjs`。

输出新 JSON 文件（拒绝覆盖），包含每次原始结果、oracle 对照、采样、工具版本、硬件、fixture HEAD / count / pack、binary 与脚本 SHA256、所有失败记录和统计方法。语义不一致的结果标记不可比较，不拿它计算“更快”比率。正式测量期间不并行构建或运行测试。

## 收尾与决策标准

完成 Rust fmt / workspace tests / clippy、独立 headless 测试和正式矩阵。确认 production daemon 的依赖树未引入 gix；不触发 UI 构建或 smoke。

`docs/decisions/0001-git-reader.md` 根据证据给出：保留 CLI、仅局部使用 gix、或后续有条件试验；解释正确性、取消、资源、兼容与维护成本。默认不因单个 microbenchmark 快就替换生产代码。

`docs/benchmarks/m0-baseline.md` 汇总本项 headless 与 P0-03 已有首屏证据，严格区分内部查询与可交互界面时间。确认现有预算和参考机器，不为宣布通过调松目标；尚未实现或未测的 UI / 搜索 / 滚动 / 空闲指标继续标未测。只在本项证据和决策齐备后勾选 P0-04 / M0，下一阶段为 M1 仓库会话与历史分页。
