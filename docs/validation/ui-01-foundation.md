# UI-01：界面基础与 v3 外壳验收记录

日期：2026-11-07。环境：macOS 27.0.1 / Apple Silicon，Node 26.0.0，pnpm 10.28.1，Electron 45.2.3。实现与验证由 Claude 完成；同一时间 P1-01 的代理在同一工作区修改主进程、preload、协议类型与 Rust 代码，P1-01 完成后在合并后的工作区复跑了全部检查。

## 实现内容

- 依赖（精确版本）：`tailwindcss` 4.3.5、`@tailwindcss/vite` 4.3.5（根 devDependencies）；`radix-ui` 1.8.1、`class-variance-authority` 0.7.1、`clsx` 2.1.1、`tailwind-merge` 3.7.0、`lucide-react` 1.70.0（桌面应用）。
- 样式：`apps/desktop/src/renderer/styles.css` 引入 Tailwind，并按 [DESIGN](../DESIGN.md) 定义浅色 / 深色 token、头像 8 色板与分支线颜色；深色由 `data-theme` 切换，跟随系统外观。字体用系统字体栈并保留中文回退。
- 组件：`components/ui/` 下按 shadcn 方式实现 Button、Badge、Input、Popover、Tabs、Skeleton；应用组件有顶部栏、提交列表、详情、状态栏、打开仓库页与占位组件。
- CSP 未改动（仍为 `style-src 'self'`）。构建产物中 HTML 不含 `<style>`；没有使用会注入样式标签的组件（ScrollArea、模态 Dialog）。
- 新增 `copyText` 窄接口：类型在 `packages/protocol/src/core-status.ts`，preload 转发，main 校验可信主框架、只接受 1 至 65,536 个字符的字符串，再写系统剪贴板。主进程的权限处理仍一律拒绝，`navigator.clipboard` 因此不可用，复制统一走这个接口。
- 测试调整：`tests/smoke/repository-smoke.mjs` 改为先打开“切换仓库”弹层再操作路径输入，新增“复制 OID 后剪贴板内容等于完整 OID”断言；`tests/smoke/electron-smoke.mjs` 的 preload 接口清单更新为当前 14 个（含 P1-01 新增的 6 个会话接口与 `copyText`）。

## 真实数据与占位

| 区域 | 状态 |
| --- | --- |
| 仓库名、HEAD、worktree（主 / linked / bare）、浅克隆标记 | 真实数据（P0-03 预览） |
| 引用列表与按引用在已加载提交中定位 | 真实数据；暂不支持切换分支 |
| 提交列表、按天分组、作者头像、引用标签、键盘上下选择 | 真实数据（HEAD 前 200 个） |
| 分支图 | 真实父关系，由前端临时布局（`lib/graph.ts`），最多画 6 条线；P2-01 替换 |
| 详情：作者与时间、OID、父提交、引用、HEAD 关系、复制 OID | 真实数据 |
| 加载、空仓库、错误与取消状态 | 真实状态 |
| 搜索与筛选 | 占位 · P1-06 |
| “有 N 处更新”与更新明细 | 占位 · P3-03（示例数据） |
| 近期活动 | 占位 · P3-02（示例数据） |
| 完整消息与 trailer、改动概览、包含它的分支 | 占位 · P2-02 |
| 文件改动与 diff | 占位 · P2-02 / P2-03（示例数据） |
| 交给 Agent | 占位 · P3-05：预览使用真实仓库路径、OID 与标题，复制按钮禁用 |
| “上次看到这里”标记、最近仓库列表 | 未显示；P1-01 后端完成后接入 |

## 验证

| 检查 | 结果 |
| --- | --- |
| `pnpm build` | 通过；协议生成产物无变化；渲染层 JS 约 380 KB、CSS 约 24 KB，HTML 无内联样式 |
| `pnpm typecheck`、`pnpm protocol:check` | 通过 |
| `pnpm test:smoke` | 通过：核心就绪、隔离与沙箱、核心异常提示、窗口关闭、SIGTERM / SIGINT 回收 |
| `pnpm test:repository`（含界面冒烟） | 通过：7 项 headless 对照；界面冒烟覆盖真实提交行、HTML 文本按纯文本显示、选中与详情、merge 双身份与父提交、复制 OID 写入剪贴板、切到空仓库、无效目录报错、安全偏好、进程退出 |
| `pnpm test:protocol`、`pnpm test:sessions` | 通过：27 项、10 项（P1-01 的测试，用于确认合并后没有回归） |
| 视觉检查 | 用 Chrome 加载构建后的渲染层，注入只用于截图的接口桩，数据由独立 git 命令从 fixture 仓库读出；检查了浅色 / 深色、merge 详情、引用弹层、切换仓库弹层、交给 Agent、更新明细、近期活动、文件改动占位、打开仓库页的空闲与报错状态。另有真实 Electron 截图 `output/playwright/p0-03-repository-preview.png` |

## 未验证与限制

- 分支图只覆盖已加载的提交，没有跨页连续性，也没有与独立 Git 的拓扑做逐条对照；颜色按 lane 序号循环，不保证同一分支跨页同色。
- 列表没有虚拟化（P1-03），当前最多 200 行。
- 窄窗口布局属于 M4；在最小窗口宽 850 时，左栏约 320、详情约 530。
- 中文输入法的路径输入沿用组词状态判断，未做人工输入法测试；Windows 未验证；新界面的首屏时间与内存未测量。
