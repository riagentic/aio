# Changelog

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
