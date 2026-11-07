# UI-03：隐藏系统标题栏

日期：2026-11-07。环境：macOS 27.0.1 / Apple Silicon、Electron 45.2.3。按用户要求去掉系统白色顶栏，沿用当前界面布局。

## 实现

- Electron 使用 `titleBarStyle: hidden` 与 Window Controls Overlay；macOS 保留原生红黄绿按钮，位置为 x=16、y=18。窗口内容铺满窗口，背景跟随应用深浅色。依据 [Electron 标题栏文档](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)。
- 仓库工具栏直接位于窗口顶部，空白处可拖动，按钮和输入控件使用 `no-drag`；通过 overlay 安全区避让窗口按钮。打开页保留同高拖动区，错误提示放在工具栏下。
- 搜索占位框可收缩，保留占位标签；默认 1180px 宽度下工具栏保持 52px 单行。850px 沿用换行布局，不扩展到 M4 窄窗口设计。
- 没有新增 preload / IPC 接口；不改变 Rust 查询、历史窗口或仓库数据。

## 验证

- `pnpm typecheck`、`pnpm build:release` 通过，renderer 为 `index-BsF-Qaqv.js`。
- `pnpm test:smoke` 通过：真实核心启动、隔离与沙箱、核心失败提示、关闭窗口与 SIGTERM / SIGINT 的进程回收。
- Playwright 驱动真实 Electron：打开页拖动区 52px；仓库工具栏 y=0、高 52px、左侧安全区 92px；原生窗口与内容 bounds 同为 1180×760，没有系统标题栏占高。
- 仓库切换、路径输入、刷新和错误关闭可点击；错误提示位于工具栏下方；850px 宽度下切换弹层仍可用。原生最小化与恢复通过 Electron API 验证。
- 深浅色原生窗口截图已检查，窗口底色分别为 `#121311`、`#F7F7F5`。自动化同时设置 Playwright 媒体外观与 Electron `nativeTheme`，没有改变 macOS 系统设置。首次探针未覆盖 Playwright 默认媒体外观而等待超时，随后修正探针；原生颜色返回大写 HEX，颜色断言已按大小写无关处理。
- 测量摘要：`output/playwright/window-chrome-check.json`；截图：`window-chrome-native-light.png`、`window-chrome-native-dark.png`、`window-chrome-open.png`、`window-chrome-narrow.png`，均在 `output/playwright/`。

## 范围

本项没有重跑 P1-03 性能基线。拖动区域验证了实际计算样式，原生按钮保留及位置通过截图和 API 确认；未做人工拖窗、原生按钮鼠标点击或全屏往返验收。Windows / Linux 的原生控制按钮 overlay 已配置，但尚未在对应平台验证。
