import * as React from "react";
import type { HandoffFacts } from "../../../../../packages/protocol/src/generated/server-message.js";
import { Button } from "./ui/button.js";
import {
  buildHandoffPrompt,
  handoffScenarios,
  handoffTargetKey,
  type HandoffPromptFacts,
  type HandoffScenario,
  type HandoffTarget,
} from "../lib/handoff-prompt.js";

export type { HandoffTarget } from "../lib/handoff-prompt.js";

export interface HandoffDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  target: HandoffTarget | null;
  sessionKey: string | null;
  onLoadFacts(target: HandoffTarget | null, intent: number): Promise<HandoffFacts | null>;
  onCancelFacts(): Promise<void>;
  onCopyText(text: string): Promise<void>;
}

export function HandoffDialog({ open, onOpenChange, target, sessionKey, onLoadFacts, onCancelFacts, onCopyText }: HandoffDialogProps): React.JSX.Element | null {
  const targetKey = handoffTargetKey(target);
  const intentRef = React.useRef(0);
  const composingRef = React.useRef(false);
  const loadRef = React.useRef(onLoadFacts);
  const cancelRef = React.useRef(onCancelFacts);
  const copyRef = React.useRef(onCopyText);
  loadRef.current = onLoadFacts;
  cancelRef.current = onCancelFacts;
  copyRef.current = onCopyText;

  const [facts, setFacts] = React.useState<HandoffPromptFacts | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [scenario, setScenario] = React.useState<HandoffScenario>(defaultScenario(target));
  const [customRequest, setCustomRequest] = React.useState("");
  const [editedText, setEditedText] = React.useState<string | null>(null);
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "failed">("idle");
  const [composing, setComposing] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    const intent = ++intentRef.current;
    let current = true;
    setFacts(null);
    setLoadError(null);
    setLoading(true);
    setEditedText(null);
    setCopyState("idle");
    void loadRef.current(target, intent).then(
      nextFacts => {
        if (current && intentRef.current === intent) setFacts(nextFacts);
      },
      error => {
        if (current && intentRef.current === intent) setLoadError(error instanceof Error ? error.message : String(error));
      },
    ).finally(() => {
      if (current && intentRef.current === intent) setLoading(false);
    });
    return () => {
      current = false;
      intentRef.current += 1;
      void cancelRef.current().catch(() => undefined);
    };
  }, [open, targetKey, sessionKey]);

  React.useEffect(() => {
    if (!open) return;
    setScenario(defaultScenario(target));
    setCustomRequest("");
    setEditedText(null);
    setCopyState("idle");
  }, [open, targetKey]);

  React.useEffect(() => {
    if (!facts) return;
    const selected = handoffScenarios(facts, target).find(option => option.id === scenario);
    if (selected?.disabled) setScenario("custom");
  }, [facts, targetKey, scenario]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && !composingRef.current) {
        event.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const built = React.useMemo(() => {
    if (!facts && scenario !== "custom") return null;
    try {
      return buildHandoffPrompt(facts, scenario, customRequest);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [facts, scenario, customRequest]);
  React.useEffect(() => { setEditedText(null); setCopyState("idle"); }, [built]);

  if (!open) return null;
  const options = handoffScenarios(facts, target);
  const generatedText = built && "text" in built ? built.text : "";
  const preview = editedText ?? generatedText;
  const tooLong = new TextEncoder().encode(preview).byteLength > 64 * 1024;
  const composingNow = composing || composingRef.current;
  const emptyCustom = scenario === "custom" && !customRequest.trim() && editedText === null;
  const copyDisabled = loading || composingNow || tooLong || emptyCustom || !preview || Boolean(built && "error" in built);

  const beginComposition = () => { composingRef.current = true; setComposing(true); setCopyState("idle"); };
  const endComposition = () => { composingRef.current = false; setComposing(false); };
  const handleCopy = async () => {
    if (copyDisabled || composingRef.current) return;
    try {
      await copyRef.current(preview);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" data-testid="handoff-backdrop">
    <section role="dialog" aria-modal="true" aria-labelledby="handoff-title" data-testid="handoff-dialog"
      className="flex max-h-[min(88vh,900px)] w-full max-w-[760px] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-xl">
      <header className="flex items-start gap-4 border-b border-line px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 id="handoff-title" className="m-0 text-base font-semibold">交给 Agent</h2>
          <p className="m-0 mt-1 text-xs text-fg3">预览并复制 prompt。CommitScope 只读取事实和写入剪贴板，不执行 Agent 或 Git 操作。</p>
        </div>
        <Button variant="ghost" size="sm" aria-label="关闭交给 Agent" data-testid="handoff-close" onClick={() => onOpenChange(false)}>关闭</Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Prompt 模板">
          {options.map(option => <Button key={option.id} data-testid={`handoff-scenario-${option.id}`} variant={scenario === option.id ? "soft" : "outline"}
            disabled={option.disabled || loading} aria-pressed={scenario === option.id} title={option.note}
            onClick={() => { setScenario(option.id); setCopyState("idle"); }}>
            {option.title}
          </Button>)}
        </div>

        {loading ? <p role="status" data-testid="handoff-loading" className="m-0 text-sm text-fg3">正在读取当前快照事实…</p> : null}
        {loadError ? <p role="alert" data-testid="handoff-error" className="m-0 rounded-lg border border-bad-line bg-bad-bg p-3 text-sm text-bad">事实读取失败：{loadError}。仍可使用自定义模板。</p> : null}
        {built && "error" in built ? <p role="alert" data-testid="handoff-prompt-error" className="m-0 rounded-lg border border-bad-line bg-bad-bg p-3 text-sm text-bad">{built.error}</p> : null}
        {tooLong ? <p role="alert" data-testid="handoff-limit-error" className="m-0 text-sm text-bad">编辑后的 prompt 超过 64 KiB，不能复制。</p> : null}

        {scenario === "custom" ? <label className="flex flex-col gap-1.5 text-xs text-fg3">
          你希望 Agent 做什么
          <textarea data-testid="handoff-custom-request" value={customRequest} onChange={event => { setCustomRequest(event.target.value); setCopyState("idle"); }}
            onCompositionStart={beginComposition} onCompositionEnd={endComposition}
            className="h-20 resize-y rounded-lg border border-line2 bg-bg p-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
        </label> : null}

        <label htmlFor="handoff-preview" className="text-xs text-fg3">可编辑预览{built && "shortened" in built && built.shortened ? " · 可选摘要已缩短" : ""}</label>
        <textarea id="handoff-preview" data-testid="handoff-preview" aria-label="Prompt 预览" value={preview}
          onChange={event => { setEditedText(event.target.value); setCopyState("idle"); }}
          onCompositionStart={beginComposition} onCompositionEnd={endComposition}
          className="min-h-[220px] flex-1 resize-y rounded-lg border border-line2 bg-bg p-3 font-mono text-xs leading-relaxed text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
      </div>

      <footer className="flex items-center gap-3 border-t border-line px-5 py-3">
        <span role="status" aria-live="polite" data-testid="handoff-copy-status" className="mr-auto text-xs text-fg3">
          {copyState === "copied" ? "已复制。粘贴给你的 Agent。" : copyState === "failed" ? "复制失败，请重试。" : "完整操作标识保留在参考数据中。"}
        </span>
        <Button data-testid="handoff-copy" disabled={copyDisabled} onClick={() => { void handleCopy(); }}>复制 prompt</Button>
      </footer>
    </section>
  </div>;
}

function defaultScenario(target: HandoffTarget | null): HandoffScenario {
  if (target?.kind === "worktree" && target.stale) return "stale-worktree";
  if (target?.kind === "branch") return "sync";
  if (target?.kind === "commit") return "review";
  return "custom";
}
