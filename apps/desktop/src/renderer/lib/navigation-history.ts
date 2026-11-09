/*
 * Back / forward across the app (⌘[ / ⌘], the top-bar arrows, mouse side buttons). A jump records the place it
 * leaves from; going back hands the current place to the forward steps and returns the place to restore.
 * Plain browsing (moving through a list, scrolling) is not a step: only jumps call `record`.
 */

export interface NavigationPlace {
  /** Two places with the same key are the same step. */
  key: string;
  /** What the place is, for "后退到 …" hints. */
  label: string;
}

export interface NavigationView {
  canBack: boolean;
  canForward: boolean;
  backLabel: string | null;
  forwardLabel: string | null;
}

export const NAVIGATION_LIMIT = 50;

export class NavigationHistory<Place extends NavigationPlace> {
  private backSteps: Place[] = [];
  private forwardSteps: Place[] = [];
  private readonly listeners = new Set<() => void>();
  private view: NavigationView = { canBack: false, canForward: false, backLabel: null, forwardLabel: null };

  constructor(private readonly limit = NAVIGATION_LIMIT) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getView = (): NavigationView => this.view;

  /** Before a jump: remember where it leaves from (not twice in a row), and forget the forward steps. */
  record(from: Place): void {
    if (this.backSteps.at(-1)?.key !== from.key) {
      this.backSteps.push(from);
      if (this.backSteps.length > this.limit) this.backSteps.shift();
    }
    this.forwardSteps = [];
    this.emit();
  }

  /** The place to go back to, skipping steps that are where the user already is; `current` becomes forward. */
  back(current: Place): Place | null {
    return this.move(this.backSteps, this.forwardSteps, current);
  }

  forward(current: Place): Place | null {
    return this.move(this.forwardSteps, this.backSteps, current);
  }

  clear(): void {
    this.backSteps = [];
    this.forwardSteps = [];
    this.emit();
  }

  private move(from: Place[], to: Place[], current: Place): Place | null {
    let target = from.pop();
    while (target && target.key === current.key) target = from.pop();
    if (target) {
      to.push(current);
      if (to.length > this.limit) to.shift();
    }
    this.emit();
    return target ?? null;
  }

  private emit(): void {
    this.view = {
      canBack: this.backSteps.length > 0,
      canForward: this.forwardSteps.length > 0,
      backLabel: this.backSteps.at(-1)?.label ?? null,
      forwardLabel: this.forwardSteps.at(-1)?.label ?? null,
    };
    for (const listener of this.listeners) listener();
  }
}
