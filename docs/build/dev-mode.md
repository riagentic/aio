# Dev Mode

## CLI flags

`aio.run()` reads `Deno.args` automatically — no parsing code needed in your
app. CLI flags override config values:

```sh
deno task dev --port=3000 --client=browser --no-persist --title="My App"
```

| Flag               | Effect                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `--port=N`         | Override server port                                                                                        |
| `--client=X`       | Client mode: `electron`, `browser`, `cli`, `server-only` (replaces `--no-electron` / `--headless`)          |
| `--no-persist`     | Disable SQLite state persistence                                                                            |
| `--keep-server`    | Keep server running after Electron window closes                                                            |
| `--kill-existing`  | Kill existing instance before starting (use with `singleton: true`)                                         |
| `--title=X`        | Override window/page title                                                                                  |
| `--verbose`        | Verbose logging — actions, state, effects, WS, HTTP, persistence                                            |
| `--prod`           | Force prod mode — serve pre-built `dist/app.js` (auto-detected in compiled binaries)                        |
| `--width=N`        | Override Electron window width (default: 800)                                                               |
| `--height=N`       | Override Electron window height (default: 600)                                                              |
| `--expose`         | Bind `0.0.0.0` + auto-HTTPS — share app with other devices on LAN (no auth by default; `key: true` opts in) |
| `--cert=PATH`      | TLS certificate file (PEM) — used with `--expose` (auto-generated if omitted)                               |
| `--key=PATH`       | TLS private key file (PEM) — used with `--expose` (auto-generated if omitted)                               |
| `--transport=X`    | Transport mode: `uds`, `ws`, or `auto` (default: `auto`)                                                    |
| `--server-url=URL` | Thin client mode — launch Electron connecting to remote aio server (no local server)                        |
| `--version`        | Print aio version and exit                                                                                  |
| `--help`           | Show available CLI flags and exit                                                                           |

**Precedence:** CLI flags > config object > defaults

Active flags are logged on startup:

```
[12:00:00][INFO] ✓ state (1 keys) · reduce · execute · App.tsx
[12:00:00][INFO] cli: --port=3000 --client=browser
[12:00:00][INFO] running (dev, browser)
[12:00:00][INFO]   web       http://localhost:3000
[12:00:00][INFO]   ws        ws://localhost:3000/ws
```

## Verbose mode

`--verbose` logs the entire pipeline in real time:

```
[12:00:00][DEBUG] config: port=52341 persist=true electron=false title="My App" baseDir=./src
[12:00:00][DEBUG] persist: SQLite aio_kv mode=single
[12:00:00][DEBUG] state: 1 keys
[12:00:01][DEBUG] http: GET /
[12:00:01][DEBUG] http: GET /App.tsx
[12:00:01][DEBUG] http: GET /__aio/ui.js
[12:00:01][DEBUG] ws: connect (1 total)
[12:00:02][DEBUG] ws: recv {"type":"INCREMENT","payload":{"by":1}}
[12:00:02][DEBUG] action -> reduce: INCREMENT {"by":1}
[12:00:02][DEBUG] state: changed [counter]
[12:00:02][DEBUG] persist: saved
[12:00:02][DEBUG] effect -> execute: LOG {"message":"incremented by 1 to 6"}
[12:00:02][DEBUG] broadcast -> 1 client(s)
[12:00:03][DEBUG] ws: disconnect (0 total)
```

## UDS transport

`--transport=uds` uses Unix domain sockets instead of WebSocket/HTTP for
Electron apps. The `auto` default selects UDS on Linux/macOS when using
Electron, WS otherwise.

**Why UDS?** No open TCP ports — more secure, slightly faster. The Electron app
communicates over NDJSON on a Unix socket instead of HTTP/WS.

**How it works:** Deno <-> UDS/NDJSON <-> Electron main (Node.js `net.connect`)
<-> IPC <-> renderer (`window.__aioIPC`). Static files are served via Electron's
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

**What it checks:**

- Errors (prevents startup): state is null/not object, reduce/execute missing,
  App.tsx missing
- Warnings (app starts but may not work): App.tsx has no default export, esbuild
  not installed, sync I/O in execute.ts
- Hints (suggestions): leftover `createRoot`, `import React`, old
  `'../dep/aio/'` imports, electron not installed

## Live reload

AIO watches `baseDir` (default: `src/`) for file changes. When any `.ts`,
`.tsx`, `.css`, or other file is modified or created, all connected browsers
automatically reload.

**How it works:**

1. `Deno.watchFs` monitors `baseDir` recursively
2. On file change, the transpile cache for that file is invalidated
3. After a 100ms debounce (to batch rapid saves), a `"reload"` frame is sent
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
   frame (not `"reload"`)
3. Browser finds the `<link>` tag for `style.css` and cache-busts it with
   `?t=<timestamp>`
4. Browser downloads the new CSS — no React unmount/remount, no state loss

If a CSS file and a TS/TSX file change in the same debounce window, a full
`"reload"` is sent instead (since the JS needs reloading anyway).
