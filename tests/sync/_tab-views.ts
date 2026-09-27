// tests/sync/_tab-views.ts — one origin's localStorage as its tabs see it.
//
// Each tab reads its own cache, which holds its own writes at once and the
// other tabs' only on `deliver` — the way tabs (separate processes) see each
// other's writes a moment late. `deliver` also fires, in order, the `storage`
// events of the writes the tab missed (other tabs' only, as a browser does),
// with the store's value before each write as `oldValue`. A `kill`ed tab gets
// nothing more: a closed tab, a reload, a navigation.
import { createLocalStorageOpStorage } from "../../src/sync/browser-storage.ts";
import type { OpBufferStorage } from "../../src/sync/op-buffer.ts";

type Ev = { key: string; oldValue: string | null; newValue: string | null };

export function tabViews() {
  const store = new Map<string, string>();
  const caches: Map<string, string>[] = [];
  const heard: ((e: Ev) => void)[][] = [];
  const log: (Ev & { by: number })[] = [];
  const cursor: number[] = [];
  const dead = new Set<number>();
  let cur = 0;
  const put = (k: string, v: string | null) => {
    log.push({ key: k, oldValue: store.get(k) ?? null, newValue: v, by: cur });
    if (v === null) {
      caches[cur]!.delete(k);
      store.delete(k);
    } else {
      caches[cur]!.set(k, v);
      store.set(k, v);
    }
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => caches[cur]!.get(k) ?? null,
      setItem: (k: string, v: string) => put(k, String(v)),
      removeItem: (k: string) => put(k, null),
      key: (i: number) => [...caches[cur]!.keys()][i] ?? null,
      get length() {
        return caches[cur]!.size;
      },
    },
  });
  const as = <T>(i: number, fn: () => T): T => {
    const prev = cur;
    cur = i;
    try {
      return fn();
    } finally {
      cur = prev;
    }
  };
  /** Bring tab `i`'s cache up to date and fire the events it missed — or,
   *  `quiet`, only the cache (the events still to come). */
  const deliver = (i: number, quiet = false): void => {
    if (dead.has(i)) return;
    as(i, () => {
      caches[i] = new Map(store);
      if (quiet) return;
      // A listener's own write lands in the log too: read to its end.
      for (; cursor[i]! < log.length; cursor[i]!++) {
        const { by, ...e } = log[cursor[i]!]!;
        if (by !== i) { for (const f of heard[i]!) f(e); }
      }
    });
  };
  return {
    deliver,
    kill: (i: number) => void dead.add(i),
    /** A new tab's queue storage, as that tab sees localStorage. A `fresh`
     *  tab is delivered to before every storage call: one shared store. */
    open(prefix: string, fresh = false): { idx: number; s: OpBufferStorage } {
      const idx = caches.push(new Map(store)) - 1;
      heard.push([]);
      cursor.push(log.length);
      const g = globalThis as { addEventListener: unknown };
      const real = g.addEventListener;
      g.addEventListener = (type: string, f: (e: Ev) => void) =>
        type === "storage" && heard[idx]!.push(f);
      let s: OpBufferStorage;
      try {
        s = as(idx, () => createLocalStorageOpStorage(prefix));
      } finally {
        g.addEventListener = real;
      }
      const call = <T>(fn: () => T): T => {
        if (fresh) deliver(idx);
        return as(idx, fn);
      };
      return {
        idx,
        s: Object.fromEntries(
          Object.entries(s).map(([k, f]) => [
            k,
            (...a: unknown[]) =>
              call(() => (f as (...a: unknown[]) => unknown)(...a)),
          ]),
        ) as unknown as OpBufferStorage,
      };
    },
  };
}
