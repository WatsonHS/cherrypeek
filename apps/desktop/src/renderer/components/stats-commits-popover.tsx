import * as React from "react";
import { LoaderCircle } from "lucide-react";
import type { OperationCommit } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { StatsCommitPage } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { RepositorySessionResult } from "../../../../../packages/protocol/src/repository-session.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import { errorText, formatCount, PartialTag } from "./stats-widgets.js";

/** A count that opens the commits behind it (getStatsCommits), paged; each commit selects it on the commits page. */
export function CommitsPopover({ children, label, title, load, onSelect }: {
  children: React.ReactNode;
  label: string;
  title: string;
  load(offset: number): Promise<RepositorySessionResult<StatsCommitPage>>;
  onSelect(oid: string): void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [commits, setCommits] = React.useState<OperationCommit[]>([]);
  const [page, setPage] = React.useState<StatsCommitPage | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);
  const token = React.useRef(0);
  const read = React.useCallback(async (offset: number) => {
    const mine = ++token.current;
    setLoading(true);
    setError(null);
    let result: RepositorySessionResult<StatsCommitPage>;
    try { result = await load(offset); } catch (failure) {
      result = { ok: false, error: { code: "PROTOCOL_ERROR", message: failure instanceof Error ? failure.message : String(failure), retryable: false } };
    }
    if (mine !== token.current) return;
    setLoading(false);
    if (!result.ok) { setError(result.error); return; }
    setPage(result.value);
    setCommits(current => offset === 0 ? result.value.commits : [...current, ...result.value.commits]);
  }, [load]);
  const change = (next: boolean) => {
    setOpen(next);
    token.current += 1;
    if (next) { setCommits([]); setPage(null); void read(0); } else setLoading(false);
  };
  return <Popover open={open} onOpenChange={change}>
    <PopoverTrigger asChild><button type="button" aria-label={label} data-testid="stats-commits-trigger"
      className="rounded px-1 text-right tabular-nums text-fg2 underline decoration-line2 underline-offset-2 hover:bg-hover hover:text-fg aria-expanded:bg-accent-soft">{children}</button></PopoverTrigger>
    <PopoverContent align="end" aria-label={title} className="flex max-h-[360px] w-[420px] flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-fg3">{title}{page ? ` · 共 ${formatCount(page.total)} 个` : ""}</span>
        {page ? <PartialTag coverage={page.coverage} /> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {commits.map(commit => <button key={commit.oid} type="button" title={commit.summary} onClick={() => { onSelect(commit.oid); setOpen(false); }}
          className="grid w-full grid-cols-[64px_minmax(0,1fr)] items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-hover">
          <span className="font-mono text-xs text-fg3">{commit.oid.slice(0, 8)}</span>
          <span className="truncate">{commit.summary || "（无标题）"}</span>
        </button>)}
        {page && commits.length === 0 && !loading ? <p className="m-0 px-1.5 py-2 text-xs text-fg3">没有提交。</p> : null}
        {loading ? <span role="status" className="flex items-center gap-1 px-1.5 py-2 text-xs text-fg3"><LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在读取…</span> : null}
        {error ? <div role="alert" className="flex flex-wrap items-center gap-2 px-1.5 py-2 text-xs text-bad"><span>{errorText(error)}</span>
          <Button variant="outline" size="sm" onClick={() => void read(page?.nextOffset ?? 0)}>重试</Button></div> : null}
      </div>
      {page?.nextOffset != null && !loading ? <Button variant="outline" size="sm" onClick={() => void read(page.nextOffset!)}>加载更多</Button> : null}
    </PopoverContent>
  </Popover>;
}
