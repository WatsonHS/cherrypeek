import * as React from "react";
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, LoaderCircle } from "lucide-react";
import type { RepositoryActions } from "../app.js";
import type { RepositoryInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import { shortRefName } from "../lib/format.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

function ElapsedTimer({ startedAt, label }: { startedAt: number; label: string }): React.JSX.Element {
  const [seconds, setSeconds] = React.useState(() => Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
  React.useEffect(() => {
    const timer = window.setInterval(() => setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <span role="timer" aria-label={label} className="tabular-nums text-fg3">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>;
}

function FetchElapsed({ startedAt }: { startedAt: number }): React.JSX.Element {
  const [seconds, setSeconds] = React.useState(() => Math.floor((performance.now() - startedAt) / 1000));
  React.useEffect(() => {
    const timer = window.setInterval(() => setSeconds(Math.floor((performance.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <span role="timer" aria-label="Fetch 已用时间" className="tabular-nums text-fg3">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>;
}

/** Updates or pushes the window's checked-out branch, independently of the browsing scope. */
export function RepositoryUpdateControl({ repository, fetch, operations, busy, remotes = [] }: {
  repository: RepositoryInfo;
  fetch: NonNullable<RepositoryActions["fetch"]>;
  operations: RepositoryActions["operations"];
  busy: boolean;
  remotes?: readonly string[];
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const refName = repository.headReference;
  const branch = refName ? shortRefName(refName) : null;
  const updating = operations?.view.running?.label === `更新 ${branch}`;
  const headPush = operations?.headPush ?? null;
  const pushState = operations?.pushState ?? null;
  const unavailable = repository.isBare ? "裸仓库没有工作区，可从下拉菜单 Fetch"
    : !repository.headOid ? "当前分支还没有提交，可从下拉菜单 Fetch"
      : !refName ? "当前工作区处于 detached HEAD，可从下拉菜单 Fetch"
        : !operations ? "当前核心不支持更新分支" : null;
  const disabled = busy || Boolean(operations?.busy) || fetch.running;
  const title = unavailable ?? `更新当前工作区分支 ${branch}：先 Fetch，再快进到上游，工作区文件随之更新`;
  const startFetch = (prune: boolean, remote: string | null = null) => { setOpen(false); void fetch.start(prune, remote); };
  const startPush = (remote: string | null, setUpstream: boolean) => {
    if (!headPush || !operations) return;
    setOpen(false);
    void operations.pushBranch(headPush.refName, { remote, setUpstream });
  };

  if (fetch.startedAt !== null) {
    return <div className="flex shrink-0 items-center" role="group" aria-label="Fetch">
      <div className="flex h-7 items-center gap-1.5 rounded-l-[7px] border border-line2 bg-panel px-2.5 text-xs">
        <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <span role="status">正在 Fetch</span>
        <FetchElapsed startedAt={fetch.startedAt} />
      </div>
      <Button variant="outline" size="sm" className="rounded-l-none border-l-0" aria-label="取消 Fetch" onClick={fetch.cancel}>取消</Button>
    </div>;
  }

  return <div className="flex shrink-0 items-center gap-1">
    <div className="flex shrink-0 items-center" role="group" aria-label="更新与 Fetch">
      <Button variant="outline" size="sm" className="rounded-r-none" data-testid="update-current-button"
        disabled={disabled || Boolean(unavailable)} title={title}
        aria-label={`更新当前工作区分支${branch ? ` ${branch}` : ""}`}
        onClick={() => { if (refName) void operations?.update(refName, { currentWorktreeOnly: true }); }}>
        {updating || fetch.running
          ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" strokeWidth={1.75} aria-hidden="true" />
          : <ArrowDownToLine className="size-3.5" strokeWidth={1.75} aria-hidden="true" />}
        <span className="max-w-[140px] truncate" aria-live="polite">{fetch.running ? "正在刷新…" : updating ? `更新 ${branch}…` : branch ? `更新 ${branch}` : "更新当前分支"}</span>
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="w-6 rounded-l-none border-l-0 px-0" disabled={disabled}
            data-testid="update-fetch-menu" aria-label="Fetch 与推送选项" title="Fetch 与推送选项">
            <ChevronDown className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[272px] p-1.5">
          <div role="menu" aria-label="Fetch 与推送选项" className="flex flex-col">
            <button type="button" role="menuitem" data-testid="fetch-button" disabled={disabled}
              className="rounded-[7px] px-2.5 py-2 text-left outline-none hover:bg-hover focus-visible:bg-hover disabled:opacity-50"
              onClick={() => startFetch(false)}>
              <span className="block font-medium">Fetch</span>
              <span className="block text-xs text-fg3">获取所有远端的新提交，保留本地分支和工作区</span>
            </button>
            <button type="button" role="menuitem" data-testid="fetch-prune-button" disabled={disabled}
              className="rounded-[7px] px-2.5 py-2 text-left outline-none hover:bg-hover focus-visible:bg-hover disabled:opacity-50"
              onClick={() => startFetch(true)}>
              <span className="block font-medium">Fetch 并清理失效引用</span>
              <span className="block text-xs text-fg3">同时清理远端已删除分支的跟踪引用</span>
            </button>
            {headPush ? <>
              <div role="separator" className="my-1 h-px bg-line" />
              {headPush.setUpstream ? (remotes.length ? remotes : headPush.remote ? [headPush.remote] : []).map(remoteName => (
                <button key={remoteName} type="button" role="menuitem" data-testid={`publish-remote-${remoteName}`} disabled={disabled}
                  className="rounded-[7px] px-2.5 py-1.5 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover disabled:opacity-50"
                  onClick={() => startPush(remoteName, true)}>
                  <span className="block truncate font-medium">发布到 {remoteName}（设置上游）</span>
                </button>
              )) : <button type="button" role="menuitem" data-testid="menu-push-button" disabled={disabled}
                className="rounded-[7px] px-2.5 py-2 text-left outline-none hover:bg-hover focus-visible:bg-hover disabled:opacity-50"
                onClick={() => startPush(headPush.remote, false)}>
                <span className="block font-medium">推送 {headPush.branch}（↑{headPush.ahead}）</span>
                <span className="block text-xs text-fg3">非强制推送到 {headPush.upstream}</span>
              </button>}
            </> : null}
            {remotes.length > 1 ? <>
              <div role="separator" className="my-1 h-px bg-line" />
              <div className="px-2.5 pt-1 pb-0.5 text-[11px] font-semibold text-fg3">单个远端</div>
              {remotes.map(remoteName => <button key={remoteName} type="button" role="menuitem" data-testid={`fetch-remote-${remoteName}`} disabled={disabled}
                className="rounded-[7px] px-2.5 py-1.5 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover disabled:opacity-50"
                onClick={() => startFetch(false, remoteName)}>
                <span className="block truncate font-medium">Fetch {remoteName}</span>
              </button>)}
            </> : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
    {pushState && operations ? <div className="flex shrink-0 items-center" role="group" aria-label="推送">
      <div className="flex h-7 items-center gap-1.5 rounded-l-[7px] border border-line2 bg-panel px-2 text-xs">
        <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <span role="status" className="topbar-push-copy">{pushState.phase === "refreshing" ? "刷新中" : "推送中"}</span>
        {pushState.phase === "pushing" ? <ElapsedTimer startedAt={pushState.startedAt} label="推送已用时间" /> : null}
      </div>
      {pushState.phase === "pushing" ? <Button variant="outline" size="sm" className="topbar-cancel-button rounded-l-none border-l-0"
        data-testid="cancel-push-button" aria-label="取消推送" onClick={operations.cancelPush}>
        <span className="topbar-cancel-label">取消</span>
      </Button> : null}
    </div> : headPush && operations ? <Button variant="outline" size="sm" className="topbar-push-button shrink-0" data-testid="push-current-button"
      disabled={disabled}
      title={headPush.setUpstream
        ? `发布 ${headPush.branch} 到 ${headPush.remote} 并设置上游（非强制推送）`
        : `非强制推送 ${headPush.branch} 到 ${headPush.upstream}（领先 ${headPush.ahead} 个提交）`}
      aria-label={headPush.setUpstream ? `发布分支 ${headPush.branch} 到 ${headPush.remote}` : `推送 ${headPush.branch}，领先 ${headPush.ahead} 个提交`}
      onClick={() => startPush(headPush.remote, headPush.setUpstream)}>
      <ArrowUpFromLine className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      {headPush.setUpstream
        ? <span className="topbar-publish-label whitespace-nowrap">发布分支</span>
        : <><span className="topbar-push-label whitespace-nowrap">推送</span><span className="tabular-nums whitespace-nowrap">↑{headPush.ahead}</span></>}
    </Button> : null}
  </div>;
}
