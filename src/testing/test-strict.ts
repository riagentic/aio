// test-strict.ts — the shared harness-STRICTNESS primitives that are safe in a
// BROWSER bundle: dev-strict mode, the app-directory sandbox, and the
// unobserved-call-failure ledger.
//
// The browser part is load-bearing, not incidental: `aio/renderer`
// (src/browser-air.ts) re-exports `testComponent`, which imports this file, so
// everything reachable from here rides in every app's browser bundle. A single
// static import of a server module from here made the bundler refuse EVERY
// browser build ("server-only module(s) statically imported") — which is why
// the boot refusals, which need `parseCli`/`isCompiled`, live in
// `boot-refusals.ts` instead: only `cell-test.ts` and `ui-test.ts` reach that,
// and neither is in the browser graph. (`check:boundaries` cannot see this —
// root files like `browser-air.ts` have unrestricted reach — so the rule is
// kept here, in words, beside the import list it constrains.)
//
// It lives in its own module because every harness needs it and the harnesses
// import each other: it used to sit in `cell-test.ts`, so `testComponent`,
// `testServer` and `testMultiClient` could not call it without an import cycle
// — and they didn't. Three of the five harnesses therefore ran with `__aioDev`
// unset, which turned off frozen-state enforcement, the readonly hint and the
// hidden-field read guard for every test written with them: a component that
// illegally mutated committed state passed `testComponent` and threw in
// `testUI`, `testCell` and production.
//
// Doctrine, verbatim: "Tests are the STRICTEST environment, never the most
// permissive." One import, one call, at the top of every harness — and
// everything else here exists for the same reason: three in-process harnesses
// must not each grow their own, weaker, answer to the same question.

import type { CellDef } from "../state/cell-types.ts";
import { attachMeta } from "../state/cell-catalog.ts";

/** Arm dev-strict checks for a test harness.
 *
 *  The runtime freezes committed state in dev AND prod so an illegal in-place
 *  mutation throws at the site; a harness that leaves `__aioDev` unset makes
 *  the same mutation silently succeed, so a green test means less than
 *  production does. Idempotent; a test that specifically needs prod-lenient
 *  behaviour can set the flag false itself.
 *  @internal */
export function _armTestStrict(): void {
  (globalThis as Record<string, unknown>).__aioDev = true;
  _sandboxAppDirs();
  _sandboxHomeStores();
}

/** The per-user stores OUTSIDE the app homes that code a test drives can
 *  write, each named by the variable that relocates it:
 *
 *  - `AIO_VERSIONS_DIR` — `~/.local/lib/aio-versions`, the provisioned
 *    framework versions every pinned app on the machine runs. MEASURED
 *    2026-09-24: a test wrote a mid-development snapshot there under the real
 *    release name; two real apps ran it for hours and `am pin` would not
 *    replace it (a provisioned version is immutable by design).
 *  - `AIO_FEEDBACK_DIR` — `~/.local/share/aio/feedback`, `am feedback`'s notes.
 *  - `AIO_INSTALL_ROOT` — `~/app`, where installed programs live.
 *  - `AIO_HOME` — the canonical install `am update` fetches, checks out and
 *    reinstalls `am` from. Pinned to an EMPTY directory: `am link` skips a
 *    candidate with no `mod.ts` (so it still finds the checkout under test),
 *    and `am update` refuses loud instead of mutating the real install.
 *
 *  Not here, deliberately: `XDG_CACHE_HOME` (`~/.cache/aio/tools`, `…/labs`)
 *  is a download cache — content-keyed, read-mostly, 100 MB+ per Electron
 *  runtime — and a private one per test process would re-download it every
 *  run; `~/.local/share/applications` and `~/.local/bin` move only with
 *  `HOME`, which the tests that install set themselves.
 *  @internal */
export const HOME_STORE_VARS = [
  "AIO_VERSIONS_DIR",
  "AIO_FEEDBACK_DIR",
  "AIO_INSTALL_ROOT",
  "AIO_HOME",
] as const;

/** Each {@link HOME_STORE_VARS} entry's sandbox subdirectory. */
const STORE_SUBDIR: Record<(typeof HOME_STORE_VARS)[number], string> = {
  AIO_VERSIONS_DIR: "versions",
  AIO_FEEDBACK_DIR: "feedback",
  AIO_INSTALL_ROOT: "install-root",
  AIO_HOME: "aio-home",
};

/** `<base>/<subdir>` for every store variable — the ONE layout both the
 *  in-process sandbox and the shard runner hand out. Pure. @internal */
export function homeStoreEnv(base: string): Record<string, string> {
  const b = base.replace(/[/\\]+$/, "");
  return Object.fromEntries(
    HOME_STORE_VARS.map((k) => [k, `${b}/${STORE_SUBDIR[k]}`]),
  );
}

let _storeBase: string | undefined;

/** Pin every {@link HOME_STORE_VARS} variable that is UNSET to a private dir
 *  under the test root. A value already set — by the runner, or by a test for
 *  its own fixture — wins; only "unset", which means "the real store", is
 *  replaced.
 *
 *  NOT once-per-process, unlike `_sandboxAppDirs`: tests pin these per test
 *  and hand them back, and a hand-back that DELETES the variable (the
 *  `prev === undefined` branch, or a bare `Deno.env.delete`) re-exposes the
 *  real store to everything after it. So every harness arm and every
 *  `tempDir()` re-checks — four env reads when nothing is missing. It cannot
 *  close the window between such a delete and the next arm; the shard runner
 *  (which sets them for the whole process, so a restore lands on the runner's
 *  value) and `check:home-clean`'s store diff are the nets for that.
 *  @internal */
export function _sandboxHomeStores(): void {
  try {
    const missing = HOME_STORE_VARS.filter((k) => !Deno.env.get(k));
    if (missing.length === 0) return;
    if (_storeBase === undefined) {
      const base = aioTestDir("stores-");
      _storeBase = base;
      globalThis.addEventListener("unload", () => {
        try {
          Deno.removeSync(base, { recursive: true });
        } catch {
          // aio-ok: process-exit cleanup of a directory this function made;
          // "already gone" and "the OS reaps it" are the only ways it fails.
        }
      });
    }
    const env = homeStoreEnv(_storeBase);
    for (const k of missing) Deno.env.set(k, env[k]!);
  } catch (e) {
    // Loud, not thrown — the same trade `_sandboxAppDirs` makes, and why.
    console.warn(
      `[aio:testing] could not sandbox ${HOME_STORE_VARS.join("/")} (${
        e instanceof Error ? e.message : e
      }). A test that provisions a framework version, installs, or writes ` +
        `feedback writes the REAL per-user store. Fix: run with ` +
        `--allow-env --allow-write, or pin them to a temp dir yourself.`,
    );
  }
}

// A harness must not be able to write into the user's home — not by design, and
// not by accident. App code legitimately asks `appDirs(appId)` where its files
// live (`<data>/files`, `<data>/tls`, …), and under a test that resolved to the
// developer's REAL `~/.<appId>`: one field report's server tests installed a
// fixture binary into the real install for the whole project, and the pollution
// then HID a second bug by making two tests pass against an artefact that only
// existed on that machine ("not a footgun — a loaded gun pointed at data the
// developer cares about").
//
// So the first harness use of the process pins every app directory into a temp
// sandbox, unless the runner already pinned one (aio's own suite does, in its
// `deno test` task). An explicit `registerAppDirs()` still wins per app — that is
// the escape hatch for a test that wants a specific fixture directory.
/** THE root for every directory a test creates: `~/tmp/aio/`.
 *
 *  USER SPACE, not `/tmp`. A test's scratch holds real application data — an
 *  `auth.db`, an `app.key`, TLS material, whatever an app under test wrote —
 *  and `/tmp` is world-writable with a sticky bit shared by every account on
 *  the machine. The directories themselves are 0700 either way; the reason not
 *  to put them under `/tmp` is that the parent is not ours, which is what makes
 *  the classic symlink and pre-creation races possible at all. Nothing about a
 *  test needs that exposure.
 *
 *  One predictable place, so "what did the tests leave behind" is one `ls` and
 *  one `rm -rf`. `AIO_TEST_ROOT` overrides it for a runner that wants its own.
 *
 *  `HOME` is read directly rather than through `paths.ts`: read the header of
 *  this file — everything reachable from here rides in every app's browser
 *  bundle, and importing a server module is how the bundler comes to refuse
 *  every browser build.
 *
 *  @internal */
export function aioTestRoot(): string {
  const override = Deno.env.get("AIO_TEST_ROOT");
  if (override && override.trim()) {
    Deno.mkdirSync(override, { recursive: true, mode: 0o700 });
    return override;
  }
  const home = (Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "")
    .replace(/[/\\]+$/, "");
  if (!home) {
    // No home to be private in — fall back rather than fail a whole suite, and
    // the 0700 below is then the only thing protecting it.
    const tmp = (Deno.env.get("TMPDIR") || "/tmp").replace(/[/\\]+$/, "");
    const root = `${tmp}/aio`;
    Deno.mkdirSync(root, { recursive: true, mode: 0o700 });
    return root;
  }
  const root = `${home}/tmp/aio`;
  Deno.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

/** A fresh directory under `aioTestRoot()`. @internal */
export function aioTestDir(prefix: string): string {
  return Deno.makeTempDirSync({ dir: aioTestRoot(), prefix });
}

let _sandboxed = false;
function _sandboxAppDirs(): void {
  if (_sandboxed) return;
  _sandboxed = true;
  try {
    if (Deno.env.get("AIO_APPS_DIR")) return; // runner already pinned it
    const dir = aioTestDir("apps-");
    Deno.env.set("AIO_APPS_DIR", dir);
    globalThis.addEventListener("unload", () => {
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch {
        // aio-ok: process-exit cleanup of a directory this function created
        // and nothing else refers to. The two ways it fails are "already
        // gone" (the outcome we want) and "the OS will reap it" — neither is
        // something a test author can act on, and a line here would print on
        // every run that ends with a still-open handle.
      }
    });
  } catch (e) {
    // NOT silent. The sandbox is the only thing standing between a test and
    // the developer's REAL `~/.<appId>`: without it `appDirs(appId)` resolves
    // to live application data, and one field report's server tests installed
    // a fixture binary into the real install for the whole project — then hid
    // a second bug by making two tests pass against an artefact that existed
    // only on that machine.
    //
    // A harness that fails to install that guard and says nothing is the exact
    // shape this project refuses: the tests still run, they just run pointed
    // at data someone cares about. It cannot THROW (a suite deliberately run
    // without --allow-env/--allow-write would stop working, and the guard is
    // protective rather than load-bearing for correctness), so it is loud
    // instead — once, naming the fix.
    console.warn(
      `[aio:testing] could not sandbox app directories (${
        e instanceof Error ? e.message : e
      }). appDirs() will resolve to the REAL per-user directories for the ` +
        `rest of this run, so a test that writes app data writes it to your ` +
        `home. Fix: run the suite with --allow-env --allow-write, or pin ` +
        `AIO_APPS_DIR=<tmp> yourself.`,
    );
  }
}

// ── Unobserved async-method failures ────────────────────────────────────
//
// `testCell` keeps a ledger: an async method that rejected with NOBODY looking
// surfaces at the next `settle()`, because a harness reporting success for the
// exact case it exists to catch is worse than no harness. `testUI` and
// `bootCells` did the opposite — `Promise.allSettled` over the pending calls,
// which swallows every rejection — so the ordinary `onClick={() => todo.add()}`
// shape passed one harness and failed the other with the SAME app code.
//
// Production is the tie-breaker and it agrees with `testCell`: the runtime
// logs the failure and dispatches `cell:__error`. It does not pretend the call
// succeeded. So the ledger moves here and both harnesses use it.
//
// "Observed" is decided the way the language decides it: attaching a handler
// (`await`, `.then`, `.catch`, `.finally`, `Promise.all`) counts as looking.
// The wrapper below is the same `_observedCall` `testCell`'s `send` returns.

/** What a harnessed method call returns: a REAL promise over `p` that tells
 *  `onObserved` the first time anyone looks at it.
 *
 *  A plain `{ then, catch, finally }` object did the looking-detection, and
 *  was not a Promise: `cell.inc() instanceof Promise` was true in production
 *  and false under `testCell`/`bootCells`/`testUI`, so a test of code that
 *  branches on it (`if (r instanceof Promise)`, a `Promise`-typed helper that
 *  checks) exercised the other branch. A subclass is a Promise to every check
 *  there is, and the language already routes every way of looking through
 *  `then`: `await` and `Promise.resolve`/`all`/`race` call it on a subclass
 *  instance (they only skip it for a plain `Promise`), and `catch`/`finally`
 *  are specified as calls to `this.then`. Derived promises are plain ones
 *  (`Symbol.species`), so only the call itself carries the hook.
 *  @internal */
export function _observedCall<T>(
  p: Promise<T>,
  onObserved: () => void,
): Promise<T> {
  return ObservedCall.over(p, onObserved);
}

class ObservedCall<T> extends Promise<T> {
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }
  #onObserved: (() => void) | undefined;
  static over<T>(p: Promise<T>, onObserved: () => void): ObservedCall<T> {
    let resolve!: (v: T | PromiseLike<T>) => void;
    let reject!: (e: unknown) => void;
    const call = new ObservedCall<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    call.#onObserved = onObserved;
    // Handled, but NOT looked at: the harness's own handler must not count as
    // the test observing the call (it reaches the ledger instead), and must
    // keep an unlooked-at rejection from killing the process. Called on the
    // base prototype so it bypasses the `then` below.
    Promise.prototype.then.call(call, undefined, () => {});
    p.then(resolve, reject);
    return call;
  }
  override then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    const look = this.#onObserved;
    if (look) {
      this.#onObserved = undefined;
      look();
    }
    return super.then(onFulfilled, onRejected);
  }
}

/** How a harness calls a `worker: true` cell's method — see
 *  `_callAcrossWorkerBoundary` (boot-refusals.ts). Passed in rather than
 *  imported: this module rides in the browser graph, which must not grow a
 *  dependency for a server-side harness concern. @internal */
export type WorkerBoundaryCall = (
  cellId: string,
  args: unknown[],
  run: (args: unknown[]) => unknown,
) => unknown;

/** One recorded failure and whether the caller ever looked at it. `named`:
 *  `err` is already the error to raise (an `onInit` throw), not a call's
 *  rejection to wrap in the unobserved-call wording. */
type LedgerEntry = {
  err: unknown;
  method: string;
  seen: () => boolean;
  named?: true;
};

/** One call whose promise has not settled yet. */
type OpenCall = {
  method: string;
  async: boolean;
  p: Promise<unknown>;
  seen: () => boolean;
};

/** A ledger installed over a booted cell set. */
export type CallFailureLedger = {
  /** Throw the first failure nobody observed, then forget every entry
   *  (delivered or reported — either way, done with them). */
  raise(): void;
  /** Wait, at most `budgetMs`, for every call nobody observed to settle, so a
   *  failure that lands just after the test body returned is in the ledger
   *  before `raise()` looks. Returns the calls still open when it stopped. */
  drain(budgetMs: number): Promise<string[]>;
  /** The SYNCHRONOUS teardown's half of `drain()`, which cannot wait. Call it
   *  BEFORE the runtime reset. It returns the unobserved async calls still in
   *  flight — the reset orphans those (their promises never settle again), so
   *  their outcome is lost and the caller must say so — and arranges for a
   *  sync-method call whose rejection already happened, but whose handler is
   *  still a microtask away, to fail loud instead of vanishing. */
  abandon(): string[];
  /** Put the cells' own bound method functions back. */
  restore(): void;
  /** Add failures the boot recorded before the ledger existed (an `onInit`
   *  that threw — see `_watchInitFailures`); the next `raise()` throws them. */
  adopt(failures: readonly InitFailure[]): void;
  /** Hold teardown for an async `onInit` still running (`method` names it):
   *  `drain()` waits for it, `abandon()` names it. Its failure arrives through
   *  `adopt`, so settling records nothing here. */
  track(method: string, p: Promise<unknown>): void;
};

/** Wrap every bound method on `cells` so a rejection nobody looked at is
 *  recorded instead of swallowed. Call AFTER the cells are bound (i.e. after
 *  the runtime booted them); `restore()` on teardown.
 *
 *  SYNC methods too. They used to be skipped on the claim that `testCell` does
 *  not ledger them either — but `testCell`'s sync send hands back a rejected
 *  promise nobody handles, which fails the test as an uncaught rejection. The
 *  runtime's bound method pre-catches the same rejection (fire-and-forget
 *  callers must not crash the app), so `onClick={() => cell.validate()}` with a
 *  throwing reducer failed `testCell` and passed `testUI` and `bootCells`,
 *  REDUCE_ERROR logged and all. One rule for every method: a failure nobody
 *  observed surfaces.
 *  @internal */
export function _watchUnobservedCalls(
  cells: readonly CellDef[],
  acrossWorkerBoundary: WorkerBoundaryCall,
): CallFailureLedger {
  const entries: LedgerEntry[] = [];
  const open = new Set<OpenCall>();
  const undo: (() => void)[] = [];
  for (const def of cells) {
    const asyncMethods = def.__aio?.asyncMethods;
    for (const key of def.__aio?.actionKeys ?? []) {
      const holder = def as unknown as Record<string, unknown>;
      const original = holder[key];
      if (typeof original !== "function") continue;
      const call = original as (...args: unknown[]) => unknown;
      const method = `${def.__aio.id}.${key}()`;
      const isAsync = asyncMethods?.has(key) === true;
      const worker = def.__aio?.worker === true;
      const wrapped = (...args: unknown[]): unknown => {
        const started = worker
          ? acrossWorkerBoundary(
            def.__aio.id,
            args,
            (a) => call.apply(def, a),
          )
          : call.apply(def, args);
        if (!isThenable(started)) return started;
        const p = started as Promise<unknown>;
        let observed = false;
        const seen = () => observed;
        const entry: OpenCall = { method, async: isAsync, p, seen };
        open.add(entry);
        // Recording (not re-throwing) also marks the rejection handled, so an
        // un-awaited failing call cannot escape as an unhandled rejection and
        // kill the test process — exactly what the runtime's own no-op catch
        // does today, minus the amnesia.
        p.then(
          () => open.delete(entry),
          (err) => {
            open.delete(entry);
            entries.push({ err, method, seen });
          },
        );
        return _observedCall(p, () => observed = true);
      };
      const creator = (def.__aio.actions as Record<string, unknown>)[key];
      if (creator) attachMeta(wrapped, creator);
      holder[key] = wrapped;
      undo.push(() => {
        // Only if nothing rebound it since — a later boot owns its own binding.
        if (holder[key] === wrapped) holder[key] = original;
      });
    }
  }
  const unobserved = () => [...open].filter((c) => !c.seen());
  return {
    raise() {
      const first = entries.find((e) => !e.seen());
      entries.length = 0;
      if (!first) return;
      if (first.named) throw first.err;
      throw unobservedError(first.method, first.err);
    },
    adopt(failures) {
      for (const f of failures) {
        entries.push({
          err: f.err,
          method: f.cell,
          seen: () => false,
          named: true,
        });
      }
    },
    track(method, p) {
      const entry: OpenCall = { method, async: true, p, seen: () => false };
      open.add(entry);
      const done = () => void open.delete(entry);
      p.then(done, done);
    },
    async drain(budgetMs: number) {
      const deadline = Date.now() + budgetMs;
      // Looped: a call that settles can start another (a follow-up dispatch),
      // and that one is just as unobserved.
      for (let left = budgetMs; left > 0; left = deadline - Date.now()) {
        const waiting = unobserved();
        if (waiting.length === 0) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled(waiting.map((c) => c.p)),
          new Promise((r) => timer = setTimeout(r, left)),
        ]);
        clearTimeout(timer);
      }
      // The settle handlers above are microtasks queued by the settlement
      // itself; let them record before the caller raises.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      return unobserved().map((c) => c.method);
    },
    abandon() {
      const still = unobserved();
      for (const c of still) {
        if (c.async) continue;
        // A sync method's reducer ran during the call, so its rejection has
        // ALREADY happened — only the handler that records it is still queued.
        // Nothing will ever read this ledger again, so the failure is thrown
        // where the runtime cannot swallow it: an unhandled rejection, which
        // fails the test module by name. Loud rather than late-and-silent.
        c.p.then(undefined, (err) => {
          throw unobservedError(c.method, err);
        });
      }
      return still.filter((c) => c.async).map((c) => c.method);
    },
    restore() {
      for (const fn of undo.splice(0)) fn();
      entries.length = 0;
      open.clear();
    },
  };
}

/** One `onInit` that threw during a harness boot. */
export type InitFailure = { cell: string; err: Error };

/** Record every `onInit` that throws while `cells` boot.
 *
 *  The runtime reports an `onInit` throw as INIT_ERROR and keeps booting — the
 *  right answer for a running app, whose other cells should still come up. A
 *  test is not a running app: the throw was a log line printed next to a
 *  PASSING test (testUI showed it only as post-test output), while the docs
 *  said it "throws, as aio.run does". So the harness records it, and its
 *  `settle()` / `dispose()` fail the test with it — the same way an
 *  unobserved failing call does (`CallFailureLedger.adopt`). The runtime's own
 *  behaviour is untouched: the throw still propagates to it and is still
 *  logged. Wrap BEFORE the boot; `restore()` puts each `onInit` back.
 *  @internal */
export function _watchInitFailures(
  cells: readonly CellDef[],
): {
  take(): InitFailure[];
  pipe(ledger: Pick<CallFailureLedger, "adopt" | "track">): void;
  restore(): void;
} {
  const failures: InitFailure[] = [];
  /** Async `onInit`s not settled yet — handed to the ledger (see `pipe`). */
  const running = new Map<Promise<unknown>, string>();
  const undo: (() => void)[] = [];
  /** Where a failure recorded AFTER the boot goes (see `pipe`). */
  let sink: ((failures: InitFailure[]) => void) | undefined;
  const record = (f: InitFailure) => {
    if (sink) sink([f]);
    else failures.push(f);
  };
  for (const def of cells) {
    const meta = def.__aio as unknown as Record<string, unknown> | undefined;
    const original = meta?.onInit;
    if (!meta || typeof original !== "function") continue;
    const cell = def.__aio.id;
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      let r: unknown;
      try {
        r = original.apply(this, args);
      } catch (e) {
        record({ cell, err: initFailureError(cell, e) });
        throw e;
      }
      // An `async onInit` fails by REJECTING. The runtime now reports that as
      // INIT_ERROR too (cell-compose-registry.ts) — which also means it is no
      // longer an unhandled rejection that failed the test by itself, so the
      // harness has to record it or the test would pass on a broken boot.
      const then = (r as { then?: unknown } | null)?.then;
      if (typeof then === "function") {
        // It may reject long after the boot the harness reads failures at —
        // an `onInit` that awaits real I/O — so it goes through `record`,
        // which hands it to the ledger once one is piped (see `pipe`).
        const p = Promise.resolve(
          then.call(r, undefined, (e: unknown) => {
            record({ cell, err: initFailureError(cell, e) });
          }),
        );
        running.set(p, cell);
        const done = () => void running.delete(p);
        p.then(done, done);
      }
      return r;
    };
    meta.onInit = wrapped;
    undo.push(() => {
      if (meta.onInit === wrapped) meta.onInit = original;
    });
  }
  return {
    take: () => failures.splice(0),
    // What the boot recorded, then every later failure as it lands. `take()`
    // alone read the list ONCE, right after the boot, so an async `onInit`
    // that rejected later was recorded where nothing looked again.
    // …and every `onInit` still running is held open in it: a teardown that
    // drains only CALLS reset the boot under a pending `onInit`, which then
    // rejected into a ledger nothing read again — a green test on a broken
    // boot.
    pipe(ledger) {
      sink = (f) => ledger.adopt(f);
      const now = failures.splice(0);
      if (now.length > 0) ledger.adopt(now);
      for (const [p, cell] of running) ledger.track(`${cell}.onInit()`, p);
    },
    restore() {
      for (const fn of undo.splice(0)) fn();
    },
  };
}

function initFailureError(cell: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  const named = new Error(
    `${cell} onInit threw — ${detail}\n` +
      `  cause: aio.run reports it as INIT_ERROR and keeps booting the other ` +
      `cells, so the app runs without whatever this onInit was to set up; ` +
      `this harness fails the test rather than reporting success.\n` +
      `  fix: an onInit that starts work dispatches it — ` +
      `\`app.dispatch({ type: "${cell}:<method>", payload: { args: [] } })\`` +
      ` — or leaves it to onStart (docs/state/lifecycle.md).`,
  );
  if (err instanceof Error) named.cause = err;
  return named;
}

/** The error an unobserved failure surfaces as — one wording for every
 *  harness and every path (raise, late rejection). */
function unobservedError(method: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  const named = new Error(
    `${method} failed and nothing awaited it — ${detail}\n` +
      `  cause: the call was made fire-and-forget (the ordinary ` +
      `\`onClick={() => cell.method()}\` shape), so its rejection reached ` +
      `no caller. Production logs it and dispatches \`__error\`; this ` +
      `harness surfaces it rather than reporting success.\n` +
      `  fix: await the call (or assert on it — \`await assertRejects(() => ` +
      `cell.method())\`) if the failure is expected; otherwise fix the ` +
      `method.`,
  );
  if (err instanceof Error) named.cause = err;
  return named;
}

/** How long a teardown that can wait gives un-awaited calls to finish, so a
 *  failure landing just after the test body returned still fails the test.
 *  Bounded because a long-lived call (a poller, a stream) is legitimate at
 *  teardown and must cost a test a moment, not its timeout. @internal */
export const _DISPOSE_DRAIN_MS = 250;

/** The line a teardown prints when it had to abandon unobserved calls whose
 *  outcome it can no longer learn. Not a throw: a long-lived call (a poller, a
 *  stream a component starts on mount) is a legitimate thing to still have
 *  running at teardown, and failing every such test would be a harness
 *  refusing ordinary apps. But not silent either — a failure inside one of
 *  these is invisible from here, and the test author has to know that.
 *  @internal */
export function _abandonedCallsWarning(
  harness: string,
  methods: readonly string[],
  spelling: string,
): string {
  // A pending `onInit` (held by `track`, named `<cell>.onInit()`) is no call:
  // nobody can await it, and a long-lived one — a poll loop — is an ordinary
  // cell. "Await the call" was advice with nothing to act on.
  const inits = methods.filter((m) => m.endsWith(".onInit()"));
  const calls = methods.filter((m) => !m.endsWith(".onInit()"));
  const initLine = inits.length === 0 ? "" : `[aio:test] ${harness} ` +
    `teardown with ${inits.join(", ")} still running — teardown orphans ` +
    `it, so if it fails afterwards this test cannot see it.\n` +
    `  fine if it is long-lived by design (a poll loop): end it from the ` +
    `cell's onDestroy, which teardown runs. If it should have finished, make ` +
    `the test wait for the state it sets up before teardown.`;
  if (calls.length === 0) return initLine;
  return (initLine ? initLine + "\n" : "") + _callsWarning(
    harness,
    calls,
    spelling,
  );
}

function _callsWarning(
  harness: string,
  methods: readonly string[],
  spelling: string,
): string {
  return `[aio:test] ${harness} teardown with ${methods.length} un-awaited ` +
    `call(s) still in flight: ${methods.join(", ")}. Teardown orphans them, ` +
    `so if one fails afterwards this test cannot see it${
      harness === "bootCells"
        ? " (and a write it makes after teardown is refused, loudly — it " +
          "can never land in a later test's state)"
        : ""
    }.\n` +
    `  fix: await the call (or \`await ${spelling}.settle()\`) before ` +
    `teardown; if it is deliberately left running, attach a handler ` +
    `(\`.catch(…)\`) to say so.`;
}

function isThenable(v: unknown): boolean {
  return !!v && (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function";
}

/** The last N method calls this test made, newest last — for a failure trace.
 *
 *  A failing UI assertion says what the surface looks like NOW. What it could
 *  never say is how it got there, and "dump the AIR tree and the last N
 *  dispatches" was the ask (report 2 §9.5): the sequence is usually the answer,
 *  and reconstructing it from a test body is exactly the work the trace exists
 *  to remove.
 *
 *  Wrapped the same way the unobserved-call ledger wraps, on the same objects,
 *  because a second interception mechanism over one set of methods is how two
 *  of them come to disagree about what ran. */
export function _recordCalls(
  cells: readonly CellDef[],
  max = 40,
): { recent: () => string[]; restore: () => void } {
  const ring: string[] = [];
  const undo: (() => void)[] = [];
  for (const def of cells) {
    for (const key of def.__aio?.actionKeys ?? []) {
      const holder = def as unknown as Record<string, unknown>;
      const original = holder[key];
      if (typeof original !== "function") continue;
      const call = original as (...args: unknown[]) => unknown;
      const label = `${def.__aio.id}.${key}`;
      const wrapped = (...args: unknown[]): unknown => {
        // Arguments are SUMMARISED, never serialized whole: a trace that
        // inlines a 2 MB payload is one nobody opens, and a secret in a
        // payload does not belong in a file the test leaves behind.
        ring.push(`${label}(${args.map(summarize).join(", ")})`);
        if (ring.length > max) ring.shift();
        return call.apply(def, args);
      };
      // The SAME line the ledger wrapper has, and the one this copy lost: a
      // bound method carries `.action()` and `.type` (the catalog), and
      // `schedule.after(ms, cell.method.action(id))` — the idiom the docs
      // teach — reads them off the WRAPPER. Without this every scheduled
      // follow-up in a testUI test was built from `undefined`, and the
      // failure pointed at the schedule, thirty tests away from the cause.
      // 1.0.0-beta shipped it; tests/testui-trace-keeps-action.test.tsx is red on it.
      const creator = (def.__aio.actions as Record<string, unknown>)[key];
      if (creator) attachMeta(wrapped, creator);
      holder[key] = wrapped;
      undo.push(() => {
        holder[key] = original;
      });
    }
  }
  return {
    recent: () => [...ring],
    restore: () => {
      for (const u of undo) u();
      undo.length = 0;
    },
  };
}

/** One argument, in a few characters. */
function summarize(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") {
    return v.length > 24
      ? JSON.stringify(v.slice(0, 24) + "…")
      : JSON.stringify(v);
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "function") return "fn";
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") return `{${Object.keys(v as object).length}}`;
  return typeof v;
}
