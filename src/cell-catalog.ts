// cell-catalog.ts — catalog building and cell binding

import type { CellDef, Creators, Msg } from "./cell-types.ts";
import { checkReservedKeys } from "./cell-types.ts";
import { registerCall } from "./cell-impl.ts";
import { log } from "./logger.ts";

/** Wrap a raw action creator with a guard for the pre-binding state.
 *  In dev (__aioDev set): throws with a clear message so the user knows
 *  the cell hasn't been bound to aio.run() yet.
 *  In prod: logs a warning once per (cell, key) and returns Promise.resolve().
 *  The wrapper preserves the .type accessor and is replaced wholesale by
 *  bindCell / bindCellReactive — bound calls pay zero overhead. */
export function makeUnboundGuard(
  cellName: string,
  key: string,
  raw: unknown,
): (...args: unknown[]) => Promise<void> {
  const isDev = (globalThis as Record<string, unknown>).__aioDev === true;
  if (isDev) {
    const guarded = (() => {
      throw new Error(
        `[${cellName}] ${key}() called before aio.run() — add this cell to aio.run({ cells: [...] })`,
      );
    }) as (...args: unknown[]) => Promise<void>;
    attachMeta(guarded, raw);
    return guarded;
  }
  let warned = false;
  const guarded = ((..._args: unknown[]): Promise<void> => {
    if (!warned) {
      warned = true;
      log.warn(
        `[${cellName}] ${key}() called before aio.run() — add this cell to aio.run({ cells: [...] })`,
      );
    }
    return Promise.resolve();
  }) as (...args: unknown[]) => Promise<void>;
  attachMeta(guarded, raw);
  return guarded;
}

/** Attach the public method metadata onto a bound/guarded callable so user code
 *  never reaches into `__aio`:
 *   - `.type`     — the prefixed action type string (refactor-safe constant).
 *   - `.action()` — `(...args) => { type, payload }`, the raw action descriptor
 *     for `schedule.*`, generators, `waitFor`, etc. `raw` is the catalog creator
 *     (`__aio.actions[key]`), pure and usable before bind (config-time schedules).
 *  Both are non-enumerable-by-convention extra props on the callable. */
export function attachMeta(fn: unknown, raw: unknown): void {
  const f = fn as Record<string, unknown>;
  f.type = (raw as { type: string }).type;
  f.action = raw;
}

/** Build a prefixed action/effect catalog from creator functions — maps keys to typed dispatchers. */
export function buildCatalog(
  prefix: string,
  creators: Creators,
): { catalog: Record<string, unknown>; typeToKey: Map<string, string> } {
  const catalog: Record<string, unknown> = {};
  const typeToKey = new Map<string, string>();

  for (const key of Object.keys(creators)) {
    const label = `${prefix}:${key}`;
    const fn = Object.assign( // A.increment(5) = { type, payload }
      (...args: unknown[]) => ({
        type: label,
        payload: creators[key]!(...args) ?? {},
      }),
      { type: label }, // A.increment.type = 'counter:increment'
    );
    // A.increment.action(5) = { type, payload } even after bindCell replaces the
    // flattened call surface with a dispatch wrapper. The catalog creator is its
    // own descriptor builder, so `.action` is a self-reference here.
    (fn as unknown as Record<string, unknown>).action = fn;
    catalog[key] = fn;
    typeToKey.set(label, key);
  }

  return { catalog, typeToKey };
}

/** Flatten action creators + string constants from catalog directly onto a cell def object.
 *  Explicit action creators are PURE FACTORIES — they stay callable before
 *  bindCell so config-time patterns (schedules arrays, tests, composition)
 *  can build actions. Only methods/generators get the pre-run loud guard
 *  (AIO-2.3) — those imply dispatch. Throws if any key collides with a
 *  reserved property or a selector. */
export function flattenOnto(
  target: Record<string, unknown>,
  catalog: Record<string, unknown>,
  selectorKeys: Set<string>,
  cellName: string,
): void {
  // Validate all keys — checkReservedKeys throws with clear explanation
  checkReservedKeys(cellName, Object.keys(catalog), "action");
  for (const [key, value] of Object.entries(catalog)) {
    if (selectorKeys.has(key)) {
      throw new Error(
        `[${cellName}] action '${key}' collides with selector of same name`,
      );
    }
    // Pure factory passthrough — bindCell later wraps with dispatch.
    target[key] = value;
  }
}

/** Bind a cell to a live app — replaces action creators with dispatch wrappers,
 *  selectors with bound state readers. Called by aio.run() after compose.
 *  All bound methods return a Promise — sync methods return Promise<void> (dispatch completion),
 *  async methods return Promise<T> (method return value). */
export function bindCell(
  f: CellDef,
  dispatch: (action: Msg) => Promise<void>,
  getState: () => Record<string, unknown>,
): void {
  if (f.__aio.bound) {
    throw new Error(
      `[${f.__aio.id}] already bound — cells can only bind to one app`,
    );
  }

  // Bind action creators: wrap with dispatch
  for (const key of f.__aio.actionKeys) {
    const creator = (f.__aio.actions as Record<string, unknown>)[key];
    if (typeof creator !== "function") continue;

    const isAsync = f.__aio.asyncMethods?.has(key);
    if (isAsync) {
      // Async methods: dispatch with _callId, return Promise that resolves with the method's return value
      const fn = (...args: unknown[]) => {
        const callId = crypto.randomUUID();
        const promise = registerCall(callId);
        const action = (creator as (...a: unknown[]) => Msg)(...args);
        dispatch({
          ...action,
          payload: { args, _callId: callId },
          _source: "Effect" as const,
        });
        return promise;
      };
      attachMeta(fn, creator);
      (f as Record<string, unknown>)[key] = fn;
    } else {
      // Sync methods: dispatch and return Promise<void> — resolves after reduce + effects
      const fn = (...args: unknown[]) =>
        dispatch((creator as (...a: unknown[]) => Msg)(...args));
      attachMeta(fn, creator);
      (f as Record<string, unknown>)[key] = fn;
    }
  }

  // Bind selectors: wrap with getState. Pass the full state as the second arg
  // so deps-form selectors can read other cells' current slices.
  for (const [key, selectorFn] of Object.entries(f.__aio.selectors)) {
    (f as Record<string, unknown>)[key] = () => {
      const state = getState();
      return selectorFn(state[f.__aio.id], state);
    };
  }

  // Bind state keys: install getters for direct state access (counter.count).
  // Overrides the creation-time default getter (installDefaultStateGetters) with
  // a live, app-state-backed one. Skip only if a method/selector owns the name
  // (impossible per AIO-6.1, but defensive — reading a default getter yields a
  // non-function, so it is correctly overridden).
  const cellName = f.__aio.id;
  for (const key of Object.keys(f.__aio.state)) {
    if (typeof (f as Record<string, unknown>)[key] === "function") continue;
    Object.defineProperty(f, key, {
      get() {
        const s = getState()[cellName] as Record<string, unknown> | undefined;
        return s ? s[key] : (f.__aio.state as Record<string, unknown>)[key];
      },
      enumerable: false,
      configurable: true, // browser-side reactive binding can override
    });
  }

  (f.__aio as Record<string, unknown>).bound = true;
}

/** Install creation-time getters returning each state key's declared default,
 *  so reading `cell.key` BEFORE aio.run() yields the declared value instead of
 *  `undefined` (sane SSR/test/isolation renders; avoids NaN from undefined math).
 *  bindCell / bindCellReactive later override these (all configurable) with live
 *  getters. State keys can't collide with methods/selectors (AIO-6.1 enforces it
 *  at definition), so installing and overriding them is always safe. */
export function installDefaultStateGetters(def: CellDef): void {
  const state = def.__aio.state as Record<string, unknown>;
  for (const key of Object.keys(state)) {
    if (key in def) continue; // defensive — a callable already owns the name
    Object.defineProperty(def, key, {
      get() {
        return (def.__aio.state as Record<string, unknown>)[key];
      },
      enumerable: false,
      configurable: true,
    });
  }
}
