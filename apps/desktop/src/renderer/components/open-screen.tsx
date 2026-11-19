import * as React from "react";
import { FolderOpen, LoaderCircle, TriangleAlert } from "lucide-react";
import type { RepositoryView } from "../lib/repository-session-store.js";
import type { RepositoryActions } from "../app.js";
import { errorTitle } from "../lib/errors.js";
import { Button } from "./ui/button.js";
import { PathField } from "./path-field.js";
import { RecentRepositories, type RecentState } from "./recent-repositories.js";

export function OpenScreen({ preview, actions, recent }: { preview: RepositoryView; actions: RepositoryActions; recent: RecentState }): React.JSX.Element {
  const loading = preview.state === "loading" || preview.opening !== null;
  return <main className="min-h-0 flex-1 overflow-auto px-6 pt-16 pb-14">
    <div className="mx-auto flex max-w-[760px] flex-col gap-7">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <AppMark />
            <h1 className="m-0 text-[26px] font-semibold tracking-[-0.01em]">CherryPeek</h1>
          </div>
          <p className="m-0 text-sm text-fg2">浏览本地 Git 历史、分支关系与统计分析。切换分支和 worktree 不会 checkout，基础收口操作仅在你点击时执行。</p>
        </div>
        <div className="flex gap-2">
          <Button size="lg" onClick={() => { void actions.choose(); }} disabled={loading}>
            <FolderOpen className="size-4" strokeWidth={1.75} />选择仓库目录…
          </Button>
        </div>
      </div>

      {loading ? <div className="flex items-center gap-3 rounded-xl bg-sunken px-4 py-3 text-[13px] text-fg2">
        <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" strokeWidth={1.75} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{preview.opening !== null ? `正在打开 ${preview.opening}…` : "正在读取首批提交…"}</span>
        <Button variant="outline" size="sm" onClick={() => { void actions.cancel(); }}>取消</Button>
      </div> : null}

      {preview.error ? <div role="alert" className="flex items-start gap-3 rounded-xl bg-bad-bg px-4 py-3.5">
        <TriangleAlert className="mt-0.5 size-4 text-bad" strokeWidth={1.75} aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-semibold text-bad">{errorTitle(preview.error.code)}</span>
          {preview.error.path ? <span className="font-mono text-[12.5px] break-all text-fg2">{preview.error.path}</span> : null}
          <span className="text-[13px] break-words text-fg2">{preview.error.message}</span>
          <code className="font-mono text-xs text-fg3">{preview.error.code}</code>
        </div>
      </div> : null}

      {preview.state === "cancelled" && !preview.error ? <p className="m-0 text-[13px] text-fg3">已取消，没有打开仓库。</p> : null}

      <RecentRepositories recent={recent} disabled={loading} onOpen={path => { void actions.open(path); }} />

      <section aria-label="打开仓库" className="flex flex-col gap-2.5 rounded-[14px] border border-line bg-panel p-4">
        <span className="text-[13px] font-semibold">或者输入仓库路径</span>
        <PathField actions={actions} disabled={loading} />
        <span className="text-xs text-fg3">可以是仓库根目录或其中任意子目录；也支持 bare 仓库和 linked worktree，也可直接将仓库文件夹拖入窗口打开。</span>
      </section>
    </div>
  </main>;
}

function AppMark(): React.JSX.Element {
  return <svg width="32" height="32" viewBox="100 100 824 824" aria-hidden="true" data-testid="app-mark" className="shrink-0">
    <rect x="108" y="108" width="808" height="808" rx="180" fill="#FBF4EC" stroke="#2B2A2E" strokeOpacity="0.12" strokeWidth="16" />
    <path d="M392 232 L392 556" fill="none" stroke="#2B2A2E" strokeWidth="32" strokeLinecap="round" />
    <path d="M392 324 C 470 356, 640 372, 664 472" fill="none" stroke="#2B2A2E" strokeWidth="32" strokeLinecap="round" />
    <path d="M392 232 C 430 166, 512 148, 574 170 C 540 226, 464 256, 392 232 Z" fill="#3E9B57" />
    <circle cx="392" cy="324" r="35" fill="#FBF4EC" stroke="#2B2A2E" strokeWidth="23" />
    <circle cx="392" cy="700" r="144" fill="#E1253B" />
    <circle cx="664" cy="596" r="124" fill="#E1253B" />
  </svg>;
}
