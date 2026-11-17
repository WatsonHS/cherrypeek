import * as React from "react";
import { LoaderCircle } from "lucide-react";
import { shortOid, shortRefName } from "../lib/format.js";
import { Button } from "./ui/button.js";

export interface FastForwardMergeTarget {
  sourceRef: string;
  sourceOid: string;
  targetRef: string;
  targetOid: string;
  targetIsHead: boolean;
  isBare: boolean;
}

/** Confirms fast-forwarding `targetRef` onto `sourceRef` without modifying commit history or merging conflicts. */
export function FastForwardMergeDialog({
  target,
  busy,
  onConfirm,
  onClose,
}: {
  target: FastForwardMergeTarget | null;
  busy: boolean;
  onConfirm(target: FastForwardMergeTarget, switchToTarget: boolean): Promise<boolean>;
  onClose(): void;
}): React.JSX.Element | null {
  const [switchToTarget, setSwitchToTarget] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const key = target ? `${target.sourceRef}:${target.sourceOid}->${target.targetRef}:${target.targetOid}` : "";

  React.useEffect(() => {
    if (!target) return;
    setSwitchToTarget(false);
    setSubmitting(false);
  }, [target, key]);

  React.useEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [target, submitting, onClose]);

  if (!target) return null;
  const sourceName = shortRefName(target.sourceRef);
  const targetName = shortRefName(target.targetRef);
  const canSwitch = !target.targetIsHead && !target.isBare;

  const submit = async () => {
    if (busy || submitting) return;
    setSubmitting(true);
    try {
      const ok = await onConfirm(target, canSwitch && switchToTarget);
      if (ok) onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" data-testid="ff-merge-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="ff-merge-title"
        data-testid="ff-merge-dialog"
        className="flex w-full max-w-[460px] flex-col gap-3.5 rounded-xl border border-line bg-panel p-5 shadow-xl"
      >
        <h2 id="ff-merge-title" className="m-0 text-[17px] font-semibold">
          快进合入 {targetName}
        </h2>
        <dl className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg bg-bg px-3 py-2.5 text-xs">
          <dt className="text-fg3">来源分支</dt>
          <dd className="m-0 flex min-w-0 items-baseline gap-2">
            <span className="truncate font-medium text-fg">{sourceName}</span>
            <code className="shrink-0 font-mono text-fg3">{shortOid(target.sourceOid)}</code>
          </dd>
          <dt className="text-fg3">目标分支</dt>
          <dd className="m-0 flex min-w-0 items-baseline gap-2">
            <span className="truncate font-medium text-fg">{targetName}</span>
            <code className="shrink-0 font-mono text-fg3">{shortOid(target.targetOid)}</code>
          </dd>
        </dl>
        <p className="m-0 text-[13px] leading-5 text-fg2">
          仅当 {targetName} 可以直接快进到 {sourceName}、且不覆盖工作区未提交改动时执行；否则拒绝并保持仓库原样，不产生 merge 提交。
        </p>
        {canSwitch ? (
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fg select-none">
            <input
              type="checkbox"
              data-testid="ff-merge-switch-checkbox"
              checked={switchToTarget}
              disabled={busy || submitting}
              onChange={event => setSwitchToTarget(event.target.checked)}
              className="size-3.5 rounded border-line2 accent-[var(--accent)]"
            />
            <span>合并后切换到 {targetName}</span>
          </label>
        ) : null}
        <footer className="mt-1 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" data-testid="ff-merge-cancel" disabled={submitting} onClick={onClose}>
            取消
          </Button>
          <Button size="sm" data-testid="ff-merge-submit" disabled={busy || submitting} onClick={() => { void submit(); }}>
            {submitting ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" strokeWidth={1.75} aria-hidden="true" /> : null}
            确认快进合入
          </Button>
        </footer>
      </section>
    </div>
  );
}
