/*
 * How diffs are shown: one setting shared by every diff (commit details, file history,
 * workspace) and kept for the next launch. Stored per viewer in localStorage; reading or
 * writing it may fail (private profile, cleared storage), so defaults always work.
 */

export type DiffLayout = "unified" | "split";
export type DiffScope = "changes" | "full";

export interface DiffDisplay {
  layout: DiffLayout;
  scope: DiffScope;
  wrap: boolean;
}

export const DEFAULT_DIFF_DISPLAY: DiffDisplay = { layout: "unified", scope: "changes", wrap: false };
const STORAGE_KEY = "commitscope.diffDisplay.v1";

function readStored(storage: Pick<Storage, "getItem"> | null): DiffDisplay {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DIFF_DISPLAY;
    const value = JSON.parse(raw) as Partial<DiffDisplay>;
    return {
      layout: value.layout === "split" ? "split" : "unified",
      scope: value.scope === "full" ? "full" : "changes",
      wrap: value.wrap === true,
    };
  } catch {
    return DEFAULT_DIFF_DISPLAY;
  }
}

function browserStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

export class DiffDisplayStore {
  private value: DiffDisplay;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = browserStorage()) {
    this.value = readStored(storage);
  }

  getView = (): DiffDisplay => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  update(patch: Partial<DiffDisplay>): void {
    const next = { ...this.value, ...patch };
    if (next.layout === this.value.layout && next.scope === this.value.scope && next.wrap === this.value.wrap) return;
    this.value = next;
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* keep the in-memory choice */ }
    for (const listener of this.listeners) listener();
  }

  toggleLayout(): void { this.update({ layout: this.value.layout === "split" ? "unified" : "split" }); }
  toggleScope(): void { this.update({ scope: this.value.scope === "full" ? "changes" : "full" }); }
  toggleWrap(): void { this.update({ wrap: !this.value.wrap }); }
}

export const diffDisplay = new DiffDisplayStore();
