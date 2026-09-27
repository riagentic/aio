// boot-refusals.ts — the in-process harnesses' half of `aio.run()`'s boot gate.
//
// `testUI`/`bootCells` do NOT boot through `aio.run()`: they compose the cells
// on the standalone runtime, so none of the composition refusals ran under
// them. A cell holding `apiKey` booted GREEN in the harness and was REFUSED the
// moment the app actually started — in dev AND in prod. A whole app could be
// built green against the harness the docs push hardest and then not start.
//
// This module exists SEPARATELY from `test-strict.ts` for one structural
// reason: `aio/renderer` (src/browser-air.ts) re-exports `testComponent`, which
// imports `test-strict.ts` — so a server import there lands in every browser
// bundle and the bundler refuses the build. Only `cell-test.ts`, `ui-test.ts`
// and `server-test.ts` import THIS file, and none is in the browser graph.
// `check:boundaries` cannot enforce that (root files have unrestricted reach),
// so it is stated here and in `test-strict.ts`, beside both import lists.

import {
  applyCellDefaults,
  applyLocalFirst,
  type CellDefaults,
} from "../state/cell-defaults.ts";
import { composeCells } from "../state/cell-compose.ts";
import { refuseUnsafeComposition } from "../server/aio-composition.ts";
import { syncListensMismatches } from "../server/aio-cells-bridge.ts";
import { log } from "../diagnostics/logger-api.ts";
import { validateWorkerCells } from "../server/cell-worker-pool.ts";
import type { CellDef, CellEntry } from "../state/cell-types.ts";
import { _cloneAcrossWorkerBoundary } from "../state/cell-impl.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import type { BootScope } from "../standalone-air.ts";
import { attachMeta, makeUnboundGuard } from "../state/cell-catalog.ts";
import { getRegisteredCells } from "../state/cell-reactive.ts";
import { _openScopeDepth } from "../state/signal.ts";
import { peerReadInWorkerMessage } from "../server/cell-worker-host.ts";

/** Run EVERY boot refusal `aio.run()` runs, against the cells a harness is
 *  about to boot in-process — a credential exposed to the UI, a filtered sync
 *  cell, access escalation through `listensTo`, an unknown selector dep.
 *
 *  Composition here is a throwaway pass whose only product is the refusal:
 *  `composeCells` is pure over the defs, so the runtime composes its own
 *  moments later exactly as before.
 *
 *  Client-scoped cells are dropped, exactly as `composeCellsWiring` drops them:
 *  they never reach the server's broadcast, so refusing one here would be a
 *  harness-only failure for code production accepts — strictness must mirror a
 *  real boot, not invent a rule of its own.
 *  @internal */
export function _refuseUnsafeCells(
  cells: readonly CellEntry[],
  opts: HarnessBootOptions = {},
): void {
  const defs = cells.map((entry) =>
    ("__aio" in entry ? entry : (entry as { cell: CellDef }).cell) as
      | CellDef
      | undefined
  );
  // What a thread boundary cannot honour (selectors, sync, listensTo, a
  // machine, client scope), refused as the worker pool refuses it at a real
  // boot — which the harness never reaches, since it hosts no workers. Eight
  // such cells booted green under bootCells/testServer/testUI while the app
  // itself would not start. BEFORE the client-scope drop below: `worker: true`
  // on a client cell is one of the contradictions.
  _refuseWorkerCells(defs);
  const serverScoped = cells.filter((_entry, i) =>
    defs[i]?.__aio?.scope !== "client"
  );
  if (serverScoped.length === 0) return; // nothing to refuse; composeCells would warn
  // aio-ok(persist-decider): composed only to run the boot refusals; never reduced, never stored.
  const composed = composeCells(serverScoped, { perfCheck: false });
  // The SAME two passes `aio.run` makes before it refuses: both change what a
  // cell hides and whether it syncs, and the contradiction is only decidable
  // once they have run. Without them an app whose only contradiction came
  // from its app-level defaults was green here and refused at boot.
  applyCellDefaults(composed, opts.cellDefaults);
  applyLocalFirst(composed, opts.localFirst === true);
  refuseUnsafeComposition(composed);
  // …and the boot WARNINGS decided on the same composition: the same line
  // `aio.run` says (aio-cells-bridge.ts `buildLegacyConfig`).
  for (const line of syncListensMismatches(composed.cells)) log.warn(line);
}

/** The worker-cell half of the boot gate, for every harness — including
 *  `testServer`, whose libraryMode boot runs worker cells in-isolate.
 *  @internal */
export function _refuseWorkerCells(
  defs: readonly (CellDef | undefined)[],
): void {
  validateWorkerCells(
    defs.filter((d): d is CellDef => d?.__aio?.worker === true),
  );
}

/** Call a `worker: true` cell's method across the boundary production puts
 *  there: a real worker is reached by `postMessage`, so its arguments and its
 *  return value are structured-cloned. The in-process harnesses run worker
 *  cells in-isolate and passed both by reference — a function argument ran, a
 *  class instance came back an instance — so a test stayed green over a call
 *  that throws, or returns a plain object, in the app. `testServer` already
 *  clones at its dispatch seam; this is the same boundary for `testCell`,
 *  `bootCells` and `testUI`. A clone failure is the call's rejection, as it is
 *  there. @internal */
export function _callAcrossWorkerBoundary(
  cellId: string,
  args: unknown[],
  run: (args: unknown[]) => unknown,
): unknown {
  let sent: unknown[];
  try {
    sent = _cloneAcrossWorkerBoundary(
      args,
      "action payload",
      cellId,
    ) as unknown[];
  } catch (e) {
    return Promise.reject(e);
  }
  const out = run(sent);
  return out !== null && typeof (out as { then?: unknown })?.then === "function"
    ? (out as Promise<unknown>).then((v) =>
      v === undefined
        ? v
        : _cloneAcrossWorkerBoundary(v, "return value", cellId)
    )
    : out;
}

// ── Worker isolation, in process ──────────────────────────────────────────
//
// Every harness runs `worker: true` cells on the main isolate, where every
// other cell is right there: a worker method reading `peer.v` got the live
// value and calling `peer.bump()` dispatched it. In a real worker both THROW —
// the worker holds only its own slice (`isolatePeerCells`, cell-worker-host.ts)
// and no cell is bound there (the unbound guard, cell-catalog.ts). An app
// whose worker method did either was green in bootCells/testUI/testServer and
// broken the moment the cell got its thread.
//
// The boundary here is ASYNC CONTEXT: a worker cell's reduce and executor run
// inside `_workerScope` (its async body keeps the scope across awaits), every
// other cell's run outside it, and a read or a call made from inside the scope
// is refused with the worker's own words. Reads inside a tracked render or
// effect are exempt: a component re-rendered by a worker cell's commit is UI
// code on the main isolate, never the method body, even though the render was
// queued from inside the method's scope.

const _workerScope = new AsyncLocalStorage<string | undefined>();

/** The standalone runtime's "whose boot is this code running for" scope
 *  (`BootScope` in standalone-air.ts), backed by `AsyncLocalStorage` so it
 *  survives `await`. Installed by every in-process harness before it boots —
 *  the harness is where boots come and go in one process, and a call a
 *  disposed boot started must not commit into the next one. Installed once and
 *  left: with one boot alive it only ever answers "that boot".
 *  @internal */
export function _armBootScope(
  install: (scope: BootScope) => () => Fence | undefined,
): void {
  _liveFence = install(_bootScope);
  _fenceTimers();
}
type Fence = Parameters<BootScope["run"]>[0];
/** A fence plus what started the code running in it: the method (its reduce,
 *  its async body), or a timer and the line that armed it. */
type BootCtx = { fence: Fence; method?: string; timer?: string };
const _bootAls = new AsyncLocalStorage<BootCtx | undefined>();
const _bootScope: BootScope = {
  run: (fence, fn, method) =>
    _bootAls.run({ fence, method: method ?? _bootAls.getStore()?.method }, fn),
  get: () => _bootAls.getStore()?.fence,
  origin: () => {
    const ctx = _bootAls.getStore();
    if (!ctx?.method && !ctx?.timer) return undefined;
    const inside = ctx.method ? `inside "${ctx.method}"` : "";
    return ctx.timer ? `${ctx.timer}${inside && `, ${inside}`}` : inside;
  },
  inTimer: () => _bootAls.getStore()?.timer !== undefined,
};
let _liveFence: () => Fence | undefined = () => undefined;

// ── Which mount is running this code ─────────────────────────────────────
//
// A timer armed outside every boot's own code is attributed to the MOUNT that
// is active when it is armed: the one whose root is rendering (its
// mount/render/hydrate, its effect and afterRender flushes — `_activeRoot`),
// or the one whose handle is driving it (its queued actions, its settle/
// waitFor drains — `_inMount`). Only code with no active mount (the test body
// between calls) falls to the outermost live mount. Without this, a timer an
// INNER nested mount's component armed went to the outer mount and, once the
// inner one closed, committed there — silently, the exact write the fence
// exists to refuse.
const _mountAls = new AsyncLocalStorage<Fence | undefined>();
const _rootFences = new WeakMap<object, Fence>();
let _renderingRoot: () => object | null | undefined = () => null;

/** Run `fn` (and what it starts) as the mount `fence` belongs to — a
 *  harness's own driving of its mount. @internal */
export function _inMount<T>(fence: Fence | undefined, fn: () => T): T {
  return fence ? _mountAls.run(fence, fn) : fn();
}

/** Attribute what renders under `root` (a mount's root element) to `fence`;
 *  `rendering` answers which root element is rendering right now. @internal */
export function _fenceMountRoot(
  root: object,
  fence: Fence | undefined,
  rendering: () => object | null | undefined,
): void {
  if (fence) _rootFences.set(root, fence);
  _renderingRoot = rendering;
}

/** The fence a timer armed right now belongs to: the rendering mount's, else
 *  the boot code's running (a method, an onInit, an attributed timer's
 *  callback — so a chain inherits), else the driving mount's, else the
 *  outermost live mount's. */
function _armingFence(outer: BootCtx | undefined): Fence | undefined {
  const root = _renderingRoot();
  return (root ? _rootFences.get(root) : undefined) ?? outer?.fence ??
    _mountAls.getStore() ?? _liveFence();
}

// ── Real timers, fenced ──────────────────────────────────────────────────
//
// A `setTimeout` a mount's COMPONENT armed (an idle lock, a poll) runs in the
// test body's context, outside every fence — so when it fired after its mount
// was disposed, its cell call went through the handle, which the NEXT mount
// had re-bound, and committed there without a word. One armed by a METHOD was
// refused, but the refusal named only the boot, never the timer: it landed on
// an innocent later test with nothing to say which timer, armed where (a
// desktop wallet app's field report).
//
// So every real timer armed while a boot is live — by code outside aio's own
// `src/`, which cleans up its own — runs in a boot's fence, remembering the
// line that armed it: the mount or boot whose code armed it (`_armingFence`),
// or — armed by the test body between calls — the OUTERMOST live mount, never
// the innermost: a timer the test arms inside a nested mount is not that
// mount's, and was refused once it closed while the outer mount lived. Live, the fence changes nothing; retired, a cell call from the timer
// is refused (a rejected call) naming that line. Nothing is cancelled: a timer
// that never calls a cell (a module's own poll) keeps running as it would in
// the app. Installed once per process; a fake clock installed later wraps it,
// one installed earlier is wrapped.
const _AIO_SRC = new URL("../", import.meta.url).href;
const _FENCED = Symbol("aio.fencedTimer");
/** The frame that called `fn` — or undefined when that is aio's own code. */
// deno-lint-ignore ban-types
function _appCaller(fn: Function): string | undefined {
  const o: { stack?: string } = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 1;
  try {
    Error.captureStackTrace(o, fn);
  } finally {
    Error.stackTraceLimit = limit;
  }
  const frame = o.stack?.split("\n")[1]?.trim().replace(/^at /, "");
  return frame && !frame.includes(_AIO_SRC) ? frame : undefined;
}
function _fenceTimers(): void {
  type Timer = (handler: unknown, ...rest: unknown[]) => unknown;
  const g = globalThis as unknown as Record<string, Timer>;
  for (const name of ["setTimeout", "setInterval"]) {
    const real = g[name]!;
    if ((real as { [_FENCED]?: true })[_FENCED]) continue;
    const fenced: Timer = (handler, ...rest) => {
      const outer = _bootAls.getStore();
      const fence = _armingFence(outer);
      const at = typeof handler === "function" && fence
        ? _appCaller(fenced)
        : undefined;
      if (!at) return real(handler, ...rest);
      const ctx: BootCtx = {
        fence: fence!,
        method: outer?.method,
        timer: `${name} armed at ${at}`,
      };
      return real(
        (...args: unknown[]) =>
          _bootAls.run(
            ctx,
            () => (handler as (...a: unknown[]) => unknown)(...args),
          ),
        ...rest,
      );
    };
    (fenced as unknown as { [_FENCED]: true })[_FENCED] = true;
    g[name] = fenced;
  }
}

/** Start a harness body OUTSIDE every in-process scope — the boot fence and
 *  the worker scope — whatever context the runner handed it. Called first,
 *  synchronously, by every harness entry (testUI both forms, testCell,
 *  bootCells): `enterWith` then holds for the rest of the caller's run,
 *  across its `await`s.
 *
 *  Why a harness body can arrive INSIDE one: Deno pins the process's ambient
 *  async context — what a callback Rust starts runs in, the next `Deno.test`
 *  body included — to the context a module is FIRST evaluated in, and never
 *  puts it back (measured, Deno 2.9.7; the npm half of it is
 *  `importOutsideApp`, outside-app.ts). A reducer runs inside its boot's
 *  fence, so a fresh `import()` there made that fence every later test's
 *  context: once its test disposed, the next body's first cell call was
 *  refused as "dispatched into a torn-down runtime" (a desktop wallet app: 19
 *  of 105 tests). A worker cell's reducer pins the worker scope the same way.
 *  A harness body is never a boot's code nor a worker's, so shedding both is
 *  exact — and the real refusal stands: a retired boot's own late call runs
 *  in ITS continuation, which this never touches.
 *  @internal */
export function _shedLeakedScopes(): void {
  _bootAls.enterWith(undefined);
  _mountAls.enterWith(undefined);
  _workerScope.enterWith(undefined);
}

/** Refuse, while a `worker: true` cell's method runs in process, what a real
 *  worker refuses: reading another cell's state, and calling any cell's
 *  method. Returns the undo. No-op when `cells` has no worker cell.
 *  @internal */
export function _isolateWorkerCellsInProcess(
  cells: readonly CellEntry[],
): () => void {
  const defs = cells.map((entry) =>
    ("__aio" in entry ? entry : (entry as { cell: CellDef }).cell) as CellDef
  ).filter((d) => d?.__aio);
  if (!defs.some((d) => d.__aio.worker === true)) return () => {};
  const undo: (() => void)[] = [];
  /** The worker cell whose method is running, or undefined. A read made while
   *  a render/effect is TRACKING is UI code, not the method. */
  const insideWorker = (): string | undefined =>
    _openScopeDepth().track > 0 ? undefined : _workerScope.getStore();

  // 1. Scope every booted cell's reduce + executor: a worker cell's INTO its
  //    scope, everyone else's OUT of it — a peer's method drained from inside a
  //    worker method's commit is main-isolate code and must not inherit it.
  for (const def of defs) {
    const a = def.__aio as unknown as Record<string, unknown>;
    const id = def.__aio.id;
    const enter = def.__aio.worker === true
      ? <T>(fn: () => T): T => _workerScope.run(id, fn)
      : <T>(fn: () => T): T => _workerScope.exit(fn);
    for (const slot of ["reduce", "execute"] as const) {
      const prev = a[slot];
      if (typeof prev !== "function") continue;
      const scoped = (...args: unknown[]) =>
        enter(() => (prev as (...x: unknown[]) => unknown)(...args));
      a[slot] = scoped;
      undo.push(() => {
        if (a[slot] === scoped) a[slot] = prev;
      });
    }
  }

  // 2. Another cell's state read — every registered cell, as the worker host
  //    isolates every registered cell, booted or not.
  for (const [name, def] of getRegisteredCells()) {
    for (const key of Object.keys(def.__aio.state ?? {})) {
      const prev = Object.getOwnPropertyDescriptor(def, key);
      if (!prev?.get || !prev.configurable) continue; // a callable, or frozen
      const get = function (this: unknown) {
        const hosted = insideWorker();
        if (hosted !== undefined && hosted !== name) {
          throw new Error(peerReadInWorkerMessage(hosted, name, key));
        }
        return prev.get!.call(this);
      };
      Object.defineProperty(def, key, { ...prev, get });
      undo.push(() => {
        if (Object.getOwnPropertyDescriptor(def, key)?.get === get) {
          Object.defineProperty(def, key, prev);
        }
      });
    }
  }

  // 3. Any cell's method — its own included, booted or not: nothing is bound
  //    in a worker, so the call meets the unbound guard, and so it does here.
  for (const def of new Set([...defs, ...getRegisteredCells().values()])) {
    const holder = def as unknown as Record<string, unknown>;
    for (const key of def.__aio.actionKeys ?? []) {
      const prev = holder[key];
      const raw = (def.__aio.actions as Record<string, unknown>)[key];
      if (typeof prev !== "function" || typeof raw !== "function") continue;
      const guarded = makeUnboundGuard(def.__aio.id, key, raw);
      const call = function (this: unknown, ...args: unknown[]) {
        if (insideWorker() !== undefined) return guarded(...args);
        return (prev as (...x: unknown[]) => unknown).apply(this, args);
      };
      attachMeta(call, raw);
      holder[key] = call;
      undo.push(() => {
        if (holder[key] === call) holder[key] = prev;
      });
    }
  }
  return () => {
    for (let i = undo.length - 1; i >= 0; i--) undo[i]!();
  };
}

/** The app-level composition options a harness has to honour to boot the
 *  cells the way `aio.run({ cellDefaults, localFirst })` does. */
export type HarnessBootOptions = {
  /** Stand in for a module a cell imports through `serverImport(…)`.
   *
   *  For a cell that owns an OS PROCESS there was no safe rung (report 9 §8.6,
   *  §9.3): `testCell` never reaches the spawn, and `bootCells` spawns the
   *  REAL child, so "random actions against a real runtime" means a real
   *  subprocess per action. Cassettes wrap a function you can reach; they
   *  cannot wrap `await import("./claude.server.ts")` inside a method.
   *
   *  ```ts
   *  await bootCells([session], {
   *    stub: { "./claude.server.ts": { run: () => "canned" } },
   *  })
   *  ```
   *
   *  Keyed by the specifier AS WRITTEN in the cell, so a test stubs the string
   *  it can see rather than a `file:///…` it would have to compute. Only
   *  imports that go through `serverImport` are stubbable — nothing can
   *  intercept a raw `await import(…)` in Deno, and pretending otherwise would
   *  be a stub that silently did not apply. */
  stub?: Record<string, unknown>;
  cellDefaults?: CellDefaults;
  localFirst?: boolean;
  /** The app's `aio.run({ perfBudget })`.
   *
   *  The harness boots the cells directly and never sees `aio.run()`'s config,
   *  so every budget was the DEFAULT — and a method the app had already
   *  budgeted at 60 ms tripped the 5 ms default on every run, with a warning
   *  recommending the exact override the app applied months ago:
   *
   *      WARN [BUDGET_EFFECT] chat effect exceeded budget: 15.2ms > 5ms …
   *      Raise the budget for THIS method only:
   *      perfBudget: { methods: { "chat:createIdentity": { effect: 40 } } }
   *
   *  The cost is not the line. It is that a suite printing known-false
   *  warnings on every run teaches everyone to skim past the real ones. Pass
   *  the same object the app passes, and the harness measures what production
   *  measures. */
  perfBudget?: import("../state/dispatch.ts").PerfBudget;
};
