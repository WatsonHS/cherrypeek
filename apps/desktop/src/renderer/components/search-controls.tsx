import * as React from "react";
import { ListFilter, Search, X } from "lucide-react";
import type { SearchIdentity, SearchPathEntry, SearchTimeField } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { SearchPathFilter, SearchQuery } from "../../../../../packages/protocol/src/generated/client-message.js";
import type { SearchIdentityState, SearchView } from "../lib/metadata-search-store.js";
import { inputDateRange, localDateInput, presetDateRange } from "../lib/search-date.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

/** The scope written inside the search box, so one box can mean different searches on different pages. */
export function SearchScopeChip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span aria-hidden="true" data-testid="search-scope" className="search-scope inline-flex h-[22px] max-w-[132px] shrink-0 items-center truncate rounded-[5px] bg-panel px-[7px] text-xs whitespace-nowrap text-fg2 shadow-[inset_0_0_0_1px_var(--line)]">
    <span className="truncate">{children}</span>
  </span>;
}

function SearchKeyHint(): React.JSX.Element {
  return <span aria-hidden="true" className="search-key-hint shrink-0 text-[11.5px] text-fg3">{/Mac|iPhone|iPad/u.test(navigator.platform) ? "⌘F" : "Ctrl+F"}</span>;
}

/** The search box of the files and workspace pages: same look, a page-specific scope and behaviour. */
export function PageSearchBox({ scope, label, placeholder, value, onChange, title, trailing, onKeyDown }: {
  scope: string;
  label: string;
  placeholder: string;
  value: string;
  onChange(value: string): void;
  title?: string;
  /** Replaces the shortcut hint, e.g. a "1 / 8" match counter. */
  trailing?: React.ReactNode;
  onKeyDown?(event: React.KeyboardEvent<HTMLInputElement>): void;
}): React.JSX.Element {
  return <div className="topbar-search-controls flex min-w-0 flex-[0_1_300px] items-center">
    <label className="flex h-[34px] min-w-0 flex-1 items-center gap-[7px] rounded-lg bg-sunken pr-2 pl-2.5 text-fg3" title={title ?? `${label}（⌘F）`}>
      <Search className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <SearchScopeChip>{scope}</SearchScopeChip>
      <span className="sr-only">{label}</span>
      <input data-testid="page-search-input" aria-label={label} value={value} placeholder={placeholder}
        onChange={event => onChange(event.currentTarget.value)} onKeyDown={onKeyDown}
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg3" />
      {trailing ?? (value ? null : <SearchKeyHint />)}
      {value ? <button type="button" aria-label="清空" onClick={() => onChange("")}
        className="flex size-5 shrink-0 items-center justify-center rounded text-fg3 hover:bg-hover"><X className="size-3.5" /></button> : null}
    </label>
  </div>;
}

export function SearchControls({ view, sessionKey, onQueryChange, onComposition, onLoadIdentities, onLoadPaths }: {
  view: SearchView;
  sessionKey: string;
  onQueryChange(query: SearchQuery, composing?: boolean): void;
  onComposition(composing: boolean): void;
  onLoadIdentities(field: SearchTimeField, text: string): void;
  onLoadPaths(text: string): void;
}): React.JSX.Element {
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [authorVisible, setAuthorVisible] = React.useState(view.query.authors.length > 0);
  const [committerVisible, setCommitterVisible] = React.useState(view.query.committers.length > 0);
  const [hashVisible, setHashVisible] = React.useState(Boolean(view.query.oidPrefix));
  const [timeVisible, setTimeVisible] = React.useState(view.query.fromTimestamp !== null || view.query.toTimestamp !== null || view.query.timeField === "author");
  const [pathVisible, setPathVisible] = React.useState(view.query.path !== null);
  const [condition, setCondition] = React.useState("");
  const [composing, setComposing] = React.useState(false);
  const composingRef = React.useRef(false);
  const query = view.query;
  const update = (patch: Partial<SearchQuery>) => onQueryChange({ ...query, ...patch });
  const removeTime = () => update({ fromTimestamp: null, toTimestamp: null, timeField: "committer" });
  const clear = () => {
    setAuthorVisible(false); setCommitterVisible(false); setHashVisible(false); setTimeVisible(false); setPathVisible(false);
    onQueryChange({ ...query, message: "", authors: [], committers: [], oidPrefix: "", fromTimestamp: null, toTimestamp: null, timeField: "committer", path: null });
  };
  return <div className="topbar-search-controls flex min-w-0 flex-[0_1_300px] items-center gap-1">
    <label className="flex h-[34px] min-w-0 flex-1 items-center gap-[7px] rounded-lg bg-sunken pr-2 pl-2.5 text-fg3" title="搜索完整提交消息；作者、OID、日期和路径在右侧筛选里（⌘F）">
      <Search className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <SearchScopeChip>提交消息</SearchScopeChip>
      <span className="sr-only">搜索提交消息</span>
      <input data-testid="search-input" aria-label="搜索提交消息" value={query.message} placeholder="搜索"
        onChange={event => onQueryChange({ ...query, message: event.currentTarget.value }, composingRef.current)}
        onCompositionStart={() => { composingRef.current = true; setComposing(true); onComposition(true); }} onCompositionEnd={event => {
          composingRef.current = false;
          setComposing(false);
          onQueryChange({ ...query, message: event.currentTarget.value });
          onComposition(false);
        }} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg3" />
      {query.message || view.active ? <button type="button" data-testid="search-clear" aria-label="清空搜索并返回历史" title="清空搜索并返回历史"
        onClick={clear} className="flex size-5 shrink-0 items-center justify-center rounded text-fg3 hover:bg-hover"><X className="size-3.5" /></button>
        : <SearchKeyHint />}
    </label>
    <Popover open={filterOpen} onOpenChange={setFilterOpen}>
      <PopoverTrigger asChild><Button variant={filterOpen ? "soft" : "ghost"} size="icon" aria-label="筛选搜索条件"
        data-testid="search-filter-trigger" aria-expanded={filterOpen}><ListFilter className="size-4" strokeWidth={1.75} /></Button></PopoverTrigger>
      <PopoverContent align="end" className="flex max-h-(--radix-popover-content-available-height) w-[380px] flex-col gap-3 overflow-auto p-3" data-testid="search-filter-popover">
        <div className="flex items-center justify-between"><span className="text-[13px] font-semibold">搜索条件</span>
          <label className="flex items-center gap-1.5 text-xs text-fg2"><input type="checkbox" checked={query.caseSensitive}
            onChange={event => update({ caseSensitive: event.currentTarget.checked })} />区分消息大小写</label></div>
        <label className="flex items-center gap-2 text-xs text-fg2"><span>添加筛选条件</span>
          <select data-testid="search-add-condition" aria-label="添加筛选条件" value={condition} onChange={event => {
            const value = event.currentTarget.value;
            setCondition("");
            if (value === "author") setAuthorVisible(true);
            else if (value === "committer") setCommitterVisible(true);
            else if (value === "hash") setHashVisible(true);
            else if (value === "time") setTimeVisible(true);
            else if (value === "author-time") { setTimeVisible(true); update({ timeField: "author" }); }
            else if (value === "path") setPathVisible(true);
          }} className="h-7 rounded-md border border-line bg-bg px-2 text-xs text-fg">
            <option value="">选择条件…</option><option value="author">Author</option><option value="committer">Committer</option>
            <option value="path">路径</option>
            <option value="hash">OID 前缀</option><option value="time">日期范围</option><option value="author-time">按 Author 时间</option>
          </select>
        </label>
        {authorVisible || query.authors.length ? <div className="relative"><IdentityPicker field="author" sessionKey={sessionKey} selected={query.authors} state={view.authorIdentities} onSearch={onLoadIdentities}
          onToggle={identity => update({ authors: toggleIdentity(query.authors, identity) })} />
          <RemoveCondition onClick={() => { setAuthorVisible(false); update({ authors: [] }); }} /></div> : null}
        {committerVisible || query.committers.length ? <div className="relative"><IdentityPicker field="committer" sessionKey={sessionKey} selected={query.committers} state={view.committerIdentities} onSearch={onLoadIdentities}
          onToggle={identity => update({ committers: toggleIdentity(query.committers, identity) })} />
          <RemoveCondition onClick={() => { setCommitterVisible(false); update({ committers: [] }); }} /></div> : null}
        {hashVisible || query.oidPrefix ? <div className="relative"><label className="flex flex-col gap-1 text-xs text-fg2"><span>OID 前缀</span>
          <input data-testid="search-filter-hash" aria-label="OID 前缀" value={query.oidPrefix}
            onChange={event => update({ oidPrefix: event.currentTarget.value })} placeholder="至少 4 位十六进制"
            className="h-8 rounded-md border border-line bg-bg px-2 font-mono text-xs text-fg outline-none focus:border-accent" />
        </label><RemoveCondition onClick={() => { setHashVisible(false); update({ oidPrefix: "" }); }} /></div> : null}
        {timeVisible || query.fromTimestamp !== null || query.toTimestamp !== null || query.timeField === "author"
          ? <div className="relative"><DateFilter query={query} onChange={update} onRemove={() => { setTimeVisible(false); removeTime(); }} /><RemoveCondition onClick={() => { setTimeVisible(false); removeTime(); }} /></div> : null}
        {pathVisible || query.path !== null ? <div className="relative"><PathFilter query={query} suggestions={view.pathSuggestions} sessionKey={sessionKey}
          onLoad={onLoadPaths} onApply={path => update({ path })} onRemove={() => { setPathVisible(false); update({ path: null }); }} /></div> : null}
        {view.active ? <Button variant="ghost" size="sm" className="self-start" onClick={() => { clear(); setFilterOpen(false); }}>清空条件并返回历史</Button> : null}
      </PopoverContent>
    </Popover>
  </div>;
}

function PathFilter({ query, suggestions, sessionKey, onLoad, onApply, onRemove }: {
  query: SearchQuery;
  suggestions: SearchView["pathSuggestions"];
  sessionKey: string;
  onLoad(text: string): void;
  onApply(path: SearchPathFilter): void;
  onRemove(): void;
}): React.JSX.Element {
  const [text, setText] = React.useState(() => pathFilterText(query.path));
  const [kind, setKind] = React.useState<SearchPathFilter["kind"]>(() => query.path?.kind ?? "file");
  const [includeDescendants, setIncludeDescendants] = React.useState(() => query.path?.includeDescendants ?? true);
  const [selectedRawHex, setSelectedRawHex] = React.useState<string | null>(() => query.path?.rawHex ?? null);
  const [error, setError] = React.useState<string | null>(null);
  const [composing, setComposing] = React.useState(false);

  React.useEffect(() => {
    setText(pathFilterText(query.path));
    setKind(query.path?.kind ?? "file");
    setIncludeDescendants(query.path?.includeDescendants ?? true);
    setSelectedRawHex(query.path?.rawHex ?? null);
  }, [query.path?.rawHex, query.path?.kind, query.path?.includeDescendants]);
  React.useEffect(() => {
    if (!text || selectedRawHex !== null || composing) return;
    const timer = setTimeout(() => onLoad(text), 200);
    return () => clearTimeout(timer);
  }, [text, selectedRawHex, composing, sessionKey, onLoad]);

  const apply = (rawHex?: string) => {
    const path = rawHex === undefined ? encodePath(text, kind, includeDescendants) : { rawHex, kind, includeDescendants };
    if (typeof path === "string") { setError(path); return; }
    setError(null);
    onApply(path);
  };
  const choose = (entry: SearchPathEntry) => {
    setText(entry.kind === "directory" && entry.path.rawHex === "" ? "." : entry.path.display);
    setKind(entry.kind);
    setSelectedRawHex(entry.path.rawHex);
    setError(null);
    onApply({ rawHex: entry.path.rawHex, kind: entry.kind, includeDescendants: entry.kind === "directory" && includeDescendants });
  };
  const entries = suggestions.text === text ? suggestions.entries : [];
  return <section className="flex flex-col gap-1.5" data-testid="search-filter-path">
    <div className="flex items-start justify-between gap-2"><div className="flex flex-col gap-0.5"><span className="text-xs text-fg2">路径 · 字面匹配，不跨重命名追溯</span>
      <span className="text-[10.5px] text-fg3">当前快照路径；已删除路径可手动输入</span></div>
      {query.path ? <button type="button" className="shrink-0 text-[11px] text-fg3 hover:text-fg" onClick={onRemove}>移除路径</button> : null}</div>
    <input data-testid="search-path-input" aria-label="仓库相对路径" value={text} onChange={event => { setText(event.currentTarget.value); setSelectedRawHex(null); setError(null); }}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={event => {
        setComposing(false); setText(event.currentTarget.value); setSelectedRawHex(null);
      }}
      placeholder="仓库相对路径" className="h-8 rounded-md border border-line bg-bg px-2 text-xs text-fg outline-none focus:border-accent" />
    <div className="flex items-center gap-2 text-xs text-fg2">
      <select aria-label="路径类型" data-testid="search-path-kind" value={kind} onChange={event => { setKind(event.currentTarget.value as SearchPathFilter["kind"]); }}
        className="h-7 rounded-md border border-line bg-bg px-1.5 text-xs text-fg"><option value="file">文件</option><option value="directory">目录</option></select>
      {kind === "directory" ? <label className="flex items-center gap-1.5"><input type="checkbox" checked={includeDescendants} onChange={event => setIncludeDescendants(event.currentTarget.checked)} />包含子目录</label> : null}
      <Button data-testid="search-path-apply" variant="outline" size="sm" className="ml-auto h-7 px-2 text-[11px]" onClick={() => apply(selectedRawHex ?? undefined)}>应用路径</Button>
    </div>
    {suggestions.loading ? <span role="status" className="text-[11px] text-fg3">读取当前快照路径…</span> : null}
    {suggestions.error ? <span role="alert" className="text-[11px] text-bad">路径建议失败：{suggestions.error}</span> : null}
    {suggestions.truncated ? <span className="text-[11px] text-fg3">建议项已截断，可继续输入缩小范围。</span> : null}
    {entries.length ? <div role="listbox" aria-label="路径建议" className="flex max-h-28 flex-col overflow-auto rounded-md border border-line">
      {entries.map((entry, index) => <button key={`${entry.path.rawHex}:${entry.kind}`} type="button" role="option" aria-selected="false"
        data-testid={`search-path-suggestion-${index}`} onClick={() => choose(entry)} title={entry.path.display}
        className="flex min-h-8 items-center gap-2 px-2 text-left text-xs hover:bg-hover">
        <span className="min-w-0 flex-1 truncate">{entry.path.display || "."}</span><span className="shrink-0 text-fg3">{entry.kind === "directory" ? "目录" : "文件"}</span>
      </button>)}
    </div> : text && !suggestions.loading && !suggestions.error ? <span className="text-[11px] text-fg3">没有当前快照建议；仍可手动应用已删除路径。</span> : null}
    {error ? <span role="alert" data-testid="search-path-error" className="text-[11px] text-bad">{error}</span> : null}
    {query.path ? <span className="text-[10.5px] text-fg3">当前条件：{decodePathHex(query.path.rawHex) || "."} · {query.path.kind === "directory" ? query.path.includeDescendants ? "包含子目录" : "仅直接文件" : "精确文件"}</span> : null}
  </section>;
}

function encodePath(text: string, kind: SearchPathFilter["kind"], includeDescendants: boolean): SearchPathFilter | string {
  if (text.includes("\0")) return "路径不能包含 NUL 字符。";
  if (text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text)) return "请输入仓库相对路径，不能使用绝对路径。";
  if (kind === "directory" && text === ".") return { rawHex: "", kind, includeDescendants };
  const value = kind === "directory" && text.endsWith("/") ? text.slice(0, -1) : text;
  if (!value) return kind === "file" ? "文件路径不能为空。" : "目录路径不能为空；根目录请使用 .。";
  if (value.split("/").some(segment => segment === "." || segment === "..")) return "路径不能包含 . 或 .. 点段。";
  const rawHex = Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, "0")).join("");
  return { rawHex, kind, includeDescendants: kind === "directory" && includeDescendants };
}

function decodePathHex(rawHex: string): string {
  const bytes = new Uint8Array(rawHex.match(/.{2}/g)?.map(byte => Number.parseInt(byte, 16)) ?? []);
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

function pathFilterText(path: SearchPathFilter | null): string {
  return path ? path.kind === "directory" && path.rawHex === "" ? "." : decodePathHex(path.rawHex) : "";
}

function IdentityPicker({ field, sessionKey, selected, state, onSearch, onToggle }: {
  field: SearchTimeField;
  sessionKey: string;
  selected: SearchIdentity[];
  state: SearchIdentityState;
  onSearch(field: SearchTimeField, text: string): void;
  onToggle(identity: SearchIdentity): void;
}): React.JSX.Element {
  const [text, setText] = React.useState("");
  const [composing, setComposing] = React.useState(false);
  const composingRef = React.useRef(false);
  const stableText = text.trim();
  React.useEffect(() => {
    if (!stableText || composing) return;
    const timer = setTimeout(() => onSearch(field, stableText), 220);
    return () => clearTimeout(timer);
  }, [field, sessionKey, stableText, composing, onSearch]);
  const title = field === "author" ? "Author" : "Committer";
  const choices = state.values.filter(identity => !selected.some(value => identityKey(value) === identityKey(identity)));
  return <section className="flex flex-col gap-1.5" data-testid={`search-filter-${field}`}>
    <label className="flex flex-col gap-1 text-xs text-fg2"><span>{title}（原始身份）</span>
      <input value={text} onChange={event => setText(event.currentTarget.value)} onCompositionStart={() => { composingRef.current = true; setComposing(true); }} onCompositionEnd={event => { composingRef.current = false; setComposing(false); setText(event.currentTarget.value); }} placeholder={`搜索${title}姓名或邮箱`}
        aria-label={`搜索${title}姓名或邮箱`} className="h-8 rounded-md border border-line bg-bg px-2 text-xs text-fg outline-none focus:border-accent" />
    </label>
    {selected.length ? <div className="flex flex-wrap gap-1">{selected.map(identity => <button key={identityKey(identity)} type="button"
      className="max-w-full truncate rounded-md bg-accent/10 px-1.5 py-1 text-[11px] text-accent-fg" title={`${identity.name} <${identity.email}>`}
      onClick={() => onToggle(identity)}>{identity.name || identity.email} ×</button>)}</div> : null}
    {state.loading ? <span role="status" className="text-[11px] text-fg3">读取身份建议…</span> : null}
    {state.error ? <span role="status" className="text-[11px] text-bad">身份建议失败：{state.error}</span> : null}
    {state.truncated || (state.coverage && !state.coverage.complete) ? <span className="text-[11px] text-fg3">身份建议可能不完整；可继续输入缩小范围。</span> : null}
    {choices.length ? <div className="flex max-h-28 flex-col overflow-auto rounded-md border border-line" role="listbox" aria-label={`${title}建议`}>
      {choices.map((identity, index) => <button key={identityKey(identity)} type="button" role="option" aria-selected="false"
        data-testid={`search-identity-${field}-${index}`} onClick={() => onToggle(identity)}
        className="flex min-h-8 items-center gap-2 px-2 text-left text-xs hover:bg-hover">
        <span className="min-w-0 flex-1 truncate">{identity.name || "（空姓名）"}</span><span className="max-w-[46%] truncate text-fg3">{identity.email}</span>
      </button>)}
    </div> : text.trim() && !state.loading && !state.error ? <span className="text-[11px] text-fg3">{state.values.length ? "建议项均已选中" : "没有匹配身份建议"}</span> : null}
  </section>;
}

function DateFilter({ query, onChange, onRemove }: {
  query: SearchQuery;
  onChange(patch: Partial<SearchQuery>): void;
  onRemove(): void;
}): React.JSX.Element {
  const inputFor = (seconds: number | null) => seconds === null ? "" : localDateInput(new Date(seconds * 1_000));
  const [from, setFrom] = React.useState(() => inputFor(query.fromTimestamp));
  const [to, setTo] = React.useState(() => inputFor(query.toTimestamp === null ? null : query.toTimestamp - 1));
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setFrom(inputFor(query.fromTimestamp));
    setTo(inputFor(query.toTimestamp === null ? null : query.toTimestamp - 1));
  }, [query.fromTimestamp, query.toTimestamp]);
  const active = query.fromTimestamp !== null || query.toTimestamp !== null;
  const timezone = query.timeZone;
  const applyDates = () => {
    const range = inputDateRange(from, to);
    if (!range) { setError("请选择有效的起止日期，且开始日期不能晚于结束日期。"); return; }
    setError(null);
    onChange({ ...range, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
  };
  const preset = (which: "today" | "7days" | "30days") => {
    const now = new Date();
    const range = presetDateRange(which, now);
    setFrom(localDateInput(which === "today" ? now : new Date(range.fromTimestamp! * 1_000)));
    setTo(localDateInput(now));
    setError(null);
    onChange({ ...range, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
  };
  return <section className="flex flex-col gap-1.5" data-testid="search-filter-time">
    <div className="flex items-center justify-between"><span className="text-xs text-fg2">日期范围</span>
      {active ? <button type="button" className="text-[11px] text-fg3 hover:text-fg" onClick={onRemove}>移除日期</button> : null}</div>
    <div className="flex gap-1.5">{(["today", "7days", "30days"] as const).map((value, index) => <Button key={value} variant="outline" size="sm" className="h-7 px-2 text-[11px]"
      onClick={() => preset(value)}>{["今天", "近 7 天", "近 30 天"][index]}</Button>)}</div>
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
      <input type="date" aria-label="开始日期" value={from} onChange={event => setFrom(event.currentTarget.value)}
        className="h-8 min-w-0 rounded-md border border-line bg-bg px-1.5 text-xs text-fg" />
      <span className="text-xs text-fg3">至</span>
      <input type="date" aria-label="结束日期（含当天）" value={to} onChange={event => setTo(event.currentTarget.value)}
        className="h-8 min-w-0 rounded-md border border-line bg-bg px-1.5 text-xs text-fg" />
    </div>
    <Button variant="outline" size="sm" className="h-7 self-start px-2 text-[11px]" onClick={applyDates}>应用日期范围</Button>
    {error ? <span role="alert" className="text-[11px] text-bad">{error}</span> : null}
    {active ? <span className="text-[10.5px] text-fg3">本地日历区间 · {timezone}</span> : null}
    <label className="flex items-center gap-2 text-xs text-fg2"><span className="min-w-0 flex-1">按哪个身份时间排序和筛选</span>
      <select value={query.timeField} onChange={event => onChange({ timeField: event.currentTarget.value as SearchTimeField })}
        className="h-7 rounded-md border border-line bg-bg px-1.5 text-xs text-fg"><option value="committer">Committer</option><option value="author">Author</option></select>
    </label>
  </section>;
}

function RemoveCondition({ onClick }: { onClick(): void }): React.JSX.Element {
  return <button type="button" className="absolute right-0 top-0 flex size-5 items-center justify-center rounded text-fg3 hover:bg-hover"
    aria-label="移除此筛选条件" title="移除此筛选条件" onClick={onClick}><X className="size-3" /></button>;
}

function toggleIdentity(values: SearchIdentity[], item: SearchIdentity): SearchIdentity[] {
  return values.some(value => identityKey(value) === identityKey(item))
    ? values.filter(value => identityKey(value) !== identityKey(item)) : [...values, item];
}

function identityKey(value: SearchIdentity): string { return `${value.name}\u0000${value.email}`; }
