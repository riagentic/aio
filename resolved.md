# AIO Framework — Resolved Issues

### ISSUE-1: Add heap/memory diagnostics to help detect OOM before crash ✅

**Reporter:** quant team (2026-03-22) · **Resolved:** 2026-03-23 **Resolution:**
Fully implemented — `memory-monitor.ts`, `diagnostics/` module,
`MEMORY_PRESSURE`/`MEMORY_CRITICAL` error codes, per-feature state sizing, trend
detection, `onMemoryPressure` callback. See
[diagnostics.md](docs/diagnostics.md) and [debugging.md](docs/debugging.md).

### ISSUE-2: Duplicate loggers — internal console log vs structured AioLogger ✅

**Reporter:** quant team (2026-03-23) · **Resolved:** 2026-03-23 **Resolution:**
Non-issue on inspection. There is ONE `log` singleton (`logger.ts:94`) that
routes to `AioLogger` when active, falls back to console (info+error) when not.
Logging is enabled by default — `logging: undefined` → `logCfg = {}` →
`AioLogger` created. Only `logging: false` disables it. No duplicate systems
exist.

### ISSUE-3: Dev server missing `/__aio/listeners.ts` route — browser 404 ✅

**Reporter:** space-invaders team (2026-03-23) · **Resolved:** 2026-03-23
**Resolution:** Route already exists at `server.ts:784-795`. Transpiles and
serves `listeners.ts` with correct `Content-Type: application/javascript`.
No 404.

### ISSUE-4: Memory monitor false alarms + Worker V8 heap limits ✅

**Reporter:** quant team (2026-03-23) · **Fixed:** 2026-03-23 **Severity:** Bug
/ Critical

**Root cause:** Memory monitor used `heapUsed / heapTotal` where `heapTotal` is
V8's lazily-allocated heap (always near `heapUsed`), not the actual maximum.
This produced false 90%+ alarms.

**Fix:** Now uses `heap_size_limit` from `node:v8` `getHeapStatistics()` as the
denominator — the actual V8 heap limit. Falls back to `heapTotal` if `node:v8`
is unavailable.

**Changes:**

- `src/memory-monitor.ts` — added `getHeapLimit` to `MonitorDeps`, `heapLimit`
  to `MemoryReport`, uses limit as denominator
- `src/aio.ts` — resolves `heap_size_limit` at startup via `node:v8`, passes to
  monitor
- `docs/debugging.md` — documented Worker isolate heap limit behavior
- `tests/memory-monitor.test.ts` — updated all tests with `getHeapLimit` dep

**Remaining (future enhancements):**

- ⬜ Memory monitor: identify Worker context in alerts
- ⬜ `aio.createWorker()` helper with context labeling
- ⬜ Startup check: log effective heap limit per isolate

### ISSUE-5: CSS `import './style.css'` in App.tsx causes MIME type error in browser ✅

**Reporter:** space-invaders team (2026-03-23) · **Resolved:** 2026-03-23
**Resolution:** CSS imports are now stripped during dev transpilation
(`server.ts` transpile function). AIO already injects `<link>` tags for
`style.css` automatically, so CSS imports in TSX were redundant. The transpiler
replaces them with a comment: `/* css import stripped — served via <link> */`.

### ISSUE-6: Update ISSUE-1 — memory monitor now exists ✅

**Reporter:** quant team (2026-03-23) · **Resolved:** 2026-03-23 **Resolution:**
Folded into ISSUE-1 (resolved) and ISSUE-4 (fixed). Memory diagnostics fully
shipped. Worker heap limit documented in debugging.md.

### AIO-1: UDS broadcasts send full state — no delta compression ✅

**Date:** 2026-03-24 · **Fixed:** 2026-03-24 **Severity:** High **Component:**
`src/aio.ts`

**Root cause:** Two bugs: (1) UDS broadcast path sent full JSON state on every
tick (~6.4MB/sec for 1.6MB state at 4/sec) while WS clients got delta-compressed
updates via `_computeDelta()`. (2) Trailing throttle flush set `udsDirty = true`
instead of `false`, so the dirty flag never cleared — every tick broadcast
regardless of changes.

**Fix:** Added `udsBroadcastState()` helper that applies `_computeDelta()` to
UDS path (same logic as WS). Fixed `udsDirty` flag. Snapshot and time-travel
paths force full state send (delta tracking reset). Reload signal broadcast left
as-is (not state).

**Commit:** `b68747e`

### AIO-2: Client diagnostics for connection health ✅

**Date:** 2026-03-24 · **Fixed:** 2026-03-24 **Severity:** Medium **Component:**
`src/vitals/`, `src/server.ts`, `src/browser.ts`

**Original problem:** No visibility into client connection health. Debugging UI
freezes/stale data required manual guesswork.

**Fix:** DiagReporter — split server+client diagnostic system that correlates
probe data into actionable console output.

**What shipped:**

- `DiagEvent` type with 5 kinds: freeze, stale, slow, disconnect, recovered
- Server-side reporter: correlates loop + transport probes → `slow`, `stale`,
  `disconnect` events with structured console output
- Client-side reporter: correlates render + pong data → `freeze`, `recovered`
  events in browser console
- `onDiagnostic` hook on `DiagnosticsConfig` for app-level telemetry
- Console throttling (2s debounce), recovery deduplication
- `onClientStateSent()` wired — last broadcast timestamp now tracked
- Broadcast payload size tracking per client (`/__aio/vitals` endpoint)
- Per-feature state size tracking (`/__aio/vitals` endpoint)
- `_applyPatch` reference stability — shallow-equal preserves references for
  unchanged patched keys, eliminating phantom re-renders
- `useAio()` dev warning — warns about full-state subscription
- Re-render storm detection (rule #7) — detects >30 subscribe callbacks/sec
- Pure `formatDiagEvent()` formatter — structured block or one-liner
- 78 vitals tests passing

**Files added:** `src/vitals/diag-reporter.ts`, `src/vitals/diag-formatter.ts`,
`tests/vitals/diag-reporter.test.ts`, `tests/vitals/diag-formatter.test.ts`

**Spec:** `docs/superpowers/specs/2026-03-24-vitals-diag-reporter-design.md`

### AIO-3: Dev server 404 on browser.ts sub-imports (vitals/*.ts) ✅

**Date:** 2026-03-24 · **Fixed:** 2026-03-24 **Severity:** Critical
**Component:** `src/server.ts`

**Root cause:** `browser.ts` imports from `./vitals/*.ts`. When served as
`/__aio/ui.js`, the browser resolves these to `/__aio/vitals/*.ts`. Only
explicit handlers for `ui.js` and `listeners.ts` existed — no catch-all.

**Fix:** Generic `/__aio/*.ts` handler (server.ts:871-895) resolves any
`.ts`/`.tsx` path relative to AIO src/, transpiles, and serves. Includes `..`
path-traversal guard. Future sub-imports are automatically covered.

**Commit:** `7a31376`

### AIO-4: useAio() unstable subscribe reference causes connection drop on page switch ✅

**Date:** 2026-03-24 · **Fixed:** 2026-03-25 **Severity:** High **Component:**
`src/browser.ts` — `useAio()`, `_subscribe`, nuclear cleanup

**Root cause:** `useAio()` created a new `_useAioSubscribe` closure every
render. `useSyncExternalStore` detected the changed reference and re-subscribed,
causing a transient `_listeners.size === 0` moment that triggered nuclear
cleanup (`_state = null`, connection closed). Result: silent "Connecting..."
reload loop on every page navigation.

**Fix (3 layers):**

1. Moved `_useAioSubscribe` to module scope — stable reference, no
   re-subscription
2. 300ms grace period on nuclear cleanup — transient listener gaps no longer
   trigger teardown
3. Dual-channel diagnostics (`console.warn` + `_diagEmit`) on all teardown
   events — no more silent failures

**Tests:** 9 cases in `tests/browser-subscribe.test.ts` **Spec:**
`docs/superpowers/specs/2026-03-25-subscription-stability-design.md` **Commit:**
`599240f`

### AIO-5: useFeature() returns null after extended runtime ✅

**Date:** 2026-03-24 · **Fixed:** 2026-03-25 **Severity:** Medium **Component:**
`src/browser.ts` — `useFeature()` / `useSyncExternalStore`

**Root cause:** Secondary symptom of AIO-4. Periodic nuclear cleanups created
brief `_state = null` windows captured by React concurrent reconciliation in
`useFeature()`'s `getSliceSnapshot`.

**Fix:** Resolved by AIO-4 fix — the 300ms grace period prevents transient
`_state = null` windows. Monitor for recurrence.

### AIO-6: syncIntervalMs root config ignored by both UDS and WS transports ✅

**Date:** 2026-03-25 · **Fixed:** 2026-03-25 **Severity:** High **Component:**
`src/aio.ts`

**Root cause:** `syncIntervalMs` was misplaced on `UiConfig` — it's a
server-side transport throttle, not a UI concern. Both UDS and WS transports
read from `ui.syncIntervalMs`, so apps setting it at root level got silently
ignored → default 10ms (100fps) flooding.

**Fix:** Moved `syncIntervalMs` from `UiConfig` to `AioConfig` root (breaking,
alpha-ok).

1. Removed from `UiConfig`, added to `AioConfig` and `FeaturesConfig`
2. UDS reads `config.syncIntervalMs ?? 10` directly
3. WS server receives `config.syncIntervalMs` (server.ts defaults to 10)
4. Updated docs: api.md, scaling.md, upgrade.md, changelog.md

### AIO-35: `_saveOfflineAction` missing IDB error handlers — silent action loss ✅

**Severity:** MEDIUM · **Fixed:** 2026-03-28 **Category:** Bug / Error Handling
**File:** `src/browser.ts`

**Bug:** `countReq` had no `onerror` handler — if IndexedDB `count()` failed,
the action was silently dropped. `store.add()` was fire-and-forget with no error
check. The outer `try/catch` only caught synchronous exceptions; IDB request
errors are async and bypassed it.

**Fix:** Added `onerror` handler to `countReq`. Captured `store.add()` return
and added `onerror` handler. Both emit `_diagEmit` with `offline-storage-error`
type, consistent with `_loadOfflineQueue` pattern. No more silent action loss.
