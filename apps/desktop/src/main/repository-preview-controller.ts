import { isAbsolute } from "node:path";
import type { ErrorCode, ResponseData } from "../../../../packages/protocol/src/generated/server-message.js";
import { emptyRepositoryPreview, type RepositoryPreviewState } from "../../../../packages/protocol/src/repository-preview.js";
import type { CoreStatus } from "../../../../packages/protocol/src/core-status.js";
import { CoreProcess } from "./core-process.js";
import { ProtocolClientError } from "./protocol-transport.js";

const MAX_PATH_BYTES = 16 * 1024;
const MAX_REFS = 2000;
const MAX_COMMITS = 200;

export class RepositoryPreviewController {
  private state = emptyRepositoryPreview();
  private readonly listeners = new Set<(state: RepositoryPreviewState) => void>();
  private active?: AbortController;
  private operation = 0;
  private readonly unsubscribeCore: () => void;

  constructor(private readonly core: CoreProcess) {
    this.unsubscribeCore = core.subscribe(status => this.onCoreStatus(status));
  }

  getState(): RepositoryPreviewState { return this.state; }

  subscribe(listener: (state: RepositoryPreviewState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async open(path: unknown): Promise<void> {
    const operation = this.invalidate("cancelled");
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) {
      this.update({ ...emptyRepositoryPreview(), state: "error", error: { code: "INVALID_REQUEST", message: "请输入有效的绝对目录路径" } });
      return;
    }
    const coreStatus = this.core.getStatus();
    if (coreStatus.state !== "ready" || !coreStatus.core.capabilities.includes("readRepositoryPreview")) {
      this.update({ ...emptyRepositoryPreview(), state: "error", error: { code: "CORE_EXITED", message: "核心尚未就绪或不支持仓库预览" } });
      return;
    }
    const controller = new AbortController();
    this.active = controller;
    this.update({ ...emptyRepositoryPreview(), state: "loading" });
    let sawRepository = false;
    let sawCommits = false;
    let sawFinalCommitChunk = false;
    try {
      const completion = await this.core.request("readRepositoryPreview", { path }, { repoId: null, generation: null }, {
        timeoutMs: 20000,
        signal: controller.signal,
        onChunk: chunk => {
          if (operation !== this.operation || controller.signal.aborted) return;
          const data: ResponseData = chunk.data;
          if (data.section === "repository") {
            if (sawRepository || sawCommits || chunk.done) throw new Error("仓库预览区块顺序无效");
            sawRepository = true;
            this.update({ ...this.state, repository: data.repository, refs: data.refs.slice(0, MAX_REFS), refsTruncated: data.refsTruncated || data.refs.length > MAX_REFS });
          } else if (data.section === "commits") {
            if (!sawRepository) throw new Error("提交区块早于仓库信息");
            if (sawFinalCommitChunk) throw new Error("done 帧后仍收到提交区块");
            sawCommits = true;
            const remaining = MAX_COMMITS - this.state.commits.length;
            this.update({ ...this.state, commits: [...this.state.commits, ...data.commits.slice(0, remaining)], hasMore: data.hasMore || this.state.commits.length + data.commits.length > MAX_COMMITS });
            if (chunk.done) sawFinalCommitChunk = true;
          } else throw new Error(`仓库预览收到意外区块：${data.section}`);
        },
      });
      if (operation !== this.operation || controller.signal.aborted) return;
      if (!sawRepository || !sawCommits || !sawFinalCommitChunk || !completion.coverage.complete || completion.coverage.processed !== this.state.commits.length) {
        throw new Error("核心返回了不完整或不一致的仓库预览");
      }
      this.update({ ...this.state, state: "ready", error: null });
    } catch (error) {
      if (operation !== this.operation) return;
      if (controller.signal.aborted) {
        this.update({ ...this.state, state: "cancelled", error: null });
      } else {
        const code = error instanceof ProtocolClientError ? error.code : "PROTOCOL_ERROR";
        this.update({ ...this.state, state: "error", error: { code, message: error instanceof Error ? error.message : String(error) } });
      }
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }

  cancel(): void {
    if (!this.active && this.state.state !== "loading") return;
    this.invalidate("cancelled");
    this.update({ ...this.state, state: "cancelled", error: null });
  }

  dispose(): void {
    this.cancel();
    this.unsubscribeCore();
    this.listeners.clear();
  }

  private invalidate(nextState: "cancelled"): number {
    this.operation += 1;
    this.active?.abort(new Error("仓库预览已取消"));
    this.active = undefined;
    if (this.state.state === "loading") this.update({ ...this.state, state: nextState, error: null });
    return this.operation;
  }

  private onCoreStatus(status: CoreStatus): void {
    if (status.state === "ready" || this.state.state !== "loading") return;
    this.active?.abort(new Error("核心已退出"));
    this.active = undefined;
    this.operation += 1;
    const errorCode: ErrorCode = "CORE_EXITED";
    this.update({ ...this.state, state: "error", error: { code: errorCode, message: "核心已退出，仓库预览已停止" } });
  }

  private update(next: Omit<RepositoryPreviewState, "revision"> | RepositoryPreviewState): void {
    this.state = { ...next, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.state);
  }
}
