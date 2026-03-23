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
