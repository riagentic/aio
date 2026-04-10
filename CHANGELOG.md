# Changelog

## 1.0.0-alpha12

### Breaking

- **React renderer removed** — AIR is the sole renderer. `aio/react`,
  `src/react.ts`, `src/browser.ts`, `src/standalone.ts`, `src/browser-fiber.ts`,
  `src/browser-hooks.ts`, `src/browser-router.ts`, `src/time-travel-react.ts`,
  `src/adapters/react.ts` and their tests are gone. See
  `docs/upgrade/from-alpha11-to-alpha12.md`

### Added

- **Direct reactive cell access** — `counter.count` is now type-safe. Both
  `cell()` overloads return `… & Readonly<S>` so UI code can read state off the
  cell without a hook. Backed by `src/cell-reactive.ts` which installs
  signal-backed getters via `Object.defineProperty`
- **JSX runtime wired up** — `aio/jsx-runtime` added to exports and import map.
  `src/jsx-runtime.ts` triple-slash-references `jsx.d.ts` so
  `JSX.IntrinsicElements` resolves and `<div/>` type-checks
- **`deno task check` covers examples** — now runs against
  `examples/counter/App.tsx` and `examples/todo/App.tsx` so JSX regressions
  break the task

### Fixed

- **Blank render in minimal apps** — dev HTML bootstrap now calls
  `ensureConnected()` before `_waitForState()`, so apps that use direct cell
  access without any UI hook still get cells bound reactively
- **Immer draft proxies in effects** — effects are cloned inside `produce()`
  before Immer revokes draft proxies; uncloneable effects are dropped rather
  than passed through as revoked proxies
- **Hardening wave** — trojan auth, `fatalOnStart`, effect async errors, cleanup
  hooks
- **Stale `VERSION`** — `src/aio-cli.ts` constant bumped alpha8 → alpha12 (was
  stale since alpha8)

### Tests

- **Regression: blank render via direct cell access** —
  `tests/boot-direct-access.test.ts` mounts a no-hook component with `happy-dom`
  and asserts `counter.count` renders after `bindAllCellsReactive()`, pins the
  undefined-without-binding failure mode, and guards the seeded-initial-state
  fallback

### Docs

- Direct cell access is the primary UI pattern; TS2722 troubleshooting added
- Quickstart covers both JSR and vendored (`dep/aio/`) `deno.json`, verified
  end-to-end against a fresh `/tmp` project with headless chrome + CDP driver
- Upgrade guide: `aio/adapters/react` subpath removed alongside `aio/react`;
  `aio/jsx-runtime` added to the required imports diff

## 1.0.0-alpha11

### Added

- **`cell()` API** — renamed from `feature()`. All internal naming updated
  (cell-impl, cell-types, cell-machine, cell-compose, cell-catalog, cell-test)
- **Type-safe machine states** — `cell({ machine })` infers literal `.type`
  union from state map keys; transitions type-checked at compile time
- **Per-cell field filters** — `persist` and `ui` config on cells controls which
  fields are persisted to KV and which are sent to clients. Strategies: `"all"`,
  `"none"`, `{ include }`, `{ exclude }`
- **Patch strategies** — per-cell `patchStrategy`: `"auto"` (default), `"full"`,
  `"filter"` with field-level control over what gets broadcast
- **State migration system** — `version` + `onMigrate(state, fromVersion)` on
  cells. Version tracked in KV, migration runs on restore when version mismatch
  detected. Failed migrations reset to `initialState` (safe fallback)
- **Per-cell locking** — async mutex in server sync handler serializes
  `handleOp` + compaction per cell, preventing race between op persist and
  compaction DELETE
- **LWW set merge** — `set-add` and `set-remove` CRDT strategies now use HLC
  comparison for content conflicts instead of always keeping local
- **Clean import boundaries** — removed `aio/core` export, stripped server
  re-exports from `aio/air` and `aio/react`. `Msg` type unified via single
  import from `cell-types.ts`
- **Upgrade guide** — `docs/upgrade/from-alpha10-to-alpha11.md`

### Fixed

- **Sync server race condition** — fire-and-forget `tryCompact()` could
  interleave with `handleOp`, losing ops. Now awaited inside per-cell lock
- **Silent op drops** — sync engine buffer-full silently discarded ops. Now
  prunes confirmed ops first, warns on actual drop
- **Migration failure safety** — `onMigrate` throwing left stale persisted
  state. Now resets to cell's `initialState` with error log
- **Low-water corruption** — `getLowWater` JSON parse failure was silent. Now
  logs warning and triggers full snapshot
- **Duplicate `Msg` type** — `cell-impl.ts` had its own `Msg` definition
  diverging from `cell-types.ts`. Replaced with import
- 184 bugs fixed across 5 audit waves (waves 1-4 in alpha8-10, wave 5 in
  alpha11)

### Changed

- **`feature()` → `cell()`** (breaking) — all public API renamed. See upgrade
  guide for migration steps
- **`bindFeature` → `bindCell`**, **`testFeature` → `testCell`**,
  **`composeCells`** (was `composeFeatures`)
- **Test count** — 1774 → 1949 (175 new tests: migration, patch filter, merge
  null safety, sync locking, protocol, virtual list)

## 1.0.0-alpha10

### Added

- **`src/sync/` module** — offline-first CRDT sync engine with
  server-authoritative merging. Includes hybrid logical clock (HLC), op buffer
  with storage abstraction and cap enforcement, merge strategies (LWW, counter,
  LWW-per-key, set-add, set-remove), rebase engine for unconfirmed ops, and
  client sync engine with op stamping, ack, status, and reconnect
- **Server-side sync** — `__op`/`__sync` message handlers, atomic compaction
  with schema definitions, sync table init, KV exclusion for sync keys
- **Sync feature API** — `sync` config on features, sync routing hook in
  `state-core send()`, barrel export via `src/sync/mod.ts`
- **Client log forwarding** — forward client console output to server
- **DOM-based UI snapshot & interaction** — `am ui` now captures live DOM tree
  from connected clients, with `am ui <userId>` for server-state filtering

### Fixed

- **`afterSubtree` crash** — `instanceof HTMLElement` replaced with
  `nodeType === 1` check to work in non-browser environments (happy-dom); added
  missing `_devMode` guard (was always stamping `data-component`)
- **`_syncFeatureIds`** registered in valid config keys
- **`am ui`** test aligned with refactored `cmdUi` (DOM snapshot default path)

### Changed

- **Test count** — 1343 → 1774 (431 new tests, mostly sync/CRDT coverage
  including property-based, integration, and reconnection tests)

## 1.0.0-alpha9

### Added

- **`src/boot/` module** — structured startup orchestration: `parseCli()`,
  `printHelp()`, `handleCliExit()` (CLI); `bootIdentity()` (appId/port/title
  resolution); `bootLock()` (single-instance lock); `electron-helpers.ts`
  (`toSlug`, `escapeForExecuteJavaScript`, `requireElectronVersion`,
  `buildWillNavigateHandler`, `buildCertificateHandler`,
  `buildKeyboardShortcuts`, `WINDOW_STATE_HELPERS`)
- **`bindFeature(feature, dispatch, getState)`** — wire a feature to a custom
  dispatch bus without `aio.run()`, for advanced composition and custom hosts
- **Legacy delta deprecation warning** — `$p/$d` format now logs a one-time
  console warning on receipt; server no longer produces it

### Fixed

- **AIO-287..291** — 7 AIR renderer bugs: signal flush guard on re-entrant
  notify, in-flight subscriber tracking, `_FLUSH_MAX_ITERATIONS` raised to 1000,
  phase-1 failure isolation in flush loop
- **Signal equality** — all comparisons use `Object.is` (NaN-correct,
  cross-realm safe via duck-typing instead of prototype checks)
- **Persistence** — `result.ok` guard on KV `setMulti`; snapshots use
  `structuredClone` before write
- **Dispatch JSON fallback** — warns explicitly when `structuredClone` fails and
  JSON round-trip is used (data loss: `undefined`/`NaN`/`Infinity`/`Date`)
- **`disable()` rollback** — failure during cleanup rolls back
  `disabledFeatures` set and logs the error; feature re-enabled on destroy
  failure
- **Catch logging audit** — all silent catches now log or carry a documented
  rationale comment; no swallowed errors remain

### Changed

- **`_status` → `__aio_status`** (breaking) — internal machine state key
  renamed. Direct reads of `feature._status` must migrate (see upgrade guide).
  The reserved-key guard now **throws** (was: warn) and also blocks any
  `__aio_*` prefix in feature state definitions.
- **`appVersion` required in examples** — quickstart and all docs examples now
  include `appVersion` in `aio.run()` calls
- **Quickstart style guide** — added decision table for `methods` vs
  `generators` vs `actions + reduce`

## 1.0.0-alpha8

### Added

- **Dynamic user resolution (`resolveUser`)** — async hook for JWT, OAuth, or
  database-backed auth. Supports `Promise<AioUser | null>` return type. Unified
  `_buildUserResolver` factory replaces separate static/dynamic code paths
  (AIO-171)
- **`ResolveUserFn` type** exported from `mod.ts`
- **Patch compaction** — broadcast protocol compacts redundant patches before
  sending, reducing wire overhead for rapid-fire mutations
- **Broadcast size guard** — oversized patch sets auto-fallback to full-state
  send

### Fixed

- 58 bugs fixed across 23 files in 13-round nuclear audit (AIO-57..236)
- Prototype pollution guard on `_deepMergeFiltered` (AIO-238 — security)
- Delta protocol hardening — backpressure recovery, filtered merge, array
  identity patching, periodic resync improvements
- Renderer fixes — flush guard on disposed root, hydration signal binding, keyed
  fragment placement, Suspense cleanup
- Feature system — proxy tracking, async method batching, flow cleanup,
  delegation leak, schedule prefix handling
- Electron — `pageReady` reset on reload, IPC null cleanup
- Server — stateForUI memoization for undefined results, time-travel perf
  metrics timing, config schedule ID validation

### Changed

- `_extractToken` and `_buildUserResolver` replace inline auth resolution in
  server.ts — single code path for all auth modes
- Auth mode reporting: `authMode` now distinguishes `"resolveUser"` from
  `"users"` in trojan API

## 1.0.0-alpha7

### Added

- **Type-safe `send`** — `useFeature` infers method signatures from feature
  definition; `send.methodName(...)` is fully typed with args and return
- **`aio/air` and `aio/react` subpath exports** — barrel modules for each
  renderer; all primitives available from a single import
- **React compat hooks** — `useState`, `useEffect`, `useCallback`, `useMemo`
  wrappers in `src/compat.ts` for zero-friction React migration
- **AIR renderer primitives exported** — `useRef`, `onMount`, `onCleanup`,
  `effect`, `computed`, `signal`, `batch` all re-exported from `aio/air`

### Fixed

- Proxy stale `ownKeys` — second+ `.map()`/spread on proxy state (AIO-57)
- Signal equality — `.set()` with same value no longer triggers re-render
  (AIO-59)
- Ref callback invocation reliability (AIO-58)
- JSX event types use native DOM events, no `as any` casts (AIO-62)
- `useLocal` single-field `.patch()` (AIO-66)
- `useFeature` type inference without double-cast (AIO-67)
- `key` prop warnings for array rendering (AIO-69)
- AIR renderer primitives not exported from main import (AIO-70)
- CJS server-only stubs for esbuild (AIO-55)
- `aio://` custom protocol `registerSchemesAsPrivileged` (AIO-56)
- Explicit return types for JSR no-slow-types compliance

### Changed

- Extracted `middleware.ts` and `lint.ts` from `aio.ts` monolith
- Renderer exports stripped from `mod.ts` — base is now server/protocol only
- Docs imports updated to `aio/react` and `aio/air`

## 1.0.0-alpha6

### Added

- **AIR native renderer** — signal-based VDOM engine with JSX, keyed
  reconciliation, auto-memo per-component reactivity (~8KB)
- Renderer Phase 2: per-component signal tracking, auto-memo, VDomHooks
- Renderer Phase 3: SSR, hydration, ErrorBoundary, AIO bridge hooks
- Renderer Phase 4: lifecycle, context, portal, suspense, forms, devtools
- Signal system — `signal()`, `computed()`, `effect()`, `batch()` reactive
  primitives
- VDOM engine — `h()`, diff, patch, keyed reconciliation
- Form bindings — `useForm()` with signal-backed validation
- Animation system — `useSpring()`, `useTransition()` signal-driven
- Virtual list — `useVirtualList()` for large datasets
- DevTools integration for AIR renderer (component tree, render counts)
- **Adapter architecture** — `state-core.ts` as framework-agnostic foundation,
  React and AIR adapters as thin consumers
- `state-core` exports: `getFeatureSignal`, `getStateSignal`, `createSendProxy`,
  `setTransport`, `flushOfflineQueue`, `_trackingProxy`, `_resolveWithFallback`
- New export paths: `@riagentic/aio/state-core`,
  `@riagentic/aio/adapters/react`, `@riagentic/aio/adapters/air`,
  `@riagentic/aio/jsx-runtime`
- Delta round-trip invariant tests
- AIO-33 state integrity test suite

### Fixed

- Electron IPC `__aio:ready` requests fresh state from server via `__subs:*`
  (AIO-26)
- Unsafe delta replay removed from `__aio:ready` handler (AIO-26)
- UDS `__subs:` handling and per-client subscription filtering (AIO-27)
- Cancel sub timer on `_accessedPaths.clear()`, guard empty subs (AIO-28)
- `$f` marker for filtered state — merge instead of replace (AIO-29)
- Control messages no longer corrupt `lastFullState`, shallow `$f` merge
  (AIO-30)
- `useFeature` auto-merges init shape — prevents crash on incomplete state
  (AIO-30)
- Recursive deep merge for `$f` responses, prevents sub-sub-key loss (AIO-31)
- `unflattenPatch` contradicting `$arr`+`$d` on empty→identity array transition
  (AIO-31)
- `_applyPatch` defense-in-depth: `$arr` identity patch survives contradicting
  `$d` deletion with diagnostic warning
- Dev-mode `_checkStateIntegrity` warns when keys from initial full state
  disappear (state-shape-drift diagnostic)
- Periodic resync every ~5s prevents permanent delta desync (AIO-33)
- `lastKeyJsons` updated after successful send, not before (AIO-33)
- Removed unsafe reference-equality shortcut in `_computeDelta` (AIO-34)
- Renderer hydration `afterSubtree` — instanceStack leak fix
- `useSpring` timestep hardening, lazy re-render, context signal cleanup

## 1.0.0-alpha5

### Added

- Identity-keyed array delta compression (AIO-12) — `flattenKeys` detects arrays
  with stable `id` fields, diffs per-element. 160-element array with 10 changes:
  120KB → ~7.5KB per tick
- 4-layer wasted render prevention (AIO-11) — `useProjection`, `memo` with
  structural comparison, aiol lint rule, runtime warning
- IPC keepalive ping (AIO-24) — `__ping` every 60s as defense-in-depth for
  Electron IPC
- `.ts` added to live-reload watcher extensions

### Fixed

- UDS ghost socket elimination (AIO-24) — removed idle timeout, close conn on
  read-loop exit, `_ipcConnected` flag, write-error cleanup
- UDS broadcast/sendTo write failures now close connection cleanly (AIO-25)
- `_reset()` clears `_idMaps`, `_useAioActiveCount`, `_diagLastEmit`,
  `_vitalsUrlLogged`, `_vitalsPingTimer`, `_vitalsTransportProbe` (AIO-14,
  AIO-23)
- `_applyArrPatch` self-heals on desync instead of injecting `undefined`
  (AIO-15)
- `flattenKeys` preserves empty arrays as atomic keys (AIO-16)
- `onerror` handler cleans up vitals/payloadStats/pressureMonitor (AIO-17)
- Double `onDisconnect` callback prevented via `disconnected` flag (AIO-18)
- Delta-before-state now emits diagnostic event (AIO-19)
- `ws.onopen` guards `readyState` after async gap (AIO-20)
- `_accessedPaths` pruned on full state receive (AIO-21)
- Graph validation race guard via `_graphGeneration` counter (AIO-22)
- Electron IPC test updated to match dual-replay `lastFullState` template

### Changed

- `_preserveArrayRefs` bypassed entirely for identity-patched arrays (AIO-13) —
  8,000 shallow comparisons per patch eliminated

## 1.0.0-alpha4

### Added

- Todo app example (`examples/todo/`) — CRUD, filtering, inline editing,
  persistence
- Interactive playground (`examples/playground/`) — standalone HTML, 3 examples,
  live code editor, no server needed
- Tests for `listeners.ts`, `sql.ts` (buildWhereOr, buildQuerySuffix,
  isWhereOp), Electron script generators (29 unit tests)

### Fixed

- `structuredClone` failure in dispatch now reports `EFFECT_ERROR` and drops
  effects instead of silently continuing with revoked Immer draft refs
- Effect timeout is now hard-cancel — timed-out effects are abandoned and
  counted toward circuit breaker. Late rejections after timeout are suppressed
  (no double-report)
- `db.transaction()` callback form: `_inTransaction` flag now resets even when
  `BEGIN` fails, preventing permanent deadlock on subsequent transactions

### Changed

- Extracted `server-html.ts` from `server.ts` (MIME, import map, HTML gen, error
  classification)
- Extracted `aio-cli.ts` from `aio.ts` (CliFlags, parseCli, printHelp, VERSION)
- `effectTimeout` behavior change: previously warn-only, now marks effect as
  abandoned after timeout. The underlying promise may still complete but the
  framework considers the effect failed.

## 1.0.0-alpha3

### Added

- Diagnostics module — state diffs, action log, checkpoint, crash handler,
  dev/prod config
- Circuit breaker, state validation, correlation ID race fix, error tips
- First-class error infrastructure — `AioError`, memory monitor, correlation
  IDs, TT error markers
- Logging enabled by default (`logging: false` to disable)
- CI pipeline — fmt, check, lint, test, publish to JSR on tag

### Fixed

- Memory monitor false alarms (use `heap_size_limit`), strip CSS imports
- AM reads `appId`/`port` from app.ts, kills stuck instances, fixes lock
  self-deadlock
- Console fallback only prints info + error (mirrors app.log)
- Pre-release audit — fmt, types, tests, CI, version

### Changed

- Extracted shared `Listeners<T>` — deduplicate browser.ts and standalone.ts
- Unified loggers — single `logger.ts` singleton, plain text, wipe-on-start
- Time-travel `MAX_ENTRIES` bumped to 20,000

## 1.0.0-alpha1

- Initial alpha: reactive + sequential + explicit feature styles
- Server-side state persistence (Deno KV), WebSocket sync, offline queue
- Build targets: browser, Electron desktop, Android (WebView), CLI, service
- App Manager (`am`) — process control, logs, KV inspect
- Time-travel debugger, middleware, selectors, scheduling
- AIO linter (`aiol`) — framework-specific checks

## 0.9.5

- Fix Electron dev loading (IPC ready handshake + E2E test)

## 0.9.4

- UI fix, exports, random ports, `/tmp/aio/`, startup log

## 0.9.3

- JSR-native builds, esbuild HTTP plugin, android template, Electron fixes
