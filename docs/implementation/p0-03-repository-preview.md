# P0-03：真实仓库首屏与 fixture 代码级计划

日期：2026-11-07。状态：本机 macOS 实现与验收完成，见[验收记录](../validation/p0-03-repository-preview.md)及[10 次首屏基线](../benchmarks/p0-03-first-screen.md)。主代理负责契约、审查和验收；三个轻量模型代理分别实现 Rust、桌面与 fixture / 测量。

## 本项边界

选择 / 输入本地目录 → Rust 识别仓库 → 固定本次 HEAD OID → 显示引用与最多 200 条真实提交 → 可选择摘要、取消读取、重新打开目录。支持普通仓库、空仓库、detached HEAD、bare 和 linked worktree，明确区分无效目录、Git 不可用与对象缺失。

这是 M0 首屏验证，不实现分页、完整仓库 session、最近仓库持久化、搜索、图、diff 或活动统计。不创建假数据产品页面。首屏完成前不统计全库提交数、不建索引、不读取文件 diff。P1 再把本项读取能力接入持久 session 与分页契约。

## 分工

| 执行者 | 所有权 |
| --- | --- |
| Rust 代理 | `crates/**`、必要 Cargo 文件、`packages/protocol/schema/**`：协议扩展、只读 Git 进程、仓库发现、引用与首屏读取、Rust 测试 |
| 桌面代理 | `apps/desktop/**`、`packages/protocol/src/**`、`scripts/build.mjs`、`scripts/launch.mjs`、根 package.json、`tests/protocol/**`、`tests/smoke/**`：类型生成、业务 IPC、视图、取消与 UI 验证、release 构建命令 |
| Fixture 代理 | `scripts/generate-fixtures.mjs`、`scripts/test-repository.mjs`、`scripts/benchmark-first-screen.mjs`、`tests/fixtures/**`、`tests/repository/**`：确定性生成器、独立数据对照、只读哨兵、整树测量脚本 |
| 主代理 | 本计划、其余文档、独立验证与报告 |

所有代理共享目录，不回滚别人改动，不创建 Git commit；跨归属文件修改先协调。三个代理直接同步接口依赖，避免等主代理中转。

## 协议与模型

保留协议版本 1，新增 capability / 内部方法 `readRepositoryPreview`。本仓库尚未公开协议；两端随同构建并由生成 schema 验证。请求 params 固定 `{ path: string }`，不接受任意 Git 参数或 revision 表达式；路径最多 16 KiB，必须绝对、无 NUL，Rust 再校验目录。`repoId` / `generation` 仍为 null：本项请求本身界定一次预览，不冒充已建立的仓库 session。

新增 Rust 类型，继续生成 TS，所有 nullable 字段必须显式出现：

```text
RepositoryInfo {
  path: string, gitDir: string, commonDir: string,
  worktreePath: string | null,
  isBare: boolean, isShallow: boolean, objectFormat: string,
  headOid: string | null, headReference: string | null
}
RefInfo {
  name: string, kind: "localBranch" | "remoteBranch" | "tag",
  oid: string, peeledOid: string | null, symbolicTarget: string | null
}
CommitIdentity { name: string, email: string, timestamp: string, offset: string }
CommitSummary {
  oid: string, parents: string[], summary: string, summaryTruncated: boolean,
  author: CommitIdentity, committer: CommitIdentity, textLossy: boolean
}
```

`timestamp` 为原始 epoch 秒的十进制字符串，避免精度损失；offset 保留原始 ±HHMM。OID 长度依据 objectFormat 校验，支持 SHA-1 / SHA-256，不以 40 字符作为接口类型。原始 Author / Committer 分离，不使用 mailmap。summary 是消息第一行，最多 4 KiB，按 UTF-8 边界截断并明确标志；原始消息包含 NUL / 换行不得破坏对象边界。非 UTF-8 或非 UTF-8 encoding header 用明确 `textLossy` 标识，不把替换后的文本当作无损解析。无法表达的文件系统路径返回明确不支持错误。

ResponseData 新增两类：

```text
{ section: "repository", repository: RepositoryInfo, refs: RefInfo[], refsTruncated: boolean }
{ section: "commits", commits: CommitSummary[], hasMore: boolean }
```

先发 repository，随后按序发送 commits 块；最多保存 / 返回 200 条，遍历最多额外取第 201 个 OID 判断 hasMore。最后一块 `done: true`，`coverage.complete: true` 仅表示本次有界首屏查询完成，不表示全库历史已经加载；UI 使用 hasMore 标注“仅显示前 200 条”。`coverage.processed` 是本次已返回提交数，`nextCursor: null`，不伪造分页游标。空 HEAD 发送零条 commits 的完成帧。

引用最多 2,000 条，额外读取一条判断 refsTruncated；按 refname 排序，仅列 heads / remotes / tags。repository 帧同样按实际 JSON 编码控制在 512 KiB 目标内，长引用名称导致超限时减少引用数量并设置 refsTruncated，不影响首屏历史读取。oid 是实际引用目标，peeledOid 是 Git 返回的解引用目标，不能将 tag 对象直接当 commit。引用只是观察到的列表，不计算包含关系。历史始终使用一次解析固定的 HEAD OID，不在读取过程中重新用可变 HEAD。本项未建立覆盖所有引用的原子快照，不宣称 refs 与多次 Git 命令具有跨命令事务保证。

错误扩展：`GIT_UNAVAILABLE`、`NOT_A_REPOSITORY`、`REPOSITORY_UNAVAILABLE`、`MISSING_OBJECT`、`UNSUPPORTED_REPOSITORY`、`RESOURCE_LIMIT`、`GIT_ERROR`；沿用 CANCELLED / TIMEOUT。Git 非零退出不能被当空仓库；仅确认 unborn HEAD 才返回空历史。缺失或损坏对象不返回完整成功。

## Rust 读取路径

新增小型 `git_command.rs` 与 `repository.rs`，允许按职责拆解析模块，不建立多后端框架。服务端 method dispatch 复用现有两个活动请求、取消标志和有界 writer；保留运行信息查询回归。

1. 规范化路径，分别读取 gitDir / commonDir / worktree root、bare、shallow、objectFormat 与 HEAD 状态。路径结果单独解析，不按空格分割；路径换行不得串成多个字段。普通仓库子目录可以解析到仓库根目录。
2. 用一次有界 `for-each-ref` 读取 heads / remotes / tags，固定格式以 NUL 分字段；不输出任意 commit message 作为 delimiter 协议。
3. 使用固定完整 HEAD OID 执行 `rev-list --topo-order --max-count=201 <oid> --`，不做全库 count。先确认 HEAD 为 commit；缺对象、非 commit HEAD 与 unborn HEAD 分开处理。
4. 用单个 `cat-file --batch` 进程批量读取最多 200 个 commit，按 header 中 objectsize 精确读取原始字节，校验返回 OID / type / 长度；不每行 spawn，不依赖消息分隔符，不加 textconv / filters / mailmap 选项。
5. 解析 commit header 中 parent、author、committer，正确跳过多行签名等 continuation header。原始单对象上限 1 MiB、单查询原始累计上限 32 MiB；身份单字段最多 4 KiB，parents 最多 128，超出返回 RESOURCE_LIMIT，不静默漏父关系。
6. 输出按实际 JSON 编码大小分块（目标每块 ≤ 512 KiB，硬限仍 1 MiB），单块最多 25 条；禁止 200 条直接塞一帧。读取 / 解析循环检查取消，正常与异常路径 kill + wait 所有自有 Git 子进程。

Git 执行共用固定绝对 executable、参数数组和有界 stdout / stderr；不使用 shell 或无界 output()。清除继承的 `GIT_*` 覆盖变量后显式设置 `GIT_NO_LAZY_FETCH=1`、`GIT_OPTIONAL_LOCKS=0`、`GIT_TERMINAL_PROMPT=0`、`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL` 为平台空文件。固定 `--no-pager`、`--no-replace-objects`，命令配置禁用 auto maintenance / gc、fsmonitor、hooks 和外部协议访问。只允许明确的只读子命令，不执行 status / checkout / fetch / maintenance / commit-graph 写入，不修改 safe.directory；配置报错原样映射成有界错误。

默认仓库查询总截止 15 秒，客户端 20 秒；总计时不因多次 spawn 重置。版本探测仍为原 2 秒。读取输出线程必须可终止：取消 / timeout / 达上限后先 kill child，再回收管道与线程。对于只读内置 Git 命令不启动外部 helper；用测试哨兵证明。执行环境和 cwd 不得让 renderer 或仓库内容成为命令片段。

仓库命令同时显式传入全局 `--no-lazy-fetch`，不能仅依赖可能被旧 Git 忽略的环境变量。旧版本不支持此选项时明确失败；不降级成允许隐式补拉的模式。本机 `git --no-lazy-fetch --version` 已确认支持，版本为 2.54.0（Apple Git-157）。

原始对象解析来自 [cat-file 的长度协议](https://git-scm.com/docs/git-cat-file)；路径与对象格式来自 [rev-parse](https://git-scm.com/docs/git-rev-parse)；禁用隐式补拉和可选锁见 [Git 选项](https://git-scm.com/docs/git)；引用限量与格式见 [for-each-ref](https://git-scm.com/docs/git-for-each-ref)。本机 Git 2.54 的实际支持由测试确认。

## 桌面与界面

main 新增单个 `RepositoryPreviewController`（或等价模块），拥有当前 AbortController、递增 revision 和有界预览状态。新打开立即取消旧读取，响应 / 回调 / finally 都检查本次 token，不能让旧错误或迟到结果覆盖当前状态。核心退出也要结束 loading。每次新请求从空预览开始，错误或取消可保留本次已读结果但明确不完整，不混入上次仓库数据。

preload 仅新增业务接口：

```text
chooseRepository(): Promise<string | null>
openRepositoryPreview(path: string): Promise<void>   // 校验后启动，快速返回
cancelRepositoryPreview(): Promise<void>
getRepositoryPreview(): Promise<RepositoryPreviewState>
onRepositoryPreviewChanged(listener): unsubscribe
```

状态类型从生成的 Repository / Commit 类型派生，不重复手写 Git 数据。状态有 revision、idle / loading / ready / error / cancelled、repository / refs / commits / hasMore / refsTruncated、稳定错误 code / message；历史数组硬限 200、refs 硬限 2,000。main 每个 handler 都沿用可信窗口 / 顶层 frame / 精确 URL 校验。路径校验同时在 main / Rust 执行。通用 transport 不开放给 renderer。

页面为紧凑只读表格：目录输入、选择目录、打开仓库、取消；仓库名 / bare / worktree / shallow / HEAD 状态；引用列表；提交摘要、Author、Committer 时间、短 OID。选中行显示完整 OID、父 OID、双身份与双时间，原始文本使用 React text，不能插 HTML。时间无法转换为 JS Date 时显示原始秒值。标注只展示首批、引用截断、编码损失与摘要截断。允许输入路径使人工与自动化都能走相同业务入口。

窗口调整到适合表格的尺寸，保留现有隔离、沙箱、CSP 和错误状态测试。暂不引入表格 / 虚拟化依赖：最多 200 行，本项不宣称长历史滚动已完成。取消按钮只取消当前读取，不关闭应用。输入法 composition 期间 Enter 不提交。

为自动化与启动基线提供公开启动参数 `--repository=<绝对路径>`，调用同一 main 业务路径；默认启动仍等待用户选择。渲染节点约定 `data-testid="commit-row"` / `data-oid` 与 `data-testid="preview-state"` / `data-state`，状态 ready 只能在完成帧后出现。选中行有 aria-selected。生产 UI 不显示测试步骤或内部计时。

## Fixture 与独立正确性

生成器 `node scripts/generate-fixtures.mjs --output <新目录> [--large] [--seed <整数>]`；默认种子 20261107，拒绝覆盖已有非空 / 用户仓库目录。只在明确新建的 fixture 目录运行写 Git 命令，Git 不可用要退出失败。生成器用固定作者、提交者、日期、消息和 PRNG，采用流式 fast-import 生成规模数据，不运行 10 万次 git commit。输出 manifest 记录生成器版本、seed、Git 版本、各仓库用途 / 规模 / refs / objectFormat / HEAD / pack 状态与已知预期元数据，所有路径为相对生成根目录。

小集合至少包含：空仓库、具有 root / 分叉 / merge / octopus / 同时间戳 / 双身份差异 / 中文 / HTML 文本 / 消息正文的拓扑仓库；detached、bare、linked worktree、浅克隆、SHA-256、缺失对象。SHA-256 若 Git 不支持必须明确记录而非伪造通过。大集合 `--large` 生成恰好 100,000 提交的固定拓扑 / 身份 / 时间数据，pack 状态可重复且记录，不把生成与 pack 工作计入打开耗时。

`tests/repository` 通过真实 daemon 调协议，不复用被测 Rust 解析器生成预期。正常记录用独立 Git log / show 命令与 manifest 声明对照：OID 顺序、父顺序、summary、双身份、时间偏移、引用目标；SHA-256 长度与 linked worktree 的独立 HEAD / 共享 commonDir 要断言。fixture 可增加原始 NUL / 非 UTF-8 commit 验证边界。

只读检查对打开前后的工作区、Git 元数据和 commonDir 做内容 / 模式 / symlink 快照（忽略 atime），不能只比较 git status。配置 pager / fsmonitor / diff / textconv / hooks / remote helper 哨兵，确认不执行；缺失 promisor 对象必须失败且无 lazy fetch。用受控慢 Git 夹具验证取消与切仓不会留下进程，夹具属于测试目录，不进入产品逻辑。

## 测量与验收

根脚本新增 `fixtures:generate`、`test:repository`、`benchmark:first-screen`、`build:release`，由桌面代理协调根 package.json。test:repository 自动生成小型临时 fixture，失败也回收 daemon；UI 测试至少覆盖真实小仓库 / 空仓库 / 无效目录、选择、取消或切换、文本注入与健康退出。已有协议和 smoke 保持回归。

`build:release` 编译 release Rust 并打包现有桌面资源，不等同于安装包。基线脚本接收 `--repository=<100k目录> --runs=10 --output=<JSON>`，用真实 Electron 和相同启动入口。每次从启动调用至 200 条真实行可选择且完成绘制计时（注明自动化启动开销），确认实际首行 OID；不读取 / 生成 fixture 来充当 UI 结果。

持续采样 Electron main / renderer / GPU / helper / Rust / Git 整棵进程树的 RSS、累计 CPU 与 PID；保存采样间隔、每次结果与进程分类，退出后验证捕获的进程全部结束。RSS 总和可能重复计算共享页；短命 Git 可能落在采样间隔之间，CPU 与峰值是采样估计，不能说是精确总量。每次使用新的应用数据目录，不清 OS page cache；没有索引 / 应用缓存实现，不宣称暖索引性能。10 次报告原始值、中位数、p95 与采样峰值，但发布关卡仍需 30 次、安装包和长期轨迹。

完整检查：protocol:check、typecheck、build、test:protocol、test:repository、test:smoke、Rust fmt / test / clippy；真实首屏 UI 与 10 次 100k 基线由主代理独立执行。记录到 `docs/validation/p0-03-repository-preview.md` 和 `docs/benchmarks/p0-03-first-screen.md`。P0-04 再比较 CLI / gix 和深页成本、冻结预算；不能提前标记 M0 完成。

## 后续协作边界

用户在本项收尾时将 UI 设计交给 Claude。此后主代理和轻量代理不再调整界面或做视觉验收；性能测量使用此前已构建的版本，并核验产物前后未变。后续 UI 改动不由本记录宣称已验收。
