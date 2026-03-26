# Changelog

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
