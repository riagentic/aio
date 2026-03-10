# Changelog

## v0.6.0

- `flow()` — generator-based sequential workflows triggered by actions
- `FlowCtx` — call, step, done, fail, put, all, race, sleep
- `reduce` and `machine` now optional in `feature()` — flow-only features
- Auto-generated flow actions visible in time-travel
- Auto-cancellation on re-trigger, feature disable, and destroy

## v0.5.0

- `feature()` — one function defines state, actions, effects, machine, reduce, execute, selectors
- State machines — required guards with validated transitions, `_status` auto-managed
- `A` / `E` dual-role objects — labels for switch + creators for dispatch
- `aio.run({ features })` — compose features into single dispatch loop
- `useFeature()` — scoped React hook with state, send, status
- `bridge()` — cross-feature request/response with timeouts, retries, circuit breaker
- `testFeature()` / `testBridge()` — isolated test harnesses
- Foreign action listeners — react to other features' actions via machine
- Scoped dispatch — executors limited to own actions + `crossDispatch` allowlist
- `implement()` — deferred executor attachment for server-only imports
- Feature lifecycle — `init` / `destroy` hooks, dependency-ordered
- Feature registry — `enable` / `disable` / `health` at runtime
- Middleware system — `aio.middleware.logger()`, `.validate()`, composable
- State versioning — `version` + `migrations` for schema evolution
- Health endpoint — `GET /__health` with per-feature status

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
