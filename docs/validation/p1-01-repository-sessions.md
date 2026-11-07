# P1-01：仓库会话验收记录

日期：2026-11-07。任务：P1-01。结论：后端与非视觉接口通过本机验收。实现基于 `1806364` 后的工作树；包含同目录并行开发的界面改动，本记录只验收 Rust、协议、存储与非视觉桌面接口。实现契约见[代码级计划](../implementation/p1-01-repository-sessions.md)。

## 范围

新增六个会话方法，捕获 `head` 范围的固定 HEAD，区分对象库与 worktree 的稳定身份，并通过本次打开独有的 repoId / generation 拒绝过期请求。最近仓库与上次查看分开持久化；只有显式 `recordRepositoryView` 保存捕获的 tip，打开、失败、关闭和核心退出不会自动标为已读。缓存损坏或不可写不妨碍基础浏览。

main / preload 已提供对应窄接口和可序列化错误结果，存储位置由 main 的 userData 决定。旧预览接口保留；最近仓库菜单、查看记录触发时机及新增标记尚待 UI 接入，本记录不以这些界面能力作为已完成项。

## 环境与命令

本机 macOS 27.0.1 / Apple Silicon，Node 26.0.0、pnpm 10.28.1、Rust 1.95.0；另用 Electron 45.2.3 的 Node 24.22.2 复验协议测试。真实 Git fixture 由现有生成器使用种子 20261107 在临时目录创建，应用数据也使用独立临时目录，不改动固定的 10 万提交性能 fixture。

| 命令 | 结果 |
| --- | --- |
| `cargo test --workspace --locked` | 30/30：core 2、daemon 16、startup 12 |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过 |
| `cargo fmt --all -- --check` | 通过 |
| `pnpm protocol:check` | 三份 schema 与生成 TypeScript 一致 |
| `pnpm typecheck` | 通过 |
| `pnpm test:protocol` | 27/27，Node 26 |
| `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/test-protocol.mjs` | 27/27，Electron Node 24；不启动窗口 |
| `node scripts/test-repository.mjs` | 旧预览 headless 回归 7/7；未传 `--ui-smoke` |
| `pnpm test:sessions` | 真实 daemon 集成 10/10，无失败或跳过 |
| `git diff --check` | 通过 |

## 已验证的关键边界

- 协议分块、取消、超时、核心退出和真实慢 Git 子进程回收继续通过；legacy null 请求与 session 请求分别门控。
- 桌面取消 open 后保留其终态。已提交的迟到成功用于同步内部会话，后续打开失败仍能读取、关闭正确会话；旧 close 不清除新会话。
- open / close 结果超时无法确认时终止核心连接；核心退出或 controller 销毁后，迟到 continuation 不恢复会话。
- 存储单测验证：打开只写 recent、显式保存 tips、空集合与首次查看区分、recent 去重 / 顺序 / 上限 20、查看记录上限 100、损坏文件不被覆盖、超大文件 / symlink 拒绝，以及仓库内部的数据目录在创建前被拒绝。
- 真实会话验证：外部 HEAD 前进后仍读取旧 HEAD，显式保存旧 tip，重启后恢复 previousView 并拒绝旧句柄；曾查看空仓库的 `[]` 在首次提交后仍有效。主 worktree 与 linked worktree 共用对象库身份、各自保存 tips；子目录 / symlink 规范化一致，bare 与 SHA-256 正确。本机 SHA-256 分支实际执行。
- 慢 Git 用例验证：新 open 取代旧候选，取消候选不写 recent，关闭会话取消关联查询，旧 close / record 返回过期上下文；Git PID 均确认退出。所有 daemon 正常退出，测试 helper 将非零退出、信号退出或需要强杀判为失败。
- 缓存的坏 JSON、未知版本、超过 1 MiB、状态文件 symlink、仓库内路径与相对路径均有明确降级状态。非 root 权限用例实际执行：不可写缓存不妨碍预览，record 返回未保存；不可访问仓库返回 `PERMISSION_DENIED`。真实 fixture 的只读快照前后相同（测试主动模拟外部提交的变化单独建立基准），状态仅写入独立临时目录。
- 旧读取路径继续覆盖独立 Git 字段对照、双身份、特殊字节、bare、linked worktree、浅克隆、SHA-256、缺失对象、继承环境隔离与只读快照。

## 审查修复

旧查看记录只校验 OID 格式与数量，不要求等于当前 HEAD；否则外部新增提交会错误地使旧记录失效。会话提交集中在 server 主循环，取消检查发生在 recent 写入之前，提交后不再因迟到取消回报失败。同步响应发送失败时关闭连接，不静默丢失终态。

状态文件使用有界读取、独占临时文件、sync 与 rename；只清理本次实际创建的临时文件，创建目录后复核仓库边界，拒绝 app-data 路径中的父目录跳转。首轮 Rust 测试发现 macOS `/var` 与 `/private/var` 别名导致单测直接传入非规范路径，已修正测试 fixture，未放松生产路径检查；旧握手断言也已补上新增 capability。

## 限制

仅验收本机 macOS。Windows、多个应用实例同时更新同一状态文件、真实桌面窗口对新 API 的调用流程尚未验收。本项未运行 UI 构建或视觉测试，保留 Claude 的并行界面改动。

本次只冻结 HEAD；refs 是独立命令观察到的有界列表，不宣称原子多引用快照。分页、游标、手动刷新、多范围历史、搜索、图、diff 和新增标记由后续任务实现。未做新性能测量，不把功能测试耗时或历史 M0 基线作为 P1-01 的发布性能结论。
