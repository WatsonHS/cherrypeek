# 项目工作约定

- 开始实现前阅读 `README.md`、`docs/PRODUCT.md`、`docs/ARCHITECTURE.md` 和 `docs/PLAN.md`；按阶段更新状态和验证证据。
- Electron + React/TypeScript 前端、Rust 核心已确定。独立实现，不 fork 或复制 GitComet，不接入其 crates / AppStore。
- MVP 是只读历史浏览器。浏览分支不得触发 checkout；不加入 stage、commit、merge、rebase、push 等写操作或自动 fetch。
- 仓库事实由 Rust 查询服务提供；renderer 只持有有界页面和视图状态。查询必须可取消，过期结果不得覆盖当前视图。
- Author 与 Committer 分开保存；OID 不固定为 40 字符；分支是引用与可达性关系。
- 仓库内容按不可信文本处理；Electron 开启隔离和沙箱，preload 仅暴露明确的业务接口。
- 应用缓存写入应用数据目录，不写被查看仓库。Git 命令使用参数数组，禁用外部 diff / textconv 等隐式执行路径。
- 新能力的测试围绕用户可见行为和数据正确性。性能报告必须区分目标与实测，统计整个进程树。
- 文档使用中文，代码和接口标识使用英文。保留无关改动；不为文档阶段生成空应用、假数据演示或已完成的占位任务。
