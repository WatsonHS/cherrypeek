# P6-02 文件改动索引代码级计划

日期：2026-11-12。

- metadata_index schema 1 → 2：新增 commit_changes（OID、原始路径 BLOB、旧路径、状态、增删行、二进制）和 changes_complete。保留旧 commits / snapshot_commits，事务迁移；旧成员按批补文件记录，提交行与文件完成标记原子提交。
- 新提交仍按 64 条批次读取元数据；批量 diff-tree --stdin --raw --numstat -z -r -M --root，对 merge 显式给第一父提交。复用既有 raw / numstat 配对解析器，不复制解析逻辑。路径不转 Unicode 再存储。
- 元数据 coverage 保留原定义；文件查询另给 changes coverage，未补完不能声称全部。暂停 / 取消 / 强退以每批 SQLite 事务为续建边界。
- 遇到 .gitattributes 的仓库使用逐提交属性来源，普通仓库批量比较；禁止外部 diff / textconv。重命名检测超限明确降级，不把缺失结果当零。
- 保留既有配额与只读缓存安全检查；空提交和 merge 也有完成标记，不能用“无文件记录”推断未完成。
- 临时真实仓库对照根、merge、重命名、二进制、非 UTF-8 路径；构造 v1 数据库升级后补齐并核验 metadata 原值。运行旧有索引恢复测试。
- 同一十万提交 fixture，对比已保存的 v1 release 与 v2 release，空应用缓存各构建一次。记录 wall time、数据库 / 总缓存体积、整个 daemon 子进程树 RSS 采样峰值；单次实测不当稳定性验收。
