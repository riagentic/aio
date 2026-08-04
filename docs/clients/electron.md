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
4. Sets window icon from `icon.png` next to your entry — the app dir, the same
   place the build packages it from (`src/icon.png` in a scaffolded app; loaded
   from disk in UDS mode, fetched from the server in WS mode)
5. Resizes window to the server's configured dimensions, sets title
6. Loads the remote URL — app runs as if it were local

## Unified aio client + LAN discovery

**aio-client** is a standalone Electron app — one install that connects to _any_
remote aio app. No Deno runtime, no per-app build. Scaffolded projects get a
task for it:

```sh
deno task install:electron   # once — the client needs Electron
deno task compile:client     # (re)builds aio-client-<arch>.AppImage
```

Or invoke the builder directly (from the repo, or via JSR):

```sh
deno run -A dep/aio/src/build.ts --client            # vendored
deno run -A jsr:@riagentic/aio/build --client        # from JSR
```

Its connect page does four things:

- **Discovers apps on your network.** Every app running with `--expose` answers
  a UDP broadcast probe on a fixed port (`8099`, override with
  `AIO_DISCOVERY_PORT`). The client shows a live "Apps on your network" list —
  name, address, and whether auth is needed — so you click instead of typing an
  IP. Multiple apps on one host all show up.
- **Pairs with keyed apps by PIN.** Click an app marked `⛿ auth` and type the
  6-digit **pair code** the app printed on startup. The client submits it to the
  app's `/__aio/pair` endpoint, receives the profile (cert + key), pins the
  cert, saves it as a recent, and connects — once. Next launch it's one click,
  no code.
- **Remembers where you've been.** Recent servers persist across launches; click
  to reconnect, ✕ to forget.
- **Validates the target.** Before loading, it checks the page actually looks
  like an aio app — a friendly error beats a blank window on a wrong address.

Manual entry always works too (type `192.168.1.100:8000`), and `--server-url`
still connects directly for shortcuts.

### Finding apps from the CLI

```sh
deno run -A jsr:@riagentic/aio/am discover
# found 2 aio app(s) on the LAN:
#   dashboard   http://192.168.1.50:8000
#   trading     https://192.168.1.51:8010  ⛿ auth required
```

### How discovery works

- Exposed apps (`--expose`) listen on the shared UDP discovery port and reply to
  `AIO_DISCOVER?` probes; the client resolves each app's IP from the datagram.
  LAN/subnet only (broadcast doesn't cross routers), and **best-effort** — UDP
  runs over `node:dgram` (stable, no flags), but it's silently blocked on some
  corporate/guest networks, so manual entry is always the fallback.
- **Many apps on one host all show up.** Each exposed app stamps its discovery
  info (`name, port, title, needsAuth, tls`) into its lock file — the same
  per-host registry `am ls` uses. A probe is answered with _every_ exposed app
  on the host, read live from that registry, so it doesn't matter which app's
  socket the OS hands the broadcast to. (Apps also all bind the UDP port via
  `SO_REUSEPORT`, so several can answer; the client dedups.)
- Discovery advertises _existence + address_ only; the **auth key is separate**.
  An app marked `needsAuth` is paired by **PIN**: click it, enter the code the
  app printed at startup, and the client pulls the profile (cert + key) from
  `/__aio/pair` — no share link to copy, no file to transfer. The endpoint is
  attempt-limited and the code is session-scoped (restart to reissue). Headless
  setups can still import a `.aioapp` from `am profile` instead.
- **Self-signed certs are trusted** for validated aio apps. `--expose` serves a
  self-signed TLS cert that a generic browser rejects ("unable to verify the
  first certificate"); the dedicated aio client accepts it — but only for the
  specific host it fetched and confirmed is an aio app, not the whole internet.
- Only `--expose`'d apps advertise; a localhost-only app is invisible (it
  wouldn't be reachable off-box anyway).

### Window metadata

The server embeds window config in HTML `<meta>` tags (set via
`ui: { width, height }`):

```html
<meta name="aio:width" content="1200">
<meta name="aio:height" content="900">
```

The thin client reads these to auto-configure the Electron window. The `<title>`
tag is used for the window title.
