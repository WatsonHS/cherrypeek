# 项目工作约定

- 开始实现前阅读 `docs/DEVELOPMENT.md`、`docs/PRODUCT.md`、`docs/ARCHITECTURE.md` 和 `docs/PLAN.md`；按阶段更新状态和验证证据。开发进度、文档索引和测试命令写在 `docs/DEVELOPMENT.md`；`README.md` 与 `README.en.md` 面向使用者，只在功能、安装或使用方式变化时更新（2026-11-10 起）。
- Electron + React/TypeScript 前端、Rust 核心已确定。独立实现，不 fork 或复制 GitComet，不接入其 crates / AppStore。
- 浏览保持只读：浏览分支不得触发 checkout，读取路径不写被查看仓库。2026-11-12 起（用户确认）App 可执行白名单内的基础 Git 操作：fetch、快进更新、切换分支、新建分支，清单与规则见 `docs/PRODUCT.md`「基础操作」。操作只由用户显式触发，不自动 fetch；只做一步完成、不产生冲突、不丢数据的操作，做不到时不执行、保持仓库原样，并提示交给 Agent。不加入 stage、commit、merge、rebase、reset、stash、cherry-pick、revert、force push 或冲突解决；扩充白名单需用户确认。
- 仓库事实由 Rust 查询服务提供；renderer 只持有有界页面和视图状态。查询必须可取消，过期结果不得覆盖当前视图。
- Author 与 Committer 分开保存；OID 不固定为 40 字符；分支是引用与可达性关系。
- 仓库内容按不可信文本处理；Electron 开启隔离和沙箱，preload 仅暴露明确的业务接口。
- 应用缓存写入应用数据目录，不写被查看仓库。Git 命令使用参数数组，禁用外部 diff / textconv 等隐式执行路径。
- 新能力的测试围绕用户可见行为和数据正确性。性能报告必须区分目标与实测，统计整个进程树。
- 文档使用中文，代码和接口标识使用英文。保留无关改动；不为文档阶段生成空应用、假数据演示或已完成的占位任务。
- 界面中后端尚未接入的区域可以显示示例内容，但必须明确标注“占位 · 任务编号”，与真实数据区分开，不得当作真实数据、验收证据或已完成功能（2026-11-07 用户确认）。
