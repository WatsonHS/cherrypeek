# 文件夹展开延迟修复

2026-11-09 用户反馈文件页展开目录需要等待。修复范围限定在目录交互，不改 Git 历史语义或并发上限。

## 定位与改动

真实 Flutter 仓库中连续展开 `packages → flutter → lib`：目录查询本身约 25 ms，后两次显示子目录却分别用了 813 / 811 ms。记录中出现 `CANCELLED` 和 `BUSY`，renderer 按 400 ms 重试。原来的目录按钮同时调用 `toggleDirectory` 和 `select(directory)`，后者立刻启动 200 条目录历史查询，给单纯的展开操作增加了竞争。

- `files-page.tsx`：目录行只展开 / 收起；旁边的历史按钮显式选择目录并查看历史。展开时保留当前文件内容与选择。
- 已加载目录继续使用 `FilesStore` 中绑定当前版本的条目，收起后重开不发请求；不增加缓存、轮询或后台预加载。
- 补充文件页状态定向检查，实窗复测连续展开和历史入口；更新产品口径。

## 验证

同一 Flutter 仓库、同一提交、独立用户目录，连续展开相同三级目录的实窗单轮对照：

| 展开目录 | 修复前 | 修复后 |
| --- | --- | --- |
| `packages` | 65 ms | 101 ms |
| `packages/flutter` | 813 ms | 51 ms |
| `packages/flutter/lib` | 811 ms | 107 ms |

两轮目录查询本身均约 25–27 ms；修复后展开过程只有四次成功的目录读取（含根目录），没有目录历史、取消或繁忙重试。收起重开不再读取，独立历史按钮仍能发起目录历史查询。表中为从自动化点击开始到子目录可见的时间，包含点击与渲染开销；单轮局部对照不代表所有仓库性能。

`COMMITSCOPE_RENDERER_TEST_FILES=files-store.test.mjs pnpm test:renderer` 的 14 项检查及 `pnpm typecheck` 通过，release 构建与 `pnpm package:mac` 通过，已更新本机 `.app` / `.dmg`。给既有全页面 smoke 增加了展开保留所选文件的断言，但本轮未重跑整个页面测试集。

原始记录在忽略目录 `output/benchmarks/file-tree-before.json` 和 `file-tree-after.json`；定向实窗脚本还检查了重开复用与独立历史入口。当前已运行的开发窗口需重启后加载新资源；此前安装的应用需以新包替换。
