// listeners.ts — shared listener registry used by browser.ts and standalone.ts

import { log } from "../diagnostics/logger-api.ts";

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

  /** Notify all listeners with a value.
   *
   *  Each listener is ISOLATED. They belong to different subscribers that know
   *  nothing about each other, and an unguarded loop meant the FIRST one to
   *  throw silently cancelled every listener after it — for that notification
   *  and every later one, since the throw propagates out of `notify` into
   *  whatever raised the event.
   *
   *  Four registries share this class and the damage is the same shape in all
   *  of them: `_rListeners` (router-core) is every `useRoute()` in the app, so
   *  one component's route handler throwing left the rest of the app on the
   *  old route — half the screen navigated, half did not, with one console
   *  line that named neither half. `protocol-subscription`'s is every state
   *  subscriber.
   *
   *  Reported the way the render pipeline reports a user callback that threw:
   *  loudly, and the notification still reaches everyone else. */
  notify(value: T): void {
    for (const fn of Array.from(this.fns)) {
      try {
        fn(value);
      } catch (e) {
        log.error(
          "listeners",
          `a subscriber threw while being notified (the others were still ` +
            `notified): ${e instanceof Error ? e.stack ?? e.message : e}`,
        );
      }
    }
  }

  /** Remove all listeners */
  clear(): void {
    this.fns.clear();
  }
}
