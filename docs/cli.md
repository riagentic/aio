# CLI & App Manager

Command-line flags, startup linter, live reload, and the `am` process manager.

For the docs index, see [manual.md](manual.md). For build flags, see
[builds.md](builds.md).

## CLI flags

`aio.run()` reads `Deno.args` automatically — no parsing code needed in your
app. CLI flags override config values:

```sh
deno task dev --port=3000 --client=browser --no-persist --title="My App"
```

| Flag               | Effect                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `--port=N`         | Override server port                                                                               |
| `--client=X`       | Client mode: `electron`, `browser`, `cli`, `server-only` (replaces `--no-electron` / `--headless`) |
| `--no-persist`     | Disable Deno.Kv state persistence                                                                  |
| `--keep-server`    | Keep server running after Electron window closes                                                   |
| `--kill-existing`  | Kill existing instance before starting (use with `singleton: true`)                                |
| `--title=X`        | Override window/page title                                                                         |
| `--verbose`        | Verbose logging — actions, state, effects, WS, HTTP, persistence                                   |
| `--prod`           | Force prod mode — serve pre-built `dist/app.js` (auto-detected in compiled binaries)               |
| `--width=N`        | Override Electron window width (default: 800)                                                      |
| `--height=N`       | Override Electron window height (default: 600)                                                     |
| `--expose`         | Bind `0.0.0.0` + auto-HTTPS + auth token — share app with other devices on LAN                     |
| `--cert=PATH`      | TLS certificate file (PEM) — used with `--expose` (auto-generated if omitted)                      |
| `--key=PATH`       | TLS private key file (PEM) — used with `--expose` (auto-generated if omitted)                      |
| `--transport=X`    | Transport mode: `uds`, `ws`, or `auto` (default: `auto`)                                           |
| `--server-url=URL` | Thin client mode — launch Electron connecting to remote aio server (no local server)               |
| `--version`        | Print aio version and exit                                                                         |
| `--help`           | Show available CLI flags and exit                                                                  |

**Precedence:** CLI flags > config object > defaults

Active flags are logged on startup:

```
[12:00:00][INFO] ✓ state (1 keys) · reduce · execute · App.tsx
[12:00:00][INFO] cli: --port=3000 --client=browser
[12:00:00][INFO] running (dev, browser)
[12:00:00][INFO]   web       http://localhost:3000
[12:00:00][INFO]   ws        ws://localhost:3000/ws
```

### Verbose mode

`--verbose` logs the entire pipeline in real time:

```
[12:00:00][DEBUG] config: port=52341 persist=true electron=false title="My App" baseDir=./src
[12:00:00][DEBUG] persist: loaded from KV key="state"
[12:00:00][DEBUG] state: 1 keys
[12:00:01][DEBUG] http: GET /
[12:00:01][DEBUG] http: GET /App.tsx
[12:00:01][DEBUG] http: GET /__aio/ui.js
[12:00:01][DEBUG] ws: connect (1 total)
[12:00:02][DEBUG] ws: recv {"type":"INCREMENT","payload":{"by":1}}
[12:00:02][DEBUG] action → reduce: INCREMENT {"by":1}
[12:00:02][DEBUG] state: changed [counter]
[12:00:02][DEBUG] persist: saved
[12:00:02][DEBUG] effect → execute: LOG {"message":"incremented by 1 to 6"}
[12:00:02][DEBUG] broadcast → 1 client(s)
[12:00:03][DEBUG] ws: disconnect (0 total)
```

### UDS transport

`--transport=uds` uses Unix domain sockets instead of WebSocket/HTTP for
Electron apps. The `auto` default selects UDS on Linux/macOS when using
Electron, WS otherwise.

**Why UDS?** No open TCP ports — more secure, slightly faster. The Electron app
communicates over NDJSON on a Unix socket instead of HTTP/WS.

**How it works:** Deno ↔ UDS/NDJSON ↔ Electron main (Node.js `net.connect`) ↔
IPC ↔ renderer (`window.__aioIPC`). Static files are served via Electron's
`protocol.handle('aio', ...)` — no HTTP server needed.

Socket path: `/tmp/aio/{slug}.sock` (or `$XDG_RUNTIME_DIR/aio/{slug}.sock` if
set).

**Exceptions:** `--expose` always uses WS (needs real HTTP for remote access).
Browser mode always uses WS. Windows always uses WS (no UDS support).

CLI apps can connect via `connectCliUDS(socketPath)` for headless UDS transport.

## Startup linter

When `aio.run()` starts, it checks your app and reports issues:

**Clean startup:**

```
[12:00:00][INFO] ✓ state (1 keys) · reduce · execute · App.tsx
[12:00:00][INFO] running (dev, electron)
[12:00:00][INFO]   web       http://localhost:52341
[12:00:00][INFO]   ws        ws://localhost:52341/ws
[12:00:00][INFO]   id        my-app
[12:00:00][INFO]   title     My App
[12:00:00][INFO]   singleton true
[12:00:00][INFO]   persist   single
[12:00:00][INFO]   expose    false
[12:00:00][INFO]   auth      none
```

**Issues found:**

```
[12:00:00][INFO] ── checks ──
[12:00:00][INFO]   ✓ state (1 keys) · reduce · execute
[12:00:00][WARNING] App.tsx has no `export default` — add it so the framework can mount your component
[12:00:00][INFO]   · App.tsx has `import React` — not needed, JSX transforms are automatic
```

**What it checks:**

- `✗` **Errors** (prevents startup): state is null/not object, reduce/execute
  missing, App.tsx missing
- `⚠` **Warnings** (app starts but may not work): App.tsx has no default export,
  esbuild not installed, sync I/O in execute.ts
- `·` **Hints** (suggestions): leftover `createRoot`, `import React`, old
  `'../dep/aio/'` imports, electron not installed

**Sync I/O warnings:** The linter detects blocking operations in `execute.ts`:

- `Deno.readTextFileSync`, `Deno.writeTextFileSync`, `Deno.readDirSync`,
  `Deno.statSync` → warn to use async versions
- These operations block the dispatch loop and make the UI unresponsive

```
[WARNING] execute.ts: sync I/O (readTextFileSync) blocks the dispatch loop — use async versions (readTextFile) instead
```

## Live reload

AIO watches `baseDir` (default: `src/`) for file changes. When any `.ts`,
`.tsx`, `.css`, or other file is modified or created, all connected browsers
automatically reload.

```
[12:00:05][DEBUG] watch: changed /home/dev/code/gen/my-app/src/App.tsx
[12:00:05][DEBUG] reload → 2 client(s)
```

**How it works:**

1. `Deno.watchFs` monitors `baseDir` recursively
2. On file change, the transpile cache for that file is invalidated
3. After a 100ms debounce (to batch rapid saves), a `__reload` signal is sent
   over WebSocket
4. Browser receives the signal and calls `location.reload()`
5. Fresh page loads, `useAio()` reconnects, server sends current state

**No state is lost** — state lives on the server, so reloading the browser is
free. The UI picks up exactly where it left off.

### Server restart detection

When the server restarts (crash, manual restart, `am restart`), existing browser
tabs auto-reconnect via WebSocket. The server sends a boot ID on each WS connect
— if the browser detects a different boot ID on reconnect, it triggers
`location.reload()` to pick up fresh JS. No stale code in memory after restarts.

Additionally, browser open is delayed 1.5s on startup. If an existing tab
reconnects within that window (common on fast restarts), no duplicate tab is
opened.

### CSS hot reload

CSS changes are handled specially — instead of a full page reload, the browser
injects the updated stylesheet without losing React state.

**How it works:**

1. File watcher detects a change
2. If only `.css` files changed in the debounce window, server sends `__css`
   signal (not `__reload`)
3. Browser finds the `<link>` tag for `style.css` and cache-busts it with
   `?t=<timestamp>`
4. Browser downloads the new CSS — no React unmount/remount, no state loss

If a CSS file and a TS/TSX file change in the same debounce window, a full
`__reload` is sent instead (since the JS needs reloading anyway).

## am — App Manager

Full reference: **[am.md](am.md)**

Manage your aio app without `ps`, `kill`, or `curl`. Quick overview:

```sh
deno task am <command> [args] [--flags]
```

Output auto-detects: terminal → pretty text, piped → JSON. Override with
`--json` or `--quiet`.

### Global flags

| Flag         | Effect                                                                               |
| ------------ | ------------------------------------------------------------------------------------ |
| `--app=X`    | Target a specific app by ID (default: from `deno.json` `appId`)                      |
| `--port=N`   | Target a specific port (default: from lock file or 8000)                             |
| `--wait[=N]` | start/stop: block until complete (default 10s/5s). state: poll every Ns (default 2s) |
| `--json`     | Force JSON output                                                                    |
| `--quiet`    | Suppress output (exit code only)                                                     |

### Process management (singleton)

Each app requires `appId` in `aio.run()` — the single source of truth for app
identity. See [am.md](am.md) for full details.

The `singleton` config option controls instance behavior:

| Value                                 | Behavior                                                       |
| ------------------------------------- | -------------------------------------------------------------- |
| `true` (default)                      | Refuse if another instance of the same app is running          |
| `singleton: true, killExisting: true` | Kill existing instance, start new one (useful for dev servers) |
| `false`                               | Allow multiple instances                                       |

Locking uses a single lock file per app at `/tmp/aio-{appId}.lock` (or
`$XDG_RUNTIME_DIR`). Contains
`{ appId, pid, port, startedAt, status, cwd, socketPath?, trojanPort? }`. Stale
locks (dead PID) are auto-cleaned.

| Existing instance               | Behavior                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------- |
| None                            | Start normally                                                                |
| Dead (stale lock file)          | Clean up, start                                                               |
| Alive + responding              | Refuse ("already running") — or kill if `singleton: true, killExisting: true` |
| Alive + not responding (zombie) | Kill (SIGTERM → SIGKILL), then start                                          |
| Status `stopping`               | Wait up to 3s, force kill if stuck, then start                                |
| Status `starting`               | Refuse ("instance is starting — use am restart")                              |

```sh
deno task am start                # start app (kills zombies, refuses if running)
deno task am start --wait         # start and block until healthy (default 10s timeout)
deno task am start --wait=30      # start with 30s timeout (slow boot apps)
deno task am start --port=9000    # start on specific port (passed through to app)
deno task am stop                 # graceful shutdown, return immediately
deno task am stop --wait          # stop and block until dead (default 5s timeout)
deno task am restart              # stop (waits internally) + start (returns immediately)
deno task am status               # stopped|starting|started|stopping
```

`start` and `stop` return immediately by default — use `--wait[=N]` to block
until the action completes. `restart` always waits for stop internally (port
must be free), then spawns and returns immediately. `status` cross-validates
lock file against process liveness and port response. Exit codes: `started` → 0,
`stopped` → 1, `starting`/`stopping` (transitional) → 2.

`start` writes the lock file with `status: starting`, logs to `.aio.log`. `stop`
tries graceful shutdown via trojan API, falls back to SIGTERM, escalates to
SIGKILL after timeout. Kill sequence is always graceful-first: SIGTERM → wait 2s
→ SIGKILL.

### Instance discovery

```sh
deno task am instances            # list all running aio apps on this machine
deno task am ls                   # alias for instances
deno task am instances --json     # JSON output for scripting
```

Scans lock files in `/tmp/` (or `$XDG_RUNTIME_DIR`), validates each PID is
alive, and returns active instances with their appId, port, PID, uptime, and
cwd.

**Programmatic:**

```ts
import { instances, resolveAppId, slugify } from "aio";

const running = await instances(); // all running apps
const mine = await instances("my-app"); // specific app
const id = resolveAppId({ appId: "foo" }); // canonical ID
const slug = slugify("My Cool App!"); // 'my-cool-app'
```

### State inspection

```sh
deno task am state                          # full state JSON
deno task am state fleet[0].stats           # JS-like path traversal
deno task am state fleet[0].{name,active}   # pick specific fields (destructuring)
deno task am state fleet[*].{pair,status}   # wildcard: pluck from every array element
deno task am state fleet[*].stats.pnl       # wildcard: nested traversal
deno task am state {counter,page}           # pick from root
deno task am state fleet[0].stats --wait=5  # poll every 5s, print each result
deno task am state fleet[*].pnl --wait     # poll every 2s (default)
deno task am ui                             # UI state (stateForUI result)
deno task am ui alice                       # UI state for specific user
```

Path syntax mirrors TypeScript: `fleet[0].stats.pnl` for traversal, `{id,name}`
for field picking (like destructuring), `[*]` for wildcard over arrays. Missing
keys in brace-pick are silently skipped. `--wait[=N]` polls every N seconds
(default 2s), printing each result (Ctrl+C to stop).

### Actions

```sh
# Methods — positional args (no =)
deno task am dispatch counter:increment 5                    # { payload: { args: [5] } }
deno task am dispatch counter:reset                          # { payload: { args: [] } }

# Actions — named payload (with =)
deno task am dispatch counter:BulkUpdate items='[1,2]'       # { payload: { items: [1,2] } }

# Raw JSON
deno task am dispatch --body='{"type":"counter:increment","payload":{"args":[5]}}'
deno task am actions                       # last 20 actions from history
deno task am actions 50                    # last 50 actions
```

Positional args (without `=`) are wrapped as `{ args: [...] }` — use for
methods. Named `key=value` pairs produce `{ key: value }` — use for actions.
Values are auto-parsed: numbers, booleans, `null`, JSON arrays/objects, strings.

### Time-travel

**In browser (dev mode only):**

- Press `Ctrl+.` (period) to toggle the time-travel panel
- Shows action history with timestamps
- **Performance metrics**: each action shows `reduce:ms effects:ms`
  - Times turn red when budget exceeded
  - Helps identify slow reducers or blocking effects

```
┌─ Time-travel ──────────────────────┐
│ ▸ Increment    2ms  0ms             │
│   LoadUsers    5ms  1ms             │
│   SaveFile     3ms  (async)         │
│ ◾ SetPage     12ms 150ms ⚠         │ ← slow!
└─────────────────────────────────────┘
```

**Via `am` CLI:**

### Persistence & snapshots

```sh
deno task am persist              # force flush to KV/SQLite
deno task am snapshot             # dump state to stdout
deno task am snapshot save backup.json   # save to file
deno task am snapshot load backup.json   # restore from file
```

### Other commands

```sh
deno task am clients              # connected WebSocket clients
deno task am sql "SELECT * FROM orders LIMIT 5"  # raw SQL query
deno task am tables               # list SQLite tables
deno task am schedules            # active timers/cron
deno task am log                  # tail last 50 lines of .aio.log
deno task am log --filter=ERROR   # filter log lines
deno task am log --lines=100      # show more lines
deno task am log --follow         # stream new lines in real-time (like tail -f), also: -f
deno task am watch                # hot-restart on .ts/.tsx change in src/
deno task am watch lib            # watch a different directory
deno task am errors               # last transpile error (dev mode)
deno task am metrics              # uptime, connections, schedule count
deno task am health               # health check (exit 0 = ok)
deno task am config               # server config (port, title, auth mode, prod)
deno task am version              # aio version
deno task am help                 # full command list
```

### For AI agents

`am` is the primary interface for AI agents managing aio apps. Output is JSON
when piped, making it easy to parse programmatically:

```sh
# Check if app is running
deno task am health && echo "up" || echo "down"

# Read state, parse with jq
deno task am state | jq '.fleet[0].stats'

# Dispatch and verify
deno task am dispatch portfolio:buy symbol=AAPL qty=10
deno task am state portfolio.positions
```

## Trojan — Control API

aio exposes a REST API at `/__aio/trojan/*` for full inspection and control.
Available in both dev and prod modes — use `am` or `curl` directly.

### Inspect (GET)

```sh
curl localhost:8000/__aio/trojan/state        # raw full state (unfiltered)
curl localhost:8000/__aio/trojan/ui           # UI state (default view)
curl localhost:8000/__aio/trojan/ui?user=alice # UI state for specific user
curl localhost:8000/__aio/trojan/clients      # connected WS clients
curl localhost:8000/__aio/trojan/history      # time-travel entries
curl localhost:8000/__aio/trojan/schedules    # active timer/cron IDs
curl localhost:8000/__aio/trojan/metrics      # uptime, connections, schedule count
curl localhost:8000/__aio/trojan/config       # port, title, expose, authMode, prod
curl localhost:8000/__aio/trojan/health       # feature health (v0.5): status, enabled, errors per feature
```

### Control (POST)

```sh
# All POST endpoints require X-AIO: 1 header (CSRF protection)

# Dispatch action
curl -X POST localhost:8000/__aio/trojan/dispatch \
  -H 'X-AIO: 1' -H 'Content-Type: application/json' \
  -d '{"type":"INCREMENT","payload":{"by":1}}'

# Replace state
curl -X POST localhost:8000/__aio/trojan/snapshot -H 'X-AIO: 1' \
  -d '{"counter":99}'

# Time-travel commands (dev only — returns 403 in prod)
curl -X POST localhost:8000/__aio/trojan/tt -H 'X-AIO: 1' -d '{"cmd":"undo"}'
curl -X POST localhost:8000/__aio/trojan/tt -H 'X-AIO: 1' -d '{"cmd":"redo"}'
curl -X POST localhost:8000/__aio/trojan/tt -H 'X-AIO: 1' -d '{"cmd":"goto","arg":3}'

# SQL query (if db configured) — SELECT only
curl -X POST localhost:8000/__aio/trojan/sql -H 'X-AIO: 1' \
  -d '{"query":"SELECT * FROM users LIMIT 10"}'

# Force persist to KV/SQLite
curl -X POST localhost:8000/__aio/trojan/persist -H 'X-AIO: 1'
```

All POST endpoints require the `X-AIO: 1` header. All endpoints return JSON.
Errors return `{"error":"..."}` with appropriate status codes. Auth is inherited
— tokens required when `--expose` is active.

## HTTP endpoints

| Endpoint               | Availability                                   | Purpose                                                                                                             |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/`                    | always                                         | HTML shell — entry point for browser/Electron                                                                       |
| `/ws`                  | always                                         | WebSocket — state sync, action dispatch, delta broadcasts, TT commands                                              |
| `/__aio/ui.js`         | dev only                                       | Live-transpiled browser.ts — useAio, WS client, page(), msg()                                                       |
| `/__aio/error`         | dev only                                       | Error overlay — fetches last transpile error                                                                        |
| `/__aio/snapshot` GET  | always                                         | Full raw state dump — backup, debugging, export                                                                     |
| `/__aio/snapshot` POST | always                                         | Load state from JSON — restore, import, testing                                                                     |
| `/app.js` `/style.css` | prod only                                      | Pre-bundled dist assets from `dist/`                                                                                |
| `/__aio/trojan/*`      | always (dev-only endpoints return 403 in prod) | Control REST API — inspect state, dispatch, SQL. POST requires `X-AIO` header. (see [Trojan](#trojan--control-api)) |

All endpoints inherit auth (token/user checks run before routing). In `--expose`
mode, tokens are required.

## Troubleshooting

| Problem                                   | Fix                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `JSX.IntrinsicElements` type error        | Check `compilerOptions` in deno.json, run `deno install`                                                |
| Blank page in browser                     | Check startup log — missing App.tsx or no `export default`. Syntax errors show an overlay automatically |
| Actions do nothing                        | Check browser console + `--verbose` log for WS messages                                                 |
| State resets on restart                   | `persist: true` (default) + `"unstable": ["kv"]` in deno.json                                           |
| `import from '../dep/aio/'` error         | Always use `import from 'aio'` — never relative paths                                                   |
| Port in use                               | Kill old process or use `--port=N`                                                                      |
| Electron not found                        | `deno task install:electron`. Or use `--client=browser` to open browser instead                         |
| Electron installed but no window          | Check that `node_modules/electron/dist/` exists — run `deno task install:electron`                      |
| Server dies when Electron closes          | Use `--keep-server` flag or `keepServer: true` in config                                                |
| Build Error: could not find 'npm:esbuild' | Add `"esbuild": "npm:esbuild@^0.24"` to deno.json imports, then `deno install`                          |
| `am status` says "stopped"                | No running process. Stale lock file auto-cleaned. Check `.aio.log` for errors                           |
| `am start` says "port in use"             | Non-aio process on the port. Use `--port=N`. (aio zombies are killed automatically)                     |
| `am` targets wrong app                    | Check `appId` in `aio.run()` — use `--app=X` to target a specific app                                   |
