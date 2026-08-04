// cell-config-types.ts — exported config type definitions for cell()

import type { Method } from "./cell-impl.ts";

/** Selector definition. Plain form receives the cell's own slice; deps form
 *  receives the cell's own slice plus the current slices of the named dep
 *  cells in the order listed. The cell slice is passed to the selector fresh
 *  on every read — `bindCell` re-evaluates whenever a dep cell changes. */
export type SelectorDef<S> =
  // Plain form may take extra ARGS after the slice — a parameterized selector
  // (`byId: (s, id) => …`) surfaces as `cell.byId(id)`.
  // deno-lint-ignore no-explicit-any
  | ((s: S, ...args: any[]) => unknown)
  | { deps: readonly string[]; fn: (s: S, ...deps: unknown[]) => unknown };

/** The value a bound selector accessor returns (the selector's own return). */
// deno-lint-ignore no-explicit-any
export type SelectorReturn<D> = D extends (s: infer _S, ...a: any[]) => infer R
  ? R
  // deno-lint-ignore no-explicit-any
  : D extends { fn: (...args: any[]) => infer R } ? R
  : unknown;

/** Bound selectors surface on the cell as accessors. A plain selector's EXTRA
 *  params (beyond the state slice) become the accessor's args —
 *  `byId: (s, id: string) => T` → `cell.byId(id)`; `total: (s) => n` →
 *  `cell.total()`. Deps-form selectors are always zero-arg. */
export type SelectorAccessors<Sel> = {
  [K in keyof Sel]: SelectorAccessorFn<Sel[K]>;
};

// deno-lint-ignore no-explicit-any
type SelectorAccessorFn<D> = D extends (s: any, ...args: infer A) => infer R
  ? (...args: A) => R
  // deno-lint-ignore no-explicit-any
  : D extends { fn: (...a: any[]) => infer R } ? () => R
  : () => unknown;
import type {
  CellAccess,
  CellFieldFilter,
  CellVisibility,
  ScopedApp,
} from "./cell-types.ts";
import type { SyncConfig } from "../sync/types.ts";

/** Methods-based config (reactive style) */
export type MethodsCellConfig<
  N extends string,
  S extends Record<string, unknown>,
  M extends Record<string, Method<S>> = Record<string, Method<S>>,
  States extends string = string,
  Sel extends Record<string, SelectorDef<S>> = Record<string, SelectorDef<S>>,
> = {
  state: S;
  methods: M;
  /** Cell scope. `"client"` cells live in the browser only — never registered
   *  with the server, never synced, never server-persisted. Methods are bound
   *  locally against a signal-backed slice; each tab has its own copy. Sync
   *  methods only in v1 — async methods throw at `cell()` time. */
  scope?: "client";
  /** Cancellation triggers per ASYNC METHOD — { methodKey: [actionsOrTypes] }.
   *  A trigger action aborts the method's in-flight calls; the method observes
   *  it via `s.$signal` (perfect-aio D1). Accepts bound methods (.type) or
   *  plain type strings.
   *
   *  `"self"` means NEWEST WINS: a new call aborts the calls already running,
   *  never itself — the shape every search-as-you-type, folder scan and
   *  autocomplete needs. It also says what a self-reference cannot:
   *  the cell's own bound methods don't exist yet inside its `cell()` literal.
   *
   *  ```ts
   *  cancelOn: { open: "self", search: ["self", nav.leave] }
   *  ``` */
  cancelOn?: Record<
    string,
    "self" | (string | { type: string })[]
  >;
  /** Selectors — derived values, auto-scoped to cell state.
   *  Plain form: `(s) => R` receives the cell's own slice.
   *  Deps form: `{ deps: readonly string[]; fn: (s, ...depSlices) => R }` — deps are
   *  other cells' current slices in the order listed. Dep names are validated at
   *  aio.run() (composition time); an unknown dep throws with a clear message.
   *  The `& Record<…>` intersection supplies CONTEXTUAL typing for `s` while
   *  `Sel` still infers the literal shape (its default is an EMPTY record so
   *  selector-less cells carry no index signature — see cell-create.ts). */
  selectors?: Sel & Record<string, SelectorDef<S>>;
  /** React to FOREIGN actions (decoupled pub/sub — the source cell never
   *  knows about this one).
   *  Object form (recommended): `{ myHandler: other.method }` — the named
   *  SYNC method runs with the foreign action's payload when it dispatches.
   *  Array form: routes the action through this cell (status/machine tick)
   *  WITHOUT running a handler — use the object form when you want code to
   *  run. Accepts bound methods (.type) or plain type strings. */
  listensTo?:
    | (string | { type: string })[]
    | Record<string, string | { type: string }>;
  /** Optional state validator — called after every reduce. Return true to accept, or a string error message to reject. */
  validate?: (state: S) => true | string;
  /** Persistence filter — "all" (default) persists everything, "none" persists nothing.
   *  { include: [...] } or { exclude: [...] } for field-level control. */
  persist?: CellFieldFilter<keyof NoInfer<S> & string>;
  /** Network access rule (AUTH-1): who may call this cell's methods over the
   *  network. `true` = any authenticated user, `"admin"` = that exact role,
   *  `(user, method) => boolean` = custom. Absent = open (connection-level
   *  auth only). Server-side code always bypasses. */
  access?: CellAccess;
  /** UI visibility — "all" (default) exposes everything, "none" hides cell from clients.
   *  { include: [...] } or { exclude: [...] } for field-level control.
   *  Add forUser for per-user filtering on the already-filtered state. */
  ui?: CellVisibility<keyof NoInfer<S> & string, NoInfer<S>>;
  /** CRDT sync — true for defaults, or partial config to override merge
   *  strategies, identity keys, retention.
   *
   *  `false` is the explicit opt-OUT, and only means something under
   *  `aio.run({ localFirst: true })`, where every server cell syncs by default:
   *  it marks a cell that must keep round-tripping through the server (an
   *  auth cell, a ledger, anything whose optimistic preview would be a lie).
   *  Absent ≠ false — that distinction is the whole point. */
  sync?: true | false | Partial<SyncConfig>;
  /** Run this cell's methods in their OWN Deno worker (its own isolate and OS
   *  thread), so work that blocks — a parse, a crunch, an FFI call — can only
   *  stall THIS cell. Every other cell, every other client, and the socket loop
   *  keep running. State stays authoritative here: the worker owns the slice and
   *  streams its Immer patches back, so persistence, broadcast and time-travel
   *  are unchanged.
   *
   *  The price: a postMessage + structured clone per dispatch (noise next to
   *  heavy work, ~10× a direct call for a trivial one), module singletons are
   *  per-worker, and args/returns must be structured-cloneable. Flag the cell
   *  that does dangerous work — never a counter.
   *  See docs/state/cell-workers.md. */
  worker?: boolean;
  /** Transactional async methods: reads see a STABLE snapshot taken
   *  at method entry (an `await` never changes them), and writes commit
   *  ATOMICALLY at return — one batch, all-or-nothing (a throw/cancel discards).
   *  Kills the read-after-await class. Opt-in; sync methods are already atomic.
   *  `{ serialize: true }` runs this cell's transactional ASYNC methods one at a
   *  time (a per-cell mutex) when read-modify-write correctness matters — it
   *  does NOT hold off sync methods, which are reducers and commit whenever
   *  they are dispatched.
   *
   *  Because reads are pinned, a field a SYNC method writes mid-await is
   *  invisible to the running async one. That is checked, not hoped for: every
   *  commit validates the method's read-set against live state, and
   *  `conflict` decides the outcome — `"abort"` (default: reject the call,
   *  commit nothing) or `"warn"` (report loudly, commit anyway). Use `s.$live`
   *  to read current state on purpose.
   *  See docs/state/transactional-methods.md. */
  transaction?:
    | boolean
    | { serialize?: boolean; conflict?: "abort" | "warn" };
  /** State version — increment when state shape changes. Default: 0. */
  version?: number;
  /** Migration hook — called when persisted version < current version.
   *  Receives old state (after deepMerge with defaults) and old version number.
   *  Must return the migrated state.
   *
   *  `NoInfer` is load-bearing here, and on the two hooks below: `state` must
   *  be the SOLE inference site for `S`. Without it, TypeScript infers `S`
   *  from whichever property mentions the state type FIRST — so writing
   *  `onMigrate` above `state` (the order the docs list them in) inferred `S`
   *  from the hook's annotation and every method body lost its typing, with
   *  the error reported ten lines away in the methods and nothing pointing at
   *  ordering. A field report lost an afternoon to it and "fixed" it by
   *  widening the annotation, which silently widens `S` for the whole cell. */
  onMigrate?: (state: NoInfer<S>, fromVersion: number) => NoInfer<S>;
  onInit?: (app: ScopedApp<NoInfer<S>>) => void;
  onDestroy?: (app: ScopedApp<NoInfer<S>>) => void;
};
