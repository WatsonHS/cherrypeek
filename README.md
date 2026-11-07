# CommitScope

面向 Agent 高频提交场景的桌面 Git 历史浏览器。快速看清最近提交了多少、谁提交的、改了什么，以及分支之间的关系。

**当前状态：M0 及 P1-01 后端与非视觉接口已完成本机 macOS 技术验收。** 可打开本地 Git 仓库、读取当前 HEAD 的首批 200 条真实提交、选择元数据详情并取消读取；核心新增固定 HEAD 的仓库会话、最近打开与按 worktree 保存的上次查看记录，界面已按 v3 设计换成 Tailwind + shadcn 外壳（UI-01），并接入最近打开与查看记录（UI-02）；后端未接入的区域显示标注“占位”的示例内容。已有固定种子 fixture、首屏及 180 项读取对比基线，生产路线继续使用 Git CLI。分页、搜索、Rust 图布局与 diff 尚未实现，当前不是 MVP。`CommitScope` 是暂定工作名。

## 已确定的方向

- 独立新建项目，不 fork GitComet，不引入或复制其后端及状态层代码。
- Electron 桌面外壳，React + TypeScript 界面（Tailwind CSS 4 + shadcn 风格组件），Rust 承担 Git 读取、查询、缓存和后台任务。
- 第一版聚焦历史、搜索、分支、近期提交统计和按需查看 diff。
- 点击分支改变浏览范围，不切换工作区；先实现只读闭环，适配 Agent 同时操作仓库。
- 当前浏览固定引用快照，外部变化只提示有更新，用户点击刷新后才切换快照。
- 历史分页稳定后即交付元数据搜索：消息搜索框配合明确字段筛选；部分结果自动合并并保持选择和滚动锚点。
- 性能通过同仓库、同硬件的测量验收，不用语言或框架名称代替结果。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [产品范围](docs/PRODUCT.md) | 用户需求、主界面、搜索与统计口径、第一版边界 |
| [界面设计稿](https://claude.ai/artifact/LssQVaEeGiqB1WdCRn2jDa) | 已确认的「v3 · B 细化」画板（示例数据；默认仅所有者可见；以产品范围的文字为准） |
| [界面规范](docs/DESIGN.md) | 颜色、字体、间距、组件与状态的实现规范（以此为准） |
| [交给 Agent 模板](docs/HANDOFF.md) | 各场景 prompt 的文案、变量与防注入规则 |
| [UI-01 验收记录](docs/validation/ui-01-foundation.md) | 界面基础的实现范围、真实数据与占位划分、测试与未验证项 |
| [UI-02 验收记录](docs/validation/ui-02-sessions.md) | 界面接入仓库会话、最近打开与查看记录 |
| [技术架构](docs/ARCHITECTURE.md) | Electron / Rust 分工、通信、Git 读取、分页、索引与刷新 |
| [路线图](docs/ROADMAP.md) | 从技术验证到可日用版本的阶段和验收关卡 |
| [实施计划](docs/PLAN.md) | 可直接开始执行的任务、依赖、交付物和完成条件 |
| [性能与正确性验收](docs/VALIDATION.md) | 测试仓库、性能预算、测量方式和关键边界 |
| [P0-01 代码级计划](docs/implementation/p0-01-bootstrap.md) | 文件、接口、进程边界、命令与代理分工 |
| [P0-01 验收记录](docs/validation/p0-01-bootstrap.md) | 实测环境、检查结果、修复记录和未验证范围 |
| [P0-02 代码级计划](docs/implementation/p0-02-protocol.md) | 协议契约、调度、上下文判旧、生命周期与代理分工 |
| [P0-02 验收记录](docs/validation/p0-02-protocol.md) | 双端测试、Electron 运行时复测、异常与进程树回收证据 |
| [P0-03 代码级计划](docs/implementation/p0-03-repository-preview.md) | 真实 Git 读取契约、fixture、桌面预览与测量分工 |
| [P0-03 验收记录](docs/validation/p0-03-repository-preview.md) | 独立 Git 对照、只读边界、取消与真实窗口验证 |
| [P0-03 首屏基线](docs/benchmarks/p0-03-first-screen.md) | 10 万提交、10 次启动与整个进程树资源采样 |
| [P0-04 代码级计划](docs/implementation/p0-04-reader-comparison.md) | 独立 CLI / gix 实验、数据契约与代理分工 |
| [P0-04 验收记录](docs/validation/p0-04-readers.md) | 深页、原始字节、兼容性、只读与取消验证 |
| [读取路线决策](docs/decisions/0001-git-reader.md) | 保留 Git CLI，gix 暂仅用于实验 |
| [M0 汇总基线](docs/benchmarks/m0-baseline.md) | 180 项读取对比、参考硬件、冻结预算与限制 |
| [P1-01 代码级计划](docs/implementation/p1-01-repository-sessions.md) | 固定 HEAD 会话、持久身份、查看记录与非视觉桥接契约 |
| [P1-01 验收记录](docs/validation/p1-01-repository-sessions.md) | 真实会话、存储降级、取消竞态与双运行时协议验证 |

建议按产品范围 → 技术架构 → 路线图 → 实施计划阅读。下一步是 `M1 / P1-02` 固定快照与可续读历史分页；分页稳定后提前交付元数据搜索。UI 按 Claude 的设计推进，P1-01 仅接入后端与非视觉业务接口。

## 本地运行

当前验证环境为 macOS 27.0.1 / Apple Silicon，使用 Node 26.0.0、pnpm 10.28.1、Rust 1.95.0；版本分别由 `.node-version`、`packageManager` 和 `rust-toolchain.toml` 固定。准备这些工具后，在项目根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 先构建 Rust、生成协议类型并构建前端，再打开窗口；本项没有 HMR。首次启动可能需要下载已锁定版本的 Electron 二进制。可通过“选择目录”或绝对路径输入打开仓库；列表默认展示 Committer 时间（本地时区），详情分别显示 Author / Committer 及其原始时间偏移。关闭窗口会退出应用；终端中断会回收本次启动的进程。已构建后可用 `pnpm start` 直接打开，或用 `pnpm start --repository=/绝对路径/仓库` 直接进入预览。当前只读本地对象，系统 Git 必须支持 `--no-lazy-fetch`；不支持时返回错误，不自动降级补拉。

常用检查：

```sh
pnpm protocol:check
pnpm typecheck
pnpm build
pnpm test:protocol
pnpm test:sessions
pnpm test:renderer
pnpm test:repository
pnpm test:smoke
node --test tests/repository/benchmark-process-tree.test.mjs
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
```

`pnpm protocol:generate` 从 Rust 类型导出三份 schema 和 TypeScript，`protocol:check` 只校验产物一致性。`test:protocol` 覆盖真实 daemon、受控故障协议和慢 Git 子进程回收。Smoke 会启动并关闭真实 Electron 窗口，覆盖正常启动、失败状态、隔离与进程退出；本地截图写入已忽略的 `output/playwright/`。`test:repository` 自动生成临时真实 Git 仓库，完成独立字段对照、只读快照与 Electron 界面验证。性能实测见首屏基线；发布预算尚未验收。

`test:renderer` 用假接口测试界面的会话状态（判旧、取消、记录时机），不启动 Electron。`test:sessions` 只构建 daemon，使用临时 Git fixture 与独立应用数据目录验证会话 / 查看记录，不启动 UI。旧预览的纯 headless 回归可运行 `node scripts/test-repository.mjs`。应用通过 main 把 `userData/repository-state` 传给核心；直接运行 daemon 时，未配置 `COMMITSCOPE_APP_DATA_DIR` 会禁用持久化，仍可浏览。存储不会因打开仓库就标记已读，调用方需在真实内容展示后显式记录查看。

## 工程布局

```text
apps/desktop/               Electron main、preload、React renderer
crates/core/                Rust 协议类型与 schema 导出
crates/daemon/              Rust 常驻进程、查询调度、只读 Git 与首屏解析
packages/protocol/          生成的 schema / TypeScript、桌面状态接口
scripts/                    协议生成、构建、启动、fixture 与测量脚本
tests/smoke/                真实 Electron 集成检查
tests/protocol/             客户端协议、判旧与生命周期测试
tests/sessions/             仓库会话、查看记录、存储降级与取消集成测试
tests/renderer/             界面会话状态的单元测试（假接口，不启动 Electron）
tests/repository/           独立 Git 对照、只读快照和取消测试
tests/readers/              CLI / gix 实验的 headless 正确性与取消测试
tests/fixtures/             fixture 生成和使用说明
docs/                      产品、架构、路线图、计划与验收
```

可按以下命令生成独立的 10 万提交数据集并复测；输出目录必须是新目录，结果 JSON 不覆盖已有文件：

```sh
mkdir -p output/fixtures
pnpm fixtures:generate --output output/fixtures/local-100k --large --seed 20261107
pnpm build:release
pnpm benchmark:first-screen --repository="$PWD/output/fixtures/local-100k/large" --runs=10 --output=output/benchmarks/local-first-screen.json
```

读取实验可独立构建与测试，复用上面已生成的 10 万提交数据，无需构建桌面：

```sh
pnpm build:reader-bench
pnpm test:readers --large-repository="$PWD/output/fixtures/local-100k/large"
pnpm benchmark:readers --repository="$PWD/output/fixtures/local-100k/large" --preflight --output=output/benchmarks/local-readers-preflight.json
pnpm benchmark:readers --repository="$PWD/output/fixtures/local-100k/large" --runs=10 --output=output/benchmarks/local-readers.json
```

测量前等待所有构建 / 测试结束；预检与正式结果分开保存。gix 仅为实验 dev-dependency，不进入生产 daemon 依赖。`test:readers` 要求一个已生成的 10 万提交 fixture，缺失时会提示生成命令。

`build:release` 使用优化的 Rust 二进制和构建后的桌面资源，尚非安装包。生成数据、原始采样和截图保存在忽略目录；源码中保留生成器和验收报告。历史分页、图布局、元数据索引和查询缓存尚未实现。当前仅验证本机 macOS；Windows 在跨平台阶段验收，Linux 后续评估。Electron 45.2.3 内置 Node 24.22.2，与用于构建的 Node 26 分开记录；锁文件已保留。

## 决策来源

2026-11-07 根据[《Git客户端替代方案》对话](chatgpt-conversation://6aee1e91-eb04-83e9-b710-302e29850b14)及本次要求整理。以对话后半段对需求的收敛为准：历史和搜索优先，merge 与 review 次要。本次明确选择 Electron，并取消此前“评估复用 GitComet 后端”的候选路线。

同日用户通过四项选择确认：固定快照并点击刷新、提前交付元数据搜索、消息搜索框配合明确字段筛选、部分结果自动合并并保持选择和滚动锚点。随后授权由主代理制定代码级计划与验收、轻量模型代理实现；P0-01 至 P0-04、P1-01 后端与非视觉接口已完成，后续任务按实施计划推进。

同日用户在设计画布上比较多个方向后确认界面 v3：提交列表 + 详情双栏，分支与 worktree 收进范围选择器，文件改动放到详情第二层；并新增分支合入状态（对比 origin/main，识别 squash / rebase 合并）、按需计算的包含分支和按 Author 的活动分布。随后补充上次查看后新增标记、更新明细、merge 带入的提交、trailer、宽分支图、窄窗口、筛选弹层、定位横幅与 ⌘K 命令面板。产品、架构、计划与验收文档已同步。

公开发布名称、项目许可证和分发渠道尚未决定，不影响本地开发。
