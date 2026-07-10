# Changelog

## 1.0.0-alpha17 — external-audit hardening + experimental targets

Bugfixes and hardening from an external code audit, plus honest labeling of the
targets that aren't yet field-validated. Staying on the alpha track — beta is
deferred until the remote targets are proven off-box.

### Security

- **`_safeUiEntry`** sanitizes the dev HTML shell's `ui.entry` interpolation
  (self-XSS guard); the localhost trojan's read-only SQL guard now also allows
  `WITH … SELECT` CTEs while staying read-only.

### Fixed

- **Deterministic CRDT ordering** — sync ops `ORDER BY … hlc_node` for a stable
  total order across nodes.
- **Memory** — renderer signal-binding cleanup on unmount; dispatch-storm evicts
  quiet action types so its map can't grow unbounded on a long-running server.
- **UDS zombie detection** (`isSocketAlive`) — the liveness check now covers the
  Unix-socket transport (skipHttp / electron), matching the port check.
- Renderer / transport / server refinements across ~30 files (all
  additive/bugfix; full suite + security regression stay green).

### Added

- **Remote / thin-client targets marked experimental** — they build and run but
  aren't yet field-validated off-box; flagged in `docs/build/targets.md`, the
  scaffolder menu, and a build-time notice.
- **`VirtualListConfig.containerRef`** — `scrollToIndex` now moves the actual
  scrollbar (DOM `scrollTop` is the source of truth).

### Docs

- Honest JSR install wording — JSR trails the tagged releases (latest is an
  alpha), so the scaffolder / `--vendored` paths are recommended; the `jsr:`
  pins apply once the version is published.

## 1.0.0-alpha16 — deep-audit cleanup + field-report fixes (mdview, risoto)

A full per-file audit (no correctness bugs found) plus the cleanup it turned up,
and every open item from the mdview and risoto field reports. Non-breaking:
additive API only (`deno task doctor` / `aio/doctor`, `schedule.backoff`), no
changed semantics.

### Added

- **`deno task doctor`** (+ `./doctor` export) — config sanity checker for the
  magic `deno.json` lines (jsx / jsxImportSource, `aio` import-map keys,
  `unstable: ["kv"]`, vendored `immer`/`@std/path`, Deno ≥ 2.6). Wired in the
  repo and emitted by every scaffold; covered by tests.
- **`schedule.backoff(id, attempt, { base, max?, factor? }, action)`** — a
  one-shot `after` whose delay grows exponentially with `attempt`, owning the
  retry/backoff arithmetic so RPC pollers stop hand-rolling it.

### Security

- **Field-filter safety warnings** — `ui`/`persist` `include`/`exclude` only
  match top-level state keys, so a nested key (e.g. `exclude: ["encSecKey"]`
  under `accounts[]`) was a silent no-op that kept broadcasting the secret. Two
  compose-time warnings now catch it: a non-top-level filter key, and a
  secret-looking field (`enc/secret/priv/key/seed/mnemonic/passphrase`) left
  exposed to the UI.
- **`sql.ts` validates ORDER BY direction** instead of interpolating it raw
  (injection guard); **dispatch overflow rejects** dropped actions
  (`DISPATCH_MAX`) instead of silently resolving. Both with regression tests.

### Removed (dead code found by the audit)

- The `boot/` folder — a redundant parallel implementation of lock/identity/CLI
  the live server path already does inline (0 importers).
- `server-html-error-overlay.ts` — superseded by `server-html-scripts.ts`'s live
  dev-error path since alpha12.
- `browser-transport.ts` — the pre-split monolith, superseded by the
  `browser-transport-{state,vitals,send,ws,ipc}.ts` family.

### Fixed

- **`.gitignore` wrongly ignored `docs/build/`** — 5 authored docs were on disk
  but never tracked, so five files linking into the section had dead links in
  the pushed repo. Un-ignored and tracked. Added `*.zip`/`*.exe`.
- **Honest install path across all docs** — scaffolder/vendored first, JSR "once
  published"; the stale `jsr:@…/src/doctor` quickstart path now points at
  `deno task doctor`.
- **A dynamic `schedule.every`/`after` reusing a static schedule id** (from
  `aio.run({ schedules })`) warns instead of silently colliding.
- **aiol false positives** — `db:` inside a comment no longer trips "SQLite
  configured"; the table-import check is quote-agnostic; the `.env` warning
  respects `.gitignore`.
- Doc/test quality — corrected `useTimeTravel`'s signature, removed the internal
  `setDevMode` from the public reference, updated the input example to
  `e.currentTarget`, strengthened weak middleware/selector test assertions, and
  made the `stress.test.ts` header honest.

### Docs

- `ui.forUser` typing workaround (a TS inference gap across sibling config
  properties) and a copy-paste **Modal / focus-trap recipe**.

## 1.0.0-alpha15 — Deno 2.9 blank-app fix, kata test sweep, runtime hardening

Every aio version ≤ alpha14 dies on Deno ≥ 2.9 the moment a UI connects (WS
upgrade bug) — this release fixes that plus four more real-app bugs found by the
new kata-driven test suites, and hardens the runtime against a
watcher-feedback-loop incident from a field report.

**Behavior changes** (not API-breaking, but visible):

- Framework logs moved from `./log/` to **`.aio/log/`** (dot-dir — file
  watchers/scanners skip it; the incident was aio's own logs feeding an app's
  workspace watcher). Configure via `logging: { dir }`.
- Default file log level is **`info`** (was `trace`) — set
  `logging: { level: "trace" }` to keep logging every dispatch.
- Identical consecutive log lines collapse into "… last message repeated N
  times"; log writes are batched (250ms) instead of one fs write per entry.
- A server whose HTTP listener dies now **exits loudly** (supervisor-friendly)
  instead of spinning as a zombie; the single-instance lock treats "pid alive
  but port dead" as stale and reclaims it.

### Hardening (2026-07-08 field report)

- **`DISPATCH_STORM` guard** — new `dispatchStorm` config (default on: over 200
  dispatches/s sustained 5s) names the runaway action type in a warning +
  `dispatch:storm` diagnostic instead of leaving downstream symptoms;
  `{ breaker: true }` drops the offending action while the storm lasts
  (src/diagnostics/dispatch-storm.ts, wired through `beforeReduce`)
- **Event-loop stall detector** — a 1s heartbeat that arrives >3s late logs a
  `loop:stall` warning naming the starvation instead of dying silently
- **Zombie-server guard** — `httpServer.finished` without shutdown →
  `Deno.exit(1)` so supervisors restart the app
- **Lock liveness** — `AppLock.acquire` reclaims locks whose owner pid is alive
  but whose port refuses connections (10s startup grace; UDS instances exempt)
- **Log sink** — buffered writes, repeat suppression, `info` default, dot-dir
  (all above)

### Fixed (kata-driven test sweep, 2026-07-08)

- **WS connect no longer kills the server on Deno ≥ 2.9** — `handleWs` read
  `req.headers` (user-agent) _after_ `Deno.upgradeWebSocket(req)`; newer Deno
  closes the request on upgrade, so the header read threw `Request closed`, the
  serve callback died with "Upgrade response was not returned from callback",
  and **every app went blank the moment its UI connected**. Headers are now read
  before the upgrade (src/server/server-ws.ts)
- **Delegated event handlers see the right `e.currentTarget`** — AIR delegates
  most events to the mount root, so handlers received the root as
  `currentTarget` and the documented `e.currentTarget.value` pattern (docs,
  scaffolder templates, examples) read `undefined`. The dispatcher now presents
  the handling element as `currentTarget` while each handler runs
  (src/air/vdom-events.ts), matching the `AioEvent` contract in jsx-runtime
- **Nested `<Route>` + `<Outlet>` render** — a component returning an array
  (exactly what `Outlet` returns for route children) crashed the renderer
  (`applyProps` on `props: undefined`); `Outlet` now wraps array children in a
  Fragment (src/browser/browser-air-router.ts). Documented layouts in
  docs/ui/air-routing.md work now
- **`cell("app", { state: {}, methods: {} })` no longer crashes** — the empty
  methods map (generated by the `aio create` remote-electron/android scaffolds)
  fell through to the actions builder and threw; empty/omitted `methods` is now
  a valid state-only cell (src/state/cell-create.ts)
- **Flat apps get a browser import map** — the dev server only read `deno.json`
  from `baseDir/..` (scaffold layout); flat layouts (entry next to deno.json,
  e.g. repo examples) got no npm mappings, `immer` failed to resolve, and the
  page rendered blank. Fallback chain: `baseDir/..` → `baseDir` → cwd
  (src/server/server.ts)

### Added (roadmap B-testing)

- `examples/targets/<target>/` — one runnable example per compile target (all
  10), mirroring `aio create` output; runtime-tested in CI
  (tests/examples.test.ts) and UI-functionally tested via the real AIR renderer
  (tests/examples-ui.test.ts)
- Coverage ratchet gate — `deno task coverage:check` (scripts/check-coverage.ts)
  enforces a floor on src/ line coverage in CI; floor only moves up
- Tests for previously-untested exports: `NavLink`/`Outlet` (router),
  `useTimeTravel` + panel, `persistOp`/`loadOpsSince`/`getLowWater`/
  `SYNC_DEFAULTS`, `setSyncHandler`/`resendSubscriptions`, `disconnectDevTools`,
  `DEFAULT_PRAGMAS`/`createDB`

### Security (roadmap B5)

- **`/__aio/snapshot` requires `role: "admin"` in multi-user mode** — it
  returns/accepts raw, unfiltered state, so any authenticated user (e.g. a
  viewer) could bypass `ui: { exclude, forUser }` filtering; now admin-only on
  both the main server and the localhost trojan helper
- **`allowedOrigins`/`strictOrigin` are real config** — they existed on the
  internal server type but were never plumbed from `aio.run()` config (dead
  code); additionally, pages served by the server itself (Origin = own Host) are
  now accepted in `--expose` mode without manual allowlisting
- **Trojan localhost helper authenticates in `users`/`resolveUser` mode**
  (previously only token mode was checked)
- `?token=` URL warning also fires on the per-user auth path; the `ui: "all"`
  visibility warning also fires for multi-user (non-expose) setups
- **Symlinks under `baseDir` can no longer escape it** — static file serving
  re-checks the real path
- Docs: secrets need BOTH `persist.exclude` and `ui.exclude` (invariant +
  examples fixed in tutorial/persistence docs), snapshot semantics, health
  endpoint auth note

### Fixed

- **Dev server serves the browser app again** — folderization moved
  `server-static.ts` into `src/server/`, so its `/__aio/` framework-module
  resolver (`new URL(".", import.meta.url)`) pointed at `src/server/` instead of
  `src/`. Every framework module 404'd, the client's
  `import('/__aio/…/aio-renderer.ts')` threw, and **every browser/dev app
  rendered blank**. The `/__aio/` namespace now mirrors the `src/` folder
  structure (base at `src/` root; the client mounts
  `/__aio/air/
  aio-renderer.ts`), so a module's own `../state/…` imports
  resolve back inside `/__aio/`. Found by browser field validation, driven
  end-to-end in real chromium (AIO-405)
- **`compile:*` bundling works again** — folderization moved the build module,
  and its framework-path resolution (`frameworkSrcDir`, `frameworkBase`, the
  generated entry's `./src/App.tsx` import) still pointed at the old flat
  layout; all `compile:browser/electron/cli/android` targets bundle again
  (AIO-404)
- **Android builds run cell-based apps end-to-end** — verified on a real
  emulator (Pixel 7 / API 35): scaffold → `compile:android` → APK → install →
  interact → persist across restart. Fixes found in the process (AIO-404):
  - `standalone-air` now exports `cell` and a standalone `aio.run()`; the
    generated client bundle mounts `App.tsx` and never runs the user's `app.ts`,
    so `ensureConnected()` boots the runtime from the **cell registry** and
    binds methods before first render
  - the android entry auto-mounts and bundles as `iife` (was `esm` — the WebView
    loads it as a classic `<script>`, which threw on `export`)
  - state getters are upgraded to reactive signals so `counter.count` reads
    re-render the AIR tree after a local dispatch (verified: tap +, count
    updates; localStorage survives a force-stop + relaunch)

- **`connectCli` works against exposed (TLS + token) servers** — `wss://` URLs
  were silently downgraded to `ws:` and a `?token=` in the URL (the server's own
  share-link format) was dropped, so remote thin clients hung on `ready` forever
  with no error; both fixed, and repeated connect failures now log an actionable
  hint. Found by the remote field validation run (AIO-403)

### Internal

- **`src/` folderized into domain modules** — 199 flat files moved into
  `state/ protocol/ air/ browser/ server/ build/ am/ electron/ diagnostics/
  testing/`
  (plus existing `db/ sync/ vitals/ boot/`); `src/` root now holds only the
  public entry files. No export paths changed — vendored projects and jsr
  consumers are unaffected.
- **Module-boundary gate** — `deno task boundaries`
  (`scripts/check-boundaries.ts`, CI-enforced) locks the folder dependency
  matrix: `state/` stays isomorphic-light, `browser/`+`air/` can never import
  `server/`, tooling can't leak into the runtime graph.
- `src/*.test.ts` strays moved to `tests/`; `.gitignore` `build/` root-anchored
  (was silently excluding `src/build/` from the JSR package graph).

## 1.0.0-alpha14 — public-surface audit + AIR test harness (BREAKING for alpha users)

Road-to-1.0 hardening plus field-report fixes: the public-surface audit (entry
renames, export trims), wire-protocol and persistence versioning, AIR renderer
lifecycle correctness, and a public component test harness (from field-report
feedback).

### Added

- **Wire-protocol version handshake (roadmap A3)** — server and clients exchange
  `__proto:{v,min}` hellos on connect (WS, UDS, CLI); mismatches close loudly
  (code 4505) instead of failing mysteriously, and post-1.0 protocol evolution
  can negotiate instead of breaking old clients. Legacy clients without a hello
  still work.
- **Persistence schema versioning (roadmap A4)** — KV snapshots are stamped with
  the framework's schema version after each successful write; alpha-era
  (unstamped) stores migrate transparently on boot, stores written by a newer
  aio refuse to load with `PERSIST_SCHEMA` instead of being misread. Also fixes
  cell `version`/`onMigrate` stamps never being written — migrations re-ran on
  every restart.
- **`useRaf` hook** — requestAnimationFrame loop with automatic cleanup
  (AIO-392)
- **Public `testComponent`/`setDocument` harness** — render and drive AIR
  components in tests without a browser (AIO-393)
- **`CellEffect` type** — typed self-referencing effects in cell configs
- **`cell.method.action()` descriptor accessor** — schedule methods without
  hand-writing action objects
- **`aio create --vendored`** — git-clones the framework into `dep/aio/`
  (`git -C dep/aio pull` to update) with the vendored import map already correct
  (field-report follow-up)

### Changed (BREAKING — public-surface audit, roadmap A1)

Full audit + upgrade steps: `docs/specs/2026-07-04-public-surface-audit.md`,
`docs/upgrade/from-alpha13-to-alpha14.md`.

- **Entry renames**: `./src/build` → `./build` (now exports `build(cfg?)`
  instead of building on import), `./src/am` → `./am` (pure CLI entry, zero
  library exports). Update `deno task` definitions that use the jsr: paths.
- **`aio/adapters/air` removed** — import `useAio`/`useLocal`/`useConnected`
  from `aio/air`.
- **`aio/air` trimmed 145 → 101 exports**: state re-exports (`aio`, `cell`,
  `actions`, `effects`, `log`, `schedule`, `msg`) moved to `aio` only;
  `_`-internals and protocol plumbing (`bridge`, `client`, `matchPath`,
  `ensureConnected`) hidden; every remaining export documented; `useTimeTravel`
  tagged `@experimental`.
- **Stability tags**: `aio/state-core` entry and `aio/sync` engine internals are
  `@experimental`; `aio/db` no longer exports the worker wire format;
  `aio/air/compat` no longer exports test-only `_resetHints`.
- **Additive**: `aio/testing` re-exports `testComponent`/`setDocument`; `mod.ts`
  inference-only `_`-types tagged `@internal`.

### Fixed

- **Browser `aio` surface exports `own`** — cell modules that `import { own }`
  at module top (the documented `own.set` pattern, AIO-382) crashed the whole
  browser graph with "does not provide an export named 'own'"; browser-air now
  re-exports a pure effect-creator stub alongside the `schedule` stubs (AIO-402)
- **`onMount` runs after the DOM subtree and refs are committed** — refs are
  populated and children attached when it fires (AIO-390)
- **Pre-bind cell reads return declared state defaults** instead of undefined
  (AIO-391)
- **Fragment-in-map keyed children keep DOM order across re-renders** — region
  anchoring in the child differ, plus a reorder/add/remove stress suite
  (AIO-395)
- **Awaited methods no longer falsely time out** — ack registration is
  idempotent per cid (AIO-396), and the AIR command router settles acks instead
  of swallowing `__ack:` frames (AIO-399)
- **Nested array state serializes as arrays** through the async live proxy
  (AIO-397)
- **Browser-side `cell()` honors `scope: "client"`** and rejects async client
  methods at definition time (AIO-398)
- **`onMount` fires exactly once** — re-renders that re-collect mount callbacks
  (e.g. children changes) no longer remount wrappers/layouts (AIO-400)
- **Perf guards no longer flood the console** — WARN-class codes log at warn
  level and repetitive perf/vitals reports are throttled per (code, action) to
  once per 10s with a coalesced count; every occurrence still counts and reaches
  the diagnostic bus (AIO-401)
- **Typed `t.send` senders** in the test harness; refactor-safe scheduling docs
- **Clearer async-guard diagnostics**, type-only Deno refs, `testCell`
  self-dispatch

### Docs

- **Backoff on rate-limit** — worked self-scheduling `after`-chain pattern for
  dynamic polling (replaces hand-rolled `backoffUntil` state), cross-linked from
  `schedule.every` and static schedules (field-report P2)
- **Keyed map with default** — declare-once accessor pattern for
  `Record<string, T>` cell reads in JSX, no sprinkled `?? 0` guards
  (field-report P3)
- README vendored snippet now declares `immer` + `@std/path` (the doctor-check
  footgun)

## 1.0.0-alpha13 — DX overhaul + production hardening (BREAKING for alpha users)

The largest release since the `feature()` → `cell()` rename: the full DX
overhaul (phases 1–9), a production-readiness pass that fixed every audited
defect and made the project's own gates green, binding, and CI-enforced, plus
nuclear audit waves 6–11.

### DX overhaul — the framework now behaves as its docs and your intuition predict

- **Defaults flipped to honest**: `persist` and `ui` default to `"all"` —
  zero-config persists and syncs, as the README always claimed. Opt out per cell
  (`persist: "none"` / include/exclude). The "mode cliff" (one configured cell
  flipping global behavior) is gone.
- **`await method()` is real**: bound methods return Promises — sync resolves
  after the dispatch is applied, async resolves with the return value; in the
  browser the Promise resolves on server ack, so a state read on the next line
  is fresh (cid/ack protocol). Calling before `aio.run()` throws in dev.
- **State/callable name collisions now throw at `cell()` time** with a rename
  suggestion (previously the callable silently shadowed the state key).
- **Client-scoped cells**: `scope: "client"` — browser-local, per-tab,
  signal-backed, sync methods only; skipped by server composition. The todo
  example's filter uses it.
- **useEffect deps are honored** (React semantics, signal auto-tracking disabled
  inside deps-driven effects); React compat hooks
  (`useState`/`useEffect`/`useMemo`/`useCallback`) live **only** at
  `aio/air/compat` — removed from the `aio/air` main surface (`useRef` stays, it
  is a native AIR primitive).
- **Typed events**: `e.currentTarget` is element-typed on intrinsic handlers
  (AirEvent<T>); `onDoubleClick` aliased; unknown event names warn in dev.
- **Child signal subscriptions are independent of parents** — the
  `void sig.value` incantation is deleted from docs; invariant pinned by test.
- **Sync-classified methods returning a Promise throw in dev** (transpiled async
  detection) with a `markAsync` fix message.
- **`ui.entry`** option replaces the hardcoded App.tsx convention (default
  unchanged); **`aio doctor`** validates the six magic deno.json lines.

### Correctness fixes (full production audit — `bugs.md` B-1…B-13)

- **Signal graph never drops updates** — computed invalidation is now eager
  (push dirty flags synchronously, pull values lazily), so an effect reading a
  signal plus a derived computed written in the same `batch()` is glitch-free.
  This sat under every DOM event handler. (B-2)
- **SQLite worker type-checks again** on current Deno; `deno check` now covers
  `src/` (incl. worker entries) so it can't silently rot. (B-1, B-9)
- **Dropped dispatches reject instead of resolving** — under overload or after
  close(), `await cell.method()` no longer succeeds on unapplied state. (B-4)
- **Persistence/offline silent-failure trio fixed**: failed multi-key KV commits
  are reported, the offline queue warns when full, and the shutdown flush
  re-runs so a late write can't be lost. (B-7, B-8, B-10)
- **esbuild**: the false "not installed" warning is gone (it probes the real
  import) and dev transpile + prod bundle are pinned to the exact tested
  version. (B-5, B-6)
- **Lint to zero**, and the gate is now binding. (B-3)

### Operations & security

- **Configurable WebSocket limits** (`wsLimits`: message size / messages-per-sec
  / bytes-per-sec) for tuning `--expose` deployments without forking; defaults
  unchanged.
- **`/health` reports the framework version** for deploy verification.
- **Token-in-URL** (`?token=`) auth emits a one-time warning — it stays a
  fallback but flags the leak surface. (B-11)

### Release engineering

- **CI workflow** (`.github/workflows/ci.yml`): fmt / lint / check / full test
  suite across the supported Deno range + a JSR publish dry-run — "green" is now
  provable on every PR.
- **Whole-tree `deno fmt`** so the formatting gate is binding, and a
  **`docs:check` gate** that fails if any `AioErrorCode` ships undocumented.
- **GitHub issue templates** (bug / DX paper-cut / docs-lie) for a real feedback
  loop.

### Hardening — nuclear audit waves 6–11 (~194 fixes)

- Sync protocol routing (`onTTCommand` guard stops time-travel commands leaking
  into prod sync), sync cursor advance, concurrent HLC drop, SVG namespace,
  watcher sentinel TOCTOU, logger flush race, signal listener leak, rate-limiter
  abuse detection, op-buffer TTL eviction, state-module cleanup.

### Docs

- New **`from-alpha12-to-alpha13`** upgrade guide for the breaking changes;
  fixed the stale "persist defaults to none" claim in the alpha10→11 guide;
  every error code is documented in `docs/debugging/errors.md`; dead links fixed
  and stale `stateForUI`/`stateForDB` references removed.

---

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
