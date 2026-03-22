# am — App Manager

Manage your aio app without `ps`, `kill`, or `curl`. Works for humans and AI agents alike.

```sh
deno task am <command> [args] [--flags]
```

Output auto-detects: terminal → pretty text, piped → JSON. Override with `--json` or `--quiet`.

## App Identity

Every aio app requires `appId` in the `aio.run()` call:

```ts
await aio.run({
  appId: 'my-app',
  features: [...]
})
```

This is the single source of truth for app identity — used for lock files, UDS sockets, KV/SQLite paths, and `am` commands. The value is slugified (lowercase alphanumeric + hyphens).

**`appId` is mandatory.** The app will not start without it. It must be in `aio.run()`, not `deno.json` — compiled builds don't have access to `deno.json` at runtime.

For `am` commands, use `--app=X` to specify which app to manage, or add `appId` to `deno.json` as a dev convenience (the linter will warn but `am` can read it).

## Global flags

| Flag | Effect |
|------|--------|
| `--app=X` | Override appId (default: from `deno.json` in dev) |
| `--port=N` | Override port (default: from lock file) |
| `--wait[=N]` | start/stop: block until complete (default 10s/5s). state: poll every Ns (default 2s) |
| `--json` | Force JSON output |
| `--quiet` | Suppress output (exit code only) |

## Commands

### Process management

```sh
deno task am start                # start app (kills zombies, refuses if running)
deno task am start --wait         # start and block until healthy (default 10s timeout)
deno task am start --wait=30      # start with 30s timeout
deno task am stop                 # graceful shutdown
deno task am stop --wait          # stop and block until dead (default 5s timeout)
deno task am restart              # stop + start
deno task am status               # stopped|starting|started|stopping
```

Exit codes: `started` → 0, `stopped` → 1, `starting`/`stopping` → 2.

**Singleton behavior** — controlled by `singleton` in `aio.run()`:

| Value | Behavior |
|-------|----------|
| `true` (default) | Refuse if another instance is running |
| `'takeover'` | Kill existing instance, start new one |
| `false` | Allow multiple instances |

Lock files are stored in `/tmp/aio/` (or `$XDG_RUNTIME_DIR/aio/`) as `{appId}.lock`. Stale locks (dead PID) are auto-cleaned.

### Instance discovery

```sh
deno task am instances            # list all running aio apps on this machine
deno task am ls                   # alias
deno task am instances --json     # JSON output
```

### State inspection

```sh
deno task am state                          # full state (raw, unfiltered)
deno task am state counter                  # single feature slice
deno task am state counter.count            # nested path
deno task am state fleet[0].stats           # array index traversal
deno task am state fleet[0].{name,active}   # pick specific fields
deno task am state fleet[*].{pair,status}   # wildcard: pluck from every array element
deno task am state fleet[*].stats.pnl       # wildcard: nested traversal
deno task am state {counter,page}           # pick from root
deno task am state counter --wait=5         # poll every 5s
deno task am state counter --wait           # poll every 2s (default)
```

Path syntax: `fleet[0].stats.pnl` for traversal, `{id,name}` for field picking, `[*]` for wildcard over arrays.

```sh
deno task am ui                             # UI state (stateForUI filtered)
deno task am ui alice                       # UI state for specific user
```

`am state` = raw server state. `am ui` = what the browser sees.

### Dispatching actions

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

Positional args (without `=`) are wrapped as `{ args: [...] }` — use for methods. Named `key=value` pairs produce `{ key: value }` — use for actions. Values are auto-parsed: numbers, booleans, `null`, JSON arrays/objects, strings.

### Time-travel (dev mode)

In browser: press **Ctrl+.** to toggle the time-travel panel. Shows action history with timestamps and performance metrics.

### Persistence & snapshots

```sh
deno task am persist                        # force flush to KV/SQLite
deno task am snapshot                       # dump state to stdout
deno task am snapshot save backup.json      # save to file
deno task am snapshot load backup.json      # restore from file
```

### Database

```sh
deno task am sql "SELECT * FROM orders LIMIT 5"   # read-only SQL query
deno task am tables                                # list SQLite tables
```

### Monitoring

```sh
deno task am clients              # connected clients (with type and transport)
deno task am schedules            # active timers/cron
deno task am metrics              # uptime, connections, schedule count
deno task am health               # health check (exit 0 = ok)
deno task am config               # server config (port, title, auth mode, prod)
```

`am clients` returns each client with:

| Field | Values |
|-------|--------|
| `index` | Sequential ID (0, 1, 2...) |
| `type` | `electron`, `browser`, `electron-reload`, `browser-reload` |
| `transport` | `ws` (WebSocket) or `uds` (Unix Domain Socket / Electron IPC) |

### Client inspection (dev mode)

Inspect the React component tree on a connected client — like React DevTools, but from the CLI.

```sh
deno task am client 0              # React component tree (names, useState, props)
```

Returns:
```json
[
  { "component": "App", "state": { "page": "dashboard" } },
  { "component": "Nav", "props": { "title": "My App" } },
  { "component": "Counter", "state": [5, false], "props": { "label": "clicks" } }
]
```

### Click components (dev mode)

Trigger a click on a React component's DOM node from the CLI.

```sh
deno task am click 0 Nav                      # click first Nav component
deno task am click 0 Nav 0                    # same — explicit index
deno task am click 0 Nav 2                    # click third Nav
deno task am click 0 Card title:Settings      # click Card where title="Settings"
```

Returns:
```json
{ "ok": true, "clicked": "Nav → <button>" }
```

**How it works:**
1. Finds the component in the React fiber tree by name + index or prop match
2. Resolves the nearest DOM node (walks down to first `<div>`, `<button>`, etc.)
3. Dispatches a real `click` event on that element

Use `am client <index>` first to see available components and their props, then `am click` to interact.

### Logs

```sh
deno task am log                  # tail last 50 lines of app log
deno task am log --filter=ERROR   # filter log lines
deno task am log --lines=100      # show more lines
deno task am log --follow         # stream new lines (like tail -f), also: -f
deno task am errors               # last transpile error (dev mode)
```

### Development

```sh
deno task am watch                # hot-restart on .ts/.tsx change in src/
deno task am watch lib            # watch a different directory
```

### Scaffolding

```sh
deno task am new feature payments          # → src/features/payments/index.ts
deno task am new page settings             # → src/pages/Settings.tsx
```

### Other

```sh
deno task am version              # aio version
deno task am help                 # full command list
```

## Trojan — Control API

aio exposes a REST API at `/__aio/trojan/*` for inspection and control. Available in dev and prod.

### Inspect (GET)

| Endpoint | Returns |
|----------|---------|
| `/__aio/trojan/state` | Raw full state (unfiltered) |
| `/__aio/trojan/ui` | UI state (stateForUI filtered) |
| `/__aio/trojan/ui?user=alice` | UI state for specific user |
| `/__aio/trojan/clients` | Connected clients (type, transport, index) |
| `/__aio/trojan/client/<n>` | React component tree from client n (dev mode) |
| `/__aio/trojan/click/<n>/<target>` | Click component on client n (dev mode) |
| `/__aio/trojan/history` | Time-travel entries |
| `/__aio/trojan/schedules` | Active timer/cron IDs |
| `/__aio/trojan/metrics` | Uptime, connections, schedule count |
| `/__aio/trojan/config` | Port, title, expose, authMode, prod |
| `/__aio/trojan/health` | Feature health: status, enabled, errors per feature |

### Control (POST)

```sh
# Dispatch action (X-AIO header required on all POST)
curl -X POST localhost:8000/__aio/trojan/dispatch \
  -H 'X-AIO: 1' -H 'Content-Type: application/json' \
  -d '{"type":"INCREMENT","payload":{"by":1}}'

# Force persist
curl -X POST localhost:8000/__aio/trojan/persist -H 'X-AIO: 1'

# Time-travel (dev only)
curl -X POST localhost:8000/__aio/trojan/tt -H 'X-AIO: 1' -d '{"cmd":"undo"}'
curl -X POST localhost:8000/__aio/trojan/tt -H 'X-AIO: 1' -d '{"cmd":"goto","arg":3}'

# SQL query (read-only, SELECT only)
curl -X POST localhost:8000/__aio/trojan/sql -H 'X-AIO: 1' \
  -d '{"query":"SELECT * FROM users LIMIT 10"}'
```

All POST endpoints require the `X-AIO: 1` header (CSRF protection). All endpoints return JSON. Auth is inherited — tokens required when `--expose` is active.

## For AI agents

`am` is designed for programmatic use. Output is JSON when piped:

```sh
# Check if app is running
deno task am health && echo "up" || echo "down"

# Read state, parse with jq
deno task am state | jq '.fleet[0].stats'

# Dispatch and verify
deno task am dispatch portfolio:buy symbol=AAPL qty=10
deno task am state portfolio.positions
```
