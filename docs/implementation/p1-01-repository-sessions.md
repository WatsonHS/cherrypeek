# P1-01：仓库会话与本地查看记录代码级计划

日期：2026-11-07。状态：后端与非视觉接口已通过本机验收，见[验收记录](../validation/p1-01-repository-sessions.md)。先完成 HANDOFF 的五项修订，再按本计划实现 P1-01 的 Rust 会话、持久化及非视觉桌面接口。主代理定稿契约、复核与验收，轻量模型代理实现。renderer、样式与设计文件由 Claude 负责，本项不改，也不运行 UI 构建或视觉测试。

## 边界与行为

- 生产仍使用 Git CLI；复用只读 Git、发现、摘要解析、取消和协议。一个 daemon 连接仅保留一个当前仓库会话。
- 本项范围固定为 `head`。会话捕获打开时的 HEAD OID，空仓库为空集合，detached 保留完整 OID。外部提交不会改变会话；重新 open 会创建新上下文。多 tip 范围、refresh、游标和长期遍历放 P1-02 / P1-04。
- 不因打开仓库就标为已读。调用方在内容实际展示后，在失焦 / 切换 / 关闭时显式调用 `recordRepositoryView`，后端仅保存当前会话捕获的 tips；不接受客户端传入 tips，也不重新查询外部最新 HEAD。打开时返回的 previousView 在本次会话内保持不变。
- 保留 P0 `readRepositoryPreview` 的 null 上下文契约与原 renderer。新增 main / preload 窄业务接口供后续 UI 接入；本项可通过 headless 真实 daemon 完整验证，不宣称最近仓库菜单或新增标记已显示。

## 文件所有权

| 代理 | 文件 |
| --- | --- |
| Rust | `crates/core/src/lib.rs`，`crates/daemon/src/{server,repository,session,main}.rs`，必要的 Rust tests；Cargo.toml / Cargo.lock；协议生成产物 |
| 存储与独立验证 | `crates/daemon/src/session_store.rs` 及其单元测试，`tests/sessions/**`、`scripts/test-sessions.mjs`、package.json 的 `test:sessions` 命令 |
| 桌面桥接 | `apps/desktop/src/main/{core-process,protocol-transport,index,repository-session-controller}.ts`、preload、窄接口类型文件、非视觉协议 / controller 测试；不改 renderer 或旧 preview controller |
| 主代理 | 本计划、HANDOFF / PRODUCT / ARCHITECTURE / PLAN / VALIDATION 同步、验收证据和代码复核 |

共享目录，不还原他人改动；Cargo / schema 只由 Rust 代理变更。工作开始前各代理阅读本计划，接口变动先通知主代理。不进行格式化全仓以外的无关重构。

## 协议

版本仍为 1，增加 `repositorySessions` capability（表示下列六个方法）和有类型的 response section；Rust 类型生成 JSON Schema / TS，不手改产物。响应 envelope 始终回显请求上下文，open 的新上下文在 payload 中返回。

| 方法 | 上下文 / params | 响应 section |
| --- | --- | --- |
| `openRepository` | null/null，`{path}`，绝对路径且 ≤16 KiB、无 NUL | `repositorySession`，`{session}` |
| `getRepositorySession` | 当前 repoId/generation，`{}` | `repositorySession`，同一固定 session |
| `readSessionPreview` | 当前 repoId/generation，`{}` | 复用 `repository` 与 `commits` 分块，最多 200 条，从捕获的 HEAD 读取 |
| `recordRepositoryView` | 当前 repoId/generation，`{}` | `repositoryViewRecorded`，`{saved,status}` |
| `closeRepository` | 当前 repoId/generation，`{}` | `repositoryClosed`，`{closed:true}` |
| `listRecentRepositories` | null/null，`{}` | `recentRepositories`，`{repositories,status}` |

`RepositorySessionInfo` 字段：`repoId`、`generation`（本次打开唯一且重启不复用），`repositoryKey`、`worktreeId`（下述持久身份），`scope:"head"`、`observedAtUnixMs`、`repository:RepositoryInfo`、`previousView:LastViewedSnapshot|null`、`persistence:{recent:StoreStatus,lastSeen:StoreStatus}`。

`LastViewedSnapshot`：`tips:string[]`、`viewedAtUnixMs`。tips 是与 objectFormat 相符的完整 OID，head 范围最多 1 个；成功看过的空仓库记录 `[]`，与首次查看 `null` 区分。

`RecentRepository`：`repositoryKey`、`worktreeId`、`path`、`gitDir`、`commonDir`、`worktreePath:string|null`、`objectFormat`、`lastOpenedAtUnixMs`。`StoreStatus` 为 `ok | disabled | unavailable | corrupt`。没有配置存储目录时 disabled；存储失败不把已成功打开仓库变成失败。

新增 `PERMISSION_DENIED`；路径权限与固定 locale 下的 Git 权限错误明确映射。缺少 Git、非仓库、目录不可用、缺失对象、取消、超时继续使用已有错误码。绑定方法缺失 / 错误 / 已关闭的上下文返回 `STALE_CONTEXT`，不得替用户猜测当前 session。

## 发现与会话提交

从 repository.rs 提取发现阶段，legacy 与 session 复用；gitDir、commonDir、worktree 根全部规范化，子目录与 symlink 入口映射到相同根。bare 以规范化 gitDir 作为仓库入口。持久身份为稳定 SHA-256：repositoryKey 由版本前缀、canonical commonDir 和 objectFormat 组成；worktreeId 由版本前缀、repositoryKey 与 canonical gitDir 组成（字段用长度前缀或 NUL 分隔，路径已禁 NUL）。分支名称或 HEAD 变化不改变身份；不同 linked worktree 身份必须不同。

open 只做发现，不遍历全部提交。以 worker 执行并保持当前最多两个活动任务限制。只有被接受的 open 分配递增 intent；更新 intent 时取消较早 pending open。候选发现失败或在提交前被取消时不替换已打开 session，也不写最近记录。server 主循环串行处理会话变更；在写入 recent 之前最后核对 intent、取消标志与 shutdown，该点之后按已提交处理，发布 current 并取消旧 session 关联任务，不因迟到取消将已落盘的成功改报失败。存储访问不持有请求表锁，避免会话提交与请求注册的锁反转。旧 worker 不得覆盖新 session；已经排队的旧查询响应仍带旧上下文，由客户端丢弃。运行时探测不因切仓被误取消。

close 只关闭精确匹配的 session，取消其关联任务及尚未提交的 open；迟到 close / record 不得作用于新 session。取消标志由原 Git 子进程回收机制处理，关联任务终止时必须 kill / wait，测试检查最终无残留。EOF / shutdown 取消所有 worker，不自动把未确认展示的打开操作标为已读。

`readSessionPreview` 使用会话中冻结的 RepositoryInfo / 已观察 refs 和 HEAD。refs 仍是独立命令观察值，可能截断；本项不宣称它们与 HEAD 构成原子多引用快照。P1-02 再定义完整查询快照。读取期间对象被外部 GC 移除时保留 `MISSING_OBJECT`，不补拉。

## 存储契约与写入边界

main 在 app ready 后把 `app.getPath("userData")/repository-state` 作为可信 `COMMITSCOPE_APP_DATA_DIR` 传给 Rust，并覆盖继承的同名值；renderer 无传入或修改此路径的接口。直接运行 daemon 未配置该变量时禁用持久化，仍可浏览。

两个 schemaVersion=1 的 JSON 文件：`recent-repositories-v1.json`、`last-viewed-tips-v1.json`。最近最多 20 条；上次查看按 repositoryKey + worktreeId + scope 保存，最多 100 条；文件各限 1 MiB。仅接受当前 `head` scope 和有效字段，未知版本、超限或坏 JSON 返回 corrupt / unavailable，不影响浏览。

存储代理对外接口（Rust 代理与其对齐具体签名，不复制存储实现）：`SessionStore::from_env()`；`recent()`；`open_repository(&RepositoryInfo, repositoryKey, worktreeId, observedAtUnixMs)` 返回 previousView 与两项状态并记录 recent；`record_view(&RepositorySessionInfo)` 返回 saved/status。存储由 server 主循环串行访问；previousView 查询先于任何 viewed 写入，recent 写入只在最终成功 open 提交时进行。旧 tips 只校验格式与数量，不要求等于当前 HEAD；曾看过空仓库的 `[]` 在首次提交后仍是有效记录。

不在启动时创建目录，写入前核对数据根的规范路径：不得在正在查看的 worktree / gitDir / commonDir 内；有缺失层级时先解析最近存在祖先再验证，创建后复核。拒绝状态文件 symlink；临时文件独占创建在同一安全目录，写完 sync 再 rename，不跟随目标 symlink 写入别处。读取 / 写入失败降级并返回状态，不覆盖损坏文件来假装已恢复，不保存任意客户端提供的 tips。不会通过 chmod 等动作修正被查看仓库权限。

本项不引入 SQLite；P1-05 的元数据索引独立实施。serde / sha2 使用已有锁定版本作为普通依赖；libc 用于 Unix O_NOFOLLOW 文件打开保护，getrandom 0.4.3 用于重启不复用的随机 session 标识，随机源失败不回退到易碰撞值。gix 仍仅 dev-dependency。

## 桌面非视觉接口

增加 `RepositorySessionController`，由 main 持有当前 session 与最新 open operation；preload 仅暴露 `openRepositorySession(path)`、`getRepositorySession()`、`readSessionPreview()`、`recordRepositoryView()`、`closeRepositorySession()`、`listRecentRepositories()`。不接收 renderer 指定的 repoId / generation / 数据目录，main 从其 current session 取上下文。

控制方法 open/listRecent 使用 null context，在 transport 中明确作为控制请求绕过当前视图 gate；legacy preview / runtime 同样保持 null context 并独立于 session gate，不顺带放开任意方法或任意参数。session 查询在 open 成功后切换 current gate，取消旧上下文请求；latestObserved 规则不变。open 的取消必须排空核心的最终响应：即使调用方意图已过期，已提交的成功仍用于同步 main 的内部 session，再向旧调用方返回被取代，避免下一次打开失败后两端状态分裂。close 取消并排空正在打开的请求，再关闭准确的当前 session；新的 open 使迟到 close 不能清除新会话。会话变更请求若超时而无法确定是否提交，则使连接失败并回收核心；普通只读查询超时仍只取消该请求。旧 preview / runtime 的 null 请求仍能工作，且不会覆盖 session controller。daemon 退出清理 current；record 仅在调用方确认内容已显示后调用，本项不添加自动 blur / ready 标记。

IPC 继续校验现有可信 mainFrame / APP_URL，参数和路径由 main 与 Rust 双重校验。六个 IPC API 返回可序列化的 `RepositorySessionResult<T>`：成功为 `{ok:true,value}`，失败为 `{ok:false,error:{code,message,retryable}}`，避免 Electron invoke 丢失自定义错误字段；类型放 `packages/protocol/src/repository-session.ts`，由已有 CommitScopeApi 扩展。查询返回有界数据；不新增通用发送器，不改旧 renderer。recent 列表只是路径记录，用户实际打开时重新发现，不假定路径仍存在。

## 验证与完成条件

1. 独立 Git 对照普通、子目录、symlink、bare、linked worktree、unborn、detached、SHA-256；同 commonDir 的 worktree 身份不同且 HEAD 正确。
2. open A/B 乱序、取消 pending open、失败保留旧 session、切换取消旧查询、迟到 close / record 拒绝、重启 handle 失效、真实慢 Git 子进程回收。
3. 外部移动 HEAD 后 get/session preview 仍读旧 HEAD；record 保存旧 tips。打开或失败不标已读；显式 record 后重启可恢复；两个 worktree 上次查看记录互不污染。
4. recent 去重 / 顺序 / 上限；坏 JSON、过大文件、未知版本、无写权限 / 配置不安全、状态文件 symlink 均不妨碍基础查询；仓库/commonDir 内容与权限前后不变。
5. 窄接口与 transport 上下文门控、控制请求、迟到响应、旧 preview 回归；生成 schema 一致、TypeScript typecheck、Rust fmt/tests/clippy。session 独立 runner 只构建 daemon / 协议所需产物，不运行 build.mjs / Vite / Electron UI。
6. 记录 `docs/validation/p1-01-repository-sessions.md` 与未验证项，按证据更新 PLAN；不宣称最终分页 / UI / 搜索 / Windows 已完成。
