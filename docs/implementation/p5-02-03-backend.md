# P5-02 / P5-03 后端代码级计划

日期：2026-11-12。范围：Rust 核心、生成协议、daemon 对照测试；不修改桌面端手写代码。

1. 在 core 的独立 operations 类型模块定义 getBranchSync、checkOperation、runOperation；server 沿用已有 fetch 独立操作额度。读取与预检仅使用隔离运行器，写入仅在 operations.rs。
2. 分支同步使用冻结引用 OID 与捕获的 upstream 映射；实时操作重新读取 HEAD、目标、上游、worktree 和进行中操作。只接受完整引用与仓库对象格式对应的完整 OID。
3. 快进非当前分支使用 update-ref 的旧值比较交换；当前分支使用固定 merge --ff-only --no-autostash 模板；切换与创建使用 switch / branch，不强制覆盖。
4. 经核查 Git 源码，read-tree 即使 dry-run 也创建 index.lock，故不使用。工作区预检用只读 status、diff --name-only 和 ls-files 检查 index / 工作区，不写仓库临时文件；涉及文件按原始字节返回。拒绝场景对仓库内容、元信息做前后快照。
5. fetch 与快进拆开：保留 fetchRepository；移除草案的 fetchFirst，界面先 fetch、刷新 OID，再 check / run。fetch 成功的写入不能冒充快进被拒绝时“完全没有写入”。switch 补充目标 expectedOid；createBranch 补充 expectedHeadOid，避免切换工作区前提变化。
6. navigation 捕获 upstream 与净化后的 remotes；不向界面暴露 URL 凭据。补真实 Git fixture：当前 / 其他分支快进、分叉、脏文件、worktree、进行中操作、引用变化、远端跟踪创建、名称校验、hook 与全局配置、SHA-256。
7. 运行 Rust 和协议 / pages 检查，更新接口约定、PLAN 与 DEVELOPMENT。Git 开始执行后的 I/O / hook 失败按实际错误报告，不声称仓库未写入。外部 Git 进程在最后一次预检之后的竞态由 Git 自身锁与 CAS 作最后保护，不提供跨任意外部进程的事务承诺。
