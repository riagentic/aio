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

*Future versions will be documented here as they are released.*
