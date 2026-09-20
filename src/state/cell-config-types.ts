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
import type { ArgSchemas } from "./arg-schema.ts";
import type { ConcurrencyMode } from "./method-policy.ts";

/**
 * Shape every cell `state` must satisfy — the documented name of
 * `Record<string, unknown>`.
 *
 * Use a `type` alias, not an `interface`:
 *   type St = { n: number }          // ✓
 *   interface St { n: number }       // ✗ TS2322 (no index signature)
 *
 * An `interface` is not assignable under TypeScript's rules, so `state: St`
 * fails far from the call — inside aio — and every `s.field` reads as
 * `unknown`. Import `CellState` when you want to name the constraint; aiol
 * flags `state: {…} as SomeInterface` at the cause. The MethodsCellConfig
 * type-parameter bound stays `Record<string, unknown>` (frozen surface).
 */
export type CellState = Record<string, unknown>;

/** Methods-based config (reactive style) */
export type MethodsCellConfig<
  N extends string,
  S extends Record<string, unknown>,
  M extends Record<string, Method<S>> = Record<string, Method<S>>,
  States extends string = string,
  Sel extends Record<string, SelectorDef<S>> = Record<string, SelectorDef<S>>,
> = {
  /** The cell's initial state — a plain JSON-shaped object. It is also the
   *  type every method's `s` gets, and what a reset returns to. */
  state: S;
  /** The cell's methods — `name(s, ...args)` reads and writes the state `s`;
   *  call it as `cell.name(...args)`, from the UI or the server.
   *
   *  Optional: `cell-create.ts` accepts an empty OR omitted methods map —
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
  /** What happens when an ASYNC method is called again while it is still
   *  running. One report had three different hand-written answers to this one
   *  question in a single app, and the comment on one records that its
   *  first-wins guard was itself a bug (report 8 §15).
   *
   *  ```ts
   *  concurrency: { search: "newest", scan: "first", save: "queue" }
   *  ```
   *
   *  - `"newest"` — the new call wins, the running one aborts. Exactly what
   *    `cancelOn: { m: "self" }` does, and it registers that same trigger, so
   *    there is one mechanism rather than two that can disagree.
   *  - `"first"` — the running call wins, and the new caller ADOPTS its
   *    result. Resolving the second caller with `undefined` is the bug the
   *    report shipped.
   *  - `"queue"` — the new call waits for the running one, then runs.
   *
   *  Declaring both this and `cancelOn: "self"` for one method is refused:
   *  two spellings of one decision is how they come to disagree. */
  concurrency?: { [K in keyof M & string]?: ConcurrencyMode };
  /** Milliseconds for which a SUCCESSFUL async call answers an identical one
   *  without running it. Keyed by the arguments as well as the method, so
   *  `fetchUser(1)` never answers `fetchUser(2)`. Failures are never cached —
   *  that would make one bad minute last the whole ttl. */
  ttl?: { [K in keyof M & string]?: number };
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
  /** Optional per-method ARGUMENT rules, positional, keyed by method name.
   *
   *  ```ts
   *  args: { setAge: [z.number().int().min(0)] },
   *  ```
   *
   *  The boundary is untyped at runtime: a method's TypeScript signature
   *  protects the call sites you compile, and nothing protects `am dispatch`,
   *  a hand-written action, a form, a URL or an agent. aio's arity warning
   *  exists for exactly that reason, and two reports counted the cost — a
   *  dozen hand-written coercions in one week (report 9 §9.6, report 3 §12.7).
   *
   *  Each entry is a Standard Schema (Zod, Valibot, ArkType all implement it)
   *  or a plain predicate returning `true` or the reason it is not; `null`
   *  skips a position. A schema COERCES as well as refuses — the parsed value
   *  is what the method receives.
   *
   *  Checked on the dispatch path, so it guards every caller equally. */
  args?: ArgSchemas;
  /** Persistence filter — "all" (default) persists everything, "none" persists
   *  nothing. { include: [...] } or { exclude: [...] } for field-level control.
   *  To SHAPE what is written rather than only filter it, see
   *  {@linkcode MethodsCellConfig.onPersist}. */
  persist?: CellFieldFilter<keyof NoInfer<S> & string>;
  /** Keep this cell's ACTIONS out of the on-disk dev diagnostics — the action
   *  journal (`logs/actions.jsonl`) and the dev action timeline.
   *
   *  A separate word on purpose. `persist: "none"` was read as covering this
   *  too (report 2 §7), and it does not: `persist` is about the STATE STORE, the
   *  journal is a dev diagnostic that is off in production and lives in the
   *  app's own data directory. Making one key silently mean two things is
   *  worse than the surprise, so this is the key that means the other one.
   *
   *  It is about ACTIONS, not state. A cell that must keep its state off disk
   *  says `persist: "none"`; a cell that must keep its method calls and
   *  payloads out of the diagnostic record says `diagnostics: false`; a cell
   *  that needs both says both. `redact` remains the tool for hiding one
   *  FIELD while keeping the rest of the record. */
  diagnostics?: false;
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
   *  state unchanged — a repair that fails must not cost you the app. After a
   *  crash it runs again on a slice `journal: true` replay changed, so a
   *  crash and a clean stop come back the same — keep it a repair
   *  (idempotent), not a counter. */
  onRestore?: (state: NoInfer<S>) => NoInfer<S> | void;
  /** Shape this cell's state on its way TO the store — the mirror of
   *  {@linkcode MethodsCellConfig.onRestore}.
   *
   *  aio let you repair what comes back and not shape what goes out (report 9 §8.4).
   *  The reporter got lucky — their fat field was dead weight, so an `exclude`
   *  covered it — and said plainly that had the field been needed ON SCREEN,
   *  the only move left was a second mirrored cell kept in sync by hand.
   *
   *  ```ts
   *  onPersist: (s) => ({ key: s.thumbKey }),   // 40 MB live, 200 bytes on disk
   *  onRestore: (s) => { s.thumb = load(s.key) },
   *  ```
   *
   *  Receives the slice AFTER `persist`'s include/exclude, and returns what is
   *  written. `onPersist` and `onRestore` are a pair and read in that order: a
   *  shape that only DROPS fields needs no partner (the declared initial fills
   *  them), one that RESHAPES needs an `onRestore` that knows the new shape.
   *
   *  NOT error-guarded, unlike the observe-only hooks. It runs on the persist
   *  path, and "the write quietly stopped happening" is the worst outcome aio
   *  has — the app keeps running on state that is not on disk and finds out at
   *  the next boot. A throw is reported as a failed WRITE, which is what it is.
   *
   *  Refused on a `sync: true` cell, for the same reason a `persist` filter is:
   *  an op IS the method call's payload, written raw. */
  onPersist?: (state: NoInfer<S>) => Record<string, unknown>;
  /** Runs once at boot, after the cells it depends on are initialized — open
   *  a connection, start a watcher. `app` is scoped to this cell.
   *
   *  `initState` is the cell's DECLARED default state — the registry passes it
   *  (`cell-compose-registry.ts`) because `app.getState()` may not yet reflect
   *  `__init` when the hook runs. It was passed at runtime and missing from
   *  this type, so `onInit(app, initState)` — the shape the docs teach — was a
   *  compile error for every app that wrote it. */
  onInit?: (app: ScopedApp<NoInfer<S>>, initState: NoInfer<S>) => void;
  /** Runs when the app shuts down (cells in reverse order) or the cell is
   *  disabled — close what `onInit` opened. Errors are reported, never
   *  thrown: one cell's cleanup cannot stop another's. */
  onDestroy?: (app: ScopedApp<NoInfer<S>>) => void;
};
