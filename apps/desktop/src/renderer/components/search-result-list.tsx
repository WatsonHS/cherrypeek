import * as React from "react";
import type { CommitSummary } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { SearchView } from "../lib/metadata-search-store.js";
import { identityTime, identityTimeTitle, shortOid } from "../lib/format.js";
import { createVirtualLayout } from "../lib/virtual-window.js";
import { Button } from "./ui/button.js";

const ROW_HEIGHT = 62;
const EMPTY_COMMITS: CommitSummary[] = [];

export function SearchResultList({ view, onSelect, onAnchor, onNext, onPrevious, onRetry }: {
  view: SearchView;
  onSelect(oid: string): void;
  onAnchor(anchor: { oid: string; offset: number } | null): void;
  onNext(): void;
  onPrevious(): void;
  onRetry(): void;
}): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const frame = React.useRef<number>(0);
  const window = view.window;
  const commits = window?.commits ?? EMPTY_COMMITS;
  const virtual = React.useMemo(() => createVirtualLayout(commits.map(commit => ({ key: commit.oid, height: ROW_HEIGHT }))), [commits]);
  const [range, setRange] = React.useState(() => virtual.range(0, 560, 10));
  const status = searchStatus(view);
  const restoredWindow = React.useRef("");

  const updateRange = React.useCallback((paginate = false) => {
    const element = containerRef.current;
    if (!element) return;
    setRange(virtual.range(element.scrollTop, element.clientHeight, 10));
    const index = virtual.range(element.scrollTop, 1, 0).start;
    const oid = commits[index]?.oid;
    const rowOffset = oid ? virtual.offset(oid) : undefined;
    if (window && oid && rowOffset !== undefined) onAnchor({ oid, offset: rowOffset - element.scrollTop });
    if (paginate && element.scrollTop < Math.max(element.clientHeight, 100) && window?.previousCursor && !view.pageLoading) onPrevious();
    else if (paginate && element.scrollHeight - element.scrollTop - element.clientHeight < Math.max(element.clientHeight, 100) && window?.nextCursor && !view.pageLoading) onNext();
  }, [virtual, commits, onAnchor, window?.nextCursor, window?.previousCursor, view.pageLoading, onNext, onPrevious]);

  React.useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => updateRange());
    observer?.observe(element);
    updateRange();
    return () => { observer?.disconnect(); if (frame.current) cancelAnimationFrame(frame.current); };
  }, [updateRange]);

  React.useLayoutEffect(() => {
    const key = `${window?.resultVersion ?? ""}:${window?.pageOffset ?? ""}`;
    if (restoredWindow.current === key) return;
    restoredWindow.current = key;
    const anchorOid = view.anchorOid;
    const element = containerRef.current;
    if (!window || !anchorOid || !element) return;
    const offset = virtual.offset(anchorOid);
    if (offset === undefined) return;
    element.scrollTop = Math.max(0, offset - view.anchorOffset);
    setRange(virtual.range(element.scrollTop, element.clientHeight, 10));
  }, [window?.resultVersion, window?.pageOffset]);

  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => { frame.current = 0; updateRange(true); });
  };

  const state = window?.index.state;
  const partialNote = !window?.coverage.complete
    ? state === "paused" ? "部分结果 · 索引已暂停" : state === "cancelled" ? "部分结果 · 索引已取消" : state === "failed" || state === "unavailable" ? "部分结果 · 索引当前不可用" : "部分结果 · 索引仍在构建"
    : null;
  return <nav aria-label="搜索结果" data-testid="search-results" className="flex min-h-0 min-w-[320px] flex-[0_1_400px] flex-col overflow-hidden border-r border-line">
    <div className="flex min-h-[46px] shrink-0 flex-col justify-center gap-0.5 px-3 text-xs text-fg3">
      <span data-testid="search-status" aria-live="polite">{status}</span>
      {partialNote ? <span>{partialNote}</span> : null}
      {window && !window.coverage.complete && window.matchedCount === 0 ? <span>尚未找到；部分覆盖不能说明整个范围没有匹配。</span> : null}
      {window?.anchorFound === false ? <span role="status">原视口提交不在当前已搜索窗口，已显示结果起点。</span> : null}
      {view.selectedOid && !commits.some(item => item.oid === view.selectedOid) ? <span role="status">所选提交不在当前已加载窗口；不推断整个范围的可达性。</span> : null}
    </div>
    {view.error ? <div role="alert" className="mx-2 mb-2 flex flex-col gap-1 rounded-lg border border-bad-line bg-bad-bg px-3 py-2 text-xs">
      <span className="font-semibold text-bad">{view.error.code}</span><span className="break-words text-fg2">{view.error.message}</span>
      <Button variant="outline" size="sm" className="self-start" onClick={onRetry}>重试搜索</Button>
    </div> : null}
    {window?.index.error ? <p className="mx-3 my-1 text-xs text-warn">索引状态：{window.index.error.message}；历史仍可浏览。</p> : null}
    <div ref={containerRef} role="listbox" aria-label="搜索提交" tabIndex={0} aria-busy={view.loading || view.pageLoading}
      className="min-h-0 flex-1 overflow-auto overscroll-contain outline-none" onScroll={onScroll}>
      {view.loading && !window ? <div role="status" className="p-4 text-sm text-fg3">正在搜索…</div> : null}
      {!view.loading && window?.coverage.complete && window.matchedCount === 0 ? <div className="p-4 text-sm text-fg3">最终没有匹配提交。</div> : null}
      {!view.loading && !window && !view.error ? <div role="status" className="p-4 text-sm text-fg3">输入消息或添加筛选条件开始搜索。</div> : null}
      {window && commits.length ? <>
        <div aria-hidden="true" style={{ height: range.top }} />
        {commits.slice(range.start, range.end).map((commit, localIndex) => resultRow(commit, view, window.pathMatches[commit.oid], window.pageOffset + range.start + localIndex, onSelect))}
        <div aria-hidden="true" style={{ height: range.bottom }} />
      </> : null}
      {view.pageLoading ? <div role="status" className="p-3 text-center text-xs text-fg3">正在读取相邻结果…</div> : null}
      {window?.nextCursor ? <Button variant="ghost" size="sm" className="m-2" disabled={view.pageLoading} onClick={onNext}>读取后续结果</Button> : null}
      {window?.previousCursor ? <Button variant="ghost" size="sm" className="m-2" disabled={view.pageLoading} onClick={onPrevious}>读取更早结果</Button> : null}
    </div>
  </nav>;
}

function resultRow(commit: CommitSummary, view: SearchView, pathParents: (number | null)[] | undefined, rank: number, onSelect: (oid: string) => void): React.JSX.Element {
  const timestamp = view.query.timeField === "author" ? commit.author.timestamp : commit.committer.timestamp;
  const identity = view.query.timeField === "author" ? commit.author : commit.committer;
  const selected = view.selectedOid === commit.oid;
  const pathParentLabel = pathParents?.some(parent => parent === null) ? "根提交空树" : pathParents?.length
    ? `路径命中父提交 ${pathParents.map(parent => (parent! + 1).toString()).join("、")}` : null;
  return <button key={commit.oid} type="button" role="option" aria-selected={selected} data-testid={`search-result-${commit.oid}`} data-oid={commit.oid}
    style={{ height: ROW_HEIGHT }} className={`flex w-full items-center gap-2 px-3 text-left hover:bg-hover ${selected ? "bg-selected" : ""}`}
    onClick={() => onSelect(commit.oid)}>
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="truncate text-[13px] font-medium text-fg">{commit.summary || "（空摘要）"}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-fg3"><span className="truncate">{identity.name || identity.email || "未知身份"}</span>
        {pathParentLabel ? <span className="shrink-0 text-accent-fg" title={pathParentLabel} data-testid={`search-path-match-${commit.oid}`}>{pathParentLabel}</span> : null}
        <span className="shrink-0" title={identityTimeTitle(identity)}>{identityTime(identity)}</span><span className="ml-auto shrink-0 font-mono">#{rank + 1}</span></span>
    </span>
    <code className="shrink-0 font-mono text-[10.5px] text-fg3">{shortOid(commit.oid)}</code>
  </button>;
}

function searchStatus(view: SearchView): string {
  if (view.loading && !view.window) return "正在搜索…";
  if (view.loading) return "正在更新搜索结果…";
  if (view.error && view.window) return `搜索失败 · 保留当前结果版本`;
  if (!view.window) return "等待搜索条件";
  const count = view.window.matchedCount;
  return view.window.coverage.complete ? `最终结果 · ${count} 条` : `部分结果 · 当前找到 ${count} 条`;
}
