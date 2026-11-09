# P4-05：图宽与高亮交互测量

日期：2026-11-10。应用代码为 `f522865`，本轮仅修改测量脚本和文档。P4-05 按“宽图滚动满足预算或留下新一轮测量”的完成条件收尾：拖宽、展开、高亮已有功能证据，本轮补齐大仓测量记录。**不声明全部发布性能关卡通过**；宽图轮次的原生窗口焦点条件未全部满足，另有一次未复现的启动段停顿，保留给 P4-01。

## 环境与方法

- MacBookPro18,3 / Apple M1 Pro，10 核、32 GiB，macOS 27.0.1；Electron 45.2.3、Chromium 156.0.8078.80。运行重新打包的 arm64 `.app`，不是开发服务器。
- 使用既有 `output/fixtures/p2-01-wide-graph-20261108/wide-history`：100,000 提交、1,000 本地引用、8 条长分支、9 父 octopus，前 2,000 行最多 9 条活跃图线。独立 Git 遍历与 manifest 对照通过。千条引用不等于千条同时活跃图线。
- 每轮独立 userData，自动索引暂停于 0 条；在既有显示器 2（API 报告 59.9967 Hz）运行，不修改系统刷新率，不清理 OS page cache，不强制 GC。测量与本项目构建 / 测试串行，未关闭其他用户应用。
- 三种状态：默认六列、真实鼠标拖到十二个显示槽、展开实际全部九条图线。拖宽 / 展开后核对所选 OID 和后端图签名不变。十二个槽仍只绘制真实存在的图线。
- 每轮先静置 2 秒，然后滚动 30 秒：向下 23 秒、向上 7 秒，8,000 CSS px/s。拖宽 / 展开轮次同时每 150 ms 移动真实鼠标，触发悬停高亮。滚动停止、窗口保留 1,800 条摘要后，再测 24 次悬停切换。
- 高亮延迟从目标行收到 pointerover / pointermove 开始，到对应节点高亮 DOM 更新后的下一次 RAF；不等于物理屏幕呈现延迟。RAF 间隔也不直接等于合成器呈现时间。
- 每 100 ms 采样 DOM、加载窗口和完整 Electron 进程树，包括 main、renderer、GPU / utility、Rust 和捕获到的 Git。RSS 求和可能重复计入共享页，采样可能遗漏短命子进程峰值。

## 结果

下表列出各状态最近一次完成滚动与悬停采样的记录。R3 / R4 是原始文件轮次，不能把不同运行条件的差异归因为拖宽或高亮带来的增减。

| 状态与来源 | RAF p95 | 最大间隔 | 高亮 p95 / 最大 | 交互整树 RSS 峰值 | 60 Hz 前台条件 |
| --- | ---: | ---: | ---: | ---: | --- |
| 默认六列，R4 第 1 轮 | 16.8 ms | 17.7 ms | 17.6 / 17.6 ms | 725.3 MiB | 开始 / 结束原生焦点及连续 DOM 可见采样通过 |
| 拖宽十二槽，R3 第 2 轮 | 17.4 ms | 17.8 ms | 17.4 / 17.9 ms | 718.7 MiB | 结束时原生窗口无焦点，不判严格关卡通过 |
| 展开九条图线，R4 第 3 轮 | 17.4 ms | 33.2 ms | 17.1 / 17.8 ms | 723.5 MiB | 结束时原生窗口无焦点，不判严格关卡通过 |

三个记录都没有滚动期间的 renderer 长任务，DOM 提交行峰值 37，摘要峰值 1,800；加载窗口起点从 0 推进到 1,400，实际发生续载和旧页淘汰。图路径峰值默认 222、拖宽 / 展开 370。每轮 24 次悬停均确认目标节点已高亮，未改变选择。

每轮捕获 15 次前向加载状态到窗口更新的样本，上述三组 p95 为 59.8 / 57.0 / 56.8 ms。它从 `aria-busy` / `data-page-loading` 变化计时，到窗口数据变化后的下一次 RAF；**不是精确 RPC 到绘制的翻页验收**。反向 7 秒仍在已载窗口内，没有反向 RPC 样本。

上述三组暂停索引后的短时空闲整树 RSS 为 602.9 / 592.7 / 609.5 MiB。它们和交互峰值均是暂停索引口径，不用于判断完整索引后的 800 MiB / 1 GiB 预算。每轮捕获的 49 / 49 / 46 个进程身份均自然退出，无采样错误或强制回收。

## 异常与验收边界

- R3 第 1 轮默认六列在滚动开始约 100 ms 后出现一次 300.5 ms RAF 间隔，p95 为 17.1 ms，未记录到对应的 renderer 长任务。单独复测最大 17.8 ms，R4 默认轮最大 17.7 ms，未再次出现。原始异常保留，原因未确定，不宣称已经修复，也不以 p95 掩盖它。
- R3 三轮和 R4 展开轮在结束时 `BrowserWindow.isFocused()` 为 false，尽管 DOM 的 `document.hasFocus()` / 可见性采样始终为 true。脚本保留两种状态，严格 `sixtyHzModeConfirmed` 为 false；这些轮次只作为交互观察值。
- R4 拖宽轮在测量前就失去原生窗口焦点，脚本提前结束该轮、记录错误并返回退出码 1。该轮没有滚动样本，不进入结果表。R4 默认轮满足当前前台条件；尚不能据此替代全部宽图状态的正式验收。
- 本轮未改动应用绘图或高亮逻辑。未重跑全量测试、Windows、千条活跃图线、完整索引内存、30 分钟稳定性或精确翻页到绘制；这些不由本报告宣告通过。P4-01 继续承担发布关卡及上述异常的后续观察。

## 测量脚本修订

`scripts/benchmark-history-scroll.mjs` 新增 `--graph-interactions` 和 `COMMITSCOPE_PACKAGED_APP` 支持，复用既有进程树采样。长任务仅统计滚动时间段，`+N` 采样适配当前 SVG 旁的按钮结构；内存目标改用现行预算并保留完整索引适用条件。

macOS 打包重新签名会改变核心二进制的签名和 `__LINKEDIT` 大小，不能直接用包内文件与 cargo 产物的原始哈希判断版本。脚本对临时副本统一签名再去签名后比较内容，原包和构建产物保持不变。本轮两者归一化 SHA-256 同为 `96d76fb16526472e692a1a8cde430aa0b523208d8f8c47fec187fe36da9b6d99`；此前两次预检失败由测量脚本的原始哈希比较引起，不是旧核心或应用运行失败。

包内 `app.asar` SHA-256：`c459a2ba214598f8c8183a8220b1d3a0bda84e2b66479f27c0a0c7799c6788c0`。原始 JSON 另记可执行文件、签名前后核心、测量脚本哈希及实际运行时。

## 复现与证据

```sh
pnpm package:mac
COMMITSCOPE_PACKAGED_APP="$PWD/release/mac-arm64/CommitScope.app/Contents/MacOS/CommitScope" \
  pnpm benchmark:graph-interactions \
  --repository="$PWD/output/fixtures/p2-01-wide-graph-20261108/wide-history" \
  --graph-manifest="$PWD/output/fixtures/p2-01-wide-graph-20261108/manifest.json" \
  --runs=3 --output="$PWD/output/benchmarks/local-p4-05-graph-interactions.json"
```

输出必须使用新文件名。运行时保持测量窗口在前台；若原生焦点条件不满足，应保留结果并明确标注，不能仅凭 DOM 的焦点状态给出通过结论。

| 原始证据（本机忽略目录） | SHA-256 |
| --- | --- |
| `output/benchmarks/p4-05-graph-interactions-20261110-r3.json` | `5cb08b066342a4e02d25c4a12bf209f003e20f625ffe07f32d7f74c0eee6e5a2` |
| `output/benchmarks/p4-05-compact-recheck-20261110.json` | `eb7ed38a96cc7e6ad510edca2591c465ba40e2b54a2f08dea4f89db2413cfddb` |
| `output/benchmarks/p4-05-graph-interactions-20261110-r4.json` | `0b4616f6b7699347b8ac39306d2ed93ce7504b337c22b23feb9d2e6c94e645e1` |

打包日志：`output/benchmarks/p4-05-performance-package-20261110.log`。`.app` / `.dmg` 已更新；未公开发布。
