# AIO Upgrade Guide

How to upgrade between aio versions. Each section lists what changed, what breaks, and exact steps to update your code.

---

## v0.1 → v0.2

### New features

- **CSS hot reload** — CSS-only changes inject without page reload (React state preserved)
- **`--expose` flag** — bind `0.0.0.0` with auto-generated UUID token for LAN access
- **`--version` / `--help` flags**
- **`--url` thin client** — launch Electron connecting to a remote aio server. See [manual.md — Thin client](manual.md#thin-client---url)
- **`--width` / `--height` flags** — override Electron window dimensions from CLI
- **Window config** — `ui: { width, height }` sets default Electron window size. Embedded as `<meta>` tags for thin client discovery
- **Window state persistence** — Electron remembers window bounds across runs via `window-state.json`
- **Configurable `persistDebounce`** — control KV write frequency (default: 100ms)
- **Per-user `getUIState(state, user?)`** — server-controlled per-user state filtering
- **Multi-user auth** — `users: Record<string, AioUser>` token map with per-user identity. See [manual.md — Multi-user auth](manual.md#multi-user-auth)
- **camelCase factory creators** — `A.increment()` alongside `A.Increment` label
- **Startup linter** — validates state, config, App.tsx, esbuild, electron on boot
- **Error overlay** — transpile errors shown on page instead of blank screen
- **Guardrail hardening** — bad reducer output, invalid effects, and reducer throws are caught and logged instead of crashing
- **Lifecycle hooks** — 6 optional `on*` callbacks with `user?` parameter: `onAction`, `onEffect`, `onConnect`, `onDisconnect`, `onStart`, `onStop`. Observe-only, error-guarded. See [manual.md — Lifecycle hooks](manual.md#lifecycle-hooks)
- **Time-travel** — dev mode records action history with undo/redo/goto. Press Ctrl+. for browser panel, or use `am tt undo`. `useTimeTravel()` hook for programmatic control. 200-entry cap, zero cost in prod. See [manual.md — Time-Travel](manual.md#time-travel)
- **am — app manager** — CLI for process lifecycle, state inspection, dispatch, time-travel, log tailing. `deno task am help`. Output: pretty for terminals, JSON for scripts/agents. See [manual.md — am](manual.md#am--app-manager)
- **Connection status indicator** — shows "Reconnecting..." pill on disconnect and "Connected" briefly on reconnect. Pure DOM, no user code. Disable with `ui: { showStatus: false }`
- **State snapshots** — `app.snapshot()` / `app.loadSnapshot(json)` + HTTP `GET/POST /__snapshot`. See [manual.md — State snapshots](manual.md#state-snapshots)
- **Scheduled effects** — `schedule.after/every/at/cron/cancel` — declarative timers, intervals, cron jobs as effects. See [manual.md — Scheduled effects](manual.md#scheduled-effects)
- **aio-client** — standalone Electron connect-page app (`compile:electron:remote`). Connects to any aio server without Deno
- **One-liner init** — `sh -c "$(curl -fsSL .../init.sh)" -- my-app` scaffolds a new project with interactive template menu
- **SQLite persistence** — 3-tier data layer for structured data. `db: { orders: table({...}) }` in config. Level 1: auto-sync arrays to/from SQLite. Level 2: `app.db.orders.where(...)` ORM. Level 3: `app.db.query(...)` raw SQL. Uses `node:sqlite` (built into Deno 2.2+, zero deps). See [manual.md — SQLite persistence](manual.md#sqlite-persistence)

### Breaking changes

#### 1. `execute(app, effect)` parameter order swapped

**v0.1:** `execute(effect, app)`
**v0.2:** `execute(app, effect)`

This matches `reduce(state, action)` — context first, thing-to-process second.

```diff
- export function execute(effect: Effect, app: AioApp<AppState, Action>): void {
+ export function execute(app: AioApp<AppState, Action>, effect: Effect): void {
```

The startup linter warns if your first parameter is named `effect`.

#### 2. `subscribe()` removed

`subscribe(keys)` was a client-side bandwidth filter. It's been replaced by `getUIState(state, user?)` — a server-controlled per-user filter that's more secure and doesn't leak the full state shape.

**If you used `subscribe()`:**

```diff
  // App.tsx — REMOVE subscribe call
- import { useAio, subscribe } from 'aio'
+ import { useAio } from 'aio'

  export default function App() {
    const { state, send } = useAio<UIState>()
-   useEffect(() => { subscribe(['stats']) }, [])
    // ...
  }
```

```diff
  // app.ts — ADD getUIState with per-user filtering
  await aio.run(initialState, {
    reduce, execute,
-   getUIState: (s) => s,
+   getUIState: (s, _user?) => ({ stats: s.stats }),  // server controls what clients see
  })
```

#### 3. Factory creators are now camelCase

**v0.1:** Only PascalCase labels existed (`A.Increment` = string `"Increment"`)
**v0.2:** Also generates camelCase creators (`A.increment(5)` = `{ type: "Increment", payload: { by: 5 } }`)

No breaking change if you used the old `msg()` pattern — it still works. But the recommended pattern is now:

```ts
// Old (still works)
send(msg('Increment', { by: 5 }))

// New (recommended)
send(A.increment(5))
```

### Upgrade steps

1. **Swap execute params:** Find `execute(effect, app)` → change to `execute(app, effect)`
2. **Remove subscribe:** Delete any `subscribe()` calls from App.tsx. If you need per-user filtering, add `getUIState: (s, user?) => ...` to your `aio.run()` config
3. **Update dep/aio/:** Copy the new `dep/aio/` folder over the old one
4. **Run `deno install`**
5. **Run `deno task dev`** — the startup linter will catch remaining issues

---

## v0.2 → v0.3

### New features

- **Performance budgets** — dispatch loop timing with configurable thresholds. `perfMode: 'strict' | 'soft'` and `perfBudget: { reduce?, effect? }` in config. Violations call `onError({ source: 'performance', ... })` or warn (soft). Per-action perf metrics recorded in time-travel history. See [manual.md — Performance budgets](manual.md#performance-budgets)
- **Redux DevTools** — connect to the Redux DevTools browser extension for state inspection and action history. `connectDevTools()` / `disconnectDevTools()` from `'aio'`. See [manual.md — Redux DevTools](manual.md#redux-devtools-integration)
- **Incremental SQLite sync** — tables with a `pk()` column now use row-level INSERT/UPDATE/DELETE diffs instead of full table replacement. Significantly faster for large datasets. No migration needed — PK detection is automatic
- **Memoized selectors** — `createSelector(...inputFns, resultFn)` and `createSliceSelector`. Caches derived values until inputs change, preventing redundant recalculations. See [manual.md — Selectors](manual.md#selectors)
- **`matchEffect(effect, handlers, fallback?)`** — typed alternative to switch/case in `execute()`. Scales better for large effect catalogs. See [manual.md — matchEffect](manual.md#matcheffect)
- **`composeMiddleware(...fns)`** — compose multiple `beforeReduce` functions into a single pipeline. Return `null` from any function to drop the action. See [manual.md — composeMiddleware](manual.md#composemiddleware)
- **Android schedule warning** — unsupported schedule effects on Android now log `console.warn` instead of silently dropping

### Breaking changes

None. All v0.2 code runs unchanged on v0.3.

### Upgrade steps

1. Replace `dep/aio/` with the v0.3 folder
2. Run `deno install`
3. Run `deno task dev` — no linter warnings expected for v0.2 code

### Optional improvements

Take advantage of new features at your own pace:

```ts
// Performance budgets (catch slow reducers in CI)
await aio.run(state, {
  reduce, execute,
  perfMode: 'strict',
  perfBudget: { reduce: 50, effect: 3000 },
  onError: ({ source, error }) => console.error(`[${source}]`, error),
})
```

```tsx
// Redux DevTools (add to App.tsx in dev)
import { useAio, connectDevTools } from 'aio'
export default function App() {
  const { state, send } = useAio<AppState>()
  useEffect(() => { connectDevTools() }, [])
  // ...
}
```

```ts
// Memoized selectors (avoid recomputing expensive derivations)
import { createSelector } from 'aio'
const selectFiltered = createSelector(
  (s: AppState) => s.items,
  (s: AppState) => s.filter,
  (items, filter) => items.filter(i => i.status === filter),
)
```

---

## v0.3 → v0.4

### New features

- **Zero-config HTTPS** — `--expose` now auto-generates a self-signed ECDSA P-256 cert (cached in `.aio-tls/`). Traffic is encrypted by default. Use `--cert=path.pem --key=path.pem` to bring your own CA-signed cert. Electron windows accept self-signed localhost certs automatically
- **`am watch [dir]`** — hot-restart on `.ts`/`.tsx` changes in `src/` (or custom dir). 300ms debounce, same as `am restart`. Usage: `deno task am watch` or `deno task am watch src/`
- **`am logs --follow` / `-f`** — stream log output live (like `tail -f`). Usage: `deno task am logs -f` or `deno task am logs --follow [filter]`
- **`am status` exit codes** — now explicit: `0`=started, `1`=stopped, `2`=transitional (starting/stopping). Useful for scripts and CI
- **`persistMode:'multi'`** — store each top-level state key as a separate Deno.Kv entry, bypassing the 65KB/key limit. Set `persistMode: 'multi'` in config
- **ORM additions** — `table.whereOr(filters[])` for OR-joined WHERE, `table.upsert(row)` for INSERT OR REPLACE, `QueryOpts` with `orderBy`, `limit`, `offset` on `all(opts?)` and `where(filter, opts?)`

### Bug fixes

- **`_computeDelta` threshold** — fixed denominator to `Math.max(newKeys, oldKeys)` — previously undercounted when state keys were removed, causing unnecessary full-state broadcasts
- **`scheduleReload` symlink** — resolves real path via `Deno.realPathSync` before cache lookup — fixes hot-reload on macOS (`/var` → `/private/var` symlink)
- **`syncTables` full scan** — eliminated `SELECT * FROM table` on every sync cycle; now diffs state vs previous in memory. Zero DB reads per sync

### Breaking changes

None. All v0.3 code runs unchanged on v0.4.

### Upgrade steps

1. Replace `dep/aio/` with the v0.4 folder
2. Run `deno install`
3. Run `deno task dev` — no changes required

### Optional improvements

```sh
# Hot-restart on file changes
deno task am watch

# Stream logs live
deno task am logs -f

# Check if app is running (exit code 0=yes, 1=no, 2=transitional)
deno task am status; echo $?
```

```ts
// Bypass 65KB KV limit for large state
await aio.run(state, {
  reduce, execute,
  persistMode: 'multi',
})
```

```ts
// ORM: OR queries, upsert, pagination
const adults = table.whereOr([{ role: 'admin' }, { role: 'mod' }])
table.upsert({ id: 1, name: 'alice' })
const page = table.all({ orderBy: 'name', limit: 20, offset: 40 })
```

```sh
# Expose with auto-HTTPS (zero config)
deno task dev --expose

# Expose with your own cert
deno task dev --expose --cert=/etc/ssl/myapp.pem --key=/etc/ssl/myapp.key
```

---

*Future versions will be documented here as they are released.*
