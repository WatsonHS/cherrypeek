import * as React from "react";
import { ListFilter, Search, X } from "lucide-react";
import type { SearchIdentity, SearchTimeField } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { SearchQuery } from "../../../../../packages/protocol/src/generated/client-message.js";
import type { SearchIdentityState, SearchView } from "../lib/metadata-search-store.js";
import { inputDateRange, localDateInput, presetDateRange } from "../lib/search-date.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

export function SearchControls({ view, sessionKey, onQueryChange, onComposition, onLoadIdentities }: {
  view: SearchView;
  sessionKey: string;
  onQueryChange(query: SearchQuery, composing?: boolean): void;
  onComposition(composing: boolean): void;
  onLoadIdentities(field: SearchTimeField, text: string): void;
}): React.JSX.Element {
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [authorVisible, setAuthorVisible] = React.useState(view.query.authors.length > 0);
  const [committerVisible, setCommitterVisible] = React.useState(view.query.committers.length > 0);
  const [hashVisible, setHashVisible] = React.useState(Boolean(view.query.oidPrefix));
  const [timeVisible, setTimeVisible] = React.useState(view.query.fromTimestamp !== null || view.query.toTimestamp !== null || view.query.timeField === "author");
  const [condition, setCondition] = React.useState("");
  const [composing, setComposing] = React.useState(false);
  const composingRef = React.useRef(false);
  const query = view.query;
  const update = (patch: Partial<SearchQuery>) => onQueryChange({ ...query, ...patch });
  const removeTime = () => update({ fromTimestamp: null, toTimestamp: null, timeField: "committer" });
  const clear = () => {
    setAuthorVisible(false); setCommitterVisible(false); setHashVisible(false); setTimeVisible(false);
    onQueryChange({ ...query, message: "", authors: [], committers: [], oidPrefix: "", fromTimestamp: null, toTimestamp: null, timeField: "committer" });
  };
  return <div className="flex min-w-[200px] flex-[0_1_320px] items-center gap-1.5">
    <label className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-lg bg-sunken px-2.5 text-fg3" title="搜索完整提交消息、身份、OID 和日期">
      <Search className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <span className="sr-only">搜索提交消息</span>
      <input data-testid="search-input" aria-label="搜索提交消息" value={query.message} placeholder="搜索提交消息"
        onChange={event => onQueryChange({ ...query, message: event.currentTarget.value }, composingRef.current)}
        onCompositionStart={() => { composingRef.current = true; setComposing(true); onComposition(true); }} onCompositionEnd={event => {
          composingRef.current = false;
          setComposing(false);
          onQueryChange({ ...query, message: event.currentTarget.value });
          onComposition(false);
        }} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg3" />
      {query.message || view.active ? <button type="button" data-testid="search-clear" aria-label="清空搜索并返回历史" title="清空搜索并返回历史"
        onClick={clear} className="flex size-5 shrink-0 items-center justify-center rounded text-fg3 hover:bg-hover"><X className="size-3.5" /></button> : null}
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
          }} className="h-7 rounded-md border border-line bg-bg px-2 text-xs text-fg">
            <option value="">选择条件…</option><option value="author">Author</option><option value="committer">Committer</option>
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
        {view.active ? <Button variant="ghost" size="sm" className="self-start" onClick={() => { clear(); setFilterOpen(false); }}>清空条件并返回历史</Button> : null}
      </PopoverContent>
    </Popover>
  </div>;
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
