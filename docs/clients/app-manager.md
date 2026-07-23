# App Manager

Manage your aio app without `ps`, `kill`, or `curl`. Works for humans and AI
agents alike.

```sh
deno task am <command> [args] [--flags]
```

> Prefer a GUI? **amui** (Aio Manager UI) is the visual app manager — discover,
> inspect (cells, merged state with persist/UI flags, metrics, files), and
> start/stop every aio app on your machine. See [amui](amui.md).

Output auto-detects: terminal -> pretty text, piped -> JSON. Override with
`--json` or `--quiet`.

## Building a cloned aio app (`am fix`)

A freshly cloned aio app usually **won't build yet** — the framework link,
`.env`, electron runtime and `node_modules` are all gitignored, so they're not
in the clone. `am fix` analyzes the repo and repairs the common breakages in one
go:

```sh
# 1 — install am + the framework (once per machine)
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh
# 2 — in the cloned app
cd my-app
am fix             # repair everything it can; then run: deno task dev
am fix --dry-run   # (alias --check) show what it WOULD do, change nothing
# 3 — build/run
deno task dev
```

`am fix` **only auto-applies safe, reversible, machine-specific repairs** — the
gitignored/uncommitted bits a fresh clone lacks. Anything that touches your
committed source or config it **advises** rather than changes.

Auto-fixed (safe):

| Fix                        | When                                                   |
| -------------------------- | ------------------------------------------------------ |
| `dep/aio` framework link   | source-layout app; symlink missing/broken (gitignored) |
| `.env` from `.env.example` | example present, `.env` missing                        |
| electron runtime           | app imports electron; `node_modules/electron` missing  |
| git submodules             | `.gitmodules` present but not initialized              |
| shell scripts executable   | a task runs a `.sh` that lost its `+x` bit             |
| dependency cache           | warms `deno cache` — surfaces any resolution error     |

Advised, never changed for you: `deno.json` config (`jsx`/`jsxImportSource`/
`nodeModulesDir`), a missing `appId` in `aio.run()`, a Deno version below the
floor. For code-level issues (deprecated APIs, older-version patterns) `am fix`
points you at the linter — `deno task lint:aio` (aiol) — it won't rewrite
source.

It recognizes **how the app consumes aio** and acts accordingly: a `dep/aio`
symlink is created/repaired; a **JSR/npm pin** needs no link (skipped); a **real
vendored `dep/aio` copy** (a committed directory, not a symlink) is **never
touched** — `am fix` only ever creates or repairs a symlink, it will not delete
deliberately-vendored framework code.

**Related:** `am doctor` diagnoses deno.json config only (read-only, PASS/FAIL);
`am link` is the narrow primitive that only (re)creates the `dep/aio` symlink
(`--aio=<path>` / `$AIO_HOME` to point it elsewhere). `am fix` includes both.

## App identity

Every aio app requires `appId` in the `aio.run()` call:

```ts
await aio.run({
  appId: 'my-app',
  cells: [...]
})
```

This is the single source of truth for app identity — used for lock files, UDS
sockets, the `data.db` path, and `am` commands. The value is slugified
(lowercase alphanumeric + hyphens). **`appId` is mandatory** — the app will not
start without it.

For `am` commands, use `--app=X` to specify which app to manage, or add `appId`
to `deno.json` as a dev convenience.

## Global flags

| Flag         | Effect                                                                               |
| ------------ | ------------------------------------------------------------------------------------ |
| `--app=X`    | Target a specific app by ID (default: from `deno.json` `appId`)                      |
| `--port=N`   | Target a specific port (default: from lock file or 8000)                             |
| `--wait[=N]` | start/stop: block until complete (default 10s/5s). state: poll every Ns (default 2s) |
| `--json`     | Force JSON output                                                                    |
| `--quiet`    | Suppress output (exit code only)                                                     |

## Process management

```sh
deno task am start                # start app (kills zombies, refuses if running)
deno task am start --wait         # start and block until healthy (default 10s timeout)
deno task am start --wait=30      # start with 30s timeout
deno task am start --port=9000    # start on specific port
deno task am stop                 # graceful shutdown
deno task am stop --wait          # stop and block until dead (default 5s timeout)
deno task am restart              # stop + start
deno task am status               # stopped|starting|started|stopping
```

Exit codes: `started` -> 0, `stopped` -> 1, `starting`/`stopping` -> 2.

`start` and `stop` return immediately by default — use `--wait[=N]` to block
until the action completes. `restart` always waits for stop internally, then
spawns and returns immediately. `stop` tries graceful shutdown via trojan API,
falls back to SIGTERM, escalates to SIGKILL after timeout. Kill sequence:
SIGTERM -> wait 2s -> SIGKILL.

### Singleton behavior

Controlled by `singleton` in `aio.run()`:

| Value            | Behavior                              |
| ---------------- | ------------------------------------- |
| `true` (default) | Refuse if another instance is running |
| `'takeover'`     | Kill existing instance, start new one |
| `false`          | Allow multiple instances              |

Lock files at `/tmp/aio/` (or `$XDG_RUNTIME_DIR/aio/`) as `{appId}.lock`. Stale
locks (dead PID) are auto-cleaned. Zombies (alive but not responding) are killed
automatically on `start`.

## Instance discovery

```sh
deno task am instances            # list all running aio apps on this machine
deno task am ls                   # alias
deno task am instances --json     # JSON output
```

Scans lock files, validates each PID is alive, returns active instances with
appId, port, PID, uptime, and cwd.

**Programmatic:**

```ts
import { instances, resolveAppId } from "aio/extras";

const running = await instances(); // all running apps
const mine = await instances("my-app"); // specific app
const id = resolveAppId("My Cool App!"); // canonical slug: 'my-cool-app'
```

## State inspection

```sh
deno task am state                          # full state (raw, unfiltered)
deno task am state counter                  # single cell slice
deno task am state counter.count            # nested path
deno task am state fleet[0].stats           # array index traversal
deno task am state fleet[0].{name,active}   # pick specific fields
deno task am state fleet[*].{pair,status}   # wildcard: pluck from every element
deno task am state {counter,page}           # pick from root
deno task am state counter --wait=5         # poll every 5s
deno task am ui                             # UI state (cell-level ui filtered)
deno task am ui alice                       # UI state for specific user
```

Path syntax: `fleet[0].stats.pnl` for traversal, `{id,name}` for field picking,
`[*]` for wildcard over arrays. `am state` = raw server state. `am ui` = what
the browser sees.

## Action dispatch

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

Positional args (without `=`) -> `{ args: [...] }` for methods. Named
`key=value` -> `{ key: value }` for actions. Values are auto-parsed: numbers,
booleans, `null`, JSON arrays/objects, strings.

## Time-travel

In browser (dev mode): press **Ctrl+.** to toggle the time-travel panel. Shows
action history with timestamps and performance metrics (`reduce:ms effects:ms`).

## Persistence and snapshots

```sh
deno task am persist                        # force flush to SQLite
deno task am snapshot                       # dump state to stdout
deno task am snapshot save backup.json      # save to file
deno task am snapshot load backup.json      # restore from file
```

## UI inspection and interaction (dev mode)

Inspect and drive the live UI from the CLI through the **semantic UI surface** —
the same facility `testUI` uses, so what you do here and what a test does behave
identically. Elements are addressed by component/name, not CSS selectors.

```sh
deno task am ui                              # server-side UI state
deno task am surface                         # semantic surface (client 0): every component + triggerable element
deno task am surface 1                       # surface for a specific client
deno task am trigger 0 App:SubmitButton click        # click by component:name path
deno task am trigger 0 App:Email type "a@b"          # type into an input
deno task am trigger 0 App:Search focus               # focus / blur / hover / scroll / press
```

Run `am surface` first to see the addressable `Component:name` paths, then
`am trigger` them. This is the one unified UI facility — the old CSS-selector
`am interact`/`am click` and raw `am dom` snapshot were removed in favour of it.

## Monitoring

```sh
deno task am clients              # connected clients (type, transport)
deno task am schedules            # active timers/cron
deno task am metrics              # uptime, connections, schedule count
deno task am health               # health check (exit 0 = ok)
deno task am config               # server config
deno task am sql "SELECT ..."     # read-only SQL query
deno task am tables               # list SQLite tables
deno task am log                  # tail last 50 lines
deno task am log --filter=ERROR   # filter log lines
deno task am log --follow         # stream (like tail -f), also: -f
deno task am log --client         # tail client log (log/client.log)
deno task am errors               # last transpile error (dev mode)
deno task am watch                # hot-restart on file change in src/
deno task am new cell payments # scaffold cell
deno task am new page settings    # scaffold page
```

## Trojan — Control REST API

REST API at `/__aio/trojan/*` for inspection and control. Available in dev and
prod.

### Inspect (GET)

| Endpoint                      | Returns                                    |
| ----------------------------- | ------------------------------------------ |
| `/__aio/trojan/state`         | Raw full state (unfiltered)                |
| `/__aio/trojan/ui`            | UI state (cell-level ui filtered)          |
| `/__aio/trojan/ui?user=alice` | UI state for specific user                 |
| `/__aio/trojan/clients`       | Connected clients (type, transport, index) |
| `/__aio/trojan/surface/<n>`   | Semantic UI surface from client n (dev)    |
| `/__aio/trojan/trigger/<n>`   | POST: drive the UI ({path, action, text?}) |
| `/__aio/trojan/history`       | Time-travel entries                        |
| `/__aio/trojan/schedules`     | Active timer/cron IDs                      |
| `/__aio/trojan/metrics`       | Uptime, connections, schedule count        |
| `/__aio/trojan/config`        | Port, title, expose, authMode, prod        |
| `/__aio/trojan/health`        | Cell health: status, enabled, errors       |

### Control (POST)

All POST endpoints require the `X-AIO: 1` header (CSRF protection). All return
JSON. Auth is inherited — tokens required when `--expose` is active.

```sh
# Dispatch action
curl -X POST localhost:8000/__aio/trojan/dispatch \
  -H 'X-AIO: 1' -H 'Content-Type: application/json' \
  -d '{"type":"INCREMENT","payload":{"by":1}}'

# Force persist
curl -X POST localhost:8000/__aio/trojan/persist -H 'X-AIO: 1'

# Time-travel (dev only)
curl -X POST localhost:8000/__aio/trojan/tt -H 'X-AIO: 1' -d '{"cmd":"undo"}'
curl -X POST localhost:8000/__aio/trojan/tt -H 'X-AIO: 1' -d '{"cmd":"goto","arg":3}'

# SQL query (read-only)
curl -X POST localhost:8000/__aio/trojan/sql -H 'X-AIO: 1' \
  -d '{"query":"SELECT * FROM users LIMIT 10"}'

# Interact with client UI
curl -X POST localhost:8000/__aio/trojan/interact/0 \
  -H 'X-AIO: 1' -H 'Content-Type: application/json' \
  -d '{"action":"click","selector":"#submit"}'
```

## HTTP endpoints

| Endpoint               | Availability | Purpose                                    |
| ---------------------- | ------------ | ------------------------------------------ |
| `/`                    | always       | HTML shell — entry point                   |
| `/ws`                  | always       | WebSocket — state sync, actions, deltas    |
| `/__aio/ui.js`         | dev only     | Live-transpiled browser code               |
| `/__aio/error`         | dev only     | Error overlay                              |
| `/__aio/snapshot` GET  | always       | Full raw state dump                        |
| `/__aio/snapshot` POST | always       | Load state from JSON                       |
| `/app.js` `/style.css` | prod only    | Pre-bundled dist assets                    |
| `/__aio/trojan/*`      | always       | Control REST API (dev-only -> 403 in prod) |

## For AI agents

`am` is designed for programmatic use. Output is JSON when piped:

```sh
deno task am health && echo "up" || echo "down"
deno task am state | jq '.fleet[0].stats'
deno task am dispatch portfolio:buy symbol=AAPL qty=10
deno task am surface --json | jq '.[].elements[] | select(.text == "Login")'
deno task am trigger 0 App:LoginButton click
deno task am log --client --json | jq 'select(.level == "ERROR")'
```

## Troubleshooting

| Problem                          | Fix                                                     |
| -------------------------------- | ------------------------------------------------------- |
| `am status` says "stopped"       | No running process. Check `.aio.log` for errors         |
| `am start` says "port in use"    | Non-aio process on port. Use `--port=N`                 |
| `am` targets wrong app           | Check `appId` in `aio.run()` — use `--app=X`            |
| Actions do nothing               | Check browser console + `--verbose` log for WS messages |
| State resets on restart          | Ensure `persist` isn't `false`/`"none"`                 |
| Port in use                      | Kill old process or use `--port=N`                      |
| Server dies when Electron closes | Use `--keep-server` flag or `keepServer: true`          |
