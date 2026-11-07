# P2-03：按需只读 diff

日期：2026-11-08。状态：实现完成，接在尚未提交的 P2-02 上。按用户要求优先功能，只做编译和少量定向检查，不扩展验证矩阵或防御框架。

## 行为

文件行点击后展开 unified diff；只保留一个展开文件。切换文件、文件页、父提交或所选提交时取消旧请求并清理旧 patch。默认不自动读取第一个文件。支持空树根提交、新增、删除、重命名和 mode 变化；二进制、gitlink、LFS 指针明确说明，不下载内容。已有旧快照详情保留已读 patch，但不在新会话里发旧上下文请求。

## 接口与实现

新增 session 方法 `readDiff`，复用 `commitDetails` capability 和现有详情取消通道。

```ts
type ReadDiffParams = {
  oid: string;
  parentIndex: number | null;
  oldPathHex: string | null;
  newPathHex: string | null;
};
type FileDiff = {
  oid: string;
  parentIndex: number | null;
  parentOid: string | null;
  file: ChangedFile;
  kind: "text" | "binary" | "gitlink" | "lfs" | "tooLarge";
  patch: string;
  truncated: boolean;
  textLossy: boolean;
  oldSize: number | null;
  newSize: number | null;
};
// section: "fileDiff", diff: FileDiff；一个终态，coverage.complete 指请求完成。
```

- Rust 从选定提交 / 原始父的真实文件差异中按 old/new rawHex 找到文件，复用 P2-02 读取函数；不信任 renderer 传来的 blob OID，不按 display 路径查文件。
- 已存在两侧 blob 时直接 `git diff --no-ext-diff --no-textconv --no-color --text --unified=3 <oldBlob> <newBlob> --`，避免 copy / rename 的源文件变化混入所选文件；文件真实名称与 mode 由 `file` 展示。仅一侧存在时用固定 tree 对 / root 的 `diff-tree --no-renames -p` 和字面 raw 路径，只产生该文件 patch。禁用外部 diff / textconv、自动 fetch，沿用 ReadOnlyGit。
- `cat-file` 只查询所选 blob 的类型 / 大小；任一侧超过 2 MiB 返回 tooLarge。小于等于 1 KiB 的 blob 可读取并识别标准 LFS 指针。gitlink / binary 不执行文本 patch。
- 复用现有 Git 行流读取 patch，最多 2000 行 / 128 KiB（解码后的 UTF-8 字节）、原始单行 32 KiB，达到限制保留已读取部分并标记 truncated；流退出由既有 guard 回收。不要为此新增通用进程 / 缓存框架。沿用 15 秒查询截止。
- 原始路径在 Unix 由 bytes 转 OsString，Git 全局 `--literal-pathspecs` 加 `--` 防止路径被解释成参数或通配；不支持无损转换的平台明确报错，不替换路径。二进制分类沿用 P2-02 元数据；UTF-8 解码有损显式标记。
- main/preload 添加窄接口，复用现有 schema、session、取消及响应键校验；不复制整套嵌套字段校验。renderer 为详情 store 加一份 patch 状态，点击才查询，保留取消 / 旧响应判定。
- 直接用已有主题色渲染 hunk、增加、删除与上下文行，给行号和缺少末尾换行提示；不加入语法高亮依赖。移除 P2-03 占位。

## 分工与检查

核心代理负责 core / daemon / 生成协议，先生成类型；桌面代理负责 main / preload / renderer / 手写协议。两者共享工作区，不回退 P2-02 或彼此修改，不提交或推送。

检查限于 Rust 新模块的定向测试、TypeScript 编译及少量 patch 选择判旧测试，再做一次构建供用户直接试用。遇到明确失败才修正并重跑相关项；不跑完整 Rust / 双 Node 协议 / Electron smoke / 性能矩阵。主代理更新实际结果与路线图，不把未测项目写成通过。

## 实际结果

- `cargo test -p commitscope-daemon details::tests:: -- --nocapture`：7 项通过，其中新增的三项覆盖所选 blob 内容比较、root 新增 / 父提交删除的字面 raw 路径以及标准 LFS 指针识别。
- `cargo check -p commitscope-daemon` 与 `pnpm protocol:check` 通过。
- `pnpm typecheck` 通过；仅运行 `tests/renderer/commit-detail-store.test.mjs`，9 项通过，其中新增三项覆盖按需请求、切文件判旧、切父清理与旧上下文保留。
- `pnpm build:release` 通过，已生成 Rust release 二进制与 Electron 资源，可用 `pnpm start` 试用；Vite 提示主 bundle 为 504.63 kB，拆分留待性能阶段。
- 未运行完整测试矩阵、Electron 实窗检查或大 patch 性能测量；本轮结果不构成完整 M2 用户验收。
