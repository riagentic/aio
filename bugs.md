# Bugs — production-readiness audit findings

**Audited:** 2026-06-12 at `v1.0.0-alpha13` (commit `4dff8e7`), Deno 2.8.2 (TS 6.0.3).
**Method:** full test/check/lint run + manual code review of core paths (signals,
dispatch, persistence, WS server, offline queue, scheduler, dev checks) + live
boot smoke test of `examples/counter`. Every confirmed bug below has evidence;
suspected items are marked as such.

Severity: **P0** = breaks a core promise or the project's own gates ·
**P1** = wrong behavior users will hit · **P2** = quality/trust erosion ·
**P3** = minor/theoretical.

---

## P0

### B-1: Test suite is red on current Deno — SQLite worker fails type-check

**Evidence:** `deno task test` → `FAILED | 1924 passed | 19 failed`. Both
`tests/db.test.ts` and `tests/integration.test.ts` die with
`Uncaught (in worker "") Type checking failed`:

```
TS2591 [ERROR]: Cannot find name 'node:sqlite'.
import { DatabaseSync } from "node:sqlite";
    at src/db/db-worker.ts:4:30
```

All 16 SQLite tests in `db.test.ts` cancel; integration tests likewise.
`deno check src/db/db-worker.ts` reproduces it standalone.

**Root cause:** under Deno 2.8.2 / TypeScript 6.0.3, the worker module (which
carries `/// <reference lib="deno.worker" />`, `src/db/db-worker.ts:1`) no
longer resolves types for the `node:sqlite` specifier. Runtime behavior is
likely fine under `deno run` (no type-check by default), but any consumer who
runs `deno test`/`deno check` over code that spawns the DB worker is broken,
and the framework's own primary gate is red.

**Impact:** the entire SQLite subsystem (README headline feature) is untestable
on current stable Deno; CI/release gating impossible until fixed. README claims
"Deno 2.6+" — that claim is currently false for 2.8.x.

**Fix directions (pick one, then pin the supported Deno range in CI):**
- Add a types directive: `// @ts-types="node:sqlite"` is not valid — instead
  add `/// <reference types="npm:@types/node" />` or include `"node"` lib
  alongside `deno.worker` in the reference line, whichever satisfies TS 6.
- Or suppress at the import site (`// @ts-ignore node:sqlite types unavailable
  in worker lib scope`) with a tracking comment — pragmatic, contained.
- Verify against Deno 2.6, 2.7, 2.8 in the compat matrix afterwards
  (production-roadmap §W1).

### B-2: Signal graph drops updates — effect stuck with stale computed after `batch()`

**Evidence (runnable repro):**

```ts
import { batch, computed, effect, signal } from "./src/signal.ts";
const a = signal(0); const b = signal(0);
const c = computed(() => b.value * 10);
const seen: number[] = [];
effect(() => { seen.push(a.value + c.value); });  // reads a AND c
batch(() => { a.set(1); b.set(1); });
// seen === [0, 1]  — expected final 11. Effect never sees c's new value.
```

**Root cause (`src/signal.ts`):** two interacting design points:
1. Computed invalidation is itself a queued subscriber (`markDirtySub`,
   `signal.ts:373`). Within one flush batch, an effect ordered *before* the
   invalidation sub reads the computed while it is still clean → stale cache.
2. When `markDirtySub` then runs and calls `_notify(computed._subscribers)`,
   the effect is skipped because it is in `_inFlight` (`signal.ts:163`) — and
   it is never re-queued. The staleness is permanent until some other dep of
   the effect changes.

**Impact:** this is on the framework's hottest paths. Every DOM event handler
is wrapped in `batch()` (`src/renderer-hydrate.ts:252`), and server-patch
application uses `batch()` (`src/state-signals.ts:93`). Any component/effect
that reads a signal plus a `computed` derived from another signal written in
the same handler renders stale data with no error and no warning —
undebuggable from the outside.

**Fix direction:** don't silently skip in-flight subscribers — re-queue them
for the *next* iteration of the `_flush` while-loop (the loop already supports
multiple iterations and has the `_FLUSH_MAX_ITERATIONS` guard against true
cycles). Alternative: invalidate computeds eagerly (synchronously mark dirty
during `set()`, push-style) so a same-batch read can never see a stale-clean
computed; then `markDirtySub` only needs to notify, not mark. Add the repro
above plus a permutation matrix (orderings of signal/computed writes inside
and outside `batch`) as `tests/signal-batch-staleness.test.ts`.

### B-3: Lint gate is red

**Evidence:** `deno task lint` → `Found 29 problems` (e.g. `require-await` in
`src/sync/op-buffer.ts:358,391`, and others). Exit non-zero.

**Impact:** the project's own quality gates can't be used for CI/release
gating; new regressions hide behind existing noise.

**Fix:** burn the list down to zero (most are trivial `async`-without-`await`
removals); from then on the gate is binding. If a rule is intentionally
violated, suppress per-line with a reason, never globally.

---

## P1

### B-4: `await cell.method()` resolves successfully when the action was dropped

**Evidence:** `src/dispatch.ts:170–183` — when the dispatch is `closed`, or
the queue is at `QUEUE_MAX` (10 000), `dispatch()` reports the error internally
but returns `Promise.resolve()`. The caller's `await counter.increment()`
completes as if applied.

**Impact:** directly violates the locked Phase-2 contract ("every bound method
returns a Promise that resolves when the state change has been applied",
`todo.md`). Under overload, user code silently proceeds on unapplied state —
the exact class of bug the DX overhaul exists to kill.

**Fix:** return a rejected Promise carrying the already-created
`QUEUE_OVERFLOW` / closed-dispatch error (and ensure bound-method wrappers and
the browser ack path propagate the rejection per task 2.2's
unhandled-rejection policy). Update tests that rely on resolve-on-drop.

### B-5: False "esbuild not installed" warning on every standard dev boot

**Evidence:** boot `examples/counter` → `WARN esbuild not installed — dev mode
needs it for TSX transpilation`. The check (`src/lint.ts:194–212`) looks for
`node_modules/esbuild` under `Deno.cwd()`. The actual transpiler loads esbuild
via `await import("npm:esbuild@^0.24")` (`src/server-transpile.ts:23`), which
uses Deno's npm cache and works without any `node_modules/`.

**Impact:** scary-but-wrong warning in the default zero-config path; also
cwd-dependent (boot from a different directory changes the result). Trust
erosion — contradicts goal "detailed error descriptions" by training users to
ignore warnings.

**Fix:** probe reality instead of the filesystem: attempt the dynamic import
(cached, ~once) or call the same resolution the transpiler uses; only warn if
that fails. Drop the `node_modules` heuristic entirely except in
`nodeModulesDir` projects.

### B-6: esbuild loaded by two divergent specifiers

**Evidence:** `deno.json` pins `esbuild: npm:esbuild@0.24.2` (import-map
entry), but `src/server-transpile.ts:23` and `src/build-bundle.ts:156`
dynamically import the literal `npm:esbuild@^0.24` — bypassing the import map
pin. Dev transpile and prod bundle can resolve a *different* esbuild version
than the one the project pinned/tested.

**Fix:** import the bare specifier `"esbuild"` (resolved via import map) or
align both literals to the exact pinned version; add a test asserting the
loaded version matches `deno.json`.

---

## P2

### B-7: Multi-key persist treats a failed atomic commit as success

**Evidence:** `src/persistence.ts:96–102` and `:204–209` — `kvDb.setMulti()`
returns `Deno.KvCommitResult`; the code does `if (result.ok) prevPersistedKeys
= keys;` but on `ok: false` there is **no log, no error report, no retry**, and
the debug line `persist: saved multi` prints unconditionally.

**Impact:** currently theoretical (the atomic op uses no `.check()`s, so
`ok: false` shouldn't occur today) — but the pattern is a landmine: the moment
anyone adds a version check, persist failures become silent data loss.

**Fix:** `if (!result.ok)` → report via `_reportPersistError` and keep
`persistNeeded` true; move the "saved" debug inside the success branch.

### B-8: Offline queue silently drops actions at capacity

**Evidence:** `src/protocol-offline.ts:103` — `_saveOfflineAction` does
`if (countReq.result >= MAX_OFFLINE_ACTIONS) return;` with no `_diagEmit`, no
console signal. Every other failure path in the same file emits a diagnostic.

**Impact:** after 1000 queued offline actions, further user actions vanish
without trace — "worked offline yesterday, lost my edits today".

**Fix:** emit an `offline-queue-full` diagnostic (warning severity) once per
session, and surface queue depth via the existing vitals/diagnostic bus.

### B-9: `deno task check` coverage gap — worker-only and non-example code never type-checked

**Evidence:** `deno task check` checks `mod.ts aiol/mod.ts init.ts` + two
example files only. `src/db/db-worker.ts` (reached only via `new Worker(URL)`,
`src/db/async-db.ts:96`) is invisible to it — which is exactly why B-1 shipped
unnoticed. Any other dynamically-imported or worker-spawned module has the
same blind spot.

**Fix:** extend the task to `deno check src/ examples/` (or an explicit list
including every worker entry); wire into CI (production-roadmap §W1).

### B-10: Shutdown flush can drop a persist request that arrives mid-flush

**Evidence:** `src/persistence.ts:176–234` — `flushPersist()` builds its own
cycle whose `finally` only clears `inFlight`; unlike `_runPersistCycle`
(`:144–155`), it never re-checks `persistNeeded`. A `schedulePersist()` that
lands while the flush is writing (state changed by a late effect) is recorded
in `persistNeeded` but nothing consumes it if the process then exits.

**Impact:** rare lost-final-write on shutdown — the kind of bug that surfaces
as "my last click before closing didn't survive".

**Fix:** after `await cycle`, if `persistNeeded && !shuttingDown` run one more
cycle; or have `flushPersist` loop until `persistNeeded` is false.

---

## P3

### B-11: Auth token accepted via URL query parameter

**Evidence:** `src/server.ts:265–269` accepts `?token=` (timing-safe compare —
good), and the code itself calls out "token-in-URL deployments" as a hijacking
surface (`src/server-ws.ts:183`).

**Impact:** tokens in URLs leak via browser history, proxy logs, and Referer
(mitigated by `no-referrer` meta in generated HTML). Acceptable for
LAN-tool posture, not for "production without shame".

**Fix (roadmap-level):** prefer the `Authorization` header / cookie everywhere;
keep query-param as documented opt-in fallback for WS-upgrade contexts that
can't set headers, with a startup warning when used.

### B-12: Uncommitted working-tree drift

**Evidence:** `src/jsx-runtime.ts` modified but uncommitted (since before this
audit); `todo.md` task 2.1 checkbox unticked though commit `66226b4` claims it.

**Fix:** triage the diff (likely belongs to task 7.2/7.3), commit or stash;
reconcile the 2.1 checkbox after verifying its acceptance criteria.

### B-13: `issues.md` is stale — three of five issues are already fixed

**Evidence:** `src/signal.ts` already contains the P0 Set/Map fix (AIO-364,
`:184–190`), P1 dev tracing (`:252–272`), and P4 `{force}` (`:249`). Only P2
(`void sig.value` parent incantation — `todo.md` 7.5) and P3 (useSignal JSDoc)
remain. `issues.md` and `roadmap-to-goals.md` §R1 still present all five as
open.

**Fix:** update both docs; R1 shrinks to R1.3 (JSDoc) + 7.5. (Stale internal
docs are themselves a production-readiness defect — see roadmap §W5.)

---

## Suspected / needs investigation (not yet confirmed bugs)

- **S-1:** `_notify`'s `_inFlight` skip (`src/signal.ts:163`) may drop other
  notification shapes beyond the confirmed B-2 batch case (e.g. an effect
  setting a signal that feeds a computed read by an earlier-ordered effect in
  the same batch). The B-2 fix should be validated against a permutation test
  matrix, not just the single repro.
- **S-2:** `dispatch.drain()` (`src/dispatch.ts:488–492`) loops on
  `effectPromises` but new effects spawned by `onDone`-queued actions after
  drain starts may be missed — verify shutdown ordering guarantees with a test.
- **S-3:** Deno KV atomic limits in `setMulti` (`src/skv.ts:15–24`): >1000
  top-level keys or >800KB total per commit will throw at runtime. Error IS
  reported, but there's no chunking and no proactive size warning in multi
  mode (single mode has the 63KB warning). Needs a large-state test.
