// own.ts — keyed disposer slots for cell-owned native resources (AIO-382)
//
// Cells own OS resources (file watchers, sockets, subprocesses) that outlive
// a single action but must die with the cell — and must be replaced, not
// duplicated, when re-acquired. `own.set(id, factory)` is a pure effect with
// the same replace semantics `schedule.after` has for timers: returning it
// from a reducer or method (sync or async) runs the previous disposer for
// that id, then runs the factory and stores its disposer. All disposers run
// on cell disable and on app shutdown.
//
// Effects must survive structuredClone (dispatch detaches them from Immer
// drafts), so the factory cannot ride inside the effect. `own.set` parks the
// factory in a module-level registry under a one-shot token; the effect
// carries only plain data. On time-travel replay the token is gone — the
// manager logs and no-ops rather than re-acquiring resources.

/** A disposer: tears down the owned resource. May return a Promise (async
 *  errors are logged). Typed `unknown` so `() => arr.push(x)`-style bodies
 *  pass — `void | Promise<void>` would reject any non-void return. */
export type OwnDisposer = () => unknown;

/** What an own-factory may return: a disposer function, a closeable/
 *  disposable object, or nothing (slot stays empty — previous still freed). */
export type OwnResource =
  | void
  | OwnDisposer
  | { close(): void }
  | { dispose(): void };

/** Pure effect — returned from reducers/methods, handled by the runtime. */
export type OwnEffect =
  | { type: "__own"; kind: "set"; id: string; token: number }
  | { type: "__own"; kind: "dispose"; id: string };

// One-shot factory side-channel — consumed by the manager on handle().
const pendingFactories = new Map<number, () => OwnResource>();
let nextToken = 1;

/** Reset pending factories — for test isolation. A factory parked in
 *  `pendingFactories` (because the own.set effect was created but never
 *  dispatched, e.g. a reducer threw before returning the effect) would
 *  otherwise leak for the process lifetime, capturing its closure scope. */
export function _resetPendingFactories(): void {
  pendingFactories.clear();
  _leakWarned = false;
}

/** How many factories are parked, unconsumed — test seam for the leak bound. */
export function _pendingFactoryCount(): number {
  return pendingFactories.size;
}

/** Keyed disposer-slot API for cell-owned native resources. */
export interface Own {
  /** Acquire a resource under `id`. Same id ⇒ previous disposer runs first. */
  set(id: string, factory: () => OwnResource): OwnEffect;
  /** Dispose the resource under `id` (no-op when the slot is empty). */
  dispose(id: string): OwnEffect;
}

/**
 * Keyed disposer slots — own native resources (watchers, sockets) from
 * reducers/methods with schedule-like replace semantics. Acquiring the same
 * id again disposes the previous resource first; all slots are disposed on
 * cell disable and app shutdown.
 */
/** How many parked factories may pile up before the side-channel is treated as
 *  leaking. A dispatch consumes its token in the same tick, so more than a
 *  handful outstanding means effects are being created and never handled. */
const MAX_PENDING = 64;
let _leakWarned = false;

/** Evict the oldest parked factories once the side-channel stops draining.
 *
 *  `own.set()` parks a closure and the manager consumes it when the effect is
 *  handled. When the effect never gets there — a method that threw after
 *  calling `own.set`, a cell disabled between reduce and execute, a dispatch
 *  closed by shutdown — the closure (and everything it captured) was retained
 *  for the life of the process, once per attempt, with nothing to bound it and
 *  nothing to say so. Tokens are monotonic, so Map order IS age order. */
function _evictStaleFactories(): void {
  if (pendingFactories.size <= MAX_PENDING) return;
  const overflow = pendingFactories.size - MAX_PENDING;
  let dropped = 0;
  for (const token of pendingFactories.keys()) {
    if (dropped >= overflow) break;
    pendingFactories.delete(token);
    dropped++;
  }
  if (!_leakWarned) {
    _leakWarned = true;
    console.warn(
      `[aio:own] more than ${MAX_PENDING} own.set() factories were parked and ` +
        `never handled — dropping the oldest ${dropped}. An own.set effect was ` +
        `created but never reached the runtime: a method that threw after ` +
        `calling own.set, a cell disabled before its effects ran, or an effect ` +
        `dropped during shutdown. Each unhandled factory retains its whole ` +
        `closure. (warned once)`,
    );
  }
}

/** Resource ownership for cells: `own.set(id, factory)` acquires a resource
 *  the runtime disposes for you (on replace, on cell stop, on shutdown), so a
 *  method never leaks a handle it opened. */
export const own: Own = {
  set(id: string, factory: () => OwnResource): OwnEffect {
    const token = nextToken++;
    pendingFactories.set(token, factory);
    _evictStaleFactories();
    return { type: "__own", kind: "set", id, token };
  },
  dispose(id: string): OwnEffect {
    return { type: "__own", kind: "dispose", id };
  },
};

/** Type guard — returns true if the value is an OwnEffect (type === "__own"). */
export function isOwnEffect(e: unknown): e is OwnEffect {
  return typeof e === "object" && e !== null &&
    (e as { type?: unknown }).type === "__own";
}

// ── Own manager ─────────────────────────────────────────────────────

type Log = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
};

const VALID_ID = /^[\w\-:.]+$/;

/** Create the runtime manager that handles own effects and final cleanup. */
export function createOwnManager(log: Log): {
  handle: (effect: OwnEffect) => void;
  disposeAll: () => void;
  disposeByPrefix: (prefix: string) => void;
  active: () => string[];
} {
  const disposers = new Map<string, OwnDisposer>();
  const warnedReplace = new Set<string>();
  const isDevEnv = () =>
    (globalThis as Record<string, unknown>).__aioDev === true;

  function validateId(id: string): void {
    if (!id || !VALID_ID.test(id)) {
      throw new Error(
        `invalid own id: ${
          JSON.stringify(id)
        } — use alphanumeric, hyphens, colons, dots`,
      );
    }
  }

  function toDisposer(resource: OwnResource): OwnDisposer | null {
    if (typeof resource === "function") return resource;
    if (resource && typeof resource === "object") {
      if (typeof (resource as { close?: unknown }).close === "function") {
        return () => (resource as { close(): void }).close();
      }
      if (typeof (resource as { dispose?: unknown }).dispose === "function") {
        return () => (resource as { dispose(): void }).dispose();
      }
    }
    return null;
  }

  function runDisposer(id: string): void {
    const dispose = disposers.get(id);
    if (!dispose) return;
    disposers.delete(id);
    try {
      const r = dispose();
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch((e) =>
          log.error(`own: async disposer '${id}' failed: ${e}`)
        );
      }
    } catch (e) {
      log.error(`own: disposer '${id}' threw: ${e}`);
    }
  }

  function handle(effect: OwnEffect): void {
    validateId(effect.id);
    if (effect.kind === "dispose") {
      if (disposers.has(effect.id)) {
        runDisposer(effect.id);
        log.debug(`own: disposed '${effect.id}'`);
      }
      return;
    }
    const factory = pendingFactories.get(effect.token);
    pendingFactories.delete(effect.token);
    if (!factory) {
      // Replay or duplicate delivery — the one-shot factory was already
      // consumed. Never re-acquire (and never kill the live resource).
      log.warn(
        `own: no pending factory for '${effect.id}' — skipped (replay?)`,
      );
      return;
    }
    // Same id ⇒ REPLACE: the resource already under this key is disposed first.
    // That is the design (schedule.after has the same semantics), but it is
    // invisible at the call site, and the disposer runs arbitrary teardown — one
    // field report had `close()` stop a server process, so re-registering the key
    // after a crash SIGTERMed the freshly started server a second later and the
    // app looked like it could not start at all. Nothing warned. In dev we say
    // so, once per key, naming the id.
    if (disposers.has(effect.id) && isDevEnv()) {
      if (!warnedReplace.has(effect.id)) {
        warnedReplace.add(effect.id);
        log.warn(
          `own: '${effect.id}' was already held — disposing the previous ` +
            `resource before acquiring the new one (own.set replaces by key). ` +
            `If that disposer tears down something the new resource needs, use ` +
            `a distinct id per resource. Warns once per id, dev only.`,
        );
      }
    }
    runDisposer(effect.id); // same id ⇒ replace
    try {
      const disposer = toDisposer(factory());
      if (disposer) disposers.set(effect.id, disposer);
      log.debug(`own: acquired '${effect.id}'`);
    } catch (e) {
      log.error(`own: factory '${effect.id}' threw: ${e}`);
    }
  }

  /** Teardown is LIFO — the reverse of acquisition.
   *
   *  A resource acquired later may depend on one acquired earlier (a socket on
   *  the server it belongs to, a watcher on the directory a previous slot
   *  created); the reverse can never be true, because the earlier one did not
   *  exist yet. Disposing in acquisition order therefore tears a dependency
   *  down while its dependent is still live — and it disagreed with the
   *  framework's own rule one level up, where `destroyAll` walks cells in
   *  reverse dependency order. A Map preserves insertion order, so the fix is
   *  to walk it backwards. */
  function disposeAll(): void {
    for (const id of [...disposers.keys()].reverse()) runDisposer(id);
  }

  /** Dispose all resources whose ID is `prefix` or starts with prefix + ":"
   *  (e.g. cell name). Same rule as schedule.cancelByPrefix (AIO-198) —
   *  including the bare-`prefix` case, which was missing here: a cell disable
   *  cancelled the schedule named `mycell` but left the resource named
   *  `mycell` open, so two APIs documented as having the same keyed semantics
   *  disagreed about the most obvious id an app would pick. */
  function disposeByPrefix(prefix: string): void {
    const p = prefix + ":";
    // LIFO, for the same reason as disposeAll.
    for (const id of [...disposers.keys()].reverse()) {
      if (id === prefix || id.startsWith(p)) {
        runDisposer(id);
        log.debug(`own: disposed '${id}' (cell '${prefix}' disabled)`);
      }
    }
  }

  return {
    handle,
    disposeAll,
    disposeByPrefix,
    active: () => [...disposers.keys()],
  };
}
