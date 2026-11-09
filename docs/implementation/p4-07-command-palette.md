# P4-07 命令面板

2026-11-10 已实现并通过包内实窗检查。交付 ⌘K / Ctrl+K 快速跳转，按现有 DESIGN 的 600px 居中浮层实现，不新增依赖。

- `components/command-palette.tsx`：Radix Dialog 管理焦点、遮罩与关闭；输入筛选，按提交 / 分支 / 标签 / worktree / 命令分组，方向键选择、回车执行、Esc 或点击外部关闭。输入法组词期间不执行快捷键。关闭时卸载列表，结果限制数量。
- `lib/command-palette.ts`：纯函数构建可用命令及匹配结果；范围沿用当前会话的冻结导航信息，缺失 worktree 不作为可执行结果。
- `app.tsx` / `top-bar.tsx`：接入全局快捷键与可点击入口；复用打开仓库、浏览范围切换、页面切换、复制当前提交以及提交历史定位。没有仓库时仍可打开仓库。
- `locateCommit`：接受 4 位以上十六进制前缀，由 Rust 通过只读 Git 解析为完整提交 OID，再按当前快照定位；保持范围外提示、取消与过期结果隔离，不依赖元数据索引。完整 OID 的现有行为保持。

定向验证：命令匹配 / 不可用项与前缀定位测试，类型检查，一次真实 Electron 流程（键盘、输入法、关闭与焦点、分支浏览不 checkout、短 hash、复制、页面切换）。完成后更新本机应用包，不执行提交或推送。

## 结果

- 命令面板与会话状态定向测试 43 项通过；覆盖 Unicode / 大小写筛选、精确引用身份、不可用项隐藏、2000 条引用时的结果数量上限，以及短 hash 响应使用完整 OID。
- Rust 历史定位定向测试通过：完整 / 大写短 hash 定位到同一页，旧页与前后游标可继续使用，过短、非 hash 与不存在的前缀被拒绝。
- 协议已重新生成，`pnpm typecheck` 和 release 打包通过。
- `pnpm test:smoke:command-palette` 在实际 arm64 应用包与真实临时仓库通过：未打开仓库时用命令调起目录选择（仅系统选择器返回值替身）；输入法期间 Enter / Esc / ⌘K 不执行；方向键选择并切换页面；分支、标签和 worktree 浏览；先选中 HEAD 再用旧提交短 hash 定位，复制得到完整目标 OID；无匹配状态、外部关闭、Esc 与焦点恢复。面板内按钮聚焦时，全局页面快捷键不会穿透。原仓库 HEAD 仍指向 main，工作区无改动。
- 面板仅在打开时生成列表，各分组最多显示 20 项，更多时提示继续输入；仓库或快照切换会关闭旧面板。导航信息未加载时按现有接口读取，执行时复用既有取消与判旧逻辑。

截图：`output/playwright/p4-07-command-palette.png`；定向检查输出：`output/benchmarks/p4-07-renderer.log`；打包输出：`output/benchmarks/p4-07-package.log`。已更新 `release/mac-arm64/CommitScope.app` 和 `release/CommitScope-0.1.0-arm64.dmg`。本轮未做完整性能矩阵、Windows 或公开分发验收，未公开发布、未推送。
