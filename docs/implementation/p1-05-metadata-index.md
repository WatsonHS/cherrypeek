# P1-05：可恢复元数据索引代码级计划

日期：2026-11-07。状态：已完成本机技术验收，证据见[验收记录](../validation/p1-05-metadata-index.md)。基线为 `ba4a059`（P1-03、P1-04、UI-03 已提交）；本项不自动提交或推送。

## 交付边界

首屏历史先可用，随后在应用数据目录低优先级建立 SQLite 提交元数据索引。支持进度、暂停、继续、取消及重建；搜索仍属于 P1-06，现有搜索占位保持。索引错误不能清空历史或关闭仓库；不写 Git 仓库、不 fetch、不扫描 patch。

不引入 FTS5、通用事件总线或全分支可达矩阵。P1-05 保存完整消息、双身份 / 原始时间偏移、有序 parents 和索引成员关系，为下一项的字面搜索提供正确基线。

## 存储与恢复

- 依赖锁定 `rusqlite = 0.41.1`，使用 bundled SQLite；2026-11-07 已通过 crates registry 与[官方 API 文档](https://docs.rs/rusqlite/0.41.1/rusqlite/)确认版本。仅 Rust 持有 SQLite，renderer 不读文件 / SQL。
- 路径为 `COMMITSCOPE_APP_DATA_DIR/metadata-index/<repositoryKey摘要>/index.sqlite3`。复用 SessionStore 的路径规范化 / 仓库保护校验；同时检查最终目录、DB 及 journal / wal / shm 等已知侧文件，拒绝 symlink、异常类型及 Unix 多硬链接文件。未配置应用目录、权限不足或路径不安全时返回 unavailable，不创建仓库内目录。重建只处理该仓库缓存的确切文件，不递归删除调用方目录。
- schema v1 使用 `PRAGMA user_version` 和固定 `application_id`。只有空库可以初始化；损坏 / 不兼容库保留并报告，用户明确点“重建此仓库索引”后丢弃可重建缓存。未知版本不得静默当空库。迁移 / 初始化在事务中完成。
- 使用单写连接、小批事务、外键、`trusted_schema=OFF`、`journal_mode=DELETE`、`synchronous=FULL` 和有界 SQLite cache。原子提交和配额机制依据 [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html) 与 [PRAGMA](https://www.sqlite.org/pragma.html)。不启用扩展加载。
- 一库对应对象库。`commits` 以完整 OID 为主键，至少包含 `oid, parents_json, summary, summary_truncated, message, author_name, author_email, author_timestamp, author_offset, committer_name, committer_email, committer_timestamp, committer_offset, text_lossy`。消息不使用截断摘要替代；时间原始字符串和偏移保留。解析复用现有 cat-file 对象读取，UTF-8 / 声明编码降级规则沿用 `text_lossy`，不偷偷更改已有摘要语义。
- `snapshots` 保存 `snapshot_key, tips_json, graph_fingerprint, processed, complete, state, last_used_unix_ms`；`snapshot_commits` 保存 `snapshot_key, ordinal, oid`，具有 `(snapshot_key, ordinal)` 主键及 `(snapshot_key, oid)` 唯一约束。metadata 插入、成员插入和 processed 检查点必须同一事务提交。metadata 复用不等于某快照包含该提交。
- snapshot_key 是版本、repositoryKey、objectFormat、排序后的唯一冻结 tips、shallow/grafts 指纹的摘要；不依赖临时 generation。相同根与图边界可复用，scope / worktree 的查看记录仍按 P1-04 独立保存。最多保留 8 个快照成员集合，超出时事务删除最旧非活动快照；再次访问被淘汰快照必须重新建立 coverage，不能沿用旧 complete。提交对象缓存不预先物化所有分支关系。
- `processed` 仅计已事务提交的唯一成员；只有 rev-list 正常 EOF、全部对象成功写入且最终图指纹一致时才 complete。空 tips 的正常遍历可得到 complete / 0。错误、取消、配额中断不能把“当前已有条目”冒充全部结果。
- 连续运行使用一个有界 `rev-list --topo-order <冻结 tips>` 流，每批最多 64 个 OID，再批量 cat-file。恢复从持久检查点重放 / 跳过已提交前缀，检查顺序与检查点一致后续读，不反复为每批全量重走。恢复成本需明确记录，本项不宣称 O(1) 恢复。每批前后及完成前复核图边界；不受外部普通 refs 移动影响。
- 默认磁盘配额 2 GiB / 仓库，含 DB 与侧文件。用 `COMMITSCOPE_INDEX_QUOTA_BYTES` 提供有界的进程配置 / 测试覆盖（256 KiB 至 2 GiB，非法值明确 unavailable）。主 DB 页预算最多配额的三分之一，为 rollback journal 和文件头留空间；同时统计实际侧文件总量。到限停止写入并报告 quotaLimited，保留已提交前缀，不自动删除用户文件或谎报完整。小配额测试必须验证实际文件占用与事务回滚。

## 后台任务与生命周期

- 每 daemon 最多一个后台索引任务，不放入两条交互请求的 active map。后台仅在无交互任务时开始下一小批，状态轮询 / 控制请求不能让它永久饥饿；每批 Git 读取有 deadline、输出上限和取消标志。
- 打开会话只绑定索引上下文，不等待 SQLite。首次成功历史页之后安排 ensure；scope / refresh 的新首屏同样可触发。ensure 幂等：持久 paused / cancelled 不自动重启，running 的中断记录可在重开同快照后续建，complete 可直接复用。
- 暂停和取消均停止 / 回收流并保留已提交批次，区别是 UI 状态；用户“继续”可恢复。取消不是清除缓存。重建先停任务，再清理这个对象库的派生 DB，重新准备当前固定快照。对已经 complete 的暂停 / 取消是无副作用操作。
- scope / refresh 提交成功、关闭、切仓及 EOF 时停止旧任务；打开或刷新失败不停止原会话任务。所有控制操作在执行时复核 repoId / generation，旧任务和迟到控制不得覆盖或取消新任务。后台进度不写入新 session；退出必须回收其 Git 子进程与线程。
- status 读取内存中的有界状态，只允许少量文件 stat 核对，不打开 SQLite 做全库校验，也不重新扫描 refs。打开 / 恢复时检查 schema 和库完整性；状态查询及下一批检查 DB 是否被移除 / 替换，失去缓存应退回 incomplete / unavailable，不能继续显示陈旧 complete。

## 冻结跨层契约

protocolVersion 仍为 1，新增 `metadataIndex` capability。新方法在 Rust 路由、生成 schema、TypeScript 手写 transport 参数 / 模式 / 取消允许列表中同时登记。

```ts
type MetadataIndexAction = "pause" | "resume" | "cancel" | "rebuild";
type MetadataIndexState = "idle" | "queued" | "running" | "paused" | "cancelled"
  | "complete" | "quotaLimited" | "unavailable" | "failed";
type MetadataIndexStatus = {
  snapshotKey: string | null;
  state: MetadataIndexState;
  coverage: { processed: number; complete: boolean };
  diskBytes: number;
  quotaBytes: number;
  error: { code: ErrorCode; message: string } | null;
};
```

- 错误码补充 `INDEX_UNAVAILABLE`、`INDEX_CORRUPT`、`INDEX_VERSION_UNSUPPORTED`；Git、图边界、配额错误继续使用既有稳定错误码。故障体放在 index status，不让全局 CoreStatus 进入 error。
- `getMetadataIndexStatus {}` 与 `controlMetadataIndex {action}` 绑定当前 session；响应统一 `section: "metadataIndex", status`。协议 envelope `coverage={complete:true,processed:1}` 表示状态响应完整，与内部索引覆盖不同，禁止混用。状态内 complete 只在 state=complete 时为 true。
- 控制请求返回已确认状态：pause/cancel 返回时后台旧批次已停止，resume/rebuild 可返回 queued/running；重建仍有错误则返回失败 status。不可将“命令已排队”伪装为“暂停已完成”。不发送完整元数据数组给 renderer；验证通过 SQLite 文件与独立 Git 对照。
- preload 仅加 `getMetadataIndexStatus()`、`controlMetadataIndex(action)`，都返回既有 RepositorySessionResult；不允许 renderer 传 repoId、generation、路径、SQL、quota 或任意方法名。
- main controller 严格校验 action，处理请求取消 / 排空与会话变更；status 的旧结果有独立请求意图判旧，BUSY 不使历史失效。真实 controller → transport → daemon 的集成测试必须覆盖两种新方法。
- renderer 使用独立 index 状态，不混入历史 coverage。首屏 ready 且打开 / 刷新 / scope / 翻页 / 导航 / 查看记录请求空闲后才轮询；窗口可见时约 1 秒一次，终态减少频率或在聚焦 / 显式操作时重查。一次只允许一个 status/control 请求，BUSY 延后重试，不发同帧请求风暴。换会话、隐藏及卸载清理计时器和旧响应。
- 底栏显示“索引：已处理 N 条 / 已暂停 / 已取消 / 当前范围已完成 / 已到缓存上限 / 索引不可用”等实际状态，不给未知总量百分比。动作使用小型状态弹层或按钮，提供暂停、继续、取消、重建此仓库索引；错误文案说明历史仍可浏览。保留未接入搜索的占位及 UI-03 窗口外壳。

## 实现分工

1. Rust 代理拥有 `crates/core`、`crates/daemon`、Cargo manifest / lock 和一次 schema / TS 生成。新增 `metadata_index.rs`（可按存储 / job 必要拆分）；先落协议类型并生成，随后实现存储、完整 metadata 解析、后台任务和 server 生命周期。不得创建通用调度框架。
2. 桌面代理拥有 `apps/desktop`、protocol 手写类型、`tests/protocol`、`tests/renderer` 及对应 runner。保留现有会话、分页、导航和无边框外壳；先按冻结契约接入，等 Rust 就绪做真实集成。既有 `tests/smoke/electron-smoke.mjs` 的接口白名单也由桌面代理同步。
3. 验证代理拥有新 `tests/indexing/`、`scripts/test-indexing.mjs`、索引 Electron smoke 与 package scripts，不修改生产代码。测试独立对照完整 SQLite metadata / 成员、暂停 / 取消 / 强退恢复、固定 tips 与新快照、损坏 / 版本 / 缺失 / 配额 / 安全路径、只读、旧操作不影响新会话。
4. 主代理拥有本计划和验收文档、契约审查、构建与实窗协调。所有代理共享工作区，不覆盖他人编辑，不自行提交 / push，不并行启动实窗。

## 验证与完成条件

- Rust / schema / TypeScript / renderer / 双 Node 协议检查；新增真实索引集成与 SQLite 内容对照，包含 SHA-256、双身份、原始时区、正文非 ASCII、长消息、多父、有序 parents、空范围、shallow / 缺对象降级。
- 控制慢 Git 批次，验证 pause/cancel 时进度稳定、恢复不重复，daemon 强退后同 app data 能继续，旧快照能在持续外部提交期间完成；不是仅验证重新从零构建。
- 故障缓存与小配额不阻碍历史；complete 与实际成员、持久 processed 一致。重建的删除范围明确；仓库和 linked worktree 内容前后不变；后台不触发网络 / 维护 / 写操作。
- 真实 Electron 验证历史先可用、实际进度和控制、失败不遮挡历史、换范围不闪回旧进度、退出清理。首次实测仅做本项行为和资源边界，不重新跑 P1-03 性能矩阵；索引速度 / 恢复重放成本如未测，不作性能承诺。
- 更新 README / PRODUCT / ARCHITECTURE / PLAN 和专属验收记录，只有实际跑过的检查标为完成。P1-06、M1 和 MVP 不随本项提前完成。
