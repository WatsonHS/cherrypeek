# P4-11：diff 显示增强

日期：2026-11-09。状态：界面部分与“完整文件”的 daemon 实现均已完成，核心声明 `diffFullContext`。

## 已实现（renderer）

- “显示”菜单：上下合并 / 左右并排（⌥D）、只看改动 / 完整文件（⌥F）、自动换行（⌥Z），选择对提交详情、文件历史和工作区的 diff 都生效，保存在 localStorage，读写失败时用默认值。
- 左右并排由同一份 hunk 数据配对，行内改动按共同前缀 / 后缀标出；不换行时两侧各自横向滚动，换行时用同一网格保证行高一致。
- 文件历史在左右并排时收成标题行里的“历史 N ▾”悬浮列表，可固定回侧栏。
- 语法高亮：Shiki `codeToTokens` + JavaScript 正则引擎，在 Web Worker 里按扩展名加载打包内的语法；结果作为文本节点渲染。超过 256 KiB 或 5,000 行不高亮。颜色见 DESIGN 第 11 节的语法 token。

## “完整文件”接口（已实现）

新增 capability `diffFullContext`。`readDiff`、`readWorkspaceDiff`、`readFileChange` 都加可选参数 `fullFile: boolean`；renderer 只在核心声明了这个能力、且用户选了“完整文件”时才发送。

- `fullFile = true` 时返回把整个文件作为上下文的 diff（例如 `--unified=<足够大的行数>`），patch 仍是标准 unified 格式，renderer 不需要特殊处理。
- 上限：文件任一侧超过 5,000 行，或 patch 超过约 400 KiB（按 JSON 编码后的字节计）时，返回错误 `RESOURCE_LIMIT`，renderer 自动改用只看改动重读。`FileDiff.patch` 与 `WorkspaceDiff.patch` 的 schema 上限放宽到 1 MiB，但 daemon 拒绝超过 512 KiB 的响应，所以实际按 400 KiB 判断；普通 diff 仍按 2,000 行 / 128 KiB 截断（同样按编码后字节计）。
- 实现：`--unified=100000`，其余参数与普通 diff 相同；两侧行数只统计第一个 `@@` 之后的内容行，避免把以 `--` 开头的删除行误当作文件头。
- 二进制、LFS、子模块等非文本情况与普通 diff 相同。
- 已在 `CoreReady.capabilities` 里加入 `diffFullContext`。
