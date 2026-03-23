// listeners.ts — shared listener registry used by browser.ts and standalone.ts

/** A subscribe/notify listener set. Single source of truth for the pattern. */
export class Listeners<T> {
  private fns = new Set<(value: T) => void>();

  /** Number of active listeners */
  get size(): number {
    return this.fns.size;
  }

  /** Subscribe — returns unsubscribe function */
  add(fn: (value: T) => void): () => void {
    this.fns.add(fn);
    return () => {
      this.fns.delete(fn);
    };
  }

  /** Notify all listeners with a value */
  notify(value: T): void {
    for (const fn of this.fns) fn(value);
  }

  /** Remove all listeners */
  clear(): void {
    this.fns.clear();
  }
}
