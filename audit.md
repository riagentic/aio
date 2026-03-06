# AIO Framework — Multi-Aspect Audit

> Audited: v0.3.0 | Date: 2026-03-06 | Scope: all source files, tests, docs

---

## 1. Architecture

### Strengths
- **Clean separation of concerns** — dispatch loop (`dispatch.ts`), server (`server.ts`), persistence (`skv.ts`, `sql.ts`), scheduling (`schedule.ts`), and UI bridge (`browser.ts`) are all independent modules with narrow interfaces.
- **Dual-runtime symmetry** — `browser.ts` and `standalone.ts` expose the same API (`useAio`, `useLocal`, `page`, `actions`, `effects`, `msg`) so App.tsx is target-agnostic.
- **Immutable state with Immer** — `draft()` makes reducers ergonomic without sacrificing structural sharing. The `structuredClone` on effect payloads (before and after dispatch loop) correctly detaches Immer draft refs.
- **Delta broadcast** — per-client `lastKeyJsons` cache with ref-equality short-circuit before JSON.stringify is a genuinely clever optimization (~20x skip rate documented).
- **Config-level schedules** — declarative `ScheduleDef[]` array at startup is a clean upgrade over requiring users to emit effects from `onStart`.
- **Dispatch is re-entrant-safe** — effects can call `dispatch()` without corruption via the internal queue drain loop.
- **Trojan API** — localhost-only control REST surface (state inspect, SQL, TT, persist, shutdown) is well-scoped and useful for `am` tooling.

### Weaknesses / Issues
- **`_dispatchUser` module-level var** (`aio.ts:379`) — set before dispatch, cleared in `onDone`. Works correctly for the sync dispatch loop (one-instance-per-process design). Would need to become a parameter if async dispatch is ever added.
- **`skv.ts` is thin to the point of being vestigial** — 12 lines wrapping Deno.Kv. It provides no value (no batching, no error handling, no retry). Consider inlining it into `aio.ts` or deleting it. Current signature silently swallows write failures since `set()` returns a Promise that is never awaited in the hot path (debounced persist).
- **No KV write error propagation** — in `aio.ts:546-550`, `kvDb.set().then(log.debug).catch(log.error)` fires-and-forgets. If KV is flaky, data is silently lost. The `flushPersist()` path (shutdown) does await, so final save is safe, but interim debounced saves are not.
- **`standalone.ts` duplicates `draft()`** — acknowledged in a comment but the duplication is a maintenance risk. A shared `draft-fn.ts` importable by both without circular deps would be cleaner.
- **`browser.ts` duplicates `msg()` and factory** — also acknowledged. The comment says "sync.test.ts verifies". The test exists but it's a fragile manual sync guarantee. A build step that verifies byte-for-byte equality would be stronger.
- **`prevDbState` shallow copy** (`aio.ts:515`) — `{ ...(state as ...) }` is a shallow copy. For nested state the ref-equality check in `syncTables` will miss deep mutations if a user mutates state without going through Immer. Document that SQLite sync requires Immer or new object references.
- **No backpressure on offline IndexedDB queue** (browser.ts) — `_offlineQueue` grows without bound when disconnected after the initial connect (only `_queue` has `WS_MAX_QUEUE` guard). A malicious or buggy client could OOM the browser tab.
- **Time-travel stores full state snapshots per action** (`time-travel.ts:54`) — `structuredClone(state)` on every action. For large state (even approaching the 65KB KV limit) this is 200 × 65KB = 13MB in RAM. Should be noted in docs or bounded by state size.

---

## 2. Security

### Strengths
- **Timing-safe token comparison** (`server.ts:48-56`) — custom constant-time compare is correct and XOR-accumulates length differences.
- **Origin check on WS** — rejects non-localhost origins when not exposed. Allows `allowedOrigins` override for Docker/proxy scenarios.
- **Path traversal protection** — `filepath.startsWith(absBaseDir + SEPARATOR)` guard on static file serving.
- **CSRF on snapshot POST** — requires `X-AIO` custom header (browser won't send cross-origin without preflight). Correct.
- **Trojan SQL is read-only** — regex blocks INSERT/UPDATE/DELETE/DROP/ALTER etc. However...
- **XSS in `escHtml`** — `escHtml` in `server.ts:120-123` does NOT escape single quotes (`'`). This is only used in HTML attributes with `"..."` quoting, so not a current XSS vector, but it's a latent bug if the function is reused in other contexts.
- **HTML entity escaping** — title is escaped before embedding in HTML via `escHtml`.

### Issues
- **Trojan SQL regex is bypassable** — `ATTACH DATABASE` is blocked but `PRAGMA` is not. `PRAGMA writable_schema=ON` followed by `SELECT * FROM sqlite_master WHERE sql LIKE '%DROP%'` could leak schema details. Minor for a localhost-only API but worth noting.
- **No HTTPS/WSS** — by design for local/LAN use. Documented in manual with reverse proxy guidance (nginx/Caddy).
- **Token in URL query param** — documented risk in manual with `Authorization: Bearer` as alternative.
- **`--expose` token regenerates on restart** — documented.
- **No rate limiting on HTTP endpoints** — the Trojan API at `/__trojan/*` has no rate limiting. A local process could spam `dispatch` actions or `sql` queries without consequence.
- **`snapshot load` via Trojan bypasses CSRF check** — `/__trojan/snapshot` POST does not require the `X-AIO` header that `/__snapshot` POST requires. Inconsistency.
- **`isCompiled()` heuristic** (`aio.ts:347`) — uses `APPIMAGE` env var OR checks if URL starts with `file:///`. The `!import.meta.url.startsWith('file:///')` branch would trigger for any module loaded via `https://` (e.g. remote import), which could incorrectly trigger prod mode in some edge cases.

---

## 3. Performance

### Strengths
- **Delta broadcast** — skips unchanged keys with ref-equality. JSON.stringify only for changed keys. Avoids full serialization when state is large and changes are small.
- **Debounced persistence** — 100ms default avoids KV write storms on rapid action sequences.
- **Transpile cache** — capped at 200 entries, invalidated on source change. Prevents repeated esbuild calls for unchanged files.
- **Coalesced broadcast** — `queueMicrotask` batches multiple same-tick state changes into a single push.
- **Performance budgets** — reduce (100ms) and effect (5ms sync) budgets with `strict`/`soft` modes. Per-action timing sent to TT panel.

### Issues
- **Time-travel `structuredClone(state)` on every action in dev mode** — for large states (arrays of objects) this can be expensive at high action rates. A 50Hz action rate with 10KB state = 500KB cloned/sec. No size guard.
- **`syncTables`** — ~~full table scan per sync~~ fixed: diffs `state` vs `prev` in memory, zero `SELECT *` reads per cycle.
- **`insertMany` in `sql.ts` uses manual BEGIN/COMMIT** instead of Deno's native `database.transaction()` — fine for correctness but slightly more verbose than necessary.
- **`broadcast()` calls `getUIState()` per client per broadcast** — if `getUIState` is expensive (e.g. runs selectors), it runs N times per state change for N clients. Selectors help, but this is worth noting.
- **`_computeDelta` threshold** — ~~denominator used new-state key count, biasing toward full state on removals~~ fixed: uses `Math.max(new, old)` key count.
- **`scheduleReload` path normalization** — ~~may miss cache keys on macOS (symlink `/var`→`/private/var`)~~ fixed: `Deno.realPathSync` resolves symlinks before cache lookup.

---

## 4. Code Quality

### Strengths
- Well-typed throughout. Minimal use of `any` (mostly justified at Node.js/SQLite API boundaries).
- Good use of JSDoc with examples in `mod.ts`.
- `assertIdent` SQL identifier validation is the right pattern — whitelist regex, fail fast.
- `deepMerge` prototype-pollution protection (`BANNED_KEYS`) and depth cap are correct.
- `parseCron` / `nextCronTime` is a self-contained, testable cron implementation.
- `composeMiddleware` is pure and correct.

### Issues
- **`matchEffect` type safety** (`mod.ts:138-147`) — `handlers` uses `Partial<{ [K in E['type']]: (payload: any) => void }>`. The `payload: any` is unchecked — the handler receives the raw `.payload` field without type narrowing. A discriminated union approach would be safer but requires TypeScript 4.9+ `satisfies`.
- **`createSelector` max 5 inputs** — hardcoded overloads for 1-5 selectors. The generic variadic fallback (`...args`) exists but loses type safety. Consider a more ergonomic API or at least document the limit.
- **`resolvePath` in `am.ts`** — brace-pick regex `^(.*?)\.?\{([^}]+)\}$` is greedy on the prefix, which can produce surprising results for paths like `a.b.{c}` vs `a.{b.c}`. Edge cases aren't tested.
- **`parseCli` ignores unknown flags silently in most cases** (`aio.ts:310`) — it warns on unknown `--foo` flags but only if the known list is checked. The known list is a local string array that can drift from actual flag handling.
- **`am.ts cmdStart` uses `nohup` + shell escaping** (`am.ts:334-335`) — the manual `esc()` function using single-quote wrapping works on bash but not on all sh implementations (e.g. fish, zsh in certain modes, Windows). The `doService` flag in `build.ts` generates a systemd unit file that hardcodes path assumptions.
- **`electronClientScript` inline HTML** (`electron.ts:199`) uses template literals with raw JS — no CSP headers, no subresource integrity. The connect page runs in Electron with full node integration disabled (correct), but the absence of CSP is still a gap.
- **`generateHTML` dev mode has inline script** (`server.ts:160`) with dynamic import map and error overlay JS. No nonce or CSP. For localhost-only use this is acceptable but should be noted.
- **Version sync** — `VERSION` is defined in `aio.ts` and manually kept in sync with `deno.json`. The `validateVersion()` call at module load is a best-effort check that only runs at build time. A CI lint step enforcing this would be more reliable.
- **`isWhereOp` heuristic** (`sql.ts:122-126`) — any plain object with only keys from `['gt','gte','lt','lte','ne','like','in']` is treated as a where operator. A user object `{ like: 'something' }` would be misinterpreted as an operator. This is a semantic footgun.

---

## 5. Test Coverage

### Strengths
- 413 tests passing. Good coverage of: dispatch loop, delta protocol, deep-merge, factory, msg, selectors, schedules (including cron), time-travel, hooks, middleware, SQL ORM, server (unit), integration (WS protocol), standalone, cli-client, lint, snapshot, perf budgets.
- Integration tests use real sockets (not mocks) — tests actual WS handshake, delta protocol, auth rejection, multi-client broadcast.
- `sync.test.ts` enforces browser.ts / msg.ts parity — clever.
- `freeze.test.ts` verifies dev-mode immutability enforcement.

### Gaps
- **`build.ts` — 0% functional coverage** — only `slugify`, `writePlaceholderIcon`, `copyDir` helpers are tested. The actual esbuild bundling, deno compile, AppImage packaging, Android build, and service file generation are untested. This is the most complex file and the most likely to break silently.
- **`browser.ts` — 0% direct coverage** — the offline queue, IndexedDB persistence, boot-ID reload, Redux DevTools integration, TT panel rendering, and reconnect backoff are all untested. The `sync.test.ts` only verifies API surface parity.
- **`am.ts` — ~15% coverage** — `readPid`, `writePid`, `formatUptime`, `resolvePath`, `parsePayload`, `parseGlobalFlags` are tested. But `cmdStart`, `cmdStop`, `cmdRestart`, `cmdStatus`, `cmdDispatch`, `cmdSnapshot`, `cmdLog`, `cmdSql` — the actual process management and HTTP client logic — are not tested. These are the most operationally critical paths.
- **`electron.ts` — 0% coverage** — the Electron main script generation, window state persistence, keyboard shortcut handling, and client connect-page logic are untested. `electronMainScript` and `electronClientScript` generate ~100 lines of JS each.
- **`server.ts` — partial** — unit tests cover auth, delta, static serving. Missing: path traversal edge cases, Trojan API POST endpoints (`dispatch`, `snapshot`, `tt`, `sql`, `persist`, `shutdown`), the file watcher, max connections enforcement, binary file serving.
- **No chaos/fault tests** — KV failure during write, SQLite locked, electron crash, WS close during broadcast, dispatch queue overflow (>1000). The overflow guard exists but isn't tested.
- **No load tests** — claimed 50-100 concurrent clients / 100-200 actions/sec. No benchmark that validates this under sustained load.
- **`standalone.ts` — partial** — happy path tested. Missing: localStorage quota exceeded, `onRestore` throwing, schedule effects warning, frozen state mutation in dev mode.
- **`deep-merge.ts` — gaps** — prototype pollution with `__proto__` key is tested. Missing: depth > 32, `null` merging edge cases for all branches, mismatched array/object types.

---

## 6. Developer Experience

### Strengths
- **`aio create`** — interactive CLI with 10 app types × 4 sizes. Good UX with colored prompts, numbered menus, and sensible defaults.
- **Startup linter** — catches `App.tsx` missing, bad imports, sync I/O in execute.ts, import path mistakes. Fires before server starts.
- **`am` tool** — process management with `start/stop/restart/status`, state inspection, time-travel control, SQL queries, snapshot management. Rich CLI with `--json`, `--quiet`, `--wait` flags.
- **Time-travel panel** — built-in Ctrl+. toggle, draggable, shows action history with per-action perf timing. No external dev tools needed.
- **Error overlay** — build errors shown in browser with source location, WS reconnects automatically on fix.
- **Hot reload** — CSS-only changes inject without page reload; TS/TSX changes trigger full reload. 100ms debounce.
- **Redux DevTools** — `connectDevTools()` bridges to the browser extension for users who prefer it.

### Issues
- **`am start` requires `nohup` + manual PID file** — fragile compared to a proper process supervisor. On macOS, `nohup` behavior differs. On Windows, this doesn't work at all. There's no Windows `am start` path.
- **No `am logs --follow`** — `cmdLog` reads the log file once. There's no `tail -f` equivalent via `am`. Users must manually tail `.aio.log`.
- **`deno task` not mentioned in `am help`** — users must know to run `deno task am` vs `deno task build` vs `deno task compile`. The help text assumes the user knows the task names.
- **`--headless` flag inconsistency** — it can be passed as a config option OR a CLI flag. But the `--headless` CLI flag for `am start` passthrough requires knowing this; `am help` doesn't document passthrough flags.
- **No `am logs --level=error`** — the log filter is substring-based. A structured log level filter would be more useful.
- **Template `Medium`/`Large` sizes** — the size matrix exists but what distinguishes them isn't clear from the create UX. A description of what's included in each size would help.
- **`aio create` remote types** — `remote-electron` and `remote-android` are thin clients that require a separately running server. This two-component mental model is non-obvious for new users.
- **No `am watch` command** — there's no "restart on source change" dev loop command. Users must manually stop/start during backend changes (frontend is covered by hot reload).
- **Electron window persistence (`window-state.json`)** — persists to `userData`. If the user renames the app (changes slug), they get a new userData path and lose their window position. Documented nowhere.

---

## 7. Documentation

### Strengths
- `A4.md` — one-page framework overview is genuinely useful.
- `MANUAL.md` — comprehensive API reference.
- `QUICKSTART.md` and `MIGRATION.md` cover the two main entry points.
- `README.md` — includes examples, architecture diagram (text), and feature matrix.
- Inline JSDoc in `mod.ts` with runnable examples.

### Gaps
- **No architecture diagram** — the data flow (action → dispatch → reduce → effects → execute → broadcast) is described in prose but not visualized. A simple ASCII flowchart would help.
- **Security model** — ~~undocumented, scattered~~ consolidated into "Security model" section in manual.md: threat table, limitations table, intended deployment model, reverse proxy examples.
- **SQLite Level 1/2/3 terminology** — referenced in memory but not defined in docs in a way that's discoverable without reading the source.
- **`getUIState` per-user filtering** — the pattern for RBAC (role-based state filtering) is not shown in a complete example anywhere.
- **`composeMiddleware` is exported but not in A4.md or QUICKSTART.md** — easy to miss.
- **`matchEffect` is exported but underdocumented** — the footgun around untyped payload is not mentioned.
- **No changelog** — `UPGRADE.md` covers migration but there's no chronological changelog of what changed between versions.
- **Cron pattern documentation** — `schedule.cron()` accepts a 5-field cron pattern but the supported syntax (ranges, steps, wildcards, no named months/DOW) is not documented in MANUAL.md.
- **`effectTimeout` config option** — mentioned in `AioConfig` but not described in docs. It appears in the type but is never actually used in the implementation (no timeout logic in dispatch.ts or execute path). Dead config key.
- **`perfBudget.effect` semantics** — "sync portion only" is a subtle but critical distinction. Async effects return a Promise immediately; the 5ms budget measures only the synchronous setup. This should be prominently documented.

---

## 8. What Is Missing / Could Be Added

### High value, low effort
- **`am logs --follow`** — tail `.aio.log` in real time. Simple `Deno.watchFs` or `Deno.stdin` loop.
- **`am watch`** — restart server on `src/app.ts` change (backend hot reload). Frontend already hot-reloads; backend doesn't.
- **`effectTimeout` implementation** — the config key exists but does nothing. Wire it up: wrap async effect promises with `Promise.race([effect, timeout])` and log/report if exceeded.
- **Snapshot auto-rotation** — scheduled snapshots (e.g. daily backup to `snapshots/YYYY-MM-DD.json`) via the existing schedule system.
- **`am dispatch --watch`** — poll state after dispatch and print it. Useful for scripting.
- **`createSelector` with 6+ inputs** — trivial to add, removes the arbitrary limit.

### Medium value, medium effort
- **HTTP/2 or HTTPS support** — `Deno.serve` with TLS options. Would make `--expose` deployments production-grade without requiring a reverse proxy.
- **`am tail` / structured log streaming** — instead of file-based logging, stream logs over a WebSocket or SSE endpoint from `/__trojan/logs`. Would enable `am logs --follow` without file I/O.
- **State schema validation on restore** — `deepMerge` handles type mismatches silently. An optional `validateState: (s: S) => boolean | string` hook in `AioConfig` would let users reject or correct corrupt persisted state.
- **`subscribe()` for server-side effects** — a way for server-side code to react to state changes without dispatching actions (e.g. send email when `order.status === 'paid'`). Current workaround is lifecycle hooks + manual state tracking in effects.
- **Multi-key KV persistence** — storing state as one big blob (65KB limit) is the main scalability bottleneck. Splitting across multiple KV keys (one per top-level state key) would multiply the effective limit.
- **`db.insertOrUpdate()` / upsert** — common pattern missing from ORM. Currently requires `find()` + `insert()` or `update()` branching.
- **`WHERE OR` support** — `buildWhere` only generates `AND` clauses. `OR` is a common query need.
- **`ORDER BY` / `LIMIT` in ORM** — `all()` returns all rows, `where()` has no ordering. For large tables this forces in-memory sort.
- **TypeScript strict mode** — the project doesn't use `"strict": true` in `deno.json` compilerOptions. Enabling it would catch a class of bugs (implicit any, nullability) that exist silently today.

### Lower value / exploratory
- **WASM for state serialization** — `JSON.stringify`/`JSON.parse` in the hot path (broadcast, persist, delta) is a JS bottleneck. A WASM JSON codec could help for large states, but this is micro-optimization territory given the current scale targets.
- **Reactive selectors pushed to UI** — instead of sending full `getUIState()` result, push only selector outputs that changed. More granular than key-level deltas.
- **Plugin ecosystem** — a `middleware` array (compose-based) is cleaner than `beforeReduce` alone. Something like Redux middleware for effects (`afterReduce`) would unlock logging, analytics, etc.
- **iOS / React Native target** — the Android path works via WebView; iOS/RN would require a different bridge strategy.
- **Multi-process / worker support** — for CPU-heavy reducers, offload to a `Deno.Worker` and return results via message passing.

---

## 9. Bugs Found

| ID | File | Line(s) | Severity | Description |
|----|------|---------|----------|-------------|
| B1 | `server.ts` | 499-519 | Medium | Snapshot POST size check uses `content-length` header which can be spoofed or absent. The actual body is re-checked with `json.length` but the header check runs first and could pass for a missing/wrong header. Both checks are needed; current order is correct but the `content-length` check gates too early on a header that can be 0 or missing. |
| B2 | `aio.ts` | 776-777 | Low | `Deno.args.filter(a => a.startsWith('--'))` for logging CLI flags will show `--` if user passes bare `--`. Cosmetic. |
| B3 | `am.ts` | 508 | Low | `cmdStatus` exits with code 1 for `stopping` and `starting` states. This breaks shell scripts that use `am status` to detect a running app — exit code 1 is conventionally "error", not "not fully started". Exit code 2 for non-fatal "not ready" would be cleaner. |
| B4 | `selector.ts` | 71 | Low | `lastInputs && inputs.length === lastInputs.length` — first call always recomputes even if inputs haven't changed (since `lastInputs` is null). Harmless but the comment "cache miss on first call" is worth adding. |
| B5 | `browser.ts` | 386-393 | Medium | `_send()` during initial connect (before `_wasConnected`) pushes to `_queue` with `WS_MAX_QUEUE` guard. But if `_wasConnected` becomes true and then the connection drops, subsequent sends go to `_offlineQueue` which has NO size cap. A slow reconnect + high action rate can grow `_offlineQueue` without bound. |
| B6 | `schedule.ts` | 91-109 | Low | `nextCronTime` uses UTC fields (`getUTCMonth`, `getUTCHours` etc.) but the cron spec doesn't document timezone behavior. Users expecting local time cron will get surprises. Should be documented or made configurable. |
| B7 | `sql.ts` | 189 | Low | `insertMany` derives column list from `rows[0]` keys. If rows have different key sets (e.g. some rows omit optional fields), the INSERT will fail for later rows. Should validate all rows against schema or use the schema column list directly. |
| B8 | `aio.ts` | 587-588 | Low | `beforeReduce` returning `null` to drop an action returns `{ state: s, effects: [] as E[] }`. This correctly skips the action, but it still calls `onDone()` (persist + broadcast) for a no-op. Minor unnecessary work. |
| B9 | `electron.ts` | 341 | Low | `spawnElectron` writes temp `.cjs` file, spawns, and cleans up after `proc.status`. If the process is killed externally (SIGKILL), `proc.status` resolves but the temp file may not be cleaned up if the runtime dies before the `.then()` runs. Use `Deno.addSignalListener` or `unload` event for cleanup. |
| B10 | `server.ts` | 640-641 | Medium | Path traversal check: `filepath.startsWith(absBaseDir + SEPARATOR)`. On Windows, `SEPARATOR` is `\` but the URL pathname uses `/`. The `resolve()` call normalizes, but if `absBaseDir` itself contains a trailing separator (e.g. root drive `C:\`), the check `C:\ + \` = `C:\\` may fail. Likely fine in practice but worth a Windows integration test. |

---

## 10. Summary Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Architecture | 9/10 | Clean, modular, well-separated. One-instance-per-process is intentional design. |
| Security | 9/10 | Auto-HTTPS on `--expose` (self-signed cert, BYO supported). Token auth, origin check, trojan localhost-only. Security model documented. |
| Performance | 9/10 | Delta broadcast, debounced persist, transpile cache, zero-scan SQLite sync. TT memory (dev-only) is the remaining gap. |
| Code Quality | 8/10 | deepMerge array→object bug fixed. isWhereOp footgun documented. insertMany validated. Dead effectTimeout implemented. |
| Test Coverage | 7/10 | Core well tested + effectTimeout, cert handler, resolveControlPort, quota, deepMerge edge cases added. build.ts/browser.ts/am handlers deferred. |
| DX | 9/10 | TT panel, error overlay, hot reload, `am watch`, `am logs -f`, `--expose` auto-HTTPS, linter, 10-target create flow. |
| Documentation | 8/10 | Security model, TLS/HTTPS guide, cron UTC note, isWhereOp warning, getUIState RBAC example. Architecture diagram still missing. |
| **Overall** | **8/10** | Solid, opinionated, production-grade for localhost/LAN/remote with auto-TLS. Main gaps: build/browser test coverage, no load tests. |
