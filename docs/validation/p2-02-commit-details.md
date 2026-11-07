# P2-02 提交详情与文件列表验收记录

日期：2026-11-08。状态：实现、自动验证与 release 构建完成；详情实窗仅完成部分检查，未声明完整实窗验收。用户要求“少点验证”后停止补跑。实现基线 `1160146`（P2-01 已提交），本项尚未提交。契约见[代码级计划](../implementation/p2-02-commit-details.md)。

## 实现范围

新增 `commitDetails` capability 和四个会话查询：`getCommit`、`listChangedFiles`、`readMergeCommits`、`branchesContaining`。详情显示完整消息、末尾 trailer、独立 Author / Committer、原始父提交、冻结引用与 worktree。普通提交和 merge 文件页按选定原始父比较；根提交使用空树语义。概览与文件页共享比较父，文件路径保留原始字节身份，明确显示重命名、二进制、mode 与 gitlink 对象变化。

merge 按非第一父分别计算带入提交，提供当前组的完整作者分布与分页。包含分支只在点击后查询冻结 tips；不会把引用移动后的关系混入原快照。选择或窗口重新聚焦时，可用约一秒预算复核当前 scope 对所选提交的可达性；只有明确受影响才在头部提示，失败或无法证明时为 unknown，不推进会话或自动刷新历史。

renderer 主历史 / 搜索窗口上限改为 1800 条，当前 merge 页最多 200 条；另保留既有的一条旧选择摘要。详情仅保留一个 OID 的完整消息、一页文件和一页 merge。旧快照中已读的内容在刷新后保留并标注观察时间；新范围尚未加载该 OID 时不自动把旧内容归入新上下文。重新加载到该 OID 或显式重试后才切换详情上下文。

## 已有自动验证

- Rust core 5 项、daemon 51 项、startup 12 项通过；fmt、Clippy `-D warnings` 与 `protocol:check` 通过。新增覆盖 SHA-256 全零缺失侧 OID、异常字节重命名路径、gitlink / binary、raw 与 numstat 路径配对和 annotated tag 解引用。日志：`output/test/p2-02-rust-{fmt,clippy,test,daemon-parallel,startup}.log`。
- 完整 workspace 并行运行曾在既有 history fixture 出现缺失对象，诊断确认是 fixture 对象链断裂。测试 helper 改为独占创建含纳秒的临时目录、隔离继承的 `GIT_*`、禁用自动 GC / maintenance，并保留失败诊断；随后 daemon 全部 51 项并行通过。此前定向与串行也通过，但根因未被完全证实，不能把这些修正宣称为已证明的唯一原因；workspace 失败轮次不计作全量通过。
- 桌面 `pnpm typecheck` 通过；renderer 58/58，覆盖详情串行查询、按需包含分支、选择响应判旧、焦点复核不重置页面、旧详情保留及重新关联、文件请求被 merge 操作替换。主进程校验请求 / 响应 OID、父序号、页数、统计、字节路径与完整性，详情有独立取消域。
- Node 26 与 Electron 内置 Node 24 的协议测试各 43/43，通过真实 daemon 和受控核心验证。日志：`output/test/p2-02-protocol-node26-r3.log`、`output/test/p2-02-protocol-electron24-r3.log`。早期测试仅因 fake capability 清单未同步新增能力而失败，已修复；未启动 Electron 窗口。
- 真实 Git 集成八项已分轮验证：r2 通过七项，修正浅克隆测试后定向通过剩余一项，随后补跑 SHA-256 根文件页。覆盖完整消息、重复 / 折行 trailer 与正文中间伪 trailer、双身份、root、普通 merge、三父 octopus、205 项文件分页、205 + 1 项带入组、作者分布、rename / delete / typechange / binary / gitlink、Unicode / 换行 / 两种无效 UTF-8 路径 / 空白及选项形状路径、原始 OID 与 mode、numstat、目标提交 attributes、冻结包含分支、快进 / 改写 / 引用删除、取消及只读快照。日志：`output/test/p2-02-details-r2.log`、`output/test/p2-02-details-shallow-r4.log`、`output/test/p2-02-details-sha-r5.log`。
- 浅边界的包含分支返回不完整，merge 差集明确 `UNSUPPORTED_REPOSITORY`；缺失对象、超大消息和非法分页明确报错。仓库配置的 trailer command、外部 diff / textconv 哨兵未执行。测试中人为移动引用的写入与 daemon 只读观察分开取快照，不把 reflog 的预期变化当作应用写入。
- r1 的未通过项为测试 helper、旧 generation 和含换行路径的 shared clone 问题；修正测试而未放松生产断言。普通 clone 避免 alternates 文件的换行分隔限制。中断轮次的测试进程及临时目录已回收。

## 真实 Electron 窗口

最终 `pnpm build:release` r3 通过，日志 `output/test/p2-02-build-release-r3.log`。Vite 提示主 JS chunk 略超 500 kB；这是构建提示，不是运行性能结果。

详情 smoke r2 使用真实 Git fixture，已走过全文 / trailer、切换文件比较父、octopus 205 + 1 两组分页、包含分支及 A→B→C 快速选择。随后文件页测试的文本同时匹配列表行与详情标题，触发 Playwright strict-mode 错误；r1 则曾等待不存在的 merge 行 `data-oid` 属性。这两处测试定位器已修正，按用户“少点验证”要求停止补跑，不计作完整 smoke 通过。日志 `output/test/p2-02-details-smoke-r2.log`，截图 `output/playwright/p2-02-commit-details-failure.png`。

后续文件分页、搜索结果详情、light / dark 截图、只读快照和收尾预算断言未在实窗完成；对应的数据分页、判旧与只读行为已有自动测试证据。测试代理已确认本轮 Electron、daemon 和 runner 无残留进程。

未额外运行 P2-01 历史图回归或重复性能矩阵。1800 + 200 摘要预算由状态测试及已执行的局部窗口检查支持，不据此宣称 1800 条淘汰后的全部实窗流程已经重测。

## 边界与成本

文件与 merge 页使用有上限的完整扫描后投影当前页，不是常数时间随机访问。文件最多 20000 项、16 MiB Git 输出、单路径 16 KiB；merge 最多 10000 个提交、1000 个作者、16 MiB 累计解码元数据估算。单个响应目标上限 512 KiB，超限明确失败，不默默截断。基础详情超限时仍可读历史摘要，依赖基础详情的文件 / merge 区域明确显示等待重试。

trailer 由隔离仓库配置的 Git 解析，两次调用验证正文与末尾块边界；无法证明安全拆分时保留原文，并提示附加信息可能仍在正文中。浅 / grafts 仓库不把无法证明完整的 merge 差集当成完整结果；根 diff 在此类边界下采取保守拒绝。缺失对象不自动 fetch。

文件内容与 patch 仍为“占位 · P2-03”；图形定位、外部变化 watcher 和路径搜索不属于本项。没有重跑十万提交性能矩阵，也没有把功能测试耗时当成详情延迟或整树内存验收；P4-01 的既有资源待修项保留。
