# P0-02：协议与生命周期代码级计划

日期：2026-11-07。状态：已完成本机 macOS 验收，见 [验证记录](../validation/p0-02-protocol.md)。延续主代理规划与验收、轻量模型编码的分工。

## 本项交付

将 P0-01 的单向启动行升级为有版本协商、请求关联、分块结果、取消、超时和错误恢复的 stdio 协议。现有窗口通过握手显示真实核心状态。用真实 `getRuntimeInfo` 查询验证通道，返回核心运行信息和本机 Git 版本探测；不引入仓库浏览、假提交或通用 shell 接口。

P0-03 才实现仓库会话与首屏 Git 查询；真实引用变化通知由 M3 产生。本项实现其所需的上下文判旧规则并用受控协议测试验证，不宣称仓库刷新已经可用。

## 文件归属

| 执行者 | 文件 / 职责 |
| --- | --- |
| Rust 代理 | `crates/core/**`、`crates/daemon/**`、必要 Cargo 文件、`packages/protocol/schema/**`：消息类型、schema 导出、服务端调度、受控 Git 版本进程、Rust 测试 |
| 桌面代理 | `apps/desktop/src/main/core-process.ts` 及必要 transport 模块、共享 TS 生成产物与状态接口、`scripts/protocol-lib.mjs`、相关 package 配置、`tests/protocol/**`、必要 smoke 调整：客户端协议、异常矩阵、集成测试 |
| 主代理 | 本计划、README / ARCHITECTURE / PLAN 等状态文档、独立审查与 `docs/validation/p0-02-protocol.md` |

两名编码代理共享目录，不回滚其他人的改动；不提交 Git commit。保留 P0-01 的安全设置和窗口测试，尽量不改 renderer / preload；不能暴露通用请求或任意方法到 renderer。

## 消息契约

Rust 为消息类型唯一来源，继续生成 draft-07 JSON Schema 与 TypeScript。保留 `CoreReady`，增加 `git` 与 `capabilities`；新增 `ClientMessage`、`ServerMessage` schema。`export-protocol` 默认保留单个 CoreReady schema 输出，增加 `--all` 输出以文件基名为键的三个 schema：`core-ready`、`client-message`、`server-message`。JS 生成器使用 `--locked`，一次导出再生成三份类型；check 只比较，不修改文件。

`GitInfo` 固定为 `{ available: boolean, version: string | null, error: string | null }`；没有 Git 不阻止核心完成握手，但明确报告不可用。`CoreReady` 字段为 `protocolVersion`、`coreVersion`、`pid`、`git`、`capabilities`，本项 capabilities 仅含 `getRuntimeInfo`。

所有声明为 nullable 的字段也必须出现，无值时显式传 null；Rust 解码、schema 与 TypeScript 校验一致拒绝缺失字段，避免将缺 requestId 的协议错误误当作无关响应忽略。

每行一个 JSON 对象，消息使用 `type` 判别。客户端：

```json
{"type":"hello","protocolVersion":1}
{"type":"request","requestId":"request-1","method":"getRuntimeInfo","repoId":null,"generation":null,"params":{}}
{"type":"cancel","requestId":"request-1"}
```

服务端握手：

```json
{"type":"hello","core":{"protocolVersion":1,"coreVersion":"0.1.0","pid":12345,"git":{"available":true,"version":"git version ...","error":null},"capabilities":["getRuntimeInfo"]}}
```

`getRuntimeInfo` 返回两个真实数据分块，第二块完成查询：

```json
{"type":"response","requestId":"request-1","repoId":null,"generation":null,"sequence":0,"done":false,"coverage":{"complete":false,"processed":1},"nextCursor":null,"data":{"section":"core","coreVersion":"0.1.0","pid":12345}}
{"type":"response","requestId":"request-1","repoId":null,"generation":null,"sequence":1,"done":true,"coverage":{"complete":true,"processed":2},"nextCursor":null,"data":{"section":"git","git":{"available":true,"version":"git version ...","error":null}}}
```

查询第二块重新执行受限 Git 版本探测，便于验证真实子进程取消；不是伪造延时或伪造业务数据。未找到 Git 时返回真实不可用状态；探测超时或取消时返回终止错误，不能伪装为完整成功。

错误格式：

```json
{"type":"error","requestId":"request-1","repoId":null,"generation":null,"code":"CANCELLED","message":"请求已取消","retryable":false}
```

协议级错误的 requestId / repoId / generation 均为 null。错误码至少包括 `PROTOCOL_MISMATCH`、`PROTOCOL_ERROR`、`INVALID_REQUEST`、`UNKNOWN_METHOD`、`BUSY`、`CANCELLED`、`TIMEOUT`、`CORE_EXITED`、`STALE_CONTEXT`；后两类可由客户端产生，但使用相同稳定错误结构。

`requestId` 非空且 UTF-8 长度最多 128 字节，`repoId` / `generation` 为最多 256 字节的非空不透明字符串或 null，generation 不用 JS 可能丢精度的数字。本项运行信息查询只接受 null 仓库上下文和空 params；未知方法、无效参数或无效仓库上下文要返回请求错误，不创建任务。合法请求的响应回传原上下文；无法安全回传的无效标识使用 null，不将超长输入放大为错误帧。

## 握手和 framing

- 客户端先发 hello，服务端验证版本后探测 Git 并回 hello；收到请求前没有握手不得执行，重复 hello 视为协议错误。客户端只有校验 schema、版本和真实 child PID 后才进入 ready。
- 版本不兼容返回 `PROTOCOL_MISMATCH` 并关闭连接，错误必须在现有 UI 中可见。启动整体上限 5 秒；服务端不能无限等客户端 hello。
- 两端逐字节分帧，单帧 JSON 最大 1 MiB（不含 LF 或 CRLF 换行符）。支持一个数据块内多行、跨数据块的一行与跨块 UTF-8 字符；严格 UTF-8，不能静默替换非法字节。
- 超长行应在读取过程中拒绝；不要先无限 read_line / read_until 再检查。EOF 有未完成尾帧、畸形 JSON、非法消息结构作为协议错误，拒绝全部待完成请求并回收进程。
- stdout 只输出协议，stderr 为有界诊断。响应序列从 0 连续递增；重复、跳号或上下文不匹配不能被当成合法结果。

## Rust 服务端调度

优先沿用标准库实现，不为本项引入大框架。stdin 读取与查询执行分开，不能因查询等待 Git 而无法接收 cancel。每个会话最多两个执行中的交互请求，超额立即 `BUSY`，不排无限队列。

建议组织为 `protocol.rs`（core 类型）、`framing.rs`（有界读取）、`runtime.rs`（Git 发现与探测）、`server.rs`（握手、任务、取消与输出）。不机械增加抽象层；允许合并小模块。输出单一 writer，有界队列（建议 16 帧）；任务发送时可检查取消，stdout 背压不能导致输入取消失效。EOF / fatal error 时取消所有任务并回收实际子进程，不能因 writer 阻塞无限等待。

每个任务持有取消标志和实际 Child 的所有权；取消时 kill 并 wait / try_wait 回收，先检查取消再发送下一块。重复取消和取消未知 / 已完成请求均无副作用，不再发重复终止结果。对正在执行的请求只发送一次终止错误；取消与完成竞争时，客户端一旦接受取消就不得再呈现成功。

Git 可执行文件在受信任层从非空绝对 PATH 目录发现并固定为绝对路径，macOS 可回退 `/usr/bin/git`；测试可用受控 PATH 夹具。忽略相对 PATH 项，避免从仓库当前目录拾取 `git`。仅允许参数数组 `--version`，stdin 为 null，不走 shell，不读取仓库配置，不触发网络。探测最多 2 秒，stdout / stderr 分别最多 4 KiB，不能用无界 output() 或读取。任务取消与服务退出都回收探测进程。

Node 在 macOS 为 daemon 建立独立进程组，Git 继承该组。daemon 异常退出或强制停止时，Node 清理本次已知进程组以覆盖仍在运行的 Git 子进程；禁止 `pkill` 等全局匹配。单次请求取消回收它实际拥有的 Git 进程。本项 Git --version 无外部 helper，测试慢进程使用 exec 保持同一 PID。Windows 的 Job Object / 整树验收继续留在跨平台阶段，不宣称本项已验证。

## TypeScript 客户端

保留 `CoreProcess.start/getStatus/subscribe/stop`，将单行启动解析改为持续 transport。新增内部 `request` 方法，参数包含方法名、params、原始上下文、分块回调、请求超时和 AbortSignal；不通过 preload 暴露此通用接口。接口具体签名可在桌面代理内部收敛，语义必须如下：

- 只有 ready 可请求；分配本实例唯一且不复用的 requestId；未完成请求 Map 最多两个，超额 `BUSY`。
- 默认请求超时 5 秒，测试可指定较短正数。stdin 写队列有帧数 / 总字节上限（建议 16 帧 / 2 MiB），遵守 write 返回值与 drain；遇到管道错误拒绝等待者，不无限积压 Promise。
- 按 requestId 路由，校验原始 repoId / generation、sequence 和 done。逐块回调，完成 Promise 只返回终止信息，不默认积累全量结果。回调异常必须有界终止该请求，不使其他请求永久挂起。
- Abort / timeout / 主动换上下文时立即从可接收集合移除请求，再发 cancel；迟到的合法分块按未知请求忽略，不重新插回 pending。清理 timer、abort listener 和回调引用。
- `stop`、daemon crash、非法帧、stdout 截断、写失败时拒绝全部 pending，并回收进程；无自动重启循环。主动再次打开可创建新的 CoreProcess 实例，不复用停止的实例。
- 超时、取消和核心异常保留稳定 code / message / retryable，现有 UI 仍仅展示核心状态。

## 浏览上下文判旧

在 main 侧实现小型明确的上下文门控，可与 transport 分离：当前浏览上下文与最新已观察上下文分别记录。观察到新 generation 只更新通知状态；只有显式切换当前浏览上下文才取消被替代请求。分块交付前检查请求仍属当前视图，仓库或 generation 不匹配时拒绝 `STALE_CONTEXT`。

本项没有真实仓库 handle；使用受控 transport 测试验证“旧快照仍在显示时可完成”和“主动切换后旧结果被丢弃”。不能为了测试而让真实 getRuntimeInfo 接受任意未打开 repoId。此规则随后由仓库会话复用。

## 测试与验收

Rust 使用真实 daemon 集成测试，测试端 timeout 与 Child guard 保持。Node 使用 `node:test` 和 esbuild 在忽略的临时输出中编译 transport；受控故障 peer 放在 `tests/protocol/fixtures/`，测试数据仅服务协议验证，不能作为产品演示。

| 场景 | 验证要求 |
| --- | --- |
| 握手 | 正确版本可用；不兼容、未握手请求、重复握手、启动超时均明确失败 |
| 真实请求 | 两块顺序与真实版本 / PID / Git 状态正确，终止一次；未知方法 / 无效参数 / 忙碌有稳定错误 |
| framing | 合包、拆包、UTF-8 拆分、CRLF、畸形 JSON、非法 UTF-8、超长、EOF 截断；内存与队列有界 |
| 取消与超时 | 取消真实慢 Git 探测并确认 PID 退出；重复取消无副作用；超时后新请求可继续；迟到成功不覆盖取消 |
| 关联与分块 | 乱序 sequence、错 repo / generation 不接收；未知已取消 requestId 的合法结果忽略；回调失败不挂其他请求 |
| 快照判旧 | 外部观察到新版本不取消旧浏览快照；显式切换仓库 / 快照后旧结果不可见 |
| 生命周期 | pending 中核心崩溃、stdin 写失败、慢子进程中关窗 / stop，所有 pending 结束、已知进程树无残留 |
| 回归 | P0-01 窗口、沙箱、CSP、真实 PID、失败提示与启动脚本信号回收仍通过 |

命令：`pnpm protocol:check`、`pnpm typecheck`、`pnpm build`、新增 `pnpm test:protocol`、`pnpm test:smoke`，以及既有 Rust fmt / test / clippy。主代理独立复跑并记录实际结果；不因为测试设计存在就勾选任务。原始日志与截图保存在 `output/playwright/`，报告保存到 `docs/validation/p0-02-protocol.md`。

参考：[Node 子进程文档](https://nodejs.org/api/child_process.html)、[Node Stream 背压](https://nodejs.org/api/stream.html)、[Rust Child 的显式回收责任](https://doc.rust-lang.org/std/process/struct.Child.html)。具体 API 以项目固定 Node 24 / Rust 1.95 编译与运行结果确认。
