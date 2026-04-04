# Changelog

## v1.0.0-alpha10

**CRDT sync module, client observability, nuclear audit**

- **CRDT sync** -- offline-first, server-authoritative collaborative state.
  Per-feature `sync: { merge }` config with 5 merge strategies (lww, counter,
  lww-per-key, set-add, set-remove). HLC causality, op buffer (IndexedDB),
  rebase engine, client sync engine, server-side compaction (SQLite op-log)
- **Client log forwarding** -- `installConsoleIntercept()` forwards browser
  console output + unhandled errors to server as `__log` wire messages
- **DOM snapshot** -- `snapshotDOM()` captures semantic UI state (5000 nodes,
  depth 50) with unique selectors and visibility tracking
- **DOM interaction** -- `interact()` dispatches click, type, select, focus,
  blur, scroll, hover with validation
- `feature()` accepts `sync` config option (additive, no breaking changes)
- Server routes `__op`/`__sync` messages for sync protocol
- KV persistence auto-excludes sync-enabled features (uses SQLite instead)
- Nuclear audit: 40 findings fixed across sync, server, client, DOM modules
- Renderer fix in release prep

---

## v1.0.0-alpha9

**Boot module, `__aio_status` rename & quality hardening**

- `src/boot/` module -- `parseCli()`, `bootIdentity()`, `bootLock()`, and
  Electron helpers extracted into structured startup orchestration
- `bindFeature(feature, dispatch, getState)` -- wire a feature to a custom
  dispatch bus without `aio.run()`
- Signal equality uses `Object.is` throughout -- NaN-correct, cross-realm safe
- Legacy `$p/$d` delta format emits one-time deprecation warning; removal in
  v1.0.0

**Breaking: `_status` -> `__aio_status`**

- Internal machine state key renamed. Use `useFeature().status` or
  `registry.status()` instead of reading directly.
- Reserved-key guard now **throws** at startup (was warn) and blocks any key
  starting with `__aio_`.

**AIO-287..291 -- AIR renderer (7 bugs fixed)**

- Signal flush: in-flight tracking prevents re-entrant double-run
- `_FLUSH_MAX_ITERATIONS` raised to 1000
- Phase-1 failure isolation: failing prepare step no longer blocks phase-2

**Quality hardening**

- Persistence: `result.ok` guard on KV `setMulti`; `structuredClone` before
  write
- Dispatch: JSON fallback warns explicitly on data loss
- `disable()` rollback on destroy failure
- All silent catches now log or carry documented rationale

---

## v1.0.0-alpha8

**Dynamic auth & nuclear audit hardening**

- `resolveUser` hook -- async JWT/OAuth/database auth with `ResolveUserFn<S>`
- Patch compaction + size guard in broadcast protocol
- `ResolveUserFn` type exported from `mod.ts`

**Nuclear audit -- 58 bugs fixed across 23 files (AIO-57..236)**

- 13 rounds of adversarial code review covering all 100 source files
- Security: prototype pollution guard on `_deepMergeFiltered`
- Delta protocol: backpressure recovery, filtered merge, array identity patching
- Renderer: flush guard on disposed root, hydration signal binding, keyed
  fragment placement, Suspense partial cleanup
- Feature system: proxy stale tracking, async batching, flow lifecycle cleanup
- Electron: `pageReady` reset on F5 reload, IPC null cleanup
- Server: `stateForUI` memo fix, TT perf timing, schedule ID validation

---

## v1.0.0-alpha7

**Type-safe send & renderer split**

- `useFeature` infers method signatures -- `send` is fully typed
- `aio/air` and `aio/react` subpath exports
- React compat hooks for zero-friction migration
- AIR renderer primitives exported from `aio/air`
- Monolith decomposition: extracted `middleware.ts` and `lint.ts` from `aio.ts`

**Bug fixes (AIO-55..70)** -- Proxy stale `ownKeys`, signal equality, ref
callback reliability, JSX DOM event types, `useLocal` `.patch()`, `useFeature`
type inference, array `key` prop warnings, CJS server stubs, JSR compliance

---

## v1.0.0-alpha6

**AIR native renderer (~8KB)**

- Signal-based VDOM engine with JSX, keyed reconciliation, auto-memo
- SSR + hydration, ErrorBoundary, lifecycle hooks, context, portals, suspense
- Form bindings (`useForm()`, `useFieldArray()`), animation (`useSpring()`,
  `useTransition()`), virtual scrolling (`useVirtualList()`)
- Adapter architecture: `state-core.ts` as framework-agnostic foundation

**Delta protocol hardening (AIO-26..34)** -- 9 targeted fixes: Electron IPC
replay safety, UDS handling, `$f` marker protocol, control message corruption,
`unflattenPatch` empty-to-identity fix, periodic resync, reference-equality
shortcut removal

---

## v1.0.0-alpha5

**Identity-keyed array delta compression (AIO-12)**

- Arrays with `id` fields sent as identity-keyed deltas (120KB -> 7.5KB typical)
- Wire format: `$arr` marker + `$id:<key>` per-element patches + `$rm` removals

**4-layer wasted render prevention (AIO-11)**

- `useProjection(fn, deps)` -- structural sharing for derived data
- `memo(Component)` -- `_shallowEqual` per prop instead of referential equality
- `aiol` lint rule for `memo()` + `.map()` without `useProjection()`

**Deep proxy-tracked subscriptions** -- `useAio()` auto-tracks accessed paths;
server filters broadcasts to client's actual reads

**UDS ghost socket elimination (AIO-24/25)** -- removed idle timeout, explicit
`conn.close()`, IPC keepalive, write error handling

**Framework reliability (AIO-14..23)** -- 10 targeted fixes across dispatch,
flow, server, electron

**JSR documentation score -- 100%**

---

## v1.0.0-alpha4

- `ctx.getFullState()` -- read full app state from generators
- `ctx.when(predicate, opts?)` -- wait until state condition is true
- Vital signs system: LoopProbe, RenderProbe, TransportProbe, HintEngine
- DiagReporter: split server/client output, structured console, `onDiagnostic`
- PressureMonitor: payload size + broadcast rate + render degradation warnings
- Subscription stability fix (AIO-4/3): stable `_useAioSubscribe`, grace period
- Diagnostic bus + health overlay, smart module loader, `PERSIST_ERROR` code
- Reduce phase performance breakdown in time-travel and `perf.log`
- Render optimization: `_applyPatch` reference stability, re-render storm
  detection
- Graph validator: circular deps, missing features at startup
- Todo app and interactive playground examples

---

## v1.0.0-alpha3

- Logging enabled by default (`logging: false` to disable)
- Logger rewrite: plain text format, wipe-on-start, colored ANSI console
- Unified logger singleton
- `AioError` class with 16 error codes, correlation IDs, state snapshots
- Memory pressure monitor with configurable thresholds
- Diagnostics module: state diffs, action log, checkpoint recovery, crash
  handler
- Circuit breaker rolling window option
- ~27 raw `console.*` calls routed through structured `log.*`

---

## v1.0.0-alpha2

**BREAKING: Config audit**

- Renames: `persistDebounce` -> `persistDebounceMs`, `effectTimeout` ->
  `effectTimeoutMs`, `deltaThreshold` -> `fullStateThreshold`, `perfMode` ->
  `perfCheck`
- Restructure: `ui.electron` + `headless` ->
  `client: 'electron'|'browser'|'cli'|'server-only'`
- `appId` mandatory in `aio.run()` (no longer from `deno.json`)
- `appVersion` mandatory
- Promise-returning dispatch -- all bound methods return Promise
- Browser import DX: esbuild plugin, dynamic import map, `aiol` lint checks
- Reliable live reload (ISSUE-1)

## v1.0.0-alpha1

- All internal endpoints moved under `/__aio/`
- Security: CSRF header, rate limiting, SQL allow-list, audit logging
- Mixed mode features: `feature()` supports methods + actions + effects together
- 10 audit bugs resolved (B1-B10)
- Tests: 801 passing (13.5K lines)

---

## v0.9.5

- Fix: Electron dev stuck on "Loading..." -- replaced timeout with `__aio:ready`
  handshake

## v0.9.4

- Fix: UI fails to load from JSR -- strip `npm:` prefix after esbuild transform
- Fix: compile:electron and am tasks from JSR -- added `./src/build` and
  `./src/am` exports
- Random ephemeral ports (no more conflicts between apps)
- Startup log: full resource + config listing

## v0.9.3

- JSR-native builds + Electron install simplification (same train as v0.9.2)

## v0.9.2

- esbuild HTTP plugin: loads from JSR directly, no temp dir
- Android template embedded as TS constants
- `import.meta.dirname` -> `new URL(...)` for JSR/HTTP modules
- Electron install simplified to single `install:electron` task

## v0.9.1

- Rich error overlay: build errors with source + caret, runtime error category
- Live reload: always-active dev WebSocket independent of `useAio`

## v0.9.0

- UI sync rate throttling (`syncIntervalMs`, default 100fps)
- Async Worker-based SQLite replaces sync ORM (`AioDB` -> `DB` interface)
- `log` public singleton, `LogLevel` type exported
- Scaffolder uses JSR, `noUncheckedIndexedAccess` enabled

## v0.8.0

- `reactive()` removed -- `feature({ methods })` is the one API
- Object-form `reduce` and `execute` -- named handlers replace switch/case
- Generators unified: `generators` key replaces `flows`
- `GenCtx<S>` generic, typed generator arguments
- `call()` standalone function with timeout/retries
- Structured logging, `ScopedApp.getFullState()`,
  `feature({ persist: { exclude } })`
- Lowercase action type strings (`featureName:actionKey`)

## v0.7.0

- `reactive()` -- plain methods instead of reduce/execute
- `flow()` improvements: `ctx.waitFor`, `ctx.getState`, `cancelOn`
- `useFeature(ref)`, nested delta patches, UDS transport, app identity

## v0.6.0

- `flow()` generator-based sequential workflows, `GenCtx`, auto-cancellation

## v0.5.0

- `feature()`, state machines, `aio.run({ features })`, `useFeature()`,
  `bridge()`, `testFeature()`, middleware, health endpoint

## v0.4.0

- Zero-config HTTPS, `am watch/logs`, `persistMode:'multi'`, ORM queries

## v0.3.0

- Performance budgets, Redux DevTools, SQLite sync, `createSelector()`,
  `matchEffect()`, `composeMiddleware()`

## v0.2.0

- CSS hot reload, `--expose` LAN access, time-travel, `am` CLI, scheduled
  effects, SQLite persistence, one-liner init

## v0.1.0

- Core framework, WebSocket sync, Deno.Kv persistence, React integration,
  Electron window, delta patches, offline queue, compile targets
