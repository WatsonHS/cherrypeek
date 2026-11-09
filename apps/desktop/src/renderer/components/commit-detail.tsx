import * as React from "react";
import { Check, ChevronDown, ChevronUp, Copy, FileText, LoaderCircle } from "lucide-react";
import type { BranchesContainingResult, ChangedFile, ChangedFilesPage, CommitDetails, CommitIdentity, CommitSummary, GitPath, MergeCommitsPage, RefInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { SearchTimeField } from "../../../../../packages/protocol/src/generated/client-message.js";
import type { RepositoryView } from "../lib/repository-session-store.js";
import type { CommitDetailView } from "../lib/commit-detail-store.js";
import { FoldToggle, FoldedText, foldItems } from "./fold.js";
import type { HandoffRequest } from "./handoff-dialog.js";
import { CommitHandoffMenu } from "./handoff-menu.js";
import { identityTime, identityTimeTitle, repositoryName, sameIdentity, shortOid, shortRefName } from "../lib/format.js";
import { refsByTarget, RefTags } from "./commit-list.js";
import { IdentityAvatar } from "./identity-avatar.js";
import { DiffView } from "./diff-view.js";
import { cn } from "../lib/utils.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";

/** ⌥⌘1 / ⌥⌘2 on the commits page: scroll the details to the overview (top) or to 文件改动. */
export const COMMIT_DETAIL_SCROLL_EVENT = "commitscope:commit-detail-scroll";

export function CommitDetail({ preview, detail, onRetryDetails, onRetryFiles, onLoadFiles, onRetryMerge, onLoadMerge, onToggleDiff, onLoadContaining, onRetryContaining, selectedOid, onSelect, onMoveSelection, commitsOverride, selectedCommitOverride, timeField, canMovePrevious, canMoveNext, onLocateInHistory, onOpenHandoff, onOpenFile }: {
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
  /** Opens the files page on a path's history with this commit selected (P4-10). */
  /** Opens a changed file on the files page (its history at this commit when this commit deleted it). */
  onOpenFile?(file: ChangedFile, oid: string): void;
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
  const canAutoLoadContaining = Boolean(commit && repository && activeDetails && detail.details.state === "ready" &&
    detail.files.state !== "loading" && detail.merge.state !== "loading" && detail.diff.state !== "loading" && detail.containing.state === "idle");

  React.useEffect(() => {
    if (!canAutoLoadContaining) return;
    const timer = window.setTimeout(onLoadContaining, 150);
    return () => window.clearTimeout(timer);
  }, [canAutoLoadContaining, detail.sessionKey, detail.oid, onLoadContaining]);

  // One page: the message and overview on top, the changed files below. Another commit starts at the top again.
  const scrollRef = React.useRef<HTMLElement>(null);
  const changesRef = React.useRef<HTMLElement>(null);
  const scrollToChanges = React.useCallback(() => {
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    changesRef.current?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
  }, []);
  React.useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [commit?.oid]);
  React.useEffect(() => {
    const onScroll = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "changes") scrollToChanges();
      else scrollRef.current?.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    };
    window.addEventListener(COMMIT_DETAIL_SCROLL_EVENT, onScroll);
    return () => window.removeEventListener(COMMIT_DETAIL_SCROLL_EVENT, onScroll);
  }, [scrollToChanges]);

  if (!commit || !repository) {
    return <section aria-label="提交详情" className="flex min-w-0 flex-1 items-center justify-center bg-panel">
      <p className="m-0 text-[13px] text-fg3">{preview.selectionMissingOnPage ? "当前页未载入所选提交；这不表示它已不可达。" : "选择一条提交查看详情。"}</p>
    </section>;
  }
  const isMerge = commit.parents.length > 1;
  const isHead = !oldDetailContext && repository.headOid === commit.oid;

  return <section ref={scrollRef} aria-label="提交详情" className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-panel">
    <div className="mx-auto flex max-w-[920px] flex-col gap-5 px-11 pt-7 pb-12">
      <div className="flex flex-wrap items-center gap-2">
        {!oldSelection && !oldDetailContext ? <RefTags refs={refIndex.get(commit.oid) ?? []} headReference={repository.headReference}
          isHeadCommit={repository.headReference === null && isHead} size="default" limit={6} /> : null}
        {oldDetailContext && shownDetails?.refs.length ? <RefTags refs={shownDetails.refs} headReference={null} size="default" limit={6} /> : null}
        {shownDetails?.refsTruncated ? <span className="text-xs text-fg3">引用列表已截断</span> : null}
        {isMerge ? <Badge>Merge · {commit.parents.length} 个父提交</Badge> : null}
        <div className="flex-1" />
        {onLocateInHistory ? <Button variant="outline" size="sm" data-testid="locate-in-history" onClick={onLocateInHistory} title="在完整历史里定位这个结果（⌘L）；定位后 ⌘[ 回到搜索结果">在历史中定位</Button> : null}
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

      {/* The overview, one row per fact, so the changed files below start on the first screen. Refs and HEAD are the
          tags at the top; the full OID is the copy button there. */}
      <dl data-testid="commit-overview" className="m-0 grid grid-cols-[84px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 border-t border-line pt-4 text-[13px]">
        <dt className="text-fg3">作者</dt>
        <dd className="m-0 min-w-0"><IdentityLine identity={commit.author} />
          {sameIdentity(commit.author, commit.committer) ? <span className="ml-2 text-xs text-fg3">也是提交者</span> : null}</dd>
        {!sameIdentity(commit.author, commit.committer) ? <><dt className="text-fg3">提交者</dt><dd className="m-0 min-w-0"><IdentityLine identity={commit.committer} />
          <span className="ml-2 text-xs text-fg3" title="作者与提交者不同">{timeField === "author" ? "搜索结果按作者时间排序" : timeField === "committer" ? "搜索结果按提交者时间排序" : "列表按提交时间分组"}</span></dd></> : null}
        <dt className="text-fg3">父提交</dt>
        <dd className="m-0 flex min-w-0 flex-col gap-1">
          {commit.parents.length === 0 ? <span className="text-fg2">无（根提交）</span> : null}
          {commit.parents.map((parent, order) => <ParentLine key={parent} oid={parent} order={order} total={commit.parents.length} loaded={byOid.get(parent)} onSelect={onSelect} />)}
        </dd>
        {otherWorktrees.length ? <><dt className="text-fg3">其他 worktree</dt><dd className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-fg2">
          {otherWorktrees.map(worktree => <span key={worktree.id} title={worktree.path}>{repositoryName(worktree.path)} · {worktree.isMain ? "主" : "linked"}{worktree.isDetached ? " · detached HEAD" : ""}</span>)}
        </dd></> : null}
        <dt className="text-fg3">包含它的分支</dt><dd className="m-0 min-w-0">
          {detail.containing.value ? <ContainingBranches result={detail.containing.value} /> : null}
          {detail.containing.error ? <ErrorLine message={detail.containing.error.message} onRetry={onRetryContaining} label="重试计算" /> : null}
          {detail.containing.state === "loading" ? <span role="status" className="inline-flex items-center gap-1.5 text-xs text-fg3">
            <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />正在读取包含分支…
          </span> : null}
        </dd>
        <dt className="text-fg3">改动</dt><dd className="m-0 min-w-0"><ChangeSummary detail={detail} activeDetails={activeDetails} onRetryFiles={onRetryFiles} onJumpToFiles={scrollToChanges} /></dd>
      </dl>
      {isMerge ? <MergeSection detail={detail} activeDetails={activeDetails} refs={oldDetailContext ? shownDetails?.refs ?? [] : preview.refs} onLoadMerge={onLoadMerge} onRetryMerge={onRetryMerge} /> : null}

      <section ref={changesRef} aria-label="文件改动" data-testid="commit-changes" className="flex scroll-mt-4 flex-col gap-4 border-t border-line pt-5">
        <ChangesPanel detail={detail} activeDetails={activeDetails} onLoadFiles={onLoadFiles} onRetryFiles={onRetryFiles} onToggleDiff={onToggleDiff}
          onOpenFile={onOpenFile ? file => onOpenFile(file, commit.oid) : undefined} />
      </section>
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
    {body ? <FoldedText text={body} lines={6} testId="commit-detail-message" className="m-0 whitespace-pre-wrap break-words font-sans leading-relaxed text-fg2" />
      : <p data-testid="commit-detail-message" className="m-0 text-fg3">没有正文。</p>}
    {details.trailers.length && details.messageWithoutTrailers === details.message ? <p role="note" className="m-0 text-xs text-fg3">末尾信息已识别；为保留原文，正文可能仍包含这些行。</p> : null}
    {details.trailers.length ? <section aria-label="附加信息" data-testid="commit-detail-trailers" title="从消息末尾的 trailer 解析，只做展示">
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
        {details.trailers.map((trailer, index) => <React.Fragment key={`${trailer.key}:${index}`}>
          <dt className="text-fg3">{trailer.key}</dt><dd className="m-0 whitespace-pre-wrap break-words text-fg2">{trailer.value}</dd>
        </React.Fragment>)}
      </dl>
    </section> : null}
  </div>;
}

/** One line of counts (only the kinds present) and the busiest directories; the parent is picked once, above the file list. */
function ChangeSummary({ detail, activeDetails, onRetryFiles, onJumpToFiles }: {
  detail: CommitDetailView;
  activeDetails: CommitDetails | null;
  onRetryFiles(): void;
  onJumpToFiles(): void;
}): React.JSX.Element {
  const page = detail.files.value;
  const parentIndex = page?.parentIndex ?? detail.fileParentIndex;
  const overview = page?.overview;
  if (!overview) {
    return <span className="text-xs text-fg3">
      {detail.files.error ? <ErrorLine message={detail.files.error.message} onRetry={onRetryFiles} label="重试读取文件列表" />
        : !detail.details.value && detail.details.state === "error" ? "完整详情尚未读取，暂不能统计改动。"
        : "正在读取改动概览…"}
    </span>;
  }
  const counts = overview.counts;
  const kinds = ([["新增", counts.added], ["修改", counts.modified], ["删除", counts.deleted], ["重命名", counts.renamed], ["复制", counts.copied], ["类型变化", counts.typeChanged],
    ["二进制", overview.binaryFiles], ["子模块引用", overview.gitlinkFiles]] as const).filter(([, count]) => count > 0);
  const directories = overview.directories.slice(0, 5);
  return <div className="flex min-w-0 flex-col gap-1" data-testid="change-summary">
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <strong className="font-semibold tabular-nums">{overview.totalFiles} 个文件</strong>
      <span className="font-mono text-xs"><span className="text-add">+{overview.additions}</span> <span className="text-del">−{overview.deletions}</span></span>
      {kinds.length ? <span className="text-xs text-fg3">{kinds.map(([label, count]) => `${label} ${count}`).join(" · ")}</span> : null}
      <button type="button" data-testid="jump-to-files" onClick={onJumpToFiles} title="滚到下方的文件改动（⌥⌘2）"
        className="inline-flex items-center gap-0.5 rounded-md px-1 text-xs font-medium text-accent-fg hover:bg-accent-soft">
        查看文件<ChevronDown className="size-3" strokeWidth={1.75} /></button>
    </span>
    {overview.directories.length > 1 ? <span className="min-w-0 truncate text-xs text-fg3" title={overview.directories.map(item => `${item.path ? displayGitPath(item.path) : "（仓库根目录）"} ${item.totalFiles}`).join("\n")}>
      {directories.map(item => `${item.path ? displayGitPath(item.path) : "（根目录）"} ${item.totalFiles}`).join(" · ")}{overview.directories.length > directories.length ? ` · 另 ${overview.directories.length - directories.length} 个目录` : ""}
    </span> : null}
    {activeDetails && activeDetails.commit.parents.length > 1 ? <span className="text-xs text-fg3">与{parentLabel(parentIndex)}比较；在下方“文件改动”里切换。</span> : null}
    {page && detail.fileParentIndex !== page.parentIndex ? <span className="text-xs text-fg3">新的比较基准尚未读完，以上仍是{parentLabel(page.parentIndex)}的统计。</span> : null}
  </div>;
}

function ChangesPanel({ detail, activeDetails, onLoadFiles, onRetryFiles, onToggleDiff, onOpenFile }: {
  detail: CommitDetailView;
  activeDetails: CommitDetails | null;
  onLoadFiles(parentIndex: number | null, offset: number): void;
  onRetryFiles(): void;
  onToggleDiff(file: ChangedFilesPage["files"][number], parentIndex: number | null): void;
  onOpenFile?(file: ChangedFile): void;
}): React.JSX.Element {
  const page = detail.files.value;
  const parentIndex = page?.parentIndex ?? detail.fileParentIndex;
  // A long page folds after 30 files; the file whose diff is open always stays visible.
  const [filesOpen, setFilesOpen] = React.useState(false);
  React.useEffect(() => setFilesOpen(false), [page]);
  const shownFiles = page ? foldItems(page.files, 30, filesOpen, file => detail.diffKey === diffKeyFor(page.parentIndex, file)) : [];
  const filesFolded = page ? shownFiles.length < page.files.length : false;
  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center gap-3">
      <h2 className="m-0 text-[17px] font-semibold">文件改动</h2>
      {activeDetails ? <ParentSelector details={activeDetails} value={parentIndex} disabled={false} testId="file-parent-selector" onChange={next => onLoadFiles(next, 0)} /> : null}
      {page ? <span className="text-xs text-fg3">{activeDetails && activeDetails.commit.parents.length > 1 ? `与 ${parentLabel(page.parentIndex)} 比较 · ` : ""}{page.files.length ? `${page.offset + 1}–${page.offset + page.files.length}` : "0"} / {page.totalFiles}</span> : null}
    </div>
    {detail.files.error ? <ErrorLine message={detail.files.error.message} onRetry={onRetryFiles} label="重试读取文件列表" /> : null}
    {!page && detail.files.state === "loading" ? <p role="status" className="m-0 text-xs text-fg3">正在读取文件清单…</p> : null}
    {page ? <>
      {detail.fileParentIndex !== page.parentIndex ? <p role="status" className="m-0 text-xs text-fg3">正在读取 {parentLabel(detail.fileParentIndex)}；以下清单仍基于 {parentLabel(page.parentIndex)}。</p> : null}
      <div className="overflow-hidden rounded-xl border border-line">
        {page.files.length ? shownFiles.map((file, index) => {
          const diffKey = diffKeyFor(page.parentIndex, file);
          const expanded = detail.diffKey === diffKey;
          const canToggle = Boolean(activeDetails && detail.files.state !== "loading") || expanded && Boolean(detail.diff.value);
          return <FileRow key={`${file.oldPath?.rawHex ?? ""}:${file.newPath?.rawHex ?? ""}:${index}`} file={file}
            expanded={expanded} disabled={!canToggle} onToggle={() => onToggleDiff(file, page.parentIndex)}
            diff={expanded ? detail.diff : null} fullFileLimited={expanded && detail.diffFullFileLimited} onRetry={() => onToggleDiff(file, page.parentIndex)}
            onOpenFile={onOpenFile && (file.newPath ?? file.oldPath) ? () => onOpenFile(file) : undefined} />;
        })
          : <p className="m-0 px-4 py-5 text-sm text-fg3">这个比较没有文件改动。</p>}
      </div>
      <FoldToggle hidden={page.files.length - shownFiles.length} open={filesOpen} noun="文件" onToggle={() => setFilesOpen(value => !value)} testId="changed-files-fold" />
      {/* "下一页" waits until the folded files of this page are shown, so paging never skips them. */}
      {page.offset > 0 || page.hasMore && !filesFolded ? <div className="flex items-center justify-between">
        <Button data-testid="file-page-previous" variant="outline" size="sm" disabled={page.offset === 0 || detail.files.state === "loading"} onClick={() => onLoadFiles(page.parentIndex, Math.max(0, page.offset - page.pageSize))}>上一页</Button>
        {!filesFolded ? <Button data-testid="file-page-next" variant="outline" size="sm" disabled={!page.hasMore || detail.files.state === "loading"} onClick={() => onLoadFiles(page.parentIndex, page.offset + page.files.length)}>下一页</Button> : null}
      </div> : null}
    </> : null}
  </div>;
}

function FileRow({ file, expanded, disabled, onToggle, diff, fullFileLimited, onRetry, onOpenFile }: {
  file: ChangedFilesPage["files"][number];
  expanded: boolean;
  disabled: boolean;
  onToggle(): void;
  diff: CommitDetailView["diff"] | null;
  fullFileLimited: boolean;
  onRetry(): void;
  onOpenFile?(): void;
}): React.JSX.Element {
  const oldPath = file.oldPath ? displayGitPath(file.oldPath) : null;
  const newPath = file.newPath ? displayGitPath(file.newPath) : null;
  const primary = newPath ?? oldPath ?? "（路径不可用）";
  const status = { added: "新增", modified: "修改", deleted: "删除", renamed: "重命名", copied: "复制", typeChanged: "类型变化" }[file.status];
  // A second line only when it says something: a real mode change, a submodule, binary content, similarity.
  const modeChanged = file.oldMode !== file.newMode && !/^0+$/u.test(file.oldMode ?? "0") && !/^0+$/u.test(file.newMode ?? "0");
  const notes = [
    modeChanged ? `mode ${file.oldMode} → ${file.newMode}` : "",
    file.gitlink ? `子模块引用 ${file.oldOid ?? "000000"} → ${file.newOid ?? "000000"}` : "",
    file.binary ? "二进制" : "",
    file.similarity !== null ? `相似度 ${file.similarity}%` : "",
  ].filter(Boolean);
  return <div data-testid="changed-file-row" className="relative border-b border-line last:border-b-0">
    {onOpenFile ? <button type="button" aria-label={`在文件页打开 ${primary}`}
      title={file.newPath ? "在文件页打开这个文件（目录树版本里的内容）" : "这个提交删除了它：在文件页打开它的历史，并选中这次修改"}
      onClick={onOpenFile} data-testid="open-in-files"
      className="absolute top-2 right-[88px] z-[1] flex size-7 items-center justify-center rounded-[7px] text-fg3 hover:bg-hover hover:text-fg"><FileText className="size-3.5" strokeWidth={1.75} /></button> : null}
    <button type="button" aria-expanded={expanded} data-testid="changed-file-toggle" disabled={disabled} onClick={onToggle}
      className={cn("flex w-full min-w-0 items-start gap-3 px-3 py-2.5 text-left hover:bg-bg/70 disabled:cursor-default disabled:hover:bg-transparent", onOpenFile && "pr-[130px]")}>
      <Badge size="sm">{status}</Badge>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="break-all font-mono text-[12.5px] text-fg" title={[file.oldPath?.rawHex, file.newPath?.rawHex].filter(Boolean).join(" → ")}>{primary}{file.oldPath?.textLossy || file.newPath?.textLossy ? " · 路径含有非 UTF-8 字节" : ""}</span>
        {file.status === "renamed" || file.status === "copied" ? <span className="break-all text-xs text-fg3">{oldPath} → {newPath}</span> : null}
        {notes.length ? <span className="break-all text-xs text-fg3">{notes.join(" · ")}</span> : null}
      </span>
      <span className="shrink-0 font-mono text-xs tabular-nums"><span className="text-add">{file.additions === null ? "—" : `+${file.additions}`}</span> <span className="text-del">{file.deletions === null ? "—" : `−${file.deletions}`}</span></span>
      <span className="shrink-0 text-xs text-fg3">{expanded ? "收起 diff" : "查看 diff"}</span>
    </button>
    {expanded && diff ? <DiffPanel file={file} state={diff} fullFileLimited={fullFileLimited} onRetry={onRetry} /> : null}
  </div>;
}

function DiffPanel({ file, state, fullFileLimited, onRetry }: { file: ChangedFilesPage["files"][number]; state: CommitDetailView["diff"]; fullFileLimited: boolean; onRetry(): void }): React.JSX.Element {
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
    {diff.kind === "text" && diff.patch ? <DiffView patch={diff.patch} fullFileLimited={fullFileLimited} path={(file.newPath ?? file.oldPath)?.display ?? null} /> : null}
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

const CONTAINING_SHOWN = 8;

/** Main lines first, then other local branches, then remote ones, so folding never hides main or origin/main. */
function containingRank(ref: BranchesContainingResult["branches"][number]): number {
  const name = shortRefName(ref.name);
  const mainLine = /^(main|master)$/u.test(name.replace(/^[^/]+\//u, "")) || /\/HEAD$/u.test(name);
  if (ref.kind === "localBranch") return /^(main|master)$/u.test(name) ? 0 : 1;
  if (ref.kind === "remoteBranch") return mainLine ? 2 : 3;
  return 4;
}

/** Branches containing the commit: local ones first, folded after the first few so a busy remote does not fill the page. */
function ContainingBranches({ result }: { result: BranchesContainingResult }): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  React.useEffect(() => setExpanded(false), [result]);
  const branches = React.useMemo(() => [...result.branches].sort((a, b) => containingRank(a) - containingRank(b)), [result.branches]);
  const hidden = branches.length - CONTAINING_SHOWN;
  const shown = expanded || hidden <= 0 ? branches : branches.slice(0, CONTAINING_SHOWN);
  return <div data-testid="branches-containing-result" className="flex min-w-0 flex-wrap items-baseline gap-1.5 text-xs text-fg2">
    {branches.length ? shown.map(ref => <Badge key={`${ref.kind}:${ref.name}`} title={ref.name}
      className="h-auto min-h-[22px] max-w-full whitespace-normal break-all py-1 leading-tight">{shortRefName(ref.name)}</Badge>)
      : <span>{result.complete ? "没有已确认包含它的分支" : "当前没有已确认的分支；结果不完整"}</span>}
    {hidden > 0 ? <button type="button" data-testid="branches-containing-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
      className="inline-flex h-[22px] items-center gap-1 rounded-full px-2 text-xs font-medium text-accent-fg hover:bg-accent-soft">
      {expanded ? <>收起<ChevronUp className="size-3" strokeWidth={1.75} /></> : <>还有 {hidden} 个分支<ChevronDown className="size-3" strokeWidth={1.75} /></>}
    </button> : null}
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

function parentLabel(parentIndex: number | null): string {
  return parentIndex === null ? "空树" : `父提交 ${parentIndex + 1}`;
}

/** Avatar, name, email and time on one line. */
function IdentityLine({ identity }: { identity: CommitIdentity }): React.JSX.Element {
  return <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 align-middle">
    <IdentityAvatar identity={identity} size="xs" />
    <span className="font-medium">{identity.name}</span>
    <span className="text-[12.5px] text-fg3">{identity.email}</span>
    <span className="text-[12.5px] text-fg2 tabular-nums" title={identityTimeTitle(identity)}>{identityTime(identity)}</span>
  </span>;
}

/** A parent: short OID (full in the tooltip) and its title, which selects it when loaded. */
function ParentLine({ oid, order, total, loaded, onSelect }: {
  oid: string;
  order: number;
  total: number;
  loaded: CommitSummary | undefined;
  onSelect(oid: string): void;
}): React.JSX.Element {
  return <span className="flex min-w-0 items-baseline gap-2">
    {total > 1 ? <span className="shrink-0 text-xs text-fg3">父 {order + 1}</span> : null}
    <span className="shrink-0 font-mono text-[12.5px] text-fg2" title={oid}>{shortOid(oid)}</span>
    {loaded
      ? <button type="button" className="min-w-0 truncate text-left text-accent hover:underline" onClick={() => onSelect(oid)}>{loaded.summary}</button>
      : <span className="text-xs text-fg3">不在已加载的提交中</span>}
  </span>;
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
