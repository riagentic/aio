// use-resource.ts — a keyed thing that is OPEN, and a reaction to state that
// does not live in a JSX handler.
//
// Two reports, one shape (report 7 §2/§5/§8.4/§8.5, report 4 §10.4).
//
// `resource()` already covers "fetch when this changes". What it does not cover
// is a resource you HOLD: a camera, a socket, a GPU pipeline, a file handle —
// something with an open and a close, where the close matters and the key
// decides which one you have. The reporting app hand-rolled it, and every one
// of its lifecycle bugs came out of that code: two pipelines fighting over one
// camera on a remount, a hand-written `alive(s)` guard at ~twenty call sites
// each of which is a bug if forgotten, and a stale open installed over a newer
// one.
//
// And the rule that decides WHEN to reopen — "when the camera id changes,
// reopen the camera" — could only live in a JSX handler, so
// `am dispatch settings:patch` changed the state and the camera stayed open.
// Logically correct and genuinely surprising, which is the definition of a
// missing primitive.

import {
  _effectCollectEnd,
  _effectCollectStart,
  batch,
  effect,
  signal,
  untrack,
} from "../state/signal.ts";
import { _inRender, _onUnmount, useRef } from "./renderer-lifecycle.ts";
import type { Signal } from "../state/signal.ts";

/** Stop reacting / release the resource. Safe to call more than once. */
export type Dispose = () => void;

// ── onChange ────────────────────────────────────────────────────────────────

/** How {@linkcode onChange} decides that something changed, and whether it
 *  runs before anything has. */
export type OnChangeOptions<T> = {
  /** Run `fn` once with the current value before waiting for a change.
   *  Default `false` — "when it CHANGES" is what the name says. */
  readonly immediate?: boolean;
  /** How two values are compared. Default `Object.is`. */
  readonly equals?: (a: T, b: T) => boolean;
};

/**
 * Run `fn` whenever `selector()` produces a different value.
 *
 * The difference from a bare `effect`, and why the bare one is easy to get
 * wrong:
 *
 *  - ONLY THE SELECTOR IS TRACKED. `fn` runs untracked, so a reaction that
 *    reads other state while doing its work does not accidentally subscribe to
 *    it and re-run itself forever. That is the loop people hit first.
 *  - IT WAITS FOR A CHANGE. An `effect` runs immediately, so "when the camera
 *    id changes, reopen the camera" written as one opens a camera on boot that
 *    nobody asked for. Pass `immediate: true` when you do want that.
 *  - `fn` MAY RETURN A CLEANUP, run before the next change and on dispose.
 *    "Close the old camera, open the new one" is then one function with the
 *    close attached to the open that made it, instead of two rules that have
 *    to agree.
 *
 * Returns a disposer. It is not tied to a component, on purpose: the rule
 * outlives any particular render, and living in a JSX handler is exactly the
 * problem this exists to fix.
 */
export function onChange<T>(
  selector: () => T,
  // A UNION OF TWO SIGNATURES, not `=> void | Dispose`. TypeScript's rule that
  // a `void` return accepts any value applies per SIGNATURE and not through a
  // union, so the single-type spelling rejects
  // `onChange(sel, (v) => seen.push(v))` — `push` returns a number — which is
  // the most natural thing anyone writes. The union keeps the cleanup form
  // precisely typed AND lets an ordinary statement body through.
  fn:
    | ((value: T, previous: T | undefined) => Dispose)
    | ((value: T, previous: T | undefined) => void),
  opts: OnChangeOptions<T> = {},
): Dispose {
  const same = opts.equals ?? Object.is;
  let first = true;
  let prev: T | undefined;
  let cleanup: Dispose | undefined;

  const stop = effect(() => {
    const next = selector();
    untrack(() => {
      const isFirst = first;
      first = false;
      if (!isFirst && same(next, prev as T)) return;
      if (isFirst && !opts.immediate) {
        prev = next;
        return;
      }
      // The PREVIOUS run's cleanup, before the next one starts. A close that
      // ran after the new open is the "two pipelines fighting over one camera"
      // bug, in miniature.
      cleanup?.();
      cleanup = undefined;
      const out = fn(next, isFirst ? undefined : prev);
      prev = next;
      if (typeof out === "function") cleanup = out;
    });
  });

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    stop();
    cleanup?.();
    cleanup = undefined;
  };
}

// ── useResource ─────────────────────────────────────────────────────────────

/** A key that identifies one resource. `null`/`undefined` means "none right
 *  now" — the resource closes and nothing opens. */
export type ResourceKey = string | number | null | undefined;

/** What {@linkcode useResource} needs: which one (`key`), how to acquire it
 *  (`open`), how to let it go (`close`), and who it is shared with (`scope`). */
export type UseResourceConfig<T> = {
  /** The key, read reactively. When it changes, the old resource closes and
   *  the new one opens. */
  key: () => ResourceKey;
  /** Acquire it. `signal` aborts when the key changes again or the holder
   *  disposes, so a slow open can stop rather than land late. */
  open: (key: string | number, opts: { signal: AbortSignal }) => T | Promise<T>;
  /** Release it. Called once, when the LAST holder of this key lets go.
   *  Two signatures for the same reason `onChange`'s callback has two — a
   *  `void` return only forgives a non-void value one signature at a time. */
  close?:
    | ((value: T, key: string | number) => Promise<void>)
    | ((value: T, key: string | number) => void);
  /** Holders with the same `scope` and key SHARE one open. Default `""`.
   *  Use it to keep two unrelated resources that happen to use the same id
   *  (a user id, say) from sharing anything. */
  scope?: string;
};

/** A hold on one keyed resource — what it is, how it is going, and the way to
 *  let go. Returned by {@linkcode useResource}. */
export type ResourceHandle<T> = {
  /** The open resource, or `undefined` while opening / when the key is null. */
  readonly value: T | undefined;
  /** True while an open is in flight. */
  readonly loading: Signal<boolean>;
  /** What the last `open` threw, or `undefined`. */
  readonly error: Signal<unknown>;
  /** The key currently held (`null` when none). */
  readonly key: Signal<string | number | null>;
  /** Let go. The resource closes when the last holder does. */
  dispose: Dispose;
};

/** One shared open, and everyone holding it. */
type Entry<T> = {
  refs: number;
  value: T | undefined;
  error: unknown;
  loading: boolean;
  abort: AbortController;
  /** Bumped on every open of this slot, so a slow one that lands after a
   *  newer one can tell and stand down. */
  generation: number;
  /** Holders to notify when this entry changes. */
  readonly watchers: Set<(e: Entry<T>) => void>;
  closing?: Promise<void>;
};

// deno-lint-ignore no-explicit-any
const _open = new Map<string, Entry<any>>();

/** @internal Test seam: how many shared resources are open right now. Zero is
 *  the healthy answer once every holder has disposed. */
// aio-ok: a test-only seam; nothing in src/ inspects its own resource table
export function _openResourceCount(): number {
  return _open.size;
}

/**
 * Hold a keyed resource — something with an open and a close, where the close
 * matters.
 *
 * ```ts
 * const cam = useResource({
 *   key: () => settings.cameraId,
 *   open: (id, { signal }) => openCamera(id, signal),
 *   close: (stream) => stream.getTracks().forEach((t) => t.stop()),
 * });
 * ```
 *
 * Three things it guarantees, each of which was a bug in the hand-rolled
 * version:
 *
 *  - ONE OPEN PER KEY. Holders with the same key share it and it is
 *    reference-counted, so three components mounting the same resource open it
 *    once and close it when the last one lets go — not three opens, and not a
 *    close while somebody is still using it.
 *  - A STALE OPEN CANNOT WIN. Every open carries a generation; one that
 *    resolves after the key has moved on closes what it made and does not
 *    install it. That is "a stale open installed over a newer one", refused by
 *    construction rather than by a guard at twenty call sites.
 *  - THE CLOSE IS ATTACHED TO THE OPEN. Changing the key closes the old
 *    resource before opening the new one, so two pipelines never fight over
 *    one device.
 *  @tier Kit */
export function useResource<T>(cfg: UseResourceConfig<T>): ResourceHandle<T> {
  // A `use*` HOOK, which it was named like and did not behave like.
  //
  // It registered no cleanup and was not idempotent across renders, so it had
  // two failure modes and no correct way to call it. Left alone, the resource
  // outlived the component FOREVER — measured, three renders and an unmount
  // left `opens 1 closes 0` and `_openResourceCount()` stuck at 1, against
  // that counter's own doc: "Zero is the healthy answer once every holder has
  // disposed." Wired to `onCleanup(dispose)` the way the docs show, a body
  // cleanup fires before EVERY re-render, so three renders opened and closed
  // the camera three times — "two pipelines fighting over one device", which
  // is the exact thing this module says it exists to refuse.
  //
  // One handle per component INSTANCE (`useRef`), disposed at unmount and only
  // at unmount (the unmount-only cleanup list, not the per-render one).
  // Outside a render it behaves exactly as before: the caller
  // owns it and calls `dispose()`.
  if (_inRender()) {
    const slot = useRef<
      { handle: ResourceHandle<T>; cfg: UseResourceConfig<T> } | null
    >(null);
    if (slot.current === null) {
      // The LATEST config is read through the ref, so a later render's `key`
      // closure (one that captured a prop, say) is the one that runs — while
      // the resource itself, and the `effect` watching the key, are created
      // exactly once.
      const box = { handle: null as unknown as ResourceHandle<T>, cfg };
      // OUT OF THE RENDER'S EFFECT COLLECTOR. The renderer disposes every
      // `effect()` a render created at the NEXT re-render — right for a
      // per-render effect, fatal for this one, which is created once and must
      // live until unmount. Collected, the key reaction died on the first
      // re-render for any reason (the opened value landing, say), and a key
      // read only inside `key()` never re-keyed again: opened ["a"], closed
      // [], the page stuck on the old camera. A private collector catches the
      // dispose instead; the handle's own unmount cleanup below owns it.
      const detached = _effectCollectStart();
      try {
        box.handle = _createResource<T>(() => box.cfg);
      } finally {
        _effectCollectEnd(detached);
      }
      slot.current = box;
      // Released when the component goes away — and ALSO when this render
      // never commits. It was `onMount(() => onCleanup(dispose))`, and a
      // render that throws (the component itself, or a child an
      // `<ErrorBoundary>` above catches) never runs its onMount: the resource
      // stayed open for good, measured `opened ["cam"] closed []` after the
      // boundary recovered and the panel unmounted.
      _onUnmount(() => box.handle.dispose());
    } else {
      slot.current.cfg = cfg;
    }
    return slot.current.handle;
  }
  return _createResource<T>(() => cfg);
}

function _createResource<T>(
  getCfg: () => UseResourceConfig<T>,
): ResourceHandle<T> {
  const cfg = getCfg();
  const scope = cfg.scope ?? "";
  const value = signal<T | undefined>(undefined);
  const loading = signal(false);
  const error = signal<unknown>(undefined);
  const keySig = signal<string | number | null>(null);

  let held: string | null = null; // the slot id this holder is counted in
  let onEntry: ((e: Entry<T>) => void) | null = null;

  const publish = (e: Entry<T>) => {
    batch(() => {
      value.set(e.value);
      loading.set(e.loading);
      error.set(e.error);
    });
  };

  const release = () => {
    if (held === null) return;
    const slot = held;
    held = null;
    const e = _open.get(slot) as Entry<T> | undefined;
    if (!e) return;
    if (onEntry) e.watchers.delete(onEntry);
    e.refs--;
    if (e.refs > 0) return;
    // The LAST holder closes it. Aborting first stops an open that has not
    // landed; `close` then runs only for a value that exists.
    e.abort.abort();
    _open.delete(slot);
    const cfgClose = getCfg().close;
    if (e.value !== undefined && cfgClose) {
      const [, rawKey] = splitSlot(slot);
      try {
        const out = cfgClose(e.value, rawKey);
        if (out && typeof (out as Promise<void>).then === "function") {
          e.closing = (out as Promise<void>).catch(() => {
            // aio-ok: an async `close` that rejects has still released this
            // holder — the slot is already gone from the table. Rethrowing
            // would surface as an unhandled rejection during teardown, from a
            // promise nobody is positioned to await.
          });
        }
      } catch {
        // aio-ok: a close that throws must not stop the holder from letting
        // go — the alternative is a slot nobody can ever release, which is the
        // leak this whole module exists to prevent.
      }
    }
  };

  const acquire = (raw: string | number) => {
    const slot = `${scope}\x00${typeof raw}\x00${raw}`;
    held = slot;
    let e = _open.get(slot) as Entry<T> | undefined;
    if (!e) {
      e = {
        refs: 0,
        value: undefined,
        error: undefined,
        loading: true,
        abort: new AbortController(),
        generation: 1,
        watchers: new Set(),
      };
      _open.set(slot, e);
      const entry = e;
      const gen = e.generation;
      void (async () => {
        try {
          const v = await getCfg().open(raw, { signal: entry.abort.signal });
          // Landed late? The slot has moved on (or gone), so this value is
          // nobody's — close it rather than leaking it, and do not install it.
          if (_open.get(slot) !== entry || entry.generation !== gen) {
            const close = getCfg().close;
            if (close) await close(v, raw);
            return;
          }
          entry.value = v;
          entry.loading = false;
          entry.error = undefined;
        } catch (err) {
          if (_open.get(slot) !== entry || entry.generation !== gen) return;
          entry.error = err;
          entry.loading = false;
        }
        for (const w of entry.watchers) w(entry);
      })();
    }
    e.refs++;
    onEntry = publish;
    e.watchers.add(onEntry);
    publish(e);
  };

  // The rule itself, as a reaction rather than a handler — see `onChange`.
  const stop = onChange(() => getCfg().key(), (next) => {
    release();
    if (next === null || next === undefined) {
      keySig.set(null);
      batch(() => {
        value.set(undefined);
        loading.set(false);
        error.set(undefined);
      });
      return;
    }
    keySig.set(next);
    acquire(next);
  }, { immediate: true });

  let disposed = false;
  return {
    get value() {
      return value.value;
    },
    loading,
    error,
    key: keySig,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stop();
      release();
    },
  };
}

/** `scope\0type\0key` → [scope, key], with the number/string distinction the
 *  slot id preserved. `1` and `"1"` are different keys and must not share an
 *  open. */
function splitSlot(slot: string): [string, string | number] {
  const parts = slot.split("\x00");
  const raw = parts.slice(2).join("\x00");
  return [parts[0] ?? "", parts[1] === "number" ? Number(raw) : raw];
}
