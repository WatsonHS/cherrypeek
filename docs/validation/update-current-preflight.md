# 更新当前分支：大仓库预检超时

日期：2026-11-13。状态：修复、真实仓库只读对照与完整功能回归完成；既有 Clippy 告警保留。

## 原因与修复

用户在 `ai-native-workspace` 点击“更新 main”后，Fetch 成功，随后的 `checkOperation` 超过桌面的 20 秒请求限制。该快照落后上游 678 个提交，Git 状态有 699 条记录；两个提交树间的原始变更路径为 8,469 条（启用重命名识别时为 8,402 条）。Git status 约 0.24 秒、路径 diff 约 0.04–0.05 秒，主要耗时在 Rust 中：原实现将每条状态路径与每条变更路径两两比对，并在内层重复解码十六进制路径。

- 原始路径拆分并排序一次，按完整路径、父组件和目录前缀二分查找；每条本地路径只解码一次。分叉时的重叠路径判断复用同样的逻辑。
- 保留原始字节及目录边界，不把 `foo.txt`、`foo-other` 当作 `foo/` 内的文件；支持非 UTF-8 路径。
- 路径列表使用 `--no-renames`，把重命名源和目标都纳入覆盖检查；不执行 diff/textconv。
- CPU 检查循环响应取消并检查截止时间。桌面 20 秒请求上限未提高。
- 8,500 个新文件的实仓 fixture 进一步暴露了快进输出问题：Git diffstat 超过 64 KiB 会触发输出限制。快进增加 `--no-stat`，输出上限和 hooks 行为保持原样。

## 真实仓库只读对照

使用同一 debug daemon 构建口径，只调用 `checkOperation`，没有 Fetch、执行快进、stash、清理或改动用户仓库。

| 项目 | 修复前 | 修复后 |
| --- | --- | --- |
| 请求至终态耗时 | 38,312 ms（诊断客户端允许等待 120 秒） | 525 / 509 / 576 ms（客户端上限仍为 20 秒） |
| 结果 | 拒绝，2 条覆盖风险 | 相同的 2 条覆盖风险 |
| HEAD | `03eb9298fdc2bde200c500b04a685008af5d2189` | 不变 |
| 上游 | `3987358d06eec41ee33911006f01262c7f9c98e5` | 不变 |

两处路径为 `waner/docs/plans/2026-11-12-001-computer-use-speed.md` 和 `docs/product/waner-cu-race/`。修复后三次预检前后的 HEAD、上游、index 文件 SHA-256 和完整 porcelain 状态 SHA-256 一致。原始结果在本地忽略目录 `output/benchmarks/update-preflight/{before,after}.json`。

耗时覆盖整个请求中的 Rust 计算与 Git 子进程，未单独测量 CPU 或 RSS；这是本机固定快照的定向墙钟对照，不作为整树资源或发布性能达标结论。真实仓库存在未提交改动，所以只验证拒绝结果；成功快进在临时 fixture 上验证。

## 回归

- Rust：1,024 组路径集合逐项对照朴素的目录边界判断；覆盖同路径、父子目录、同前缀兄弟、重复目录和非 UTF-8。验证取消及截止时间。
- daemon：8,500 条上游新路径 + 700 条无关未跟踪文件，在桌面的 20 秒预算内完成预检和快进，保留本地文件；预检前后仓库完整快照一致。另验证重命名源的未提交改动会被拒绝、相似前缀的无关文件保留。
- `cargo test --locked -p commitscope-daemon operations::tests`（7 项）、`pnpm test:pages --test-name-pattern='M5 large|M5 fast-forward preflight'`（2 项）通过。随后补充全 700 个本地文件的内容及权限快照对照，定向大仓 fixture 再次通过。
- 完整 `cargo test --workspace --locked`（121 项）、`pnpm test:pages`（40 项）、`pnpm test:protocol`（60 项）、`pnpm protocol:check`、`pnpm build`、`pnpm test:smoke:update-current` 和 `git diff --check` 通过。只对本次 Rust 文件运行 rustfmt 检查，通过；未重排无关源文件。
- `cargo clippy --locked -p commitscope-daemon --all-targets -- -D warnings` 未通过：首先是未修改的 `crates/core/src/lib.rs` 中既有 `large_enum_variant`；临时在检查命令中允许该 lint 后，仍有既有的参数过多、冗余闭包和测试模块位置等告警（含 operations 原先位于文件中部的测试模块）。本轮未更改这些规则或顺带重构其他模块。
- 新桌面构建已生成，运行中的旧进程需要重启加载；未重新打包安装版。
