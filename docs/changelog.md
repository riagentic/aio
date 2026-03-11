# Changelog

## v0.7.0

**reactive() — plain methods instead of reduce/execute**
- Sync methods mutate state via Immer draft (batched, one action per call)
- Sync methods can return schedule effects (timers, intervals)
- Async methods get live Proxy — reads always fresh, writes auto-dispatch
- Machine-gated async writes — method-tagged `__setMethod` actions with auto-injected transitions
- Microtask batching — consecutive Proxy writes grouped into one action per sync frame
- `listensTo: string[]` — foreign action listeners without a full machine
- Selectors, crossDispatch, init/destroy hooks
- Direct calling — `counter.increment(5)` after `aio.run()`, no `.A.` namespace
- Async error action — `{Prefix}:__error` with machine self-loop in all states
- Async `testFeature()` — `t.runEffects()` + `t.settle()`

**flow() improvements**
- `ctx.waitFor(actionType, timeout?)` — pause until external action dispatched
- `ctx.getState()` — read current feature state inside a flow
- `cancelOn: string[]` — declarative flow cancellation on arbitrary actions
- `ctx.put()` accepts `{ type, payload? }` — payload optional
- Flow errors fed back into generator via `gen.throw()` for try/catch support

**DX & infrastructure**
- `aio.run()` binds dispatch + selectors to all features (reactive, feature, flow)
- TypeScript inference — typed intersections with autocomplete for direct calling
- Pre-bind console.warn when methods called before `aio.run()`
- `machine: false` accepted as alias for `'simple'`
- FeatureDef carries phantom State type for testFeature inference
- `useSyncExternalStore` in useAio/useFeature for selective re-renders
- `useAio` deprecated in favor of `useFeature`
- Startup linter validates empty features, `_status` reserved key, empty actionKeys
- `--type` and `--template` CLI flags for non-interactive project scaffolding

**Infra**
- Nested delta patches — fine-grained state sync (only changed sub-keys sent)
- UDS transport — zero TCP ports in prod electron builds, smart auto-detect
- `Msg<P>` generic — reduce/execute callbacks allow `action.payload.field` without casts
- WebSocket payload validation — malformed payloads rejected at boundary
- Per-user action authorization — middleware and `beforeReduce` receive `user?`
- App identity with identity-based singleton lock

**Docs**
- 15 topic files split from monolithic manual.md
- features.md — all 5 inter-feature interaction patterns
- debugging.md — error interpretation, time-travel forensics
- classic.md — v0.4 API reference

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
