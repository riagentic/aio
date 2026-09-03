// cell-config-types.ts — exported config type definitions for cell()

import type { Method } from "./cell-impl.ts";

/** Selector definition. Plain form receives the cell's own slice; deps form
 *  receives the cell's own slice plus a TUPLE of the named dep cells' current
 *  slices (alpha52): `{ deps: ["prices"], fn: (s, [prices], ...args) => … }` —
 *  so parameterized selectors and deps compose. The old spread signature
 *  `(s, ...deps)` is detected by shape and REFUSED (alpha76 —
 *  src/state/removals.ts; `aiol --safe-fix` rewrites it). The cell slice is
 *  passed to the selector fresh on every read — `bindCell` re-evaluates
 *  whenever a dep cell changes. */
export type SelectorDef<S> =
  // Plain form may take extra ARGS after the slice — a parameterized selector
  // (`byId: (s, id) => …`) surfaces as `cell.byId(id)`.
  // deno-lint-ignore no-explicit-any
  | ((s: S, ...args: any[]) => unknown)
  | {
    deps: readonly string[];
    // deno-lint-ignore no-explicit-any
    fn: (s: S, deps: any[], ...args: any[]) => unknown;
  };

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
 *  `cell.total()`. Deps-form selectors take the args after `(s, [deps])`
 *  (alpha52 tuple form) — typed loosely because a dep tuple's element types
 *  are not knowable from the dep NAMES alone. */
export type SelectorAccessors<Sel> = {
  [K in keyof Sel]: SelectorAccessorFn<Sel[K]>;
};

// deno-lint-ignore no-explicit-any
type SelectorAccessorFn<D> = D extends (s: any, ...args: infer A) => infer R
  ? (...args: A) => R
  // deno-lint-ignore no-explicit-any
  : D extends { fn: (...a: any[]) => infer R } ? (...args: any[]) => R
  : () => unknown;
import type {
  Access,
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
  /** Optional: `cell-create.ts` accepts an empty OR omitted methods map —
   *  state-only cells (thin-client stubs, selectors-only read models) are a
   *  supported shape, and a required `methods` here made the type refuse what
   *  the runtime runs. */
  methods?: M;
  /** Cell scope. `"client"` cells live in the browser only — never registered
   *  with the server, never synced, never server-persisted. Methods are bound
   *  locally against a signal-backed slice; each tab has its own copy. Sync
   *  methods only in v1 — async methods throw at `cell()` time.
   *  `"server"` (the default) may be stated explicitly (alpha52). */
  scope?: "client" | "server";
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
  cancelOn?: {
    // Typed against the cell's OWN method names, the way `long` is. The KEY is
    // a method of this cell — a string nothing checked, so `cancelOn: { opne:
    // "self" }` compiled, ran, and silently never cancelled anything. `long`
    // proved the pattern (`keyof M & string`); this is the rest of it.
    [K in keyof M & string]?: "self" | (string | { type: string })[];
  };
  /** Async methods that may run as long as they need — no call ceiling, no
   *  effect deadline.
   *
   *  The default ceiling (`effectTimeoutMs`, 30s) exists so a method that
   *  silently never settles cannot hang a caller forever. But "this one takes
   *  hours" is a property OF THE METHOD, and it used to be declared in another
   *  file, keyed by a string (`perfBudget.methods["job:colorize"].timeout`)
   *  that no rename follows and no type checks — a field report added six such
   *  entries one runtime failure at a time.
   *
   *  ```ts
   *  cell("job", {
   *    state: { pct: 0 },
   *    long: ["colorize", "refreshScratch"],   // ← checked against methods
   *    methods: {
   *      async colorize(s) { ... },            // hours; still cancellable
   *    },
   *  })
   *  ```
   *
   *  It applies everywhere the cell runs — app, `bootCells`, `testUI` and
   *  `testCell` — so a test can simply `await job.colorize()` instead of
   *  starting it and polling. Cancellation is untouched: `long` removes a
   *  deadline, `cancelOn` + `s.$signal` are still how a method is stopped.
   *  An explicit `perfBudget.methods[...]` entry still wins — including
   *  `timeout: "warn"`, which keeps the ceiling as a REPORT (one warning at
   *  the default ceiling, caller keeps waiting) for work of unknown length. */
  long?: (keyof M & string)[];
  /** Selectors — derived values, auto-scoped to cell state.
   *  Plain form: `(s) => R` receives the cell's own slice.
   *  Deps form: `{ deps: readonly string[]; fn: (s, [a, b], ...args) => R }` — the
   *  tuple holds the other cells' current slices in the order listed (the old
   *  `(s, ...depSlices)` spread was retired in alpha76). Dep names are validated at
   *  aio.run() (composition time); an unknown dep throws with a clear message.
   *  The `& Record<…>` intersection supplies CONTEXTUAL typing for `s` while
   *  `Sel` still infers the literal shape (its default is an EMPTY record so
   *  selector-less cells carry no index signature — see cell-create.ts). */
  selectors?: Sel & Record<string, SelectorDef<S>>;
  /** React to FOREIGN actions (decoupled pub/sub — the source cell never
   *  knows about this one): `{ myHandler: other.method }` — the named SYNC
   *  method runs with the foreign action's payload when it dispatches. Values
   *  may be ARRAYS of sources (alpha52): `{ onChange: [a.set, b.set] }`.
   *  Accepts bound methods (.type) or plain type strings. (The bare-array
   *  form, which routed the action without running a handler, went out in
   *  alpha70 — see src/state/removals.ts.) */
  listensTo?: Record<
    string,
    string | { type: string } | (string | { type: string })[]
  >;
  /** Optional state validator — called after every reduce. Return true to accept, or a string error message to reject. */
  validate?: (state: S) => true | string;
  /** Persistence filter — "all" (default) persists everything, "none" persists nothing.
   *  { include: [...] } or { exclude: [...] } for field-level control. */
  persist?: CellFieldFilter<keyof NoInfer<S> & string>;
  /** Network access rule (AUTH-1): who may CALL this cell's methods over the
   *  network. `true` = any authenticated user, `"admin"` = that exact role,
   *  `(user, method) => boolean` = custom. Absent = open (connection-level
   *  auth only). Server-side code always bypasses.
   *  `access` gates calls, `visible` gates reads — declare both on an
   *  exposed/multi-user app (composition refuses `access` with no `visible`
   *  there, because the unanswered read side broadcasts the whole cell). */
  access?: Access;
  /** Visibility — the READ side (alpha52; renamed from `ui`): what of this
   *  cell's state the broadcast carries to clients. "all" (default) exposes
   *  everything, "none" hides the cell from clients. { include: [...] } or
   *  { exclude: [...] } for field-level control; add forUser for per-user
   *  filtering on the already-filtered state.
   *  `access` gates calls, `visible` gates reads. */
  visible?: CellVisibility<keyof NoInfer<S> & string, NoInfer<S>>;
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
   *  ATOMICALLY at return — one batch, all-or-nothing (a throw/cancel
   *  discards). Kills the read-after-await class; sync methods are already
   *  atomic.
   *
   *  OPT-IN (`transaction: true`). It was briefly the default — alpha52 to
   *  alpha56 — and alpha57 took that back: the flip silently re-specified every
   *  async method already written, and nothing in a type, a runtime error or a
   *  test could catch it. Cells that leave it unset keep live reads +
   *  incremental commits (every write publishes on the next microtask).
   *
   *  Turn it on for a cell where a wrong merge costs something real — money,
   *  inventory, a ledger. Then publish mid-method with `s.$commit()` (the
   *  spinner idiom: `s.busy = true; s.$commit();`) and read current state on
   *  purpose with `s.$live` (e.g. `until(() => s.$live.ready)`).
   *
   *  `{ serialize: true }` additionally runs this cell's transactional ASYNC
   *  methods one at a time (a per-cell mutex) when read-modify-write
   *  correctness matters — it does NOT hold off sync methods, which are
   *  reducers and commit whenever they are dispatched.
   *
   *  Because reads are pinned, a field a SYNC method writes mid-await is
   *  invisible to the running async one. That is checked, not hoped for: every
   *  commit validates the method's read-set against live state, and
   *  `conflict` decides the outcome — `"abort"` (default: reject the call,
   *  commit nothing) or `"warn"` (report loudly, commit anyway).
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
  /** Repair this cell's restored state, once, at boot.
   *
   *  Distinct from `onMigrate`, which answers "the SHAPE changed" and only
   *  runs on a version bump. `onRestore` answers "some of what was persisted
   *  does not survive a restart" — and that is a property of the data, not of
   *  the version, so it runs on every boot after restore.
   *
   *  The case that asked for it: a fix log persisted with undo handles that
   *  are CLOSURES. They restore as dead references, so the UI offers Undo
   *  buttons that cannot work. The repair is two lines and it belongs beside
   *  the state it repairs — without this hook it had to be called from the
   *  app entry's `onStart`, in another file, away from the cell that owns it.
   *
   *  ```ts
   *  onRestore(s) {
   *    for (const e of s.log) e.undo = undefined;   // closures don't persist
   *  }
   *  ```
   *  Mutate the draft, or return a replacement. Error-guarded like every
   *  lifecycle hook: a throw is reported and boot continues with the restored
   *  state unchanged — a repair that fails must not cost you the app. */
  onRestore?: (state: NoInfer<S>) => NoInfer<S> | void;
  /** `initState` is the cell's DECLARED default state — the registry passes it
   *  (`cell-compose-registry.ts`) because `app.getState()` may not yet reflect
   *  `__init` when the hook runs. It was passed at runtime and missing from
   *  this type, so `onInit(app, initState)` — the shape the docs teach — was a
   *  compile error for every app that wrote it. */
  onInit?: (app: ScopedApp<NoInfer<S>>, initState: NoInfer<S>) => void;
  onDestroy?: (app: ScopedApp<NoInfer<S>>) => void;
};
