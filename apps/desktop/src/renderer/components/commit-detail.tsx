import * as React from "react";
import { Check, ChevronDown, ChevronUp, Copy, LoaderCircle } from "lucide-react";
import type { BranchesContainingResult, ChangedFilesPage, CommitDetails, CommitIdentity, CommitSummary, GitPath, MergeCommitsPage, RefInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { SearchTimeField } from "../../../../../packages/protocol/src/generated/client-message.js";
import type { RepositoryView } from "../lib/repository-session-store.js";
import type { CommitDetailView } from "../lib/commit-detail-store.js";
import type { HandoffRequest } from "./handoff-dialog.js";
import { CommitHandoffMenu } from "./handoff-menu.js";
import { identityTime, identityTimeTitle, repositoryName, sameIdentity, shortOid, shortRefName } from "../lib/format.js";
import { refsByTarget, RefTags } from "./commit-list.js";
import { IdentityAvatar } from "./identity-avatar.js";
import { DiffView } from "./diff-view.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.js";

export function CommitDetail({ preview, detail, onRetryDetails, onRetryFiles, onLoadFiles, onRetryMerge, onLoadMerge, onToggleDiff, onLoadContaining, onRetryContaining, selectedOid, onSelect, onMoveSelection, commitsOverride, selectedCommitOverride, timeField, canMovePrevious, canMoveNext, onLocateInHistory, onOpenHandoff, selectedTab = "overview", onTabChange }: {
  preview: RepositoryView;
  detail: CommitDetailView;
  onRetryDetails(): void;
  onRetryFiles(): void;
  onLoadFiles(parentIndex: number | null, offset: number): void;
  onRetryMerge(): void;
  onLoadMerge(parentIndex: number, offset: number): void;
  onToggleDiff(file: ChangedFilesPage["files"][number], parentIndex: number | null): void;
  onLoadContaining(): void;
  onRetryContaining(): void;
  selectedOid: string | undefined;
  onSelect(oid: string): void;
  onMoveSelection(delta: -1 | 1): Promise<void>;
  commitsOverride?: CommitSummary[];
  selectedCommitOverride?: CommitSummary | null;
  timeField?: SearchTimeField;
  canMovePrevious?: boolean;
  canMoveNext?: boolean;
  onLocateInHistory?(): void;
  onOpenHandoff?(request: HandoffRequest): void;
  selectedTab?: string;
  onTabChange?(tab: string): void;
}): React.JSX.Element {
  const commits = commitsOverride ?? preview.commits;
  const index = commits.findIndex(commit => commit.oid === selectedOid);
  const oldSelection = !selectedCommitOverride && index === -1 && preview.oldSelectedCommit?.oid === selectedOid;
  const detailValue = detail.oid === selectedOid ? detail.details.value : null;
  const commit = selectedCommitOverride?.oid === selectedOid ? selectedCommitOverride
    : index === -1 ? oldSelection ? detailValue?.commit ?? preview.oldSelectedCommit : detailValue?.commit : commits[index];
  const oldDetailContext = Boolean(detailValue && detail.detailsSessionKey !== detail.sessionKey);
  const activeDetails = detailValue && !oldDetailContext ? detailValue : null;
  const shownDetails = detailValue;
  const refIndex = React.useMemo(() => refsByTarget(preview.refs), [preview.refs]);
  const byOid = React.useMemo(() => new Map(commits.map(item => [item.oid, item])), [commits]);
  const repository = preview.repository;
  const otherWorktrees = !oldSelection && activeDetails ? activeDetails.worktrees.filter(worktree => !worktree.isCurrent && worktree.headOid === commit?.oid) : [];
  const canAutoLoadContaining = Boolean(commit && repository && activeDetails && detail.details.state === "ready" && selectedTab === "overview" &&
    detail.files.state !== "loading" && detail.merge.state !== "loading" && detail.diff.state !== "loading" && detail.containing.state === "idle");

  React.useEffect(() => {
    if (!canAutoLoadContaining) return;
    const timer = window.setTimeout(onLoadContaining, 150);
    return () => window.clearTimeout(timer);
  }, [canAutoLoadContaining, detail.sessionKey, detail.oid, selectedTab, onLoadContaining]);

  if (!commit || !repository) {
    return <section aria-label="提交详情" className="flex min-w-0 flex-1 items-center justify-center bg-panel">
      <p className="m-0 text-[13px] text-fg3">{preview.selectionMissingOnPage ? "当前页未载入所选提交；这不表示它已不可达。" : "选择一条提交查看详情。"}</p>
    </section>;
  }
  const isMerge = commit.parents.length > 1;
  const isHead = !oldDetailContext && repository.headOid === commit.oid;

  return <section aria-label="提交详情" className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-panel">
    <div className="mx-auto flex max-w-[920px] flex-col gap-5 px-11 pt-7 pb-12">
      <div className="flex flex-wrap items-center gap-2">
        {!oldSelection && !oldDetailContext ? <RefTags refs={refIndex.get(commit.oid) ?? []} headReference={repository.headReference}
          isHeadCommit={repository.headReference === null && isHead} size="default" limit={6} /> : null}
        {oldDetailContext && shownDetails?.refs.length ? <RefTags refs={shownDetails.refs} headReference={null} size="default" limit={6} /> : null}
        {isMerge ? <Badge>Merge · {commit.parents.length} 个父提交</Badge> : null}
        <div className="flex-1" />
        {onLocateInHistory ? <Button variant="outline" size="sm" data-testid="locate-in-history" onClick={onLocateInHistory}>在历史中定位</Button> : null}
        {onOpenHandoff ? <CommitHandoffMenu oid={commit.oid} isMerge={isMerge} onOpenHandoff={onOpenHandoff}
          toNewest={!commitsOverride && index > 0
            ? { commits: commits.slice(0, index + 1).map(item => ({ oid: item.oid, summary: item.summary })), complete: preview.windowPreviousCursor === null }
            : null} /> : null}
        <CopyOidButton oid={commit.oid} />
        <Button variant="outline" size="icon-sm" aria-label="上一个提交" disabled={canMovePrevious === undefined ? index < 0 || (index === 0 && preview.windowPreviousCursor === null) : !canMovePrevious}
          onClick={() => { void onMoveSelection(-1); }}><ChevronUp className="size-3.5" strokeWidth={1.75} /></Button>
        <Button variant="outline" size="icon-sm" aria-label="下一个提交" disabled={canMoveNext === undefined ? index < 0 || (index === commits.length - 1 && preview.windowNextCursor === null) : !canMoveNext}
          onClick={() => { void onMoveSelection(1); }}><ChevronDown className="size-3.5" strokeWidth={1.75} /></Button>
      </div>

      {oldSelection ? <p role="status" className="m-0 rounded-md border border-line bg-bg px-3 py-2 text-xs text-fg3">
        这条提交不在当前已加载窗口{preview.oldSelectedObservedAtUnixMs ? `（来自 ${new Date(preview.oldSelectedObservedAtUnixMs).toLocaleString()} 的观察）` : ""}；它可能仍在当前范围的更深位置，这里不推断整个范围的可达性。
      </p> : null}

      <UpdateHint details={detailValue} current={!oldDetailContext} />
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-2xl leading-[1.3] font-semibold tracking-[-0.01em] break-words [text-wrap:pretty]">{shownDetails?.message.split(/\r?\n/u, 1)[0] ?? commit.summary}</h1>
        {(!shownDetails && commit.summaryTruncated) || (shownDetails?.commit.textLossy ?? commit.textLossy) ? <p className="m-0 text-xs text-warn">
          {!shownDetails && commit.summaryTruncated ? "提交摘要过长，已截断。" : ""}{(shownDetails?.commit.textLossy ?? commit.textLossy) ? "提交文本含有无法按 UTF-8 无损解码的数据。" : ""}
        </p> : null}
        {detail.details.state === "loading" && !detailValue ? <p role="status" className="m-0 text-xs text-fg3">正在读取完整提交详情…</p> : null}
        {detail.details.error ? <ErrorLine message={detail.details.error.message} onRetry={onRetryDetails} label="重试读取详情" /> : null}
        {oldDetailContext ? <p role="status" className="m-0 rounded-md border border-line bg-bg px-3 py-2 text-xs text-fg3">
          以下详情来自旧范围观察（{new Date(detailValue!.observedAtUnixMs).toLocaleString()}），未与当前范围重新关联。<Button variant="outline" size="sm" className="ml-2" onClick={onRetryDetails}>在当前范围重新读取</Button>
        </p> : null}
        {shownDetails ? <MessageBody details={shownDetails} /> : null}
      </div>

      <Tabs value={selectedTab} onValueChange={onTabChange} className="flex flex-col gap-5">
        <TabsList>
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="changes">文件改动</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(360px,100%),1fr))] gap-x-10 gap-y-7">
            <Section title="作者与时间">
              <IdentityBlock role="Author" identity={commit.author} />
              <IdentityBlock role="Committer" identity={commit.committer} />
              {!sameIdentity(commit.author, commit.committer) ? <span className="text-xs text-fg3">作者与提交者不同；{timeField === "author" ? "搜索结果按作者时间排序。" : timeField === "committer" ? "搜索结果按提交者时间排序。" : "列表按提交时间分组。"}</span> : null}
            </Section>
            <Section title="标识与父提交">
              <dl className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3.5 gap-y-2.5 text-[13px]">
                <dt className="text-fg3">OID</dt>
                <dd className="m-0 font-mono text-[12.5px] break-all text-fg2">{commit.oid}</dd>
                <dt className="text-fg3">父提交</dt>
                <dd className="m-0 flex min-w-0 flex-col gap-2">
                  {commit.parents.length === 0 ? <span className="text-fg2">无（根提交）</span> : null}
                  {commit.parents.map((parent, order) => <ParentRow key={parent} oid={parent} order={order} total={commit.parents.length}
                    loaded={byOid.get(parent)} onSelect={onSelect} />)}
                </dd>
              </dl>
            </Section>
            <Section title="位置与引用">
              {shownDetails ? <p className="m-0 text-xs text-fg3">引用与 worktree 按 {new Date(shownDetails.observedAtUnixMs).toLocaleString()} 的快照记录。</p>
                : <p className="m-0 text-xs text-fg3">读取当前范围详情后显示引用与 worktree 快照。</p>}
              <dl className="m-0 grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-x-3.5 gap-y-2.5 text-[13px]">
                {shownDetails ? <><dt className="text-fg3">引用</dt><dd className="m-0 flex min-w-0 flex-wrap gap-1.5">
                  {shownDetails.refs.length ? <RefTags refs={shownDetails.refs} headReference={oldDetailContext ? null : repository.headReference} size="default" limit={12} /> : <span className="text-fg2">没有引用直接指向它</span>}
                  {shownDetails.refsTruncated ? <span className="text-xs text-fg3">引用列表已截断</span> : null}
                </dd><dt className="text-fg3">HEAD</dt><dd className="m-0 text-fg2">{oldDetailContext
                  ? shownDetails.worktrees.some(worktree => worktree.isCurrent && worktree.headOid === commit.oid) ? "旧观察中本窗口 HEAD 指向这里" : "旧观察未记录本窗口 HEAD 指向这里"
                  : repository.headOid === commit.oid ? `本窗口 HEAD 指向这里${repository.headReference ? `（${shortRefName(repository.headReference)}）` : "（detached）"}` : "不是本窗口 HEAD"}</dd></> : null}
                {otherWorktrees.length ? <><dt className="text-fg3">其他 worktree</dt><dd className="m-0 flex flex-col gap-1 text-fg2">
                  {otherWorktrees.map(worktree => <span key={worktree.id} title={worktree.path}>{repositoryName(worktree.path)} · {worktree.isMain ? "主" : "linked"}{worktree.isDetached ? " · detached HEAD" : ""}</span>)}
                </dd></> : null}
                {shownDetails ? <><dt className="text-fg3">工作树</dt><dd className="m-0 flex flex-col gap-1 text-fg2">
                  {shownDetails.worktrees.length ? shownDetails.worktrees.map(worktree => <span key={worktree.id} title={worktree.path}>{repositoryName(worktree.path)}{worktree.isDetached ? " · detached HEAD" : ""}{worktree.available ? "" : " · 不可用"}</span>) : "无工作树记录"}
                  {shownDetails.worktreesTruncated ? <span className="text-xs text-fg3">工作树列表已截断</span> : null}
                </dd></> : null}
                <dt className="text-fg3">包含它的分支</dt><dd className="m-0 min-w-0">
                  {detail.containing.value ? <ContainingBranches result={detail.containing.value} /> : null}
                  {detail.containing.error ? <ErrorLine message={detail.containing.error.message} onRetry={onRetryContaining} label="重试计算" /> : null}
                  {detail.containing.state === "loading" ? <span role="status" className="inline-flex items-center gap-1.5 text-xs text-fg3">
                    <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />正在读取包含分支…
                  </span> : null}
                </dd>
              </dl>
            </Section>
            <ChangeOverviewSection detail={detail} activeDetails={activeDetails} onLoadFiles={onLoadFiles} onRetryFiles={onRetryFiles} />
            {isMerge ? <MergeSection detail={detail} activeDetails={activeDetails} refs={oldDetailContext ? shownDetails?.refs ?? [] : preview.refs} onLoadMerge={onLoadMerge} onRetryMerge={onRetryMerge} /> : null}
          </div>
        </TabsContent>
        <TabsContent value="changes"><ChangesPanel detail={detail} activeDetails={activeDetails} onLoadFiles={onLoadFiles} onRetryFiles={onRetryFiles} onToggleDiff={onToggleDiff} /></TabsContent>
      </Tabs>
    </div>
  </section>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return <section aria-label={title} className="flex flex-col gap-3 border-t border-line pt-3.5">
    <h3 className="m-0 text-xs font-semibold text-fg3">{title}</h3>
    {children}
  </section>;
}

function MessageBody({ details }: { details: CommitDetails }): React.JSX.Element {
  const body = details.messageWithoutTrailers.split(/\r?\n/u).slice(1).join("\n").trim();
  return <div className="flex flex-col gap-3 text-[13px]">
    {body ? <pre data-testid="commit-detail-message" className="m-0 whitespace-pre-wrap break-words font-sans leading-relaxed text-fg2">{body}</pre> : <p data-testid="commit-detail-message" className="m-0 text-fg3">没有正文。</p>}
    {details.trailers.length && details.messageWithoutTrailers === details.message ? <p role="note" className="m-0 text-xs text-fg3">末尾信息已识别；为保留原文，正文可能仍包含这些行。</p> : null}
    {details.trailers.length ? <section aria-label="附加信息" data-testid="commit-detail-trailers" className="rounded-lg border border-line bg-bg px-3 py-2.5">
      <h2 className="m-0 mb-2 text-xs font-semibold text-fg3">附加信息</h2>
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        {details.trailers.map((trailer, index) => <React.Fragment key={`${trailer.key}:${index}`}>
          <dt className="text-fg3">{trailer.key}</dt><dd className="m-0 whitespace-pre-wrap break-words text-fg2">{trailer.value}</dd>
        </React.Fragment>)}
      </dl>
    </section> : null}
  </div>;
}

function ChangeOverviewSection({ detail, activeDetails, onLoadFiles, onRetryFiles }: {
  detail: CommitDetailView;
  activeDetails: CommitDetails | null;
  onLoadFiles(parentIndex: number | null, offset: number): void;
  onRetryFiles(): void;
}): React.JSX.Element {
  const page = detail.files.value;
  const parentIndex = page?.parentIndex ?? detail.fileParentIndex;
  const overview = page?.overview;
  const canQuery = Boolean(activeDetails);
  return <Section title="改动概览">
    {activeDetails ? <ParentSelector details={activeDetails} value={parentIndex} disabled={!canQuery} testId="overview-parent-selector" onChange={next => onLoadFiles(next, 0)} /> : null}
    {!detail.details.value && detail.details.state === "loading" ? <p role="status" className="m-0 text-xs text-fg3">正在读取完整详情，读取后加载文件概览…</p> : null}
    {!detail.details.value && detail.details.state === "error" ? <p role="status" className="m-0 text-xs text-fg3">完整详情尚未读取，暂不能读取文件概览。请使用上方“重试读取详情”。</p> : null}
    {detail.files.error ? <ErrorLine message={detail.files.error.message} onRetry={onRetryFiles} label="重试读取文件列表" /> : null}
    {!overview && detail.files.state === "loading" ? <p role="status" className="m-0 text-xs text-fg3">正在读取改动概览…</p> : null}
    {overview ? <>
      {page && detail.fileParentIndex !== page.parentIndex ? <p className="m-0 text-xs text-fg3">当前显示的是父提交 {parentLabel(page.parentIndex)} 的概览；新基准尚未加载完成。</p> : null}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <strong className="text-xl font-semibold tabular-nums">{overview.totalFiles} 个文件</strong>
        <span className="text-[13px] text-fg3">+{overview.additions} · −{overview.deletions} · {overview.binaryFiles} 个二进制 · {overview.gitlinkFiles} 个子模块引用</span>
      </div>
      <p className="m-0 text-xs text-fg3">新增 {overview.counts.added} · 修改 {overview.counts.modified} · 删除 {overview.counts.deleted} · 重命名 {overview.counts.renamed} · 复制 {overview.counts.copied} · 类型变化 {overview.counts.typeChanged}</p>
      {overview.directories.length ? <DirectoryList directories={overview.directories} /> : null}
      {page?.hasMore ? <p className="m-0 text-xs text-fg3">文件清单共 {page.totalFiles} 项，概览按完整清单统计。</p> : null}
    </> : null}
  </Section>;
}

function ChangesPanel({ detail, activeDetails, onLoadFiles, onRetryFiles, onToggleDiff }: {
  detail: CommitDetailView;
  activeDetails: CommitDetails | null;
  onLoadFiles(parentIndex: number | null, offset: number): void;
  onRetryFiles(): void;
  onToggleDiff(file: ChangedFilesPage["files"][number], parentIndex: number | null): void;
}): React.JSX.Element {
  const page = detail.files.value;
  const parentIndex = page?.parentIndex ?? detail.fileParentIndex;
  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center gap-3">
      <strong className="text-sm">文件清单</strong>
      {activeDetails ? <ParentSelector details={activeDetails} value={parentIndex} disabled={false} testId="file-parent-selector" onChange={next => onLoadFiles(next, 0)} /> : null}
      {page ? <span className="text-xs text-fg3">与 {parentLabel(page.parentIndex)} 比较 · {page.files.length ? `${page.offset + 1}–${page.offset + page.files.length}` : "0"} / {page.totalFiles}</span> : null}
    </div>
    {detail.files.error ? <ErrorLine message={detail.files.error.message} onRetry={onRetryFiles} label="重试读取文件列表" /> : null}
    {!page && detail.files.state === "loading" ? <p role="status" className="m-0 text-xs text-fg3">正在读取文件清单…</p> : null}
    {page ? <>
      {detail.fileParentIndex !== page.parentIndex ? <p role="status" className="m-0 text-xs text-fg3">正在读取 {parentLabel(detail.fileParentIndex)}；以下清单仍基于 {parentLabel(page.parentIndex)}。</p> : null}
      <div className="overflow-hidden rounded-xl border border-line">
        {page.files.length ? page.files.map((file, index) => {
          const diffKey = diffKeyFor(page.parentIndex, file);
          const expanded = detail.diffKey === diffKey;
          const canToggle = Boolean(activeDetails && detail.files.state !== "loading") || expanded && Boolean(detail.diff.value);
          return <FileRow key={`${file.oldPath?.rawHex ?? ""}:${file.newPath?.rawHex ?? ""}:${index}`} file={file}
            expanded={expanded} disabled={!canToggle} onToggle={() => onToggleDiff(file, page.parentIndex)}
            diff={expanded ? detail.diff : null} onRetry={() => onToggleDiff(file, page.parentIndex)} />;
        })
          : <p className="m-0 px-4 py-5 text-sm text-fg3">这个比较没有文件改动。</p>}
      </div>
      {page.offset > 0 || page.hasMore ? <div className="flex items-center justify-between">
        <Button data-testid="file-page-previous" variant="outline" size="sm" disabled={page.offset === 0 || detail.files.state === "loading"} onClick={() => onLoadFiles(page.parentIndex, Math.max(0, page.offset - page.pageSize))}>上一页</Button>
        <Button data-testid="file-page-next" variant="outline" size="sm" disabled={!page.hasMore || detail.files.state === "loading"} onClick={() => onLoadFiles(page.parentIndex, page.offset + page.files.length)}>下一页</Button>
      </div> : null}
    </> : null}
  </div>;
}

function FileRow({ file, expanded, disabled, onToggle, diff, onRetry }: {
  file: ChangedFilesPage["files"][number];
  expanded: boolean;
  disabled: boolean;
  onToggle(): void;
  diff: CommitDetailView["diff"] | null;
  onRetry(): void;
}): React.JSX.Element {
  const oldPath = file.oldPath ? displayGitPath(file.oldPath) : null;
  const newPath = file.newPath ? displayGitPath(file.newPath) : null;
  const primary = newPath ?? oldPath ?? "（路径不可用）";
  const status = { added: "新增", modified: "修改", deleted: "删除", renamed: "重命名", copied: "复制", typeChanged: "类型变化" }[file.status];
  return <div data-testid="changed-file-row" className="border-b border-line last:border-b-0">
    <button type="button" aria-expanded={expanded} data-testid="changed-file-toggle" disabled={disabled} onClick={onToggle}
      className="flex w-full min-w-0 items-start gap-3 px-3 py-2.5 text-left hover:bg-bg/70 disabled:cursor-default disabled:hover:bg-transparent">
      <Badge size="sm">{status}</Badge>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="break-all font-mono text-[12.5px] text-fg" title={[file.oldPath?.rawHex, file.newPath?.rawHex].filter(Boolean).join(" → ")}>{primary}{file.oldPath?.textLossy || file.newPath?.textLossy ? " · 路径含有非 UTF-8 字节" : ""}</span>
        {file.status === "renamed" || file.status === "copied" ? <span className="break-all text-xs text-fg3">{oldPath} → {newPath}</span> : null}
        <span className="break-all text-xs text-fg3">mode {file.oldMode} → {file.newMode}{file.gitlink ? ` · 子模块引用 ${file.oldOid ?? "000000"} → ${file.newOid ?? "000000"}` : ""}{file.binary ? " · 二进制" : ""}{file.similarity !== null ? ` · 相似度 ${file.similarity}%` : ""}</span>
      </span>
      <span className="shrink-0 font-mono text-xs tabular-nums"><span className="text-add">{file.additions === null ? "—" : `+${file.additions}`}</span> <span className="text-del">{file.deletions === null ? "—" : `−${file.deletions}`}</span></span>
      <span className="shrink-0 text-xs text-fg3">{expanded ? "收起 diff" : "查看 diff"}</span>
    </button>
    {expanded && diff ? <DiffPanel file={file} state={diff} onRetry={onRetry} /> : null}
  </div>;
}

function DiffPanel({ file, state, onRetry }: { file: ChangedFilesPage["files"][number]; state: CommitDetailView["diff"]; onRetry(): void }): React.JSX.Element {
  if (state.state === "loading") return <p role="status" className="m-0 border-t border-line bg-bg px-4 py-3 text-xs text-fg3">正在读取只读 diff…</p>;
  if (state.state === "error") return <div role="alert" className="flex items-center gap-2 border-t border-line bg-bg px-4 py-3 text-xs text-bad"><span>{state.error?.message}</span><Button variant="outline" size="sm" onClick={onRetry}>重试 diff</Button></div>;
  const diff = state.value;
  if (!diff) return <p className="m-0 border-t border-line bg-bg px-4 py-3 text-xs text-fg3">diff 已关闭。</p>;
  const kindLabel = {
    binary: "二进制文件不展示文本 diff。",
    gitlink: "这是 gitlink，只显示子模块对象引用，不读取子模块工作区。",
    lfs: "这是 Git LFS 指针；未下载 LFS 内容。",
    tooLarge: `文件超过读取上限（${formatSize(diff.oldSize)} → ${formatSize(diff.newSize)}），未生成 diff。`,
    text: "",
  }[diff.kind];
  return <div data-testid="file-diff" className="border-t border-line bg-bg">
    {kindLabel ? <p className="m-0 px-4 py-3 text-xs text-fg3">{kindLabel}</p> : null}
    {diff.kind === "text" && diff.patch === "" && !diff.truncated ? <p className="m-0 px-4 py-3 text-xs text-fg3">文件内容相同，仅路径或模式变化。</p> : null}
    {diff.textLossy ? <p className="m-0 px-4 py-2 text-xs text-warn">diff 文本含有无法按 UTF-8 无损解码的数据。</p> : null}
    {diff.truncated ? <p className="m-0 px-4 py-2 text-xs text-warn">diff 已截断，仅显示读取预算内的部分。</p> : null}
    {diff.kind === "text" && diff.patch ? <DiffView patch={diff.patch} /> : null}
    <span className="sr-only">{file.status} file diff</span>
  </div>;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "大小未知";
  if (bytes < 1_024) return `${bytes} B`;
  return `${(bytes / 1_024).toFixed(1)} KiB`;
}

function diffKeyFor(parentIndex: number | null, file: ChangedFilesPage["files"][number]): string {
  return `${parentIndex ?? "root"}:${file.oldPath?.rawHex ?? "-"}:${file.newPath?.rawHex ?? "-"}`;
}

function ParentSelector({ details, value, disabled, testId, onChange }: {
  details: CommitDetails;
  value: number | null;
  disabled: boolean;
  testId: string;
  onChange(parentIndex: number | null): void;
}): React.JSX.Element {
  const parents = details.commit.parents;
  if (parents.length === 0) {
    return <div className="text-xs text-fg3">对比基准 <span className="text-fg">空树（根提交）</span></div>;
  }
  if (parents.length === 1) {
    return <div className="text-xs text-fg3">对比基准 <span className="text-fg">父提交 · {shortOid(parents[0]!)}</span></div>;
  }
  return <label className="flex items-center gap-2 text-xs text-fg3">对比基准
    <select data-testid={testId} aria-label="父提交基准" className="max-w-[280px] rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] text-fg" value={value === null ? "root" : String(value)} disabled={disabled}
      onChange={event => onChange(event.target.value === "root" ? null : Number(event.target.value))}>
      {parents.map((oid, index) => <option key={oid} value={index}>父提交 {index + 1} · {shortOid(oid)}</option>)}
    </select>
  </label>;
}

function MergeSection({ detail, activeDetails, refs, onLoadMerge, onRetryMerge }: {
  detail: CommitDetailView;
  activeDetails: CommitDetails | null;
  refs: RefInfo[];
  onLoadMerge(parentIndex: number, offset: number): void;
  onRetryMerge(): void;
}): React.JSX.Element {
  const page: MergeCommitsPage | null = detail.merge.value;
  const requestedParent = detail.mergeParentIndex;
  const parent = page?.parentIndex ?? requestedParent ?? 1;
  const refsByOid = refsByTarget(refs);
  const mergeParents = activeDetails?.commit.parents.slice(1) ?? [];
  const mergeParentOid = activeDetails?.commit.parents[parent];
  const mergeParentRef = mergeParentOid ? refsByOid.get(mergeParentOid)?.[0] : undefined;
  const visibleAuthors = page?.authors.slice(0, 24) ?? [];
  return <Section title="Merge 带入">
    {activeDetails && mergeParents.length === 1 ? <div className="text-xs text-fg3">比较分组 <span className="text-fg">父提交 2 · {shortOid(mergeParents[0]!)}{mergeParentRef ? ` · ${shortRefName(mergeParentRef.name)}` : ""}</span></div> : activeDetails && mergeParents.length > 1 ? <label className="flex items-center gap-2 text-xs text-fg3">比较分组
      <select data-testid="merge-parent-selector" aria-label="Merge 父提交分组" className="max-w-[320px] rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] text-fg" value={parent}
        onChange={event => onLoadMerge(Number(event.target.value), 0)}>
        {mergeParents.map((oid, index) => {
          const parentIndex = index + 1;
          const ref = refsByOid.get(oid)?.[0];
          return <option key={oid} value={parentIndex}>父提交 {parentIndex + 1} · {shortOid(oid)}{ref ? ` · ${shortRefName(ref.name)}` : ""}</option>;
        })}
      </select>
    </label> : null}
    {!detail.details.value && detail.details.state === "loading" ? <p role="status" className="m-0 text-xs text-fg3">正在读取完整详情，读取后加载合并分组…</p> : null}
    {!detail.details.value && detail.details.state === "error" ? <p role="status" className="m-0 text-xs text-fg3">完整详情尚未读取，暂不能读取合并分组。请使用上方“重试读取详情”。</p> : null}
    {detail.merge.error ? <ErrorLine message={detail.merge.error.message} onRetry={onRetryMerge} label="重试读取 Merge 分组" /> : null}
    {!page && detail.merge.state === "loading" ? <p role="status" className="m-0 text-xs text-fg3">正在读取 Merge 分组…</p> : null}
    {page ? <div data-testid="merge-commit-page"><>
      {requestedParent !== page.parentIndex ? <p className="m-0 text-xs text-fg3">当前显示父提交 {page.parentIndex + 1} 的分组；另一分组仍在读取。</p> : null}
      <p className="m-0 text-xs text-fg3">本组 {page.totalCommits} 个提交。作者统计按本组提交计算，重复作者按原始姓名与邮箱合并。</p>
      {page.authors.length ? <><ul className="m-0 flex flex-wrap gap-x-4 gap-y-1 pl-4 text-xs text-fg2">{visibleAuthors.map((author, index) => <li key={`${author.email}:${author.name}:${index}`}>{author.name || author.email} · {author.count}</li>)}</ul>{page.authors.length > visibleAuthors.length ? <details className="text-xs text-fg3"><summary>另有 {page.authors.length - visibleAuthors.length} 位作者</summary><ul className="m-0 flex flex-wrap gap-x-4 gap-y-1 pl-4">{page.authors.slice(visibleAuthors.length).map((author, index) => <li key={`${author.email}:${author.name}:${index}`}>{author.name || author.email} · {author.count}</li>)}</ul></details> : null}</> : null}
      {page.commits.length ? <ul className="m-0 flex flex-col gap-1 pl-4 text-[13px]">{page.commits.map(item => <li data-testid="merge-commit-row" key={item.oid} className="flex min-w-0 gap-2"><span className="shrink-0 font-mono text-xs text-fg3">{shortOid(item.oid)}</span><span className="truncate">{item.summary}</span></li>)}</ul> : <p className="m-0 text-sm text-fg3">这个分组没有带入提交。</p>}
      {page.offset > 0 || page.hasMore ? <div className="flex items-center justify-between">
        <Button data-testid="merge-page-previous" variant="outline" size="sm" disabled={page.offset === 0 || detail.merge.state === "loading"} onClick={() => onLoadMerge(page.parentIndex, Math.max(0, page.offset - page.pageSize))}>上一页</Button>
        <Button data-testid="merge-page-next" variant="outline" size="sm" disabled={!page.hasMore || detail.merge.state === "loading"} onClick={() => onLoadMerge(page.parentIndex, page.offset + page.commits.length)}>下一页</Button>
      </div> : null}
    </></div> : null}
  </Section>;
}

function ContainingBranches({ result }: { result: BranchesContainingResult }): React.JSX.Element {
  return <div data-testid="branches-containing-result" className="flex min-w-0 flex-wrap items-baseline gap-1.5 text-xs text-fg2">
    {result.branches.length ? result.branches.map(ref => <Badge key={`${ref.kind}:${ref.name}`} title={ref.name}
      className="h-auto min-h-[22px] max-w-full whitespace-normal break-all py-1 leading-tight">{shortRefName(ref.name)}</Badge>)
      : <span>{result.complete ? "没有已确认包含它的分支" : "当前没有已确认的分支；结果不完整"}</span>}
    {!result.complete || result.refsTruncated || result.boundaryLimited ? <span className="text-fg3">结果不完整{result.boundaryLimited ? " · 浅边界限制" : ""}{result.refsTruncated ? " · 引用列表已截断" : ""}</span> : null}
    <span className="text-fg3">引用快照 {new Date(result.observedAtUnixMs).toLocaleString()}</span>
  </div>;
}

function UpdateHint({ details, current }: { details: CommitDetails | null; current: boolean }): React.JSX.Element | null {
  if (!details || !current || details.update.state !== "affected") return null;
  return <p data-testid="commit-update-hint" role="status" className="m-0 border-t border-line pt-3 text-xs text-fg3">
    此提交可能受当前范围更新影响。引用观察于 {new Date(details.observedAtUnixMs).toLocaleString()}；本次复核于 {new Date(details.update.checkedAtUnixMs).toLocaleString()}。
  </p>;
}

function ErrorLine({ message, onRetry, label }: { message: string; onRetry(): void; label: string }): React.JSX.Element {
  return <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-bad"><span>{message}</span><Button variant="outline" size="sm" onClick={onRetry}>{label}</Button></div>;
}

function displayGitPath(path: GitPath): string {
  return path.display.replace(/[\u0000-\u001f\u007f-\u009f]/gu, character => `\\u{${character.codePointAt(0)!.toString(16)}}`);
}

function DirectoryList({ directories }: { directories: ChangedFilesPage["overview"]["directories"] }): React.JSX.Element {
  const visible = directories.slice(0, 30);
  const remainder = directories.slice(30);
  const rows = (items: typeof directories) => items.map((directory, index) => <li key={`${directory.path?.rawHex ?? "root"}:${index}`}>
    <span className="font-mono" title={directory.path?.rawHex}>{directory.path ? displayGitPath(directory.path) : "（仓库根目录）"}{directory.path?.textLossy ? " · 含非 UTF-8 字节" : ""}</span>
    <span className="ml-2 text-xs text-fg3">{directory.totalFiles} 个文件 · +{directory.additions} · −{directory.deletions}</span>
  </li>);
  return <div className="flex flex-col gap-2">
    <ul className="m-0 flex flex-col gap-1 pl-4 text-[13px] text-fg2">{rows(visible)}</ul>
    {remainder.length ? <details className="text-xs text-fg3"><summary>另有 {remainder.length} 个目录</summary><ul className="m-0 flex flex-col gap-1 pl-4 text-[13px] text-fg2">{rows(remainder)}</ul></details> : null}
  </div>;
}

function parentLabel(parentIndex: number | null): string {
  return parentIndex === null ? "空树" : `父提交 ${parentIndex + 1}`;
}

function IdentityBlock({ role, identity }: { role: "Author" | "Committer"; identity: CommitIdentity }): React.JSX.Element {
  return <div className="flex items-start gap-3">
    <IdentityAvatar identity={identity} size="md" />
    <div className="flex min-w-0 flex-1 flex-col gap-px">
      <span className="flex items-center gap-2"><strong className="truncate font-semibold">{identity.name}</strong><Badge size="sm">{role}</Badge></span>
      <span className="truncate text-[12.5px] text-fg3">{identity.email}</span>
      <span className="text-[12.5px] text-fg2 tabular-nums" title={identityTimeTitle(identity)}>{identityTime(identity)}</span>
    </div>
  </div>;
}

function ParentRow({ oid, order, total, loaded, onSelect }: {
  oid: string;
  order: number;
  total: number;
  loaded: CommitSummary | undefined;
  onSelect(oid: string): void;
}): React.JSX.Element {
  return <div className="flex min-w-0 flex-col gap-0.5">
    <span className="font-mono text-[12.5px] break-all text-fg2">{total > 1 ? <span className="mr-1.5 font-sans text-xs text-fg3">父 {order + 1}</span> : null}{oid}</span>
    {loaded
      ? <button type="button" className="min-w-0 truncate text-left text-[13px] text-accent hover:underline" onClick={() => onSelect(oid)}>{loaded.summary}</button>
      : <span className="text-xs text-fg3">不在已加载的提交中</span>}
  </div>;
}

function CopyOidButton({ oid }: { oid: string }): React.JSX.Element {
  const [copied, setCopied] = React.useState<"idle" | "done" | "failed">("idle");
  React.useEffect(() => setCopied("idle"), [oid]);
  return <Button variant="outline" size="sm" className="font-mono" aria-label={`复制完整 OID ${oid}`}
    onClick={() => {
      void window.commitScope.copyText(oid).then(() => setCopied("done"), () => setCopied("failed"));
      window.setTimeout(() => setCopied("idle"), 1600);
    }}>
    {copied === "done" ? <Check className="size-3.5 text-ok" strokeWidth={2} /> : <Copy className="size-3.5" strokeWidth={1.75} />}
    <span aria-live="polite">{copied === "done" ? "已复制" : copied === "failed" ? "复制失败" : shortOid(oid)}</span>
  </Button>;
}
