import * as React from "react";
import { FolderOpen, LoaderCircle, TriangleAlert } from "lucide-react";
import type { RepositoryPreviewState } from "../../../../../packages/protocol/src/repository-preview.js";
import type { RepositoryActions } from "../app.js";
import { errorTitle } from "../lib/errors.js";
import { Button } from "./ui/button.js";
import { PathField } from "./path-field.js";

export function OpenScreen({ preview, actions }: { preview: RepositoryPreviewState; actions: RepositoryActions }): React.JSX.Element {
  const loading = preview.state === "loading";
  return <main className="min-h-0 flex-1 overflow-auto px-6 pt-16 pb-14">
    <div className="mx-auto flex max-w-[760px] flex-col gap-7">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <AppMark />
            <h1 className="m-0 text-[26px] font-semibold tracking-[-0.01em]">CommitScope</h1>
          </div>
          <p className="m-0 text-sm text-fg2">只读查看本地 Git 历史。浏览分支和 worktree 都不会 checkout。</p>
        </div>
        <Button size="lg" onClick={() => { void actions.choose(); }} disabled={loading}>
          <FolderOpen className="size-4" strokeWidth={1.75} />选择仓库目录…
        </Button>
      </div>

      <section aria-label="打开仓库" className="flex flex-col gap-2.5 rounded-[14px] border border-line bg-panel p-4">
        <span className="text-[13px] font-semibold">或者输入仓库路径</span>
        <PathField actions={actions} disabled={loading} />
        <span className="text-xs text-fg3">可以是仓库根目录或其中任意子目录；也支持 bare 仓库和 linked worktree。</span>
      </section>

      {loading ? <div className="flex items-center gap-3 rounded-xl bg-sunken px-4 py-3 text-[13px] text-fg2">
        <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" strokeWidth={1.75} aria-hidden="true" />
        <span className="flex-1">正在读取仓库和首批提交…</span>
        <Button variant="outline" size="sm" onClick={() => { void actions.cancel(); }}>取消</Button>
      </div> : null}

      {preview.error ? <div role="alert" className="flex items-start gap-3 rounded-xl bg-bad-bg px-4 py-3.5">
        <TriangleAlert className="mt-0.5 size-4 text-bad" strokeWidth={1.75} aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-semibold text-bad">{errorTitle(preview.error.code)}</span>
          <span className="text-[13px] break-words text-fg2">{preview.error.message}</span>
          <code className="font-mono text-xs text-fg3">{preview.error.code}</code>
        </div>
      </div> : null}

      {preview.state === "cancelled" && !preview.error ? <p className="m-0 text-[13px] text-fg3">读取已取消。</p> : null}
    </div>
  </main>;
}

function AppMark(): React.JSX.Element {
  return <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" className="shrink-0">
    <rect width="28" height="28" rx="8" fill="#1B1B19" />
    <path d="M10 7v14" stroke="#8BA8FF" strokeWidth="2" strokeLinecap="round" fill="none" />
    <path d="M10 17c0-4 8-3 8-7.5" stroke="#F0A15E" strokeWidth="2" strokeLinecap="round" fill="none" />
    <circle cx="10" cy="9" r="2.4" fill="#8BA8FF" />
    <circle cx="10" cy="20" r="2.4" fill="#8BA8FF" />
    <circle cx="18" cy="9.5" r="2.4" fill="#F0A15E" />
  </svg>;
}
