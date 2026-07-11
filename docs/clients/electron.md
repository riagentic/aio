# Electron

Desktop app packaging, thin client, and window management.

For build targets (AppImage, zip, systemd), see
[Build Targets](../build/targets.md). For the docs index, see
[the docs index](../basics/index.md).

## Setup

Electron is on by default. AIO looks for (in order):

1. `$ELECTRON_PATH` env var — set by packaged launchers (`AppRun` / `run.sh` /
   `run.bat`)
2. `node_modules/.bin/electron` — dev binary

Install for dev:

```sh
deno task install:electron
```

> **Note:** Do not use `npm install electron` — it removes Deno-managed package
> symlinks (esbuild, etc.) from `node_modules/`.

The startup linter will warn you if electron is not installed.

## Configuration

Use browser-only mode:

```ts
await aio.run({
  appId: "my-app",
  cells: [myCell],
  client: "browser", // auto-opens browser instead of Electron
});
```

Keep server running after Electron closes:

```ts
await aio.run({
  appId: "my-app",
  cells: [myCell],
  keepServer: true, // server survives electron window close
});
```

Or use `--keep-server` CLI flag. Useful for apps where the server is the primary
process and electron is optional.

The HTTP server always runs regardless of Electron — you can access the app at
`localhost:8000` in any browser, and multiple tabs stay in sync.

## UDS transport

By default (`transport: 'auto'`), Electron apps on Linux/macOS use Unix domain
sockets instead of WebSocket/HTTP. This eliminates open TCP ports — more secure,
slightly faster.

```ts
await aio.run({
  appId: "my-app",
  cells: [myCell],
  transport: "uds", // force UDS (or 'ws' to force WebSocket)
});
```

Or via CLI: `deno task dev --transport=uds`

**Architecture:**

```
Deno ↔ UDS/NDJSON ↔ Electron main (net.connect) ↔ IPC ↔ renderer (window.__aioIPC)
```

- Deno writes NDJSON messages to a Unix socket at `/tmp/aio-{slug}.sock` (or
  `$XDG_RUNTIME_DIR/aio-{slug}.sock`)
- Electron's main process connects via Node.js `net.connect` and bridges
  messages to the renderer over IPC
- The renderer accesses the bridge via `window.__aioIPC`
- Static files (HTML, JS, CSS) are served via Electron's
  `protocol.handle('aio', ...)` — no HTTP needed

**When UDS is not used:**

- Windows (no UDS support) — always falls back to WS
- `--expose` mode — needs real HTTP for remote access
- Browser mode — no Electron IPC bridge available
- `--server-url` thin client — connects to remote server over HTTP/WS

**CLI apps** can use `connectCliUDS(socketPath)` for headless UDS transport.

### Connection lifecycle

UDS connections have no idle timeout — local sockets are kept alive indefinitely
(the OS closes the socket if either process dies). When the server-side read
loop ends (client disconnect or error), the connection is explicitly closed via
`conn.close()`, which propagates to the Electron main process as a socket
`close` event, then to the renderer as `__aio:close`.

**IPC keepalive:** The browser sends a `__ping` message every 60 seconds over
the IPC bridge as defense-in-depth. The server silently ignores these messages.
This ensures the connection stays visibly alive even during purely passive
viewing (dashboards, monitoring screens).

**Write error handling:** If `sock.write()` in the Electron main process fails
(broken pipe, destroyed socket), the socket is destroyed and the renderer is
notified via `__aio:close`, triggering the reconnection UI.

## Window state persistence

Electron remembers window size and position across runs. Bounds are saved to
`window-state.json` in the app's `userData` directory. The directory is derived
from the slugified title (e.g. "My Dashboard" → `my-dashboard`), ensuring each
app gets its own persistent state.

## Thin client (`--server-url`)

Connect to a remote aio server without running a local server:

```sh
deno task dev --server-url=http://192.168.1.100:8000
```

**What happens:**

1. No local HTTP server starts
2. Electron launches with a connect page (or directly navigates if
   `--server-url` is provided)
3. Fetches the remote server's HTML to extract metadata (`<title>`,
   `<meta aio:width>`, `<meta aio:height>`)
4. Sets window icon from `src/icon.png` (loaded from disk in UDS mode, fetched
   from server in WS mode)
5. Resizes window to the server's configured dimensions, sets title
6. Loads the remote URL — app runs as if it were local

**aio-client** — standalone Electron app with a connect page:

```sh
deno run -A dep/aio/src/build.ts --client   # builds aio-client AppImage
```

The client app shows a minimal connect page where users type a server address
and hit Enter. No Deno runtime needed on the client machine — just a pure
Electron app.

### Window metadata

The server embeds window config in HTML `<meta>` tags (set via
`ui: { width, height }`):

```html
<meta name="aio:width" content="1200">
<meta name="aio:height" content="900">
```

The thin client reads these to auto-configure the Electron window. The `<title>`
tag is used for the window title.
