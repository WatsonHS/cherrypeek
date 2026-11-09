# P4-08 合入状态的补丁比对

2026-11-10，用户授权在提交 P4-07 后继续实施。

## 代码级计划

- `crates/core/src/lib.rs`：`MergeStatus` 增加 `patchEquivalent`，重新生成协议产物，复用现有查询和取消接口。
- `crates/daemon/src/navigation.rs` 与 `patch_equivalence.rs`：先保留冻结 OID 的祖先判断；不可达且历史完整时，对两侧独有提交生成只读 diff，再用 `git patch-id --stable` 比较。全部分支提交都有等价补丁，或从唯一 merge-base 到分支 tip 的整体 diff 匹配基准侧单个提交，才返回新状态。
- 每次比较最多 512 个两侧独有提交，单侧补丁最多 8 MiB，沿用请求 deadline 和取消信号。浅历史、超限或读取不完整不产生否定结论。空补丁不作为匹配证据；分支含 merge 时不忽略 merge 提交，改走整体 diff 判断。只读取已捕获 OID，不 fetch，不写对象。
- 范围菜单显示“内容已在 {实际基准}”，未匹配不显示标签；补丁等价分支也可交给 Agent 核查清理，提示词明确重新比对，不能凭旧快照强制删除。renderer 继续按快照保留已查状态，关闭菜单取消查询。
- 用真实临时仓库覆盖普通 merge、rebase、cherry-pick、多提交 squash、额外改动 squash、空提交、上限和冻结快照；独立 Git 对照。只跑相关 Rust 测试、协议生成、类型检查及提示词测试。

## 判断口径

遵循 [git cherry](https://git-scm.com/docs/git-cherry) 的补丁等价口径，使用 [git patch-id --stable](https://git-scm.com/docs/git-patch-id) 忽略空白、行号及文件 diff 顺序。该状态说明历史中存在等价补丁，不保证基准当前树从未撤销这些改动。合并时改过内容的 squash 不保证识别。

## 状态与证据

已完成，未公开发布、未推送。

- `cargo test --locked -p commitscope-daemon navigation::tests:: -- --nocapture`：7 项通过。真实临时仓库覆盖普通 merge、两提交 squash、rebase、cherry-pick、附加改动 squash、仅合入一部分、空提交；独立 `git cherry` / `git patch-id` 对照一致。捕获后移动基准引用，仍按原 OID 比较。513 个独有提交返回 `unavailable`，浅历史不推断补丁，取消返回取消。查询前后 refs、工作区状态和对象统计不变。
- `pnpm protocol:generate`、`pnpm typecheck`：通过，新枚举贯通 Rust、schema、TypeScript 和 main 验证器。
- `COMMITSCOPE_RENDERER_TEST_FILES=handoff-prompt.test.mjs pnpm test:renderer`：6 项通过，补丁等价允许交给 Agent 核查；提示词要求重新比对、检查后续撤销，`-d` 拒绝时需用户确认，不能直接强删。
- `pnpm package:mac`：更新 arm64 `.app` / `.dmg`，日志 `output/benchmarks/p4-08-package.log`。
- `node tests/smoke/patch-equivalence-smoke.mjs`：真实包内 SHA-256 仓库通过。菜单显示 squash 的“内容已在 origin/main”、祖先分支的“已合入”，未合入分支无标签；清理对话框显示等价补丁并可复制对应 prompt。HEAD、refs、工作区状态和对象统计不变。截图 `output/playwright/p4-08-patch-status.png` 与 `p4-08-patch-handoff.png`。

未跑全量回归、Windows 或大规模分支菜单性能测量。本项不是公开发行、签名公证或长期稳定性验收。
