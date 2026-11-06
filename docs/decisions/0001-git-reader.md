# ADR 0001：M1 继续使用系统 Git CLI

日期：2026-11-07。状态：已采纳。依据：P0-04 的 [180 项正式矩阵与 M0 基线](../benchmarks/m0-baseline.md)、[独立正确性验收](../validation/p0-04-readers.md)及已有 P0-03 首屏证据。

## 决策

M1 的历史与元数据读取继续由 Rust 管理系统 Git CLI，复用有界、可取消的 `ReadOnlyGit` 边界。gix 0.90.0 保留为实验 example 的 dev-dependency，本项不进入生产依赖，不新增第二套完整后端或通用适配框架。

P1-02 采用固定 tip 快照上的可续读遍历会话、有界输出 / 页面缓存和背压；不逐页从 HEAD 重新执行 `--skip=N`。批量对象读取沿用 cat-file，在后续 profile 证明有价值时评估复用其进程。随机回读和 session 淘汰时的重算成本需单列测量；本项没有足够证据选定持久化检查点格式。

## 比较了什么

相同 100,000 条线性提交、相同固定 HEAD、相同 200 个返回 OID 和原始对象摘要。四个 offset 各 10 次 / 后端，分别比较完整 page 与仅已知 OID 的 objects；另各 10 次真实遍历取消。160 次正常读取都与独立 Git oracle 完全相同，20 次取消与退出通过。

gix 使用低层 `gix::traverse::commit::topo` 的 `TopoOrder`，把 walker 构造时间计入遍历；没有用普通 breadth-first 的较少工作量冒充 Git `--topo-order`。打开使用隔离配置、禁用 replace refs，每个新 handle 的对象与 pack 缓存各限制 8 MiB，并在读取及 walker 构造中检查取消 / 资源限制。版本与公开 API 参见 [gix 0.90.0](https://docs.rs/crate/gix/0.90.0) 和 [gix-traverse 0.64.0 topo Builder](https://docs.rs/gix-traverse/0.64.0/gix_traverse/commit/topo/struct.Builder.html)；实现细节以锁定版本源码及本地测试为准。

## 为什么保留 CLI

| 观察 | 对决策的影响 |
| --- | --- |
| CLI 完整历史页中位 437–449 ms；本次 gix 配置为 701–1126 ms | gix 未改善历史浏览的主要读取成本；不为框架替换承担额外兼容成本 |
| 历史页 CLI CPU 中位 418–427 ms、采样 RSS 中位约 35–36 MiB；gix 为 700–1121 ms、约 52 MiB | 本轮完整页的资源结果同样不支持替换；仅代表此次数据与配置 |
| gix 已知 OID 的 200 对象约 1.8–2.0 ms，CLI 约 24.5–25.8 ms | 局部读取有可保留的优化机会，但约 23–24 ms 的收益不足以解释或消除约 0.42 秒的遍历成本 |
| gix 实验 topo 路径不能应用 shallow 边界，因此明确拒绝浅克隆；CLI 正常读取 | 直接替换会失去已有正确行为；不静默把缺口解释成完整结果 |
| CLI / gix 的 cancel → result p95 为 12.96 / 0.31 ms；均正常回收 | 两条路线在这项后台取消实验中均可用；gix 的更低延迟不是当前迁移理由 |
| P0-03 CLI 首屏可选择 p95 1.96 秒，目标仍为 3 秒 | 已有路线可继续产品开发；这组 10 次非安装包测量仍不构成发布验收 |

本次也验证了 bare、linked worktree、SHA-256、原始非 UTF-8 / NUL 对象、replace refs 隔离和缺失对象不补拉。merge / octopus 小 fixture 两者本次同序，但任意 DAG、多 tip、同时间戳顺序与复杂仓库性能尚未完整验证。浅克隆限制只描述本实验所选的底层 topo 路径，不泛化为整个 gix 项目的能力。

## 代价与后续约束

系统 Git 仍是本地运行前提，必须支持 `--no-lazy-fetch`，不通过取消安全选项兼容旧版本。所有调用继续使用绝对可执行路径和参数数组，禁用补拉、replace refs、外部 helper 与维护写入；查询服务不得触发 checkout 或其他写操作。

CLI 每次新建拓扑查询约 0.44 秒，已超过普通翻页 200 ms 的目标。M1 需要续读已有遍历，而不是宣称本次深页实验已解决分页性能；流式会话仍有冷启动与随机回读成本，需要用端到端数据验收。图状态和缓存必须有界，取消必须终止并 wait 关联进程，外部更新不能自动更换当前快照。

对象局部试验没有排除 gix 的未来价值。仅当生产 profile 显示对象读取成为显著瓶颈，且复用 CLI 进程 / 缓存后仍不能满足预算时，才另立小范围实验；同 OID / 同原始字节语义、shallow / linked worktree / SHA-256、缺失对象、取消、内存上限须先通过。需要换历史遍历时，再补多 tip / 复杂 DAG 的顺序和资源证据。本 ADR 不要求实现未验证的混合后端。

M0 的硬件与性能目标现已冻结，数值保持原值，见 [VALIDATION](../VALIDATION.md)。未测的搜索、最终分页、diff、滚动、空闲资源与长期运行仍为未验收；不将本次内部函数时间替代用户可见体验。
