import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CommitSummary } from "../../../../packages/protocol/src/generated/server-message.js";
import type { CoreStatus } from "../../../../packages/protocol/src/core-status.js";
import { emptyRepositoryPreview, type RepositoryPreviewState } from "../../../../packages/protocol/src/repository-preview.js";
import "./styles.css";

function App(): React.JSX.Element {
  const [status, setStatus] = useState<CoreStatus>({ state: "starting", revision: -1 });
  const [preview, setPreview] = useState<RepositoryPreviewState>(emptyRepositoryPreview(-1));
  const [path, setPath] = useState("");
  const [selectedOid, setSelectedOid] = useState<string>();
  const [statusReadError, setStatusReadError] = useState<string>();
  const [previewReadError, setPreviewReadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const composing = useRef(false);
  const pathEdited = useRef(false);
  const coreRevision = useRef(-1);
  const previewRevision = useRef(-1);

  useEffect(() => {
    let active = true;
    const acceptCore = (next: CoreStatus) => {
      if (!active || next.revision <= coreRevision.current) return;
      coreRevision.current = next.revision;
      setStatusReadError(undefined);
      setStatus(next);
    };
    const acceptPreview = (next: RepositoryPreviewState) => {
      if (!active || next.revision <= previewRevision.current) return;
      previewRevision.current = next.revision;
      setPreviewReadError(undefined);
      setPreview(next);
      if (next.repository && !pathEdited.current) setPath(next.repository.path);
      setSelectedOid(current => next.commits.some(commit => commit.oid === current) ? current : next.commits[0]?.oid);
    };
    const unsubscribeCore = window.commitScope.onCoreStatusChanged(acceptCore);
    const unsubscribePreview = window.commitScope.onRepositoryPreviewChanged(acceptPreview);
    void window.commitScope.getCoreStatus().then(acceptCore).catch(error => {
      if (active) setStatusReadError(String(error));
    });
    void window.commitScope.getRepositoryPreview().then(acceptPreview).catch(error => {
      if (active) setPreviewReadError(String(error));
    });
    return () => { active = false; unsubscribeCore(); unsubscribePreview(); };
  }, []);

  const selected = preview.commits.find(commit => commit.oid === selectedOid);
  const open = async () => {
    setActionError(undefined);
    try { await window.commitScope.openRepositoryPreview(path); }
    catch (error) { setActionError(String(error)); }
  };
  const choose = async () => {
    setActionError(undefined);
    try {
      const chosen = await window.commitScope.chooseRepository();
      if (chosen) {
        pathEdited.current = true;
        setPath(chosen);
        await window.commitScope.openRepositoryPreview(chosen);
      }
    } catch (error) { setActionError(String(error)); }
  };
  const cancel = async () => {
    setActionError(undefined);
    try { await window.commitScope.cancelRepositoryPreview(); }
    catch (error) { setActionError(String(error)); }
  };

  return <main>
    <header>
      <div><h1>CommitScope</h1><p>只读浏览本地 Git 历史</p></div>
      <div className="core-status" data-state={status.state}>
        <span className="status-dot" />
        <span>{status.state === "ready" ? "核心已就绪" : status.state === "starting" ? "核心启动中" : status.state === "error" ? "核心不可用" : "核心已停止"}</span>
        {status.state === "ready" ? <code>{status.core.coreVersion} · PID {status.core.pid}</code> : null}
      </div>
    </header>

    <section className="repository-open" aria-label="打开仓库">
      <label htmlFor="repository-path">仓库目录</label>
      <input id="repository-path" value={path} onChange={event => { pathEdited.current = true; setPath(event.target.value); }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.key === "Enter" && !composing.current && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void open();
          }
        }} placeholder="输入绝对路径，例如 /Users/me/project" />
      <button onClick={() => { void choose(); }}>选择目录</button>
      <button onClick={() => { void open(); }}>打开</button>
      {preview.state === "loading" ? <button className="quiet" onClick={() => { void cancel(); }}>取消</button> : null}
    </section>

    <div className="preview-heading">
      <div><h2 title={preview.repository?.path}>{preview.repository ? repositoryName(preview.repository.path) : "提交历史"}</h2>
        {preview.repository ? <p>{preview.repository.headReference ?? (preview.repository.headOid ? "Detached HEAD" : "尚无 HEAD")} · {preview.refs.length} 个引用{preview.repository.isBare ? " · 裸仓库" : ""}{preview.repository.isShallow ? " · 浅克隆" : ""}{preview.repository.worktreePath ? ` · 工作树 ${preview.repository.worktreePath}` : ""}</p> : <p>选择或输入本地仓库目录</p>}
      </div>
      <div className="preview-state" data-testid="preview-state" data-state={preview.state} aria-live="polite">{previewLabel(preview)}</div>
    </div>
    {status.state === "error" ? <p className="error-message" role="alert">{status.message}</p> : null}
    {preview.error ? <p className="error-message" role="alert"><strong>{preview.error.code}</strong> · {preview.error.message}</p> : null}
    {previewReadError ? <p role="alert" className="error-message">预览状态读取失败：{previewReadError}</p> : null}
    {actionError ? <p role="alert" className="error-message">操作失败：{actionError}</p> : null}

    {preview.repository ? <section className="refs" aria-label="仓库引用">
      <h3>引用</h3>
      {preview.refs.length ? <ul>{preview.refs.map(ref => <li key={`${ref.kind}:${ref.name}`}><span>{ref.name}</span><code>{ref.oid}</code></li>)}</ul> : <p className="muted">没有引用</p>}
      {preview.refsTruncated ? <p className="muted">引用数量达到显示上限，列表不完整。</p> : null}
    </section> : null}

    <div className="content-grid">
      <section className="commit-list" aria-label="提交列表">
        <h3>提交{preview.commits.length ? ` · ${preview.commits.length}` : ""}</h3>
        {preview.state === "ready" && preview.commits.length === 0 ? <p className="empty">当前 HEAD 尚无提交。</p> : null}
        <div className="table-scroll"><table>
          <thead><tr><th>提交</th><th>作者</th><th>提交时间（本地）</th></tr></thead>
          <tbody>{preview.commits.map(commit => <CommitRow key={commit.oid} commit={commit} selected={commit.oid === selectedOid} onSelect={() => setSelectedOid(commit.oid)} />)}</tbody>
        </table></div>
      </section>

      <section className="commit-detail" aria-label="提交详情">
        <h3>提交详情</h3>
        {selected ? <CommitDetail commit={selected} /> : <p className="muted">选择一条提交查看详情。</p>}
      </section>
    </div>
    {statusReadError ? <p role="alert" className="error-message">核心状态读取失败：{statusReadError}</p> : null}
  </main>;
}

function CommitRow({ commit, selected, onSelect }: { commit: CommitSummary; selected: boolean; onSelect: () => void }): React.JSX.Element {
  return <tr data-testid="commit-row" data-oid={commit.oid} aria-selected={selected} onClick={onSelect} onKeyDown={event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); }
  }} tabIndex={0}>
    <td><span className="summary">{commit.summary}</span><code title={commit.oid}>{commit.oid.slice(0, 12)}</code></td>
    <td>{commit.author.name}</td>
    <td>{formatLocalTime(commit.committer.timestamp, commit.committer.offset)}</td>
  </tr>;
}

function CommitDetail({ commit }: { commit: CommitSummary }): React.JSX.Element {
  return <div className="details">
    <p className="detail-summary">{commit.summary}</p>
    <Detail label="完整 OID"><code>{commit.oid}</code></Detail>
    <Detail label="父提交">{commit.parents.length ? commit.parents.map((parent, index) => <React.Fragment key={parent}>{index ? ", " : ""}<code>{parent}</code></React.Fragment>) : "无（根提交）"}</Detail>
    <Detail label="作者">{commit.author.name} &lt;{commit.author.email}&gt;<br />{formatIdentityTime(commit.author.timestamp, commit.author.offset)}</Detail>
    <Detail label="提交者">{commit.committer.name} &lt;{commit.committer.email}&gt;<br />{formatIdentityTime(commit.committer.timestamp, commit.committer.offset)}</Detail>
    {commit.summaryTruncated || commit.textLossy ? <p className="muted">{commit.summaryTruncated ? "提交摘要已截断。 " : ""}{commit.textLossy ? "提交文本包含无法按 UTF-8 无损解码的数据。" : ""}</p> : null}
  </div>;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <div className="detail-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

function previewLabel(preview: RepositoryPreviewState): string {
  if (preview.state === "loading") return "正在读取仓库…";
  if (preview.state === "error") return preview.commits.length ? "读取失败 · 结果不完整" : "读取失败";
  if (preview.state === "cancelled") return preview.commits.length ? "已取消 · 结果不完整" : "已取消";
  if (preview.state === "idle") return "未打开仓库";
  if (preview.repository?.headOid === null || preview.commits.length === 0) return "当前 HEAD 尚无提交";
  if (preview.hasMore) return `已显示 ${preview.commits.length} 条，仍有更多`;
  if (preview.refsTruncated) return "首屏已加载 · 引用列表不完整";
  return "首屏已加载";
}

function repositoryName(path: string): string {
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return name || path;
}

function formatLocalTime(timestamp: string, offset: string): string {
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return `${timestamp} ${offset}`;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.valueOf()) ? `${timestamp} ${offset}` : date.toLocaleString();
}

function formatIdentityTime(timestamp: string, offset: string): string {
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return `${timestamp} ${offset}`;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.valueOf()) ? `${timestamp} 原始偏移 ${offset}` : `${date.toLocaleString()} 本地显示 · Git 原始偏移 ${offset}`;
}

createRoot(document.getElementById("root")!).render(<App />);
