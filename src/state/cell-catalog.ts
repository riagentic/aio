// cell-catalog.ts — catalog building and cell binding

import type { CellDef, Creators, Msg } from "./cell-types.ts";
import { checkReservedKeys } from "./cell-types.ts";
import { randomUuid } from "../rand.ts";
import { dispatchTracked } from "./cell-impl.ts";
import { settlesCalls } from "../protocol/ack-registry.ts";
import { nameIsTaken } from "./cell-helpers.ts";
import { pendingSignal } from "./pending.ts";

/** The raw creators of cells an app has composed and is initialising, but has
 *  not bound yet. Keyed by the creator (`__aio.actions[key]`), which is unique
 *  to one def, so the guard below can tell "this cell is in no app" from "this
 *  cell's app is running its `__init`s". The two need opposite advice: the
 *  first is fixed by listing the cell, the second is a call made too early by
 *  an app that already lists it — telling that app to list it sent the reader
 *  away from the actual problem. */
const _booting = new WeakSet<object>();

/** Mark `cells` as initialising for the duration of `fn` (their `__init`
 *  dispatches and `onInit`s). Internal to the boot path. */
export function _whileCellsBoot<T>(cells: readonly CellDef[], fn: () => T): T {
  const raws: object[] = [];
  for (const f of cells) {
    for (const raw of Object.values(f.__aio.actions ?? {})) {
      if (typeof raw === "function" && !_booting.has(raw)) {
        _booting.add(raw);
        raws.push(raw);
      }
    }
  }
  try {
    return fn();
  } finally {
    for (const raw of raws) _booting.delete(raw);
  }
}

/** Wrap a raw action creator with a guard for the pre-binding state. Calling a
 *  method before the runtime is booted ALWAYS throws (dev + prod) — a pre-boot
 *  dispatch has nowhere to go, so silently no-op'ing it would lose the write.
 *  The wrapper preserves the .type accessor and is replaced wholesale by
 *  bindCell / bindCellReactive — bound calls pay zero overhead. */
export function makeUnboundGuard(
  cellName: string,
  key: string,
  raw: unknown,
): (...args: unknown[]) => Promise<void> {
  // Calling a cell method before its runtime is booted is ALWAYS a bug — there
  // is no runtime to dispatch to, so the write would silently vanish (a field report: // a plain `Deno.test` that called `network.setCluster(…)` read back stale
  // state with no error). Silently losing a state mutation is the scariest
  // failure mode, so throw loudly regardless of dev/prod. After bind, the real
  // dispatching method replaces this guard, so only the never-legitimate
  // pre-boot path is affected.
  const guarded = (() => {
    if (_booting.has(raw as object)) {
      throw new Error(
        `[${cellName}] ${key}() called while the app is still booting — the ` +
          `cell IS in aio.run({ cells }), but methods are bound only after ` +
          `every cell's \`__init\` has run, and this call came from code ` +
          `running during it (a hook seeing a \`:__init\` action, or an ` +
          `onInit). From an onInit, dispatch it instead: ` +
          `\`app.dispatch({ type: "${cellName}:${key}", payload: { args: [] } })\` ` +
          `— in the log, cancellable. Or make the call from onStart, which ` +
          `runs after binding; from a hook, skip \`:__init\` actions and make ` +
          `it on the first real action.`,
      );
    }
    throw new Error(
      `[${cellName}] ${key}() called before the cell's runtime is booted — ` +
        `add this cell to aio.run({ cells: [...] }), or boot it in a test with ` +
        `testCell/testUI/bootCells before calling its methods.`,
    );
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

/** Build a prefixed catalog for ARGS-style callables (methods/generators):
 *  payload is the positional `{ args }` envelope. Same shape guarantees as
 *  {@linkcode buildCatalog} — `.type` constant + `.action` self-reference —
 *  so the two payload styles can never drift apart again (complexity audit:
 *  this loop existed hand-rolled in cell-methods-factory, minus `.action`). */
export function buildArgsCatalog(
  prefix: string,
  keys: readonly string[],
): Record<string, unknown> {
  const catalog: Record<string, unknown> = {};
  for (const key of keys) {
    const label = `${prefix}:${key}`;
    const fn = Object.assign(
      (...args: unknown[]) => ({ type: label, payload: { args } }),
      { type: label },
    );
    (fn as unknown as Record<string, unknown>).action = fn;
    catalog[key] = fn;
  }
  return catalog;
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
        `[${cellName}] action '${key}' collides with selector of same name. Rename one (e.g. action '${key}Action').`,
      );
    }
    // Pure factory passthrough — bindCell later wraps with dispatch.
    target[key] = value;
  }
}

/** Bind a cell to a live app — replaces action creators with dispatch wrappers,
 *  selectors with bound state readers. Called by aio.run() after compose.
 *  All bound methods return a Promise — sync methods resolve with their
 *  transported return value or undefined (AIO-427), async methods with T. */
export function bindCell(
  f: CellDef,
  dispatch: (action: Msg) => Promise<unknown>,
  getState: () => Record<string, unknown>,
): void {
  if (f.__aio.bound) {
    throw new Error(
      `[${f.__aio.id}] already bound — a cell def binds to exactly ONE app ` +
        `(perfect-aio D2). Running multiple apps in one process? Give each ` +
        `aio.run({ cells: [...] }) an explicit, disjoint cell list (zero-` +
        `config auto-binds EVERY imported cell to the first app). Sharing a ` +
        `definition across apps: use a factory returning cell(...).`,
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
        const callId = randomUuid();
        const action = (creator as (...a: unknown[]) => Msg)(...args);
        // A REMOTE dispatcher settles the call itself, over its ack frame.
        // `registerCall` is the LOCAL pending-call registry, resolved by the
        // in-process executor that runs the method — a remote binding
        // (`connectCli().bind(cell)`) has no such executor, so that promise
        // was settled by NOBODY and every async bound method rejected at the
        // call ceiling with "stopped waiting", 30s after the method had
        // already finished. Successes and failures alike.
        //
        // And no `_source: "Effect"` on it. That stamp is LOCAL provenance (a
        // call made by server code); over a wire it is a claim the receiver
        // cannot trust, so `sanitizeClientAction` strips it, re-stamps "UI",
        // and warns "client sent trusted field(s) _source" — once per
        // `await cell.asyncMethod()` from connectCli/connectCliUDS, naming
        // aio's own client as a forger. The server's outcome is unchanged
        // (it always re-stamps); only the false alarm goes. `_callId` stays:
        // the server discards it quietly for the same reason.
        if (settlesCalls(dispatch)) {
          const remote = dispatch({
            ...action,
            payload: { args, _callId: callId },
          });
          remote.catch(() => {});
          return remote;
        }
        // `dispatchTracked`: the registration is settled by the executor on
        // completion — OR by the dispatch door's own refusal (paused, closed,
        // draining), which is the only time nothing else ever will. Its no-op
        // catch keeps a fire-and-forget call (`cell.asyncMethod()` without
        // await) whose body throws from escaping as an unhandled rejection —
        // the executor still logs + dispatches `__error`, and any awaiter
        // still sees the rejection. Mirrors the browser twin in
        // cell-reactive.ts.
        return dispatchTracked(
          dispatch,
          {
            ...action,
            payload: { args, _callId: callId },
            _source: "Effect" as const,
          },
          callId,
          `${f.__aio.id}:${key}`,
        );
      };
      attachMeta(fn, creator);
      (f as Record<string, unknown>)[key] = fn;
    } else {
      // Sync methods: dispatch and return a Promise that resolves after reduce
      // + effects — with the method's transported return value (AIO-427), or
      // undefined for a void/effect-only method.
      const fn = (...args: unknown[]) =>
        dispatch((creator as (...a: unknown[]) => Msg)(...args));
      attachMeta(fn, creator);
      (f as Record<string, unknown>)[key] = fn;
    }
  }

  // Bind selectors: wrap with getState. A deps-form selector ALWAYS gets the
  // full state as arg 2 (its scoped wrapper builds the dep tuple from it) plus
  // any accessor args (alpha52: parameterized + deps compose). A plain
  // selector called WITH args is parameterized (`cell.byId(id)`); with NO args
  // it gets full state as arg 2 (`(s, fullState)` cross-cell plain selectors).
  for (const [key, selectorFn] of Object.entries(f.__aio.selectors)) {
    const isDeps = key in (f.__aio.selectorDeps ?? {});
    (f as Record<string, unknown>)[key] = (...args: unknown[]) => {
      const state = getState();
      const own = state[f.__aio.id];
      if (isDeps) {
        return (selectorFn as (
          s: unknown,
          full: unknown,
          ...a: unknown[]
        ) => unknown)(own, state, ...args);
      }
      return args.length > 0
        ? (selectorFn as (s: unknown, ...a: unknown[]) => unknown)(own, ...args)
        : selectorFn(own, state);
    };
  }

  // Bind state keys: install getters for direct state access (counter.count).
  // Overrides the creation-time default getter (installDefaultStateGetters) with
  // a live, app-state-backed one. Skip only if a method/selector owns the name
  // (impossible per AIO-6.1, but defensive — reading a default getter yields a
  // non-function, so it is correctly overridden).
  const cellName = f.__aio.id;
  for (const key of Object.keys(f.__aio.state)) {
    if (nameIsTaken(f, key)) continue;
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
  // `cell.$pending("scan")` — how many calls to that method are in flight in
  // THIS runtime, reactively (report 8 §14, report 9 §9.5). Ten hand-rolled
  // booleans across five cells, each set at the top and reset in a `finally`,
  // then replicated, persisted and migrated like real domain state — which
  // they are not. This is not state: it is never broadcast, never persisted,
  // never migrated, and it is a COUNT, because a boolean is wrong the moment
  // two readings overlap.
  //
  // Installed at CREATION rather than at bind, so one definition serves the
  // server executor and a browser's own outstanding calls alike.
  if (!("$pending" in def)) {
    Object.defineProperty(def, "$pending", {
      value: (method?: string) => pendingSignal(def.__aio.id, method),
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
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
  installReflexGuards(def);
}

/** `timer.state.x` / `timer.selectors.x()` — the React/Redux reflex.
 *
 *  A cell handle IS its state (`timer.x`) and its selectors (`timer.x()`), so
 *  both spellings read a silent `undefined` and the TypeError arrived one
 *  property later, naming nothing (field report cc §4, h3 Y4). In dev — and
 *  under every harness, which runs dev-strict — the read THROWS, naming the
 *  spelling that works. In prod it answers `undefined`, exactly as before:
 *  category (b), dev stricter, never the reverse. Decided at READ time,
 *  because cells are defined at module load, before `__aioDev` is armed.
 *
 *  Only where the cell owns no such name: `state` is reserved (RESERVED_KEYS),
 *  `selectors` is a legal method/selector/field name, and the binder ASSIGNS
 *  those — so the setter hands the slot over as plain data. */
function installReflexGuards(def: CellDef): void {
  const a = def.__aio;
  for (const key of ["state", "selectors"] as const) {
    if (
      key in def ||
      Object.hasOwn(a.state as Record<string, unknown>, key) ||
      Object.hasOwn(a.selectors ?? {}, key)
    ) continue;
    Object.defineProperty(def, key, {
      get() {
        if ((globalThis as Record<string, unknown>).__aioDev !== true) {
          return undefined;
        }
        const id = a.id;
        const field = Object.keys(a.state as Record<string, unknown>)[0] ??
          "field";
        const sel = Object.keys(a.selectors ?? {})[0] ?? "selector";
        throw new Error(
          key === "state"
            ? `[cell:${id}] ${id}.state does not exist — the cell IS its ` +
              `state: read ${id}.${field}, not ${id}.state.${field} (a ` +
              `React/Redux reflex). A component re-renders on that read.`
            : `[cell:${id}] ${id}.selectors does not exist — a selector is ` +
              `called on the cell itself: ${id}.${sel}(), not ` +
              `${id}.selectors.${sel}(). The cell IS its state and its ` +
              `selectors.`,
        );
      },
      set(v: unknown) {
        Object.defineProperty(def, key, {
          value: v,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
      enumerable: false,
      configurable: true,
    });
  }
}
