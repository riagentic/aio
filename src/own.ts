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

/** Keyed disposer-slot API for cell-owned native resources. */
export interface Own {
  /** Acquire a resource under `id`. Same id ⇒ previous disposer runs first. */
  set(id: string, factory: () => OwnResource): OwnEffect;
  /** Dispose the resource under `id` (no-op when the slot is empty). */
  dispose(id: string): OwnEffect;
}

export const own: Own = {
  set(id: string, factory: () => OwnResource): OwnEffect {
    const token = nextToken++;
    pendingFactories.set(token, factory);
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
    runDisposer(effect.id); // same id ⇒ replace
    try {
      const disposer = toDisposer(factory());
      if (disposer) disposers.set(effect.id, disposer);
      log.debug(`own: acquired '${effect.id}'`);
    } catch (e) {
      log.error(`own: factory '${effect.id}' threw: ${e}`);
    }
  }

  function disposeAll(): void {
    for (const id of [...disposers.keys()]) runDisposer(id);
  }

  /** Dispose all resources whose ID starts with prefix + ":" (e.g. cell name).
   *  Same delimiter rule as schedule.cancelByPrefix (AIO-198). */
  function disposeByPrefix(prefix: string): void {
    const p = prefix + ":";
    for (const id of [...disposers.keys()]) {
      if (id.startsWith(p)) {
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
