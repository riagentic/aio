# Electron

Desktop app packaging, thin client, and window management.

For build targets (AppImage, zip, systemd), see
[Build Targets](../build/targets.md). For the docs index, see
[the docs index](../basics/index.md).

## Setup

Electron is on by default, and **nothing has to be installed by hand**. AIO
looks for (in order):

1. `$ELECTRON_PATH` env var — set by packaged launchers (`AppRun` / `run.sh` /
   `run.bat`)
2. `./electron/` **beside the executable** — the runtime the shipped Windows and
   macOS zips already carry. Resolved against the executable, never the cwd, so
   double-clicking `myapp.exe` (which skips `run.bat` and therefore
   `$ELECTRON_PATH`) finds the Electron that is sitting in the same folder
   instead of downloading a second one.
3. `node_modules/.bin/electron` — dev binary
4. in dev: auto-install via `deno install` (the npm package, with a fallback to
   its own `install.js` when the lifecycle script is skipped)
5. the runtime Electron publishes, fetched once into
   `~/.cache/aio/tools/
   electron/<version>-<platform>/` — THE path for a
   **compiled binary** (which has no `node_modules` and no `deno`), and the last
   resort for dev. The version is the one the build baked into
   `dist/electron.json` (installed runtime > `npm:electron@^x.y.z` in the import
   map > framework default).

The fetched runtime is **verified before it is unpacked**: its SHA-256 is
checked against the release's own `SHASUMS256.txt` and a mismatch refuses rather
than warns — these bytes become the process the app runs as. One download at a
time per machine (a lock file), staged into a sibling directory and renamed into
place, so two apps starting at once cannot delete each other's runtime. Set
`$ELECTRON_MIRROR` to fetch the release from somewhere other than
`github.com/electron/electron/releases/download/`.

`deno task install:electron` remains for a checkout that wants the download done
up front (CI, a machine that goes offline); it is never a required step.

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

### DevTools Protocol (`--cdp`)

`--cdp` (or `--cdp=<port>`, or the env `AIO_CDP=1|<port>` — `am start` inherits
it) launches the window with `--remote-debugging-port`, bound to 127.0.0.1 only.
It is opt-in: without it no debugging port exists, and a zero-port app really
binds zero ports. The port is printed on the boot line and recorded in the lock,
which is how `am shot` (a headless screenshot) finds it. Anything that speaks
CDP can attach to `http://127.0.0.1:<port>/json`.

## UDS transport

By default (`transport: 'auto'`), local Electron apps use a local socket — a
Unix domain socket on Linux/macOS, a named pipe on Windows — instead of
WebSocket/HTTP. This eliminates open TCP ports — more secure, slightly faster.

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

### Zero TCP ports — and the app's own routes

A local Electron app binds **no TCP port at all** — by default, on every OS, in
dev and in prod (prod needs `dist/` readable next to the binary, the
AppImage/AppDir layout). The window loads its page from the `aio://` scheme, and
the boot line says `running (…, uds — no TCP port)` — printed only when it is
literally true. A port is a cost (reachable by every process and tab on the
machine), not a feature; an app that serves nothing to a browser or another
service does not pay it.

**The opt-out is a named port.** An app that needs a route reachable from
**another process** over TCP — a webhook receiver, a local `curl` probe, a
browser tab beside the window — must say so explicitly: `--port=N` (or
`AIO_PORT`, or `aio.run({ port })`). Boot then prints
`port N named explicitly
— keeping a TCP listener`, and the route is on that
loopback port. `--zero-port` is accepted as a no-op.

Custom `routes` do not bring the port back. An app that declares

```ts
routes: { "/nft-image/*": async (req) => /* bytes, content-type, nosniff */ }
```

keeps rendering `<img src="/nft-image/<sha>">` — on the zero-port page that
relative URL resolves to `aio://app/nft-image/<sha>` (the scheme is `standard`),
the shell's `protocol.handle('aio')` proxies it over a Unix socket to the SAME
route handler an `http://` request would reach, and the `Response` comes back
**unchanged**: status, `content-type`, `nosniff`, `cache-control` all pass
through. The body is **streamed** (`stream: true`; the shell resolves on headers
and pipes the bytes), so a 100 MB image is never buffered in the Electron main
process, and Chromium caches it by scheme+URL like any other resource.
`fetch()`, CSS `url()` and a WebGL `TextureLoader` all work the same way. The
same socket serves `/__aio/*`, so `am surface` / `am trigger` still reach the
app.

Where a route is served, by mode:

| Mode                          | Page                                  | Custom `routes` / `/__aio/*` | TCP port |
| ----------------------------- | ------------------------------------- | ---------------------------- | -------- |
| prod, electron, dist/ on disk | `aio://` off disk                     | `aio://app/<path>` → UDS     | none     |
| prod, electron, no dist/      | `http://127.0.0.1:<port>`             | same origin, TCP             | one      |
| dev, electron (default)       | `aio://` → UDS                        | `aio://app/<path>` → UDS     | none     |
| dev or prod, `--port=N`       | `http://127.0.0.1:N`                  | same origin, TCP             | one      |
| any, Windows                  | as above — the socket is a named pipe | `aio://app/<path>` → pipe    | none     |

A `serverFn` is not a substitute for a route here: it returns a value over the
message bridge, while an `<img>` needs a URL the renderer's network stack can
resolve. Use `routes` for bytes, `serverFn` for values.

The full transport matrix — dev/prod × electron/browser/server-only ×
Linux-macOS/Windows, what listens where, what a named port changes — lives in
one place: [transports.md](transports.md). Short form: **Windows runs the same
rows** — the local socket there is a named pipe (`\\.\pipe\aio-<lockKey>`)
hosted by Deno, which Electron's `net.connect` / `http.request({ socketPath })`
open natively, so a local Windows app binds no TCP port either
([transports.md → Windows](transports.md#windows-a-named-pipe-the-same-protocol);
proven under Wine in CI, one pass on real Windows pending).

On an `aio://` page the IPC bridge is the **only** transport. The renderer never
falls back to `ws://app/ws` (a socket that cannot exist): if the bridge is
missing the client fails loudly — a status line, a diagnostic, and a thrown
`page has no HTTP origin and no IPC bridge — the aio:// page must be loaded by
the aio Electron shell`
— instead of retrying into a blank window. The dev reload script is skipped on
such a page as well; the bridge already delivers `reload`/`css`/`boot`.

**When UDS is not used:**

- `--expose` mode — needs real HTTP for remote access
- Browser mode — no Electron IPC bridge available
- `--server-url=X` thin client — connects to a remote server over HTTP/WS
  (`--connect` opens the connect page without a URL)

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

## Window chrome (`ui.chrome`)

How much of the window the OS draws. Three values, one line of config:

```ts
await aio.run({ ui: { chrome: "themed" } });
```

| Value                    | Frame          | Title bar                         |
| ------------------------ | -------------- | --------------------------------- |
| `"standard"` _(default)_ | the platform's | the platform's                    |
| `"themed"`               | none           | aio draws one, your CSS styles it |
| `"none"`                 | none           | none — the page _is_ the window   |

**`"themed"`** is the practical middle: dropping the OS frame otherwise takes
three things with it — dragging, the minimise/maximise/close buttons, and
double-click-to-maximise — and aio puts all three back as ordinary DOM you can
restyle from your own `style.css`:

```css
:root {
  --aio-titlebar-height: 40px;
  --aio-titlebar-bg: #101828;
  --aio-titlebar-fg: #e6edf3;
  --aio-titlebar-hover: #ffffff1a;
  --aio-titlebar-close: #e5484d;
}
.aio-titlebar {
  border-bottom: 1px solid #1f2937;
}
.aio-titlebar-title {
  font-weight: 600;
  letter-spacing: .02em;
}
```

The markup is `.aio-titlebar` > `.aio-titlebar-title` + `.aio-titlebar-controls`

> three `.aio-titlebar-button[data-act]` (`minimize` / `maximize` / `close`).
> The bar shows `document.title` and follows it when your app changes it.

**`"none"`** hands you the whole surface. You get no drag region by default, so
give yourself one — a window nobody can move is the usual first bug here:

```css
.my-header {
  -webkit-app-region: drag;
}
.my-header button {
  -webkit-app-region: no-drag;
}
```

The three window verbs are on `window.__aioWindow` in every desktop mode, so a
hand-built bar uses the same bridge aio's does:

```tsx
<button onClick={() => window.__aioWindow?.close()}>✕</button>;
```

**Browser target:** `ui.chrome` is ignored — there is no window to own. The
themed bar checks for `window.__aioWindow` and does not mount without it, so the
same page serves a browser tab with no dead buttons and no build-time branch.

## Window state persistence

Electron remembers window size and position across runs. Bounds are saved to
`window-state.json` in the app's `userData` directory. The directory is derived
from the slugified title (e.g. "My Dashboard" → `my-dashboard`), ensuring each
app gets its own persistent state.

## Thin client (`--server-url=X` / `--connect`)

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
deno task build --targets=electron-client   # (re)builds aio-client-<arch>.AppImage
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
