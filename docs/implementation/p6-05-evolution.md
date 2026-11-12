# P6-05 按需演化分析代码级计划

日期：2026-11-12。

- core 定义 estimateEvolution / analyzeEvolution，固定 commit、原始 pathHex、可选 range。先列树与读取受限 blob 估计实际文件 / 行数，不估算未知部分。
- 每次最多 200 个常规文本文件，每文件沿用 blame 1 MiB / 20000 行限制；遍历最多 10000 条树记录。跳过二进制、排除文件、gitlink / symlink、文件上限，逐项返回 reason。
- analyzeEvolution 复用 read_blame 与 blame-cache-v1；每完成一个文件推送累积结果和进度，取消保留已经发送的结果，完成文件缓存可复用。统计只由显式请求触发，独立辅助额度，交互请求可抢占。
- 年龄以请求开始的系统时间作参考（额外返回 asOfUnix），按最后修改的 author_time 分互斥年龄段；当前归属按原始 author name/email。存活按 Author 时间、UTC 周分组；新增行来自 P6-02 索引，保留单独 coverage，merge 不算新增。
- 为避免选择范围含多支导致分母污染，存活新增只取目标 commit 可达祖先，在索引 parents 图中验证；覆盖缺失时明确部分。文件改名的分母通过 blame 原路径与已索引 rename 关系追溯，不能仅按当前路径匹配。
- 接口推送带 filesDone/filesTotal/currentPath 与累积 result；错误不自动改动仓库。测试对照独立 blame --porcelain，覆盖缓存复用、取消保留、二进制 / 大文件跳过与只读快照。
- 在本仓库一个真实目录上记录耗时与 daemon 整个进程树 RSS，说明 200 文件为本版保守上限，不能外推到任意仓库。
