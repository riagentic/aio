# Dev Mode

## CLI flags

`aio.run()` reads `Deno.args` automatically — no parsing code needed in your
app. CLI flags override config values:

```sh
deno task dev --port=3000 --client=browser --no-persist --title="My App"
```

| Flag                  | Effect                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port=N`            | Override server port                                                                                                                              |
| `--client=X`          | Client mode: `electron`, `browser`, `cli`, `server-only` (replaces `--no-electron` / `--headless`)                                                |
| `--no-persist`        | Disable SQLite state persistence                                                                                                                  |
| `--keep-server`       | Keep server running after Electron window closes                                                                                                  |
| `--takeover`          | Kill existing instance before starting (use with `singleton: true`; `--kill-existing` is the deprecated alias)                                    |
| `--title=X`           | Override window/page title                                                                                                                        |
| `--verbose`           | Verbose logging — actions, state, effects, WS, HTTP, persistence                                                                                  |
| `--prod`              | Force prod mode — serve pre-built `dist/app.js` (auto-detected in compiled binaries)                                                              |
| `--width=N`           | Override Electron window width (default: 800)                                                                                                     |
| `--height=N`          | Override Electron window height (default: 600)                                                                                                    |
| `--expose`            | Bind `0.0.0.0` + auto-HTTPS — share app with other devices on LAN (no auth by default; `key: true` opts in)                                       |
| `--tls-cert=PATH`     | TLS certificate file (PEM) — used with `--expose` (auto-generated if omitted; `--cert` is a deprecated alias)                                     |
| `--tls-key=PATH`      | TLS private key file (PEM) — used with `--expose` (auto-generated if omitted; `--key` is a deprecated alias)                                      |
| `--transport=X`       | Transport mode: `uds`, `ws`, or `auto` (default: `auto`)                                                                                          |
| `--server-url=URL`    | Thin client mode — launch Electron connecting to remote aio server (no local server)                                                              |
| `--host=ADDR`         | Bind ONE address instead of the expose default (`0.0.0.0` exposed, `127.0.0.1` not) — e.g. serve one interface only                               |
| `--no-tls`            | With `--expose`: serve PLAIN HTTP/WS — everything on the wire is readable by the LAN; only behind a TLS-terminating proxy                         |
| `--key=X`             | Deprecated alias of `--tls-key` (`--cert` = alias of `--tls-cert`)                                                                                |
| `--connect`           | Open the Electron thin-client connect page (enter any server URL; bare `--server-url` is the deprecated alias)                                    |
| `--channel=X`         | Follow release channel X for updates (`dev`, `test`, `prod`, …)                                                                                   |
| `--db-path=PATH`      | Override the SQLite file (`:memory:` for throwaway runs)                                                                                          |
| `--backup-logs`       | Keep previous logs on restart (the default — rotate to `.1`, `.2`, …)                                                                             |
| `--no-backup-logs`    | Wipe the log directory on start instead of rotating                                                                                               |
| `--log-budget=N`      | Byte ceiling for the log directory (e.g. `200MB`; `0` = unlimited)                                                                                |
| `--no-data-migrate`   | Skip moving a legacy data layout into `~/.<appId>`                                                                                                |
| `--zero-port`         | No-op (accepted): zero TCP ports is already the default for a local electron app                                                                  |
| `--open`              | Open the app in your browser after boot (default: OFF — the URL is printed)                                                                       |
| `--isolate=a,b`       | Only activate the specified cells                                                                                                                 |
| `--cdp[=N]`           | Open Chrome DevTools Protocol on the Electron window, `127.0.0.1` only (free port unless N; also `AIO_CDP=1\|N`) — enables `am shot`              |
| `--aio-data-contract` | Print this build's persisted-schema promise (the data contract `deno task ship` publishes) as JSON and exit — see [updates](../deploy/updates.md) |
| `--version`           | Print aio version and exit                                                                                                                        |
| `--help`              | Show available CLI flags and exit                                                                                                                 |

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

`--transport=uds` uses the local socket (a Unix domain socket; a named pipe on
Windows) instead of WebSocket/HTTP for Electron apps. The `auto` default selects
it for a local Electron app, WS otherwise.

**Why UDS?** No open TCP ports — more secure, slightly faster. The Electron app
communicates over NDJSON on a Unix socket instead of HTTP/WS.

**How it works:** Deno <-> UDS/NDJSON <-> Electron main (Node.js `net.connect`)
<-> IPC <-> renderer (`window.__aioIPC`). Static files are served via Electron's
`protocol.handle('aio', ...)` — no HTTP server needed.

Socket path: `/tmp/aio/{slug}.sock` (or `$XDG_RUNTIME_DIR/aio/{slug}.sock` if
set).

**Exceptions:** `--expose` always uses WS (needs real HTTP for remote access).
Browser mode always uses WS. On Windows the socket is a named pipe
(`\\.\pipe\aio-<lockKey>`) — see [transports](../clients/transports.md).

CLI apps can connect via `connectCliUDS(socketPath)` for headless UDS transport.

## `dep/aio` as a live symlink

An app that tracks aio's working tree (`dep/aio` → a checkout, instead of a
pinned version) type-checks against whatever that tree holds at the moment:
`deno check src/` follows the symlink into the framework's sources, so another
session editing aio can fail the app's check on files the app does not own, and
the error is gone minutes later. There is no switch to skip it — a check that
ignored the framework it compiles against would pass an app that does not run.
The supported answer for a stable check is `am pin`: pin the app to a released
aio version (`docs/clients/app-manager.md`), and move the pin when you choose
to.

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

## Dev evaluates the prod graph

Dev serves the client one module at a time, and a browser never _evaluates_ a
statically imported module nothing calls; prod links the whole graph and
evaluates every module's top level at load. An app can pass its whole suite, a
real-browser boot and a manual pass, and have the first evaluation of half its
client graph happen on a user's machine. So at dev boot — and on every hot
reload that changes the graph — the dev server does what the build does:

1. **bundles** the client graph in memory with the build's own esbuild call
   (same plugins, same import map, same generated entry; `write: false` is the
   only difference);
2. **audits** the resolved graph with the one decider the build uses
   (`src/build/graph-audit.ts`): a `*.server.*` module the bundle reached, a
   static `@std/*` / `node:*` import anywhere in it — including one hop past a
   dynamic import of a plain module — and a Node global referenced at module
   scope;
3. **evaluates** the bundle: its module scope is run, once, in a Deno worker
   whose `Deno`, `process`, `Buffer`, `global`, `setImmediate` are deleted first
   (a browser has none of them) and where `window` / `document` / `navigator` /
   `location` / `localStorage` are permissive stubs. A `ReferenceError` there is
   the `ReferenceError` a user would have seen.

What it refuses, it refuses with the build's words (`bundle-refused`, a blocking
category: the diagnostic page in the browser, `✖ file:line` in the terminal),
and the fix hot-reloads.

**What runs, honestly:** every static import and every top-level statement of
the bundle. **What does not run:** the app is never mounted — `mount()` is
exported and not called, the Android entry's `boot()` waits for a
`DOMContentLoaded` that never fires — no WebSocket is opened, no component
renders. A render-time error is `testUI`'s job (aio/testing, under happy-dom); a
load-time error is this one's. Module-scope side effects (a top-level `fetch`, a
timer) do run inside the worker, which is terminated afterwards.

**Cost:** measured on the counter example, 128 bundle inputs: ~20 ms to bundle,
~40 ms to audit, ~20 ms to evaluate — ~80 ms at boot. A 100-module app (227
inputs): ~120 ms. The result is cached by the graph hash (every module's content
hash plus the import map), so a reload that changes no module costs 0 ms, and
the watcher's reload budget is unaffected. `--verbose` prints the numbers:
`graph: prod bundle built in memory (18ms, 128 inputs)`.

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

### Cell edits restart the app

A browser reload can't help a cell: cells run **in the server process**, so new
UI reading old cell logic is the same bug wearing a disguise. When a changed
file declares a `cell(...)`, dev restarts the app for you:

```
INFO  watch  cell file changed (cart.ts) — restarting the app
```

The app tears down first (port released, persistence flushed), then comes back
on the same port; open tabs notice the new boot ID and reload themselves. The
process that started the app becomes a thin supervisor and re-launches it, so
the process depth stays at two no matter how many times you save.

A save that does not load — a syntax error, a bad import — is a _failed
restart_, not the end of the session: the relaunched child dies at module load,
the supervisor prints the error, says it is waiting, and relaunches on your next
save. (A child that ran for a while and then crashed is a crash, and its exit
code passes through as before.)

It steps aside — warning as before, telling you to restart by hand — when it
can't relaunch faithfully:

- **not started with `-A`.** A narrower grant (`--allow-read=/x`) can't be read
  back from `Deno.permissions`, and relaunching with `-A` would silently hand
  the app more permission than you gave it.
- **`libraryMode`** (a test or host process owns the lifecycle) or **prod** (no
  watcher at all).
- **`AIO_NO_DEV_RESTART=1`** — the opt-out, when you'd rather restart yourself.

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

## Lines before aio's first line

`bigint: Failed to load bindings, pure JS will be used`,
`(node) [DEP0040]
DeprecationWarning: The punycode module is deprecated` and
Deno's npm warnings (ignored build scripts, peer dependencies) are printed by
the APP's own npm dependencies as they load — `bigint-buffer` (pulled in by
several chain SDKs), `tr46`/`whatwg-url` (via `node-fetch`), and Deno's resolver
— before any aio code runs. aio does not silence them: they are your
dependencies' messages, and a framework that hides a dependency's warning hides
its next error too. To silence a deprecation in your own app, set
`process.noDeprecation = true` in your entry before the import that triggers it
(measured on Deno 2.9: the Node env `NODE_NO_WARNINGS` is NOT honoured); the
bigint line goes away by dropping or replacing the dependency that prints it.
