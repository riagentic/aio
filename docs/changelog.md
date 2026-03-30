# Changelog

## v1.0.0-alpha8

**Dynamic auth & nuclear audit hardening**

- `resolveUser` hook — async JWT/OAuth/database auth with `ResolveUserFn<S>`
  type. Unified `_buildUserResolver` factory, single auth code path (AIO-171)
- Patch compaction + size guard in broadcast protocol
- `ResolveUserFn` type exported from `mod.ts`

**Nuclear audit — 58 bugs fixed across 23 files (AIO-57..236)**

- 13 rounds of adversarial code review covering all 100 source files
- Security: prototype pollution guard on `_deepMergeFiltered` (AIO-238)
- Delta protocol: backpressure recovery, filtered merge, array identity
  patching, periodic resync hardening
- Renderer: flush guard on disposed root, hydration signal binding, keyed
  fragment placement, Suspense partial cleanup
- Feature system: proxy stale tracking, async batching, flow lifecycle cleanup,
  delegation leak, schedule prefix handling
- Electron: `pageReady` reset on F5 reload, IPC null cleanup
- Server: `stateForUI` memo fix for undefined, TT perf timing, schedule ID
  validation

---

## v1.0.0-alpha7

**Type-safe send & renderer split**

- `useFeature` infers method signatures from feature definition — `send` is
  fully typed
- `aio/air` and `aio/react` subpath exports — one import per renderer, all
  primitives included
- React compat hooks — `useState`, `useEffect`, `useCallback`, `useMemo` for
  zero-friction migration
- AIR renderer primitives (`useRef`, `onMount`, `onCleanup`, `effect`,
  `computed`, `signal`, `batch`) exported from `aio/air`

**Monolith decomposition**

- Extracted `middleware.ts` and `lint.ts` from `aio.ts`
- Renderer exports stripped from `mod.ts` — base is server/protocol only

**Bug fixes (AIO-55..70)**

- Proxy stale `ownKeys` on second+ `.map()`/spread (AIO-57)
- Signal equality — `.set()` same value no longer re-renders (AIO-59)
- Ref callback reliability (AIO-58), JSX native DOM event types (AIO-62)
- `useLocal` `.patch()` for single fields (AIO-66)
- `useFeature` type inference without double-cast (AIO-67)
- Array rendering `key` prop warnings (AIO-69)
- CJS server-only stubs (AIO-55), `aio://` scheme privileges (AIO-56)
- JSR no-slow-types compliance (explicit return types)

---

## v1.0.0-alpha6

**AIR native renderer (~8KB)**

- Signal-based VDOM engine with JSX, keyed reconciliation, auto-memo
  per-component reactivity
- SSR + hydration, ErrorBoundary, lifecycle hooks, context, portals, suspense
- Form bindings — `useForm()` with signal-backed validation, `useFieldArray()`
  for dynamic lists
- Animation — `useSpring()` physics-based tweens, `useTransition()` enter/exit
- Virtual scrolling — `useVirtualList()` for large datasets
- DevTools integration (component tree, render counts)

**Adapter architecture**

- `state-core.ts` as framework-agnostic foundation — React and AIR adapters
  consume it as thin layers
- New export paths: `@riagentic/aio/state-core`,
  `@riagentic/aio/adapters/react`, `@riagentic/aio/adapters/air`,
  `@riagentic/aio/jsx-runtime`

**Delta protocol hardening (AIO-26..34)**

- Electron IPC `__aio:ready` replays only `lastFullState` — no unsafe delta
  replay (AIO-26)
- UDS `__subs:` handling and per-client subscription filtering (AIO-27)
- `$f` marker protocol — filtered state merges instead of replacing (AIO-29)
- Control messages no longer corrupt `lastFullState` (AIO-30)
- `unflattenPatch` contradiction on empty→identity array transition fixed
  (AIO-31)
- Periodic resync every ~5s prevents permanent delta desync (AIO-33)
- `lastKeyJsons` updated after successful send, not before (AIO-33)
- Removed unsafe reference-equality shortcut in `_computeDelta` (AIO-34)

---

## v1.0.0-alpha5

**Identity-keyed array delta compression (AIO-12)**

- Arrays containing objects with `id` fields are now detected by `flattenKeys`
  and sent as identity-keyed deltas instead of full replacement
- Wire format: `$arr` marker + `$id:<key>` per-element patches + `$rm` for
  removals — only changed elements are sent
- Typical savings: 120KB → 7.5KB per tick for a 160-element array
- Browser-side `_idMaps` registry reconstructs arrays from patches preserving
  object identity (React keys stable across updates)

**4-layer wasted render prevention (AIO-11)**

- `useProjection(fn, deps)` — derive data from state with structural sharing;
  components only re-render when the projected value actually changes
- `memo(Component, compare?)` — aio-aware memo that uses `_shallowEqual` per
  prop (not referential equality on the entire props object)
- `aiol` lint rule: warns when `.map()` renders `memo()` components without
  `useProjection()`
- Runtime dev warning: console.warn when full-state subscription detected in
  `useAio()`, deduplicated per call site

**Deep proxy-tracked subscriptions**

- `useAio()` now auto-tracks which state paths each component accesses via Proxy
  interception
- Server filters delta broadcasts to only include paths the client actually
  reads — reduces bandwidth for large state trees
- Subscription filter sent on connect and updated on access pattern change

**UDS ghost socket elimination (AIO-24/AIO-25)**

- Removed idle timeout from UDS connections — local sockets stay alive
  indefinitely (OS handles cleanup on process death)
- Server explicitly calls `conn.close()` on read-loop end — no more ghost
  sockets surviving after client disconnect
- IPC keepalive: browser sends `__ping` every 60s over IPC bridge as
  defense-in-depth for passive viewing (dashboards, monitoring)
- Write error handling: failed `sock.write()` in Electron main destroys socket
  and notifies renderer via `__aio:close`

**Framework reliability fixes (AIO-14..23)**

- 10 targeted fixes across dispatch, flow, server, and electron modules
- Improved error propagation, edge case handling, and connection lifecycle

**JSR documentation score — 100%**

- JSDoc on all public exports across all 4 entrypoints
- All transitively-referenced types re-exported from `mod.ts`
- `deno doc --lint` passes with zero errors

---

## v1.0.0-alpha4

**Flow cross-feature state access**

- `ctx.getFullState()` — read the full app state tree (all features) from inside
  a generator. Same function available in `onInit`/`onDestroy`/`execute`, now
  exposed in `GenCtx`. Fresh after each flow step.
- `ctx.when(predicate, opts?)` — wait until a state condition is true. Checks
  immediately (resolves instantly if already true), then re-checks after every
  dispatch. Supports `{ timeout }` option. Predicate receives the full app
  state. Works inside `ctx.race` and `ctx.all`.
- `notifyStateListeners` called after every reduce cycle (including
  `__FlowState` mutations from `ctx.mutate`/`ctx.done`)

**Vital signs — client diagnostic system**

- New `src/vitals/` module: three probes (loop, render, transport) + hint engine
  for detecting and diagnosing UI freezes
- `LoopProbe` — server-side dispatch metrics: reduce timing, queue depth, drain
  rate, effect backlog, circuit breaker state, p95 reduce time
- `RenderProbe` — client-side `setTimeout` drift freeze detection with action
  correlation and death spiral detection
- `TransportProbe` — ping/pong RTT measurement over WebSocket with server-side
  client liveness watchdog
- `HintEngine` — correlates all probe signals into root-cause hints with 7
  pattern rules and severity classification (`likely` / `possible` /
  `speculative`)
- Severity model: `healthy -> degraded -> warning -> frozen -> recovered`
- `VitalAlert` emitted via `onVitalAlert` callback with correlation IDs
- HTTP endpoint: `GET /__aio/vitals` returns loop metrics + client liveness
- Configurable per-layer thresholds, heartbeat interval, hint toggle
- Enabled by default (dev: hints on, prod: hints off). Kill switch:
  `vitals: false`

**DiagReporter — actionable developer diagnostics**

- Split architecture: server-side reporter (slow, stale, disconnect) +
  client-side reporter (freeze, recovered) — each outputs to its respective
  console
- Structured console output: multi-line blocks with trigger, queue depth,
  transport status, and root-cause hints for `likely`/`possible` severity;
  one-liners for recoveries and speculative events
- `onDiagnostic` hook on `DiagnosticsConfig` — fires for every `DiagEvent`, wire
  to Sentry/Datadog/custom telemetry. Not throttled (app controls its own sink)
- Console throttling: same kind+trigger suppressed for 2s to prevent spam
- Recovery deduplication: `recovered` emitted only on actual transition from
  degraded

**PressureMonitor — resource pressure warnings**

- Payload size warnings when broadcast exceeds 500KB (configurable)
- Broadcast rate warnings at 30/sec (configurable, tumbling 1s window)
- Client render degradation warnings (50ms/200ms drift — previously silent)
- New DiagEvent kind `"pressure"` — fires via console + `onDiagnostic` hook
- Server-side: `createPressureMonitor()` in vitals system
- Client-side: inline render pressure in `onStatusChange`
- Dev-only by default. Kill switch: `vitals: { pressure: false }`

**Subscription stability (AIO-4/AIO-3)**

- Fixed: `useAio()` created unstable subscribe reference every render, causing
  `useSyncExternalStore` to re-subscribe and trigger full teardown (state null,
  connection drop) on page switch. Silent — no errors in console
- `_useAioSubscribe` moved to module scope — stable reference, no
  re-subscription
- Nuclear cleanup replaced with 300ms grace period. Transient listener gaps
  (React reconciliation, page switches) no longer trigger teardown
- Dual-channel diagnostics: `console.warn` + `_diagEmit` on all teardown events.
  Teardown, teardown-averted, and state-nullified events are now always visible
  in browser/Electron devtools
- AIO-3 (`useFeature()` returns null after extended runtime) resolved as
  secondary symptom — the grace period prevents the transient `_state = null`
  windows

**Diagnostic bus & health overlay**

- **Diagnostic bus** — unified event channel for silent failures, visible via
  health overlay (green/yellow/red dot, expandable panel). 18 previously-silent
  failure points now emit dev-mode diagnostics
- **Smart module loader** — pre-validates imports before `import()`. Shows root
  cause (404, transpile error, server error) instead of generic "Failed to fetch
  dynamically imported module". Per-file error storage replaces global singleton
- **New error code:** `PERSIST_ERROR` for state persistence failures
- **New classifier:** `dynamic-import-failed` for browser module load errors

**Reduce phase performance breakdown**

- `PerfMetric` now includes optional `breakdown` field with phase-level timing:
  `produce`, `clone`, `spread`, `routing`, `listeners` (all in ms)
- Breakdown visible in time-travel panel, `perf.log` budget violations, and
  `onPerf` callback
- Zero-cost when `perfCheck: "off"` — no `performance.now()` calls
- `perf.log` entries for `BUDGET_REDUCE` now include phase breakdown showing
  where time was spent

**Render optimization**

- `_applyPatch` reference stability: shallow-equal comparison preserves object
  references for unchanged patched keys, eliminating phantom re-renders
- `useAio()` dev warning: console.warn when full-state subscription detected,
  deduplicated per call site. Active instances ref-counted (accurate after
  unmount)
- Re-render storm detection (hint rule #7): timer-based 1s window, warns when
  > 30 subscribe callbacks/sec
- Broadcast payload size tracking per client — UTF-8 bytes (exposed via
  `/__aio/vitals`)
- Per-feature state size tracking — UTF-8 bytes (exposed via `/__aio/vitals`)
- `onClientStateSent()` wired — last broadcast timestamp per client now tracked
- Pure `formatDiagEvent()` formatter — zero side effects, fully testable

**Graph validator**

- New `src/graph-validator.ts` — validates feature dependency graph at
  `aio.run()` startup
- Detects circular dependencies, missing features, and invalid `dispatchTo`
  references

**Internals**

- `structuredClone` failure in dispatch now reports `EFFECT_ERROR` and drops
  effects instead of silently continuing with revoked Immer draft refs
- Effect timeout is now hard-cancel — timed-out effects are abandoned and
  counted toward circuit breaker. Late rejections suppressed
- `db.transaction()` callback: `_inTransaction` flag resets even when `BEGIN`
  fails, preventing permanent deadlock
- Extracted `server-html.ts` from `server.ts` (MIME, import map, HTML gen, error
  classification)

**Examples**

- Todo app (`examples/todo/`) — CRUD, filtering, inline editing, persistence
- Interactive playground (`examples/playground/`) — standalone HTML, 3 examples,
  live code editor

---

## v1.0.0-alpha3

**Logging enabled by default**

- Logging is now on by default — set `logging: false` to disable
- No need for `logging: true` or `logging: {}` in most apps

**Logger rewrite — plain text, wipe-on-start, colored console**

- Log format changed from JSONL to plain text — human-readable, grep-friendly
- Format:
  `{timestamp}  {LEVEL}  {category}  {message}  {data}  {duration}  {source}`
- Colored ANSI console output in dev mode (auto-detected) — keyword highlighting
  for started/ready/failed/error
- Console fallback (when AioLogger not active) mirrors app.log — prints info +
  error only
- Logs wiped on each app start (clean slate). Use `backupLogs: true` (or
  `--backup-logs`) to rotate instead
- `rotate: { keep }` config replaced by `backupLogs: boolean` +
  `backupKeep: number`

**Unified logger singleton**

- Single `logger.ts` module — removed duplicate logging from `aio.ts`
- Shared `Listeners<T>` extracted — deduplicates browser.ts and standalone.ts

**First-class error infrastructure**

- `AioError` class — structured errors with `code`, `source`, `context`,
  `correlationId`, `stateSnapshot`
- 16 error codes: `REDUCE_ERROR`, `EFFECT_ERROR`, `FLOW_ERROR`, `INIT_ERROR`,
  etc.
- Correlation IDs on all errors — trace cause through `debug.log`
- Memory pressure monitor — heap usage alerts before OOM, configurable
  thresholds
- Time-travel error markers — errors visible as red markers in TT timeline
- `MemoryConfig` type exported:
  `{ enabled?, interval?, warnThreshold?, criticalThreshold?, onMemoryPressure? }`

**Diagnostics module — zero-config observability**

- New `src/diagnostics/` module: state diffs, action log, checkpoint recovery,
  crash handler
- State diffs: key-level change detection logged to `debug.log` after each
  action
- Action log: rolling JSONL file (`log/actions.jsonl`) with configurable max
  entries
- Checkpoint: debounced atomic state snapshots to `log/checkpoint.json` with
  `onCheckpointRestore` recovery callback
- Crash handler: global `unhandledrejection`/`error` listeners with emergency
  checkpoint write
- Two-level config: sensible dev/prod defaults +
  `diagnostics: { dev: {...}, prod: {...} }` overrides
- Kill switch: `diagnostics: false` disables entire subsystem
- New `afterAction` hook in dispatch for post-reduce observation

**Circuit breaker rolling window**

- `circuitBreaker.window` option: rolling time window for error counting (ms)
- `featureErrors` changed from cumulative count to timestamp array — enables
  sliding window pruning
- Without `window`, behavior is unchanged (cumulative count, backward
  compatible)

**Console cleanup**

- ~27 raw `console.*` calls in runtime files routed through structured `log.*`
- CLI tools (`build.ts`, `am.ts`, `electron.ts`, `standalone.ts`) keep
  `console.*` — outside app lifecycle

**Performance**

- Time-travel `MAX_ENTRIES` bumped to 20,000 (was 10,000)

---

## v1.0.0-alpha2

### BREAKING: Config audit — naming, defaults, fallbacks

**Config renames:**

- `persistDebounce` → `persistDebounceMs`
- `effectTimeout` → `effectTimeoutMs`
- `deltaThreshold` → `fullStateThreshold`
- `perfMode` → `perfCheck` (`'on'` | `'off'`)
- `singleton: 'takeover'` → `singleton: true` + `killExisting: true`

**Config restructure:**

- `ui.electron` + `headless` →
  `client: 'electron'|'browser'|'cli'|'server-only'`
- `ui.keepAlive` → `keepServer` (top-level)
- `ui.transport` → `transport` (top-level)
- `ui.syncRate` → `syncIntervalMs` (top-level)

**Now mandatory:** `appVersion` (was optional, defaulted to '0.1.0')

**CLI flag changes:**

- `--no-electron` / `--headless` → `--client=electron|browser|cli|server-only`
- `--url` → `--server-url`
- `--keep-alive` → `--keep-server`
- New: `--kill-existing`

**Behavior changes:**

- Electron not installed + `client:'electron'` → error (was: silent browser
  fallback)
- TLS cert fails + `--expose` → error (was: silent HTTP fallback)
- KV open fails + `persist:true` → error (was: silent no-persistence)
- `$HOME` missing + persistence → error (was: /tmp fallback)

**Breaking: `appId` mandatory in `aio.run()`**

- `appId` must be passed in `aio.run({ appId: 'my-app', ... })` — no longer read
  from `deno.json`
- Compiled builds don't have `deno.json` at runtime, so appId must be hardcoded
  in the app
- `am` CLI still reads `deno.json` as dev-time fallback (or use `--app=X`)
- Linter now warns if `appId` is in `deno.json` (with auto-fix to remove it) and
  errors if missing from `aio.run()`

**Promise-returning dispatch** (ISSUE-2)

- `dispatch()` returns `Promise<void>` — resolves after reduce + sync effects
  complete
- All bound feature methods return Promise: sync → `Promise<void>`, async →
  `Promise<T>`
- `await syncMethod()` now works correctly (was a silent no-op before)
- No breaking change — fire-and-forget calls work unchanged (returned Promise
  ignored)

**Browser Import DX — three-layer defense**

- esbuild plugin intercepts `@std/*` and `node:*` in prod builds — returns
  throwing proxy modules with clear error messages instead of cryptic browser
  failures
- Dynamic import map: npm packages in `deno.json` automatically aliased for
  browser via esm.sh (no manual config needed)
- `aiol` lint: 4 new checks — server-only imports in feature files, bare
  specifier validation, transitive detection (2 levels), static dynamic import
  detection
- Error overlay enhanced with fix suggestions — classifies errors and shows
  actionable "FIX" box
- Dev startup validation — warns about browser-unsafe imports on boot
- All backward compatible — only affects code paths that were already broken

**Reliable live reload** (ISSUE-1)

- UDS wiring, event filter, health monitor, CSS selector, cache normalization,
  diagnostics

## v1.0.0-alpha1

**Breaking: all internal endpoints moved under `/__aio/`**

- `/__trojan/*` → `/__aio/trojan/*`
- `/__snapshot` → `/__aio/snapshot`
- `/__health` → `/__aio/health`
- User routes (`/`, `/ws`, `/app.js`, static files) unchanged

**Security hardening**

- Trojan POST endpoints require `X-AIO` header (CSRF protection)
- Trojan rate-limited to 100 req/s
- SQL allow-list: only `SELECT` queries (replaces deny-list)
- All trojan POST mutations audit-logged
- `allowedOrigins` enforced even when `--expose` active (additive with token
  auth)
- Dev-only endpoints (`history`, `errors`, `client/`, `click/`, `tt`) return 403
  in prod
- Snapshot size limit (10MB) enforced on trojan snapshot POST
- Path traversal fix for Windows root drive edge case

**Mixed mode features**

- `feature()` supports methods + actions + effects in one feature — name
  collisions validated
- `__aio.id` replaces `__aio.prefix` — correct semantic name for feature
  identity
- `am dispatch` supports both methods (positional args) and actions (named
  payload)

**Audit: all 10 bugs (B1–B10) resolved**

- Trojan snapshot size limit, offline queue bound, selector comment,
  `_anyProcessed` flag, Electron cleanup, path traversal, cron UTC docs, `--`
  CLI filter, `cmdStatus` exit codes, SQL `insertMany` removal

**Docs**

- Architecture data flow diagram in core.md
- `composeMiddleware` and `matchEffect` expanded with examples in api.md
- Cron syntax documented in scheduling.md
- Security model consolidated in auth.md

**Tests: 801 passing (13.5K lines)**

---

## v0.9.5

**Fix: Electron dev mode stuck on "Loading..."**

- `did-finish-load` fires when HTML is parsed, but `await import('/App.tsx')`
  loads modules asynchronously. The previous 50ms timeout expired before
  `browser.ts` registered its IPC listeners, so the buffered state message was
  dropped silently.
- Replaced timeout guessing with a `__aio:ready` handshake: `_connectIPC()`
  sends `__aio:ready` after registering all listeners; Electron main replies
  with `__aio:open` + last buffered state — guaranteed to arrive after listeners
  exist.

---

## v0.9.4

**Fix: UI fails to load from JSR (npm: specifier bug)**

- esbuild, when running inside Deno, rewrites bare imports to Deno specifiers
  (e.g. `'react'` → `'npm:react@^18'`). Browsers can't fetch `npm:` URLs,
  causing `Failed to fetch dynamically imported module` for any app using
  JSR-published aio.
- `transpile()` in server.ts now strips the `npm:` prefix and version suffix
  after transform, so browsers resolve via the HTML import map as intended.

**Fix: compile:electron and am tasks failed from JSR**

- `deno.json` only exported `.` — added `./src/build` and `./src/am` exports so
  `jsr:@riagentic/aio@0.9.4/src/build` and `/src/am` resolve correctly.
- README now pins exact version (`0.9.4`) instead of `^0.9` range — prevents
  users from silently picking up a broken earlier version.

**Ports: random ephemeral, no more conflicts between apps**

- Server port now defaults to a random free port in the private range
  49152–65535 (bind-tested, not just checked). Explicit `port:` config or
  `--port` flag still override.
- Lock and socket files moved from `/tmp/` into `/tmp/aio/` (or
  `$XDG_RUNTIME_DIR/aio/`) — one directory to `rm -rf` when needed. Filenames
  simplified: `counter.lock`, `counter.sock` (no redundant `aio-` prefix inside
  the `aio/` dir).
- `am` already reads port and trojanPort from the lock file — no changes needed
  there.

**Startup log: full resource + config listing**

- Every open resource is listed on startup: `web`, `ws`, `uds`, `trojan` (only
  when TLS active).
- All app settings shown (even defaults): `id`, `title`, `singleton`, `persist`,
  `expose`, `auth`, `sqlite` (when configured), `schedules` (when configured),
  `maxconn` (when configured).
- `ws:` uses `wss://` when TLS is active; `web:` uses `https://` when TLS is
  active.

**Tests**

- Dev-mode server test suite: verifies `/__aio/ui.js` has no `npm:` specifiers,
  import map uses CDN URLs, `/__aio/error` and `/__aio/client-error` endpoints
  work correctly. Would have caught the v0.9.3 UI breakage.
- Config test: verifies `deno.json` exports `./src/build` and `./src/am` —
  catches missing export regressions.

---

## v0.9.3

JSR-native builds + Electron install simplification (see v0.9.2 below — same
release train).

---

## v0.9.2

**JSR-native builds — all compile targets work from JSR**

- esbuild HTTP plugin: `build.ts` now loads `browser.ts` / `standalone.ts`
  directly from JSR via HTTP — no temp dir, no manual dep list, esbuild resolves
  the full import graph automatically
- Android template embedded as TypeScript constants (`src/android-template.ts`,
  generated by `scripts/gen-android-template.ts`) — eliminates file-fetch
  workaround and stops copying `.gradle/` build cache into new projects
- `import.meta.dirname` was `null` for JSR/HTTP modules — all affected paths now
  use `new URL(..., import.meta.url)` throughout server.ts and build.ts

**Electron install simplified**

- `electron` removed from default `deno.json` imports — no longer downloaded for
  browser/CLI users
- `install:electron` task:
  `deno add npm:electron && deno install --allow-scripts=npm:electron` (was two
  manual steps)
- Electron launch failure now logs a warning + fallback URL instead of silently
  doing nothing

---

## v0.9.1

**Rich error overlay — Build Error and Runtime Error**

- **Build Error** now shows file path, line:col, the source line, and a `^`
  caret at the exact column (structured esbuild data via `/__aio/error` JSON
  endpoint)
- **Runtime Error** — new category for JS crashes after transpilation (wrong
  import, `null.x`, top-level throw, React render throw); previously showed a
  blank "Build Error" with no info
- Both error types always `console.error` to DevTools so the full trace appears
  in F12 even when the overlay is visible
- Runtime errors POST to `/__aio/client-error` → written to `debug.log` and
  surfaced by `am errors`; critical for Electron where DevTools isn't open by
  default

**Live reload — always-active dev WebSocket**

- Dev HTML page now establishes a `_devWs` connection before the app boots,
  independent of `useAio`
- Previously, live reload only worked when the app used `useAio`/`useFeature`;
  plain React apps or apps that crashed before first render got no reload
- `_devWs` handles `__reload`, `__css` (hot-swap stylesheet), and `__boot:`
  (reload on server restart)
- Apps using `useAio` have two WS connections in dev mode — the page-level
  reload WS and the state-sync WS; both are lightweight and dev-only

---

## v0.9.0

**UI sync rate throttling**

- `ui.syncRate?: number` — cap UI push rate to 1 update per N ms (default: `10`
  = 100fps)
- Leading edge fires immediately (via microtask coalesce); trailing flush
  guarantees last state arrives within N ms
- Prevents React re-render floods from high-frequency dispatch (timers,
  generators, reactive chains)
- Applies to both WebSocket and UDS (Electron IPC) transports
- `syncRate: 0` = microtask-only coalescing (old behavior, unbounded)

**Async Worker-based SQLite — replaces sync ORM**

- `AioDB` / `AioTable<T>` removed — replaced by `DB` interface with fully async
  methods
- `openDb()` / `loadTables()` / `syncTables()` / `reloadTable()` removed from
  public API (now private internals)
- `createDB(path, opts?)` — new factory for standalone DB access;
  `opts: { readonly?, pragmas?, readers? }`
- `DEFAULT_PRAGMAS` exported — the default pragma set applied by `createDB`
- `DB.query<T>(sql, params?)` → `Promise<QueryResult<T>>` — SELECT, rows in
  `.rows`
- `DB.execute(sql, params?)` → `Promise<QueryResult>` — INSERT/UPDATE/DELETE,
  changes in `.changes`
- `DB.transaction(stmts[])` → `Promise<QueryResult[]>` — atomic multi-statement
  batch
- `DB.close()` → `Promise<void>`
- `QueryResult<T>` = `{ rows: T[], changes: number, lastInsertRowId: bigint }`
  (`lastInsertRowId` is now `bigint`, was `number`)
- `readers?: number` on `createDB` opts — N readonly Workers for parallel reads;
  `query()` round-robins, `execute()`/`transaction()` go to writer
- `app.db` type changed from `AioDB | undefined` to `DB | undefined` — all
  `app.db` calls now need `await`
- Permissions: `--allow-read --allow-write` only — `--allow-ffi` no longer
  required
- All SQLite docs consolidated in [sqldb.md](./sqldb.md)

**Log rotation on (re)start**

- Each app start renames existing logs: `debug.log` → `debug.log.1`,
  `debug.log.1` → `debug.log.2`, etc.
- `rotate.keep` controls how many archives to retain per file (default: 7, 0 =
  unlimited)
- `rotate.maxMb` removed — startup rotation replaces size-based rotation
- Fresh log files created automatically after rotation

**`log` — public logging singleton**

- `import { log } from 'aio'` — usable from any feature or effect file
- `log.info / warn / error` → `app.log` (+ `error.log` for errors, `warning.log`
  for warnings); `log.debug / trace` → `debug.log`
- Each entry includes `src: "filename.ts:line"` — auto-detected from call stack,
  no manual tagging needed
- Silent no-op when `logging` is not configured in `aio.run()` — safe to use
  unconditionally
- Browser-side `log` is a no-op stub (server-only writes)
- `LogLevel` type exported from public API

**Scaffolder**

- Generated projects use `jsr:@riagentic/aio` — no longer downloads framework
  source
- `init.sh` passes `--reload` to bust stale Deno caches on fresh install
- `test` task added to generated `deno.json`

**Type system**

- `noUncheckedIndexedAccess` enabled — indexed access now returns
  `T | undefined` throughout

---

## v0.8.0

**Unified API — `feature({ methods })` is the default**

- `reactive()` removed — `feature({ methods })` is the one API for method-style
  features (migration: rename only)
- `feature({ methods })` is the default; `feature({ actions, reduce })` is the
  explicit/advanced style
- `bridge()` removed — `call({ timeout, retries }, ...)` covers all
  request/response patterns

**Object-form `reduce` and `execute` — named handlers replace switch/case**

- `reduce: { increment(state, payload) { ... } }` — one method per action key,
  payload typed from action creator
- `execute: { persist(app, payload) { ... } }` — one method per effect key,
  payload typed from effect creator
- No more `switch(action.type)`, no more `{ A }` / `{ E }` context parameters in
  the default path
- Function form (`reduce(state, action, { on, emit }) {}`) remains as escape
  hatch for foreign action handling

**Generators — unified sequential workflow API**

- Works in both styles: `feature({ methods, generators })` and
  `feature({ actions, generators })`
- Methods style: each generator auto-creates an action `${featureName}:${name}`
  — no trigger string needed
- Actions style: generator key must match an action key — becomes the trigger
- `flows:` key removed from both feature styles — `generators` is the only path
  now
- `flow()` export removed; `cancelOn()` exported instead

**`GenCtx<S>` — typed generator state**

- `GenCtx<S>` is generic — `S` is inferred from the `state:` config
  automatically
- `ctx.mutate('label', s => { s.count += 1 })` — `s` is typed as your feature
  state, no casts needed
- `ctx.done(s => { s.orderId = id })` — same, final mutation is fully typed
- `ctx.getState()` returns `S` — read state after a step without casting
- `ctx.mutate` is the primary name — `ctx.step` kept as a deprecated alias
- Standalone reusable generators: annotate `ctx: GenCtx<{ count: number }>`
  explicitly

**Typed generator arguments — no more payload casts**

- Actions-style generators receive the payload object directly:
  `function*(ctx, { item, qty }: { item: string; qty: number })`
- Methods-style generators receive spread args:
  `function*(ctx, item: string, qty: number)`
- `action.payload as { ... }` casts in generators are gone — types flow from the
  action creator or method signature

**`ctx.send(creatorOrType, payload?)` — dispatch shorthand**

- `yield* ctx.send(analytics.log, { msg: 'done' })` — shorter than
  `ctx.dispatch({ type: ..., payload: ... })`
- Accepts bound method (`.type` used) or plain type string; `ctx.dispatch` still
  available for full action objects

**`ctx.all` — named form alongside spread**

- `const { user, orders } = yield* ctx.all({ user: ctx.call(...), orders: ctx.call(...) })`
- Spread form still works: `const [a, b] = yield* ctx.all(gen1, gen2)`

**`ctx.waitFor` — accepts bound methods and typed creators**

- `yield* ctx.waitFor(gateway.running)` — any object with `.type` works, not
  just A catalog creators
- `yield* ctx.waitFor(feature.A.actionName)` — payload type fully inferred from
  A catalog creators
- `TypedCreator<P>` type exported for advanced use

**`cancelOn()` — functional cancelOn for generators**

- `cancelOn(['stop'], function*(ctx) {...})` — attach cancelOn to a generator
  function
- Works in both `feature({ methods, generators })` and
  `feature({ actions, generators })`

**Lowercase action type strings — `featureName:actionKey` format**

- All action types are now lowercase: `'counter:increment'` not
  `'Counter:Increment'`
- Applies to all generated types: methods, generators, flow steps, errors,
  init/destroy

**No raw strings anywhere**

- `listensTo`: pass bound methods directly — `[counter.increment]` not
  `['counter:increment']`
- `cancelOn()`: pass bound methods or `.type` strings
- `ctx.waitFor()`: pass bound function — `ctx.waitFor(payment.complete)`
- Machine `on` keys for foreign actions: use `[counter.increment.type]` not
  `'Counter:Increment'`
- `dispatchTo: [wallet, fleet]` — pass feature refs directly, string form
  removed

**`call()` — extended inter-feature coordination**

- `import { call } from 'aio'` — standalone function, usable anywhere after
  `aio.run()`
- Dispatches a real action through the store (observable, interceptable,
  time-travelable)
- **Returns async method's return value** — no bridge() needed for
  request/response
- **`call({ timeout?, retries? }, () => feature.method(args))`** — timeout
  rejects after N ms, retries on failure
- `CallOptions` type exported for `{ timeout?: number; retries?: number }`

**Structured logging — `logging` config in `aio.run()`**

- Five outputs: `log/app.log` (narrative), `log/debug.log` (all actions),
  `log/error.log` (errors), `log/warning.log` (warnings), `log/perf.log`
  (violations)
- `app.log` is smart: machine state transitions, flow completions, feature
  lifecycle, deduped errors — no firehose
- Error deduplication: first occurrence logged, repeats suppressed with count,
  summary on recovery
- `debug.log`: every non-internal action, full payload, JSONL — for when
  something breaks
- `suppressTypes`: exclude known high-frequency action types from all logs
- `LogConfig` type exported

**`ScopedApp.getFullState()` — cross-feature reads in `init`**

- `init(app)` now has `app.getFullState()` alongside `app.getState()` (own
  slice)
- `app.getState()` still returns the feature's own slice — fast path for
  self-reads

**`useFeature(f, { fallback })` — skip the null guard**

- `useFeature(counter, { fallback: initialState })` returns `state: S` (never
  null)
- TypeScript overload: `{ fallback: S }` narrows the return type to `state: S`

**`feature({ persist: { exclude } })` — per-feature persistence exclusion**

- `persist: { exclude: ['htmlCache', 'largeBlob'] }` — omit fields from KV
  persistence without `stateForDB`
- Auto-composes with other features' excludes — each feature owns its own
  persistence config

**Machine `on` is optional for terminal states**

- States with no outgoing transitions no longer need `on: {}`
- `saving: {}` and `error: {}` are valid — omit `on` entirely for dead-end
  states

**Type system improvements**

- `_status` hidden from user-facing types — access via `useFeature().status` or
  `t.expect.status()`
- Selectors auto-scoped — receive feature's own state slice in both `feature()`
  styles
- Typed action union in `reduce` — `action.payload` auto-narrows in switch/case,
  no casts needed
- `ActionUnion<Prefix, A>` exported for advanced use
- Foreign actions in object-form `reduce` via computed keys:
  `[inventory.reserve.type](state, payload) { ... }`
- `t.expect.effects()` uses full `featureName:effectKey` type strings:
  `['counter:log', 'counter:persist']`
- Internal actions hidden from time-travel (`__set*`, `__exec`, `__error`,
  `__FlowState`)
- `GenCtx` type exported (renamed from `FlowCtx` in pre-release drafts)

**DX improvements**

- `settle()` auto-runs effects — `t.runEffects()` no longer needed, just
  `await t.settle()`
- `ctx.put` renamed to `ctx.dispatch` in generators — consistent with framework
  dispatch semantics
- Inter-feature patterns reduced from 6 to 3: Observe / Read / Coordinate

**Cleanup**

- `reactive()` removed (was a 15-line shim) — `feature({ methods })` is
  identical
- `bridge()` / `testBridge()` / `BridgeTestContext` removed — use
  `call({ timeout, retries })`
- `machine: 'simple'` removed — use `machine: false` (breaking: rename in your
  config)
- Classic `aio.run(state, config)` API removed — use `aio.run({ features })`
- `flow()` removed — use `generators` key with `cancelOn()` for cancellation
- `FlowDef` removed from public API — internal type only
- `flows:` key removed from `feature()` config (both methods and actions styles)
- `{ A }` / `{ E }` context objects removed from reduce/execute (use named
  handlers or `{ on }` / `{ emit }`)
- Removed `FeatureContext` type from public API
- Removed `_setFullApp` / `_callHandler` internal wiring

---

## v0.7.0

**reactive() — plain methods instead of reduce/execute**

- Sync methods mutate state via Immer draft (batched, one action per call)
- Sync methods can return schedule effects (timers, intervals)
- Async methods get live Proxy — reads always fresh, writes auto-dispatch
- Machine-gated async writes — method-tagged `__setMethod` actions with
  auto-injected transitions
- Microtask batching — consecutive Proxy writes grouped into one action per sync
  frame
- `listensTo: string[]` — foreign action listeners without a full machine
- Selectors, dispatchTo, onInit/onDestroy hooks
- Direct calling — `counter.increment(5)` after `aio.run()`, no `.A.` namespace
- Async error action — `{Prefix}:__error` with machine self-loop in all states
- Async `testFeature()` — `t.runEffects()` + `t.settle()`

**flow() improvements**

- `ctx.waitFor(actionType, timeout?)` — pause until external action dispatched
- `ctx.getState()` — read current feature state inside a flow
- `cancelOn: string[]` — declarative flow cancellation on arbitrary actions
- `ctx.dispatch()` accepts `{ type, payload? }` — payload optional
- Flow errors fed back into generator via `gen.throw()` for try/catch support

**DX & infrastructure**

- `aio.run()` binds dispatch + selectors to all features (reactive, feature,
  flow)
- TypeScript inference — typed intersections with autocomplete for direct
  calling
- Pre-bind console.warn when methods called before `aio.run()`
- `machine: false` — no state machine guards (replaces `machine: 'simple'`)
- FeatureDef carries phantom State type for testFeature inference
- `useSyncExternalStore` in useAio/useFeature for selective re-renders
- `useFeature(ref)` added — feature-scoped state, typed send, machine status,
  selective re-renders; `useAio()` remains the right hook for root layout and
  cross-feature views
- Startup linter validates empty features, `_status` reserved key, empty
  actionKeys
- `--type` and `--template` CLI flags for non-interactive project scaffolding

**Infra**

- Nested delta patches — fine-grained state sync (only changed sub-keys sent)
- UDS transport — zero TCP ports in prod electron builds, smart auto-detect
- `Msg<P>` generic — reduce/execute callbacks allow `action.payload.field`
  without casts
- WebSocket payload validation — malformed payloads rejected at boundary
- Per-user action authorization — middleware and `beforeReduce` receive `user?`
- App identity with identity-based singleton lock

**Docs**

- 15 topic files split from monolithic manual.md
- features.md — all 5 inter-feature interaction patterns
- debugging.md — error interpretation, time-travel forensics

## v0.6.0

- `flow()` — generator-based sequential workflows triggered by actions
- `GenCtx` — call, step, done, fail, put, all, race, sleep
- `reduce` and `machine` now optional in `feature()` — flow-only features
- Auto-generated flow actions visible in time-travel
- Auto-cancellation on re-trigger, feature disable, and destroy

## v0.5.0

- `feature()` — one function defines state, actions, effects, machine, reduce,
  execute, selectors
- State machines — required guards with validated transitions, `_status`
  auto-managed
- `A` / `E` dual-role objects — labels for switch + creators for dispatch
- `aio.run({ features })` — compose features into single dispatch loop
- `useFeature()` — scoped React hook with state, send, status
- `bridge()` — cross-feature request/response with timeouts, retries, circuit
  breaker
- `testFeature()` / `testBridge()` — isolated test harnesses
- Foreign action listeners — react to other features' actions via machine
- Scoped dispatch — executors limited to own actions + `dispatchTo` allowlist
- `implement()` — deferred executor attachment (removed in v1.0 — use async
  methods)
- Feature lifecycle — `init` / `destroy` hooks, dependency-ordered
- Feature registry — `enable` / `disable` / `health` at runtime
- Middleware system — `aio.middleware.logger()`, `.validate()`, composable
- State versioning — `version` + `migrations` (removed in v1.0 — use
  `appVersion` + `onRestore`)
- Health endpoint — `GET /__aio/health` with per-feature status

## v0.4.0

- Zero-config HTTPS — `--expose` auto-generates self-signed cert
- `am watch` — hot-restart on file changes
- `am logs --follow` — stream logs live
- `am status` exit codes — 0=started, 1=stopped, 2=transitional
- `persistMode:'multi'` — per-key KV storage, bypasses 65KB limit
- ORM `whereOr()`, `upsert()`, `orderBy`/`limit`/`offset` on queries

## v0.3.0

- Performance budgets — configurable timing thresholds for reduce/effects
- Redux DevTools integration — `connectDevTools()`
- Incremental SQLite sync — row-level diffs for PK tables
- `createSelector()` — memoized derived state
- `matchEffect()` — typed alternative to switch/case in execute
- `composeMiddleware()` — compose beforeReduce functions

## v0.2.0

- CSS hot reload — inject without page reload
- `--expose` flag — LAN access with UUID token
- `--url` thin client — Electron connecting to remote server
- Window config and state persistence
- Multi-user auth — per-user tokens and identity
- Startup linter — validates config on boot
- Error overlay — transpile errors shown on page
- Lifecycle hooks — onAction, onEffect, onConnect, onDisconnect, onStart, onStop
- Time-travel — undo/redo/goto with browser panel and `am tt`
- `am` — app manager CLI for process lifecycle and state inspection
- State snapshots — save/restore via API and HTTP
- Scheduled effects — `schedule.after/every/at/cron/cancel`
- SQLite persistence — 3-tier data layer (auto-sync, ORM, raw SQL)
- One-liner project init

## v0.1.0

- Core framework — state, reduce, execute, dispatch loop
- WebSocket sync — real-time state broadcast to all clients
- Deno.Kv persistence — automatic state persistence
- React integration — `useAio()` hook
- Electron window — desktop app with `deno task dev`
- Delta patches — optimized state broadcasting
- Offline queue — IndexedDB action queue with reconnect replay
- Compile targets — binary, Electron, Android, CLI, service
