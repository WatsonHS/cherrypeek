import * as React from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { checkBranchName } from "../lib/branch-name.js";
import { shortOid } from "../lib/format.js";

/** Where the new branch would start. Titles and names come from the repository and are shown as plain text. */
export type BranchStart =
  | { kind: "commit"; oid: string; summary: string }
  | { kind: "branch"; /** Short name, e.g. `origin/main` or `feature/x`. */ name: string; oid: string };

/**
 * "新建分支". The name is checked live; creating runs through the operations flow (check, then run). A name problem
 * the core reports (`nameExists` / `nameInvalid`) stays here under the input; anything else closes the dialog.
 */
export function CreateBranchDialog({ start, existingBranches, busy, onCreate, onClose }: {
  start: BranchStart | null;
  /** Short names of the local branches in the current navigation snapshot. */
  existingBranches: readonly string[];
  /** Another operation (or this one) is running. */
  busy: boolean;
  onCreate(name: string, startOid: string, switchAfter: boolean): Promise<{ close: boolean; error?: string }>;
  onClose(): void;
}): React.JSX.Element | null {
  const [name, setName] = React.useState("");
  const [switchAfter, setSwitchAfter] = React.useState(true);
  const [touched, setTouched] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const composingRef = React.useRef(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const open = start !== null;
  const startKey = start ? `${start.kind}:${start.kind === "commit" ? start.oid : start.name}` : "";

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setSwitchAfter(true);
    setTouched(false);
    setServerError(null);
    composingRef.current = false;
    inputRef.current?.focus();
  }, [open, startKey]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && !composingRef.current) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!start) return null;
  const check = checkBranchName(name, existingBranches);
  const localError = !check.ok && !check.quiet && (touched || name !== "") ? check.message : null;
  const error = localError ?? serverError;
  const canCreate = check.ok && !busy && !submitting;
  const submit = async () => {
    if (!canCreate) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await onCreate(name, start.oid, switchAfter);
      if (result.error) setServerError(result.error);
      else if (result.close) onClose();
    } finally {
      setSubmitting(false);
    }
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" data-testid="create-branch-backdrop">
    <section role="dialog" aria-modal="true" aria-labelledby="create-branch-title" data-testid="create-branch-dialog"
      className="flex w-full max-w-[460px] flex-col gap-3.5 rounded-xl border border-line bg-panel p-5 shadow-xl">
      <h2 id="create-branch-title" className="m-0 text-[17px] font-semibold">新建分支</h2>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-fg3">起点</span>
        {start.kind === "commit"
          ? <div className="flex items-baseline gap-2 text-[13px]" data-testid="create-branch-start">
            <span className="shrink-0 font-mono text-xs">{shortOid(start.oid)}</span>
            <span className="min-w-0 truncate" title={start.summary}>{start.summary}</span>
          </div>
          : <div className="flex items-baseline gap-2 text-[13px]" data-testid="create-branch-start">
            <span className="min-w-0 truncate font-medium" title={start.name}>{start.name}</span>
            <span className="shrink-0 font-mono text-xs text-fg3">{shortOid(start.oid)}</span>
          </div>}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="create-branch-name" className="text-xs text-fg3">分支名</label>
        <Input id="create-branch-name" ref={inputRef} value={name} autoComplete="off" spellCheck={false} data-testid="create-branch-name"
          aria-invalid={error ? true : undefined} aria-describedby={error ? "create-branch-error" : undefined}
          className={error ? "h-[34px] border-bad focus-visible:border-bad" : "h-[34px]"}
          onChange={event => { setName(event.target.value); setServerError(null); }}
          onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing && !composingRef.current) { event.preventDefault(); void submit(); } }} onBlur={() => setTouched(true)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }} />
        {error ? <span id="create-branch-error" role="alert" data-testid="create-branch-error" className="text-xs text-bad">{error}</span> : null}
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={switchAfter} onChange={event => setSwitchAfter(event.target.checked)} data-testid="create-branch-switch"
          className="size-[15px] accent-accent" />
        创建后切换到这个分支
      </label>
      <p className="m-0 text-xs text-fg3">切换会更新工作区文件；有未提交改动会被覆盖时不执行。</p>
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={submitting} data-testid="create-branch-cancel">取消</Button>
        <Button disabled={!canCreate} onClick={() => { void submit(); }} data-testid="create-branch-confirm" aria-label="新建分支"
          title={busy && !submitting ? "另一个操作正在进行" : undefined}>
          {submitting ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" strokeWidth={1.75} aria-hidden="true" /> : null}新建
        </Button>
      </div>
    </section>
  </div>;
}
