<img src="docs/brand/icon/cherrypeek-256.png" width="96" height="96" alt="CherryPeek icon">

# CherryPeek

中文 | [English](README.en.md)

只读的桌面 Git 历史浏览器，适合提交频繁的仓库，比如 Agent 一天要提交很多次的时候。一眼看清最近提交了多少、谁提交的、改了什么、分支之间是什么关系，而且不动你的工作区。

> **状态：早期预览版（0.1）。** 目前只支持 Apple 芯片的 Mac。只读浏览的功能已经齐全；长时间运行的稳定性、Windows 和 Intel Mac 还没有覆盖。名字取自 cherry-pick 的谐音：挑着看一眼提交，什么都不改。（早期文档里叫 CommitScope，代码内部标识仍沿用 `commitscope`。）

## 能做什么

- **提交历史**：带分支图的提交列表，为大仓库设计（在 10 万提交、1000 个引用上测过）。可以按任一分支、标签或 worktree 浏览，切换时不会 checkout。
- **提交详情一页看完**：完整消息和 trailer、作者与提交者、父提交、包含它的分支、改动概览，下面是每个改动文件的 diff（上下合并或左右并排，只看改动或完整文件）。
- **搜索**：按消息、作者 / 提交者、日期、OID 和路径筛选，基于本地索引；索引还在建时结果也不会乱跳。任一结果都能定位到完整历史里看前后提交，再回到结果。
- **文件**：浏览任一提交的目录树，旁边是文件或目录的历史；点开某次修改，修改视图从左侧滑入盖住文件；支持逐行追溯，能在一个提交改动的所有文件之间切换。
- **工作区**：当前 worktree 里已暂存、未暂存、未跟踪和冲突的文件，以及它们的 diff。
- **已合入状态**：按可达性判断分支是否已合入默认分支；squash 或 rebase 合入的，按补丁内容判断。
- **导航**：跨页面的后退 / 前进（⌘[ / ⌘]），⌘K 快速跳到提交、分支和 worktree；每个快捷键在所有页面含义一致，完整列表在顶栏的键盘图标里。
- **交给 Agent**：一键复制写好的提示词，让 Agent 审阅某个提交、解释一次合并，或审阅某个时间点以来的所有提交。

## 只读

- 这个版本只读取你的仓库：不做 checkout、暂存、提交、合并、rebase 或推送，浏览分支也不会切换工作区。
- 仓库里的内容一律当作不可信的文本处理，窗口运行在沙箱里。
- 缓存和搜索索引存在 `~/Library/Application Support/CherryPeek`，不会写进你的仓库。删掉这个目录就能清除应用存下的所有数据。

## 安装

1. 从 [Releases](../../releases) 下载 `CherryPeek-<版本>-arm64.dmg`（已经过 Apple 签名和公证）。
2. 打开后把 CherryPeek 拖进“应用程序”。

要求：Apple 芯片的 Mac，macOS 12 或更新，已安装 Git（Xcode 命令行工具自带的就够：`xcode-select --install`）。

## 从源码构建

需要 Node.js（版本见 `.node-version`）、pnpm 10、Rust 工具链（见 `rust-toolchain.toml`）和 Git。

```sh
pnpm install
pnpm dev                 # 构建并启动
pnpm start               # 启动上一次的构建
pnpm package:mac         # 为本机打一个未签名的 .app / .dmg，放在 release/
```

签名发布用 `pnpm release:mac`，见[发布流程](docs/RELEASE.md)。

## 文档

- [开发说明](docs/DEVELOPMENT.md)：开发进度、完整文档索引、本地运行与测试命令、工程布局
- [产品范围](docs/PRODUCT.md)、[界面规范](docs/DESIGN.md)、[技术架构](docs/ARCHITECTURE.md)、[实施计划](docs/PLAN.md)
- [发布流程](docs/RELEASE.md)

## 许可证

[MIT](LICENSE)。第三方许可证列在 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)，也随应用一起附带。
