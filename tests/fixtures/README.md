# 仓库查询测试夹具

夹具仅用于测试，不是应用演示数据。默认种子为 `20261107`；同一 Git 版本与种子下，提交 OID 和 manifest 元数据可重复。大仓库由流式 `git fast-import` 创建，必须实测恰好包含 100,000 条提交。

```sh
node scripts/generate-fixtures.mjs --output /tmp/commitscope-fixtures
node scripts/generate-fixtures.mjs --output /tmp/commitscope-fixtures-100k --large --seed 20261107
```

输出目录必须是新目录或空目录；生成器拒绝覆盖非空目录、符号链接或 Git 仓库。可查看生成目录内的 `manifest.json`，其中记录 Git 版本、种子、仓库路径、HEAD、引用、对象格式、提交预期与 pack 状态。支持 SHA-256 的 Git 会生成原生 SHA-256 仓库；不支持时 manifest 明确记录未支持。

默认集合覆盖空仓库、拓扑分叉与 merge、双身份、非 UTC 时区、中文及字面 HTML、NUL 和非 UTF-8 消息、4 KiB UTF-8 截断、子目录打开、空格 / 中文 / 换行路径、detached HEAD、bare、linked worktree、shallow 和缺失 promisor 对象。`--large` 增加固定线性历史；当前固定种子的大仓库 HEAD 为 `91081e9df378d40ab325f9c04b9cc4774b2c33ee`。

运行真实 daemon 的仓库正确性与只读检查：

```sh
pnpm test:repository
```

该命令自动生成并清理小夹具，交叉核对独立 Git 结果、常见仓库形态、消息边界、只读与取消回收，再运行真实 Electron 的仓库 smoke。运行前需先构建桌面资源；默认 `pnpm build` 即可。测试不改写正在查看的仓库，也不代表 100,000 条提交的性能预算已经通过。
