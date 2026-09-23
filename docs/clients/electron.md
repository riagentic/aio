# Electron

Desktop app packaging, thin client, and window management.

For build targets (AppImage, zip, systemd), see
[Build Targets](../build/targets.md). For the docs index, see
[the docs index](../basics/index.md).

## Setup

Electron is on by default, and **nothing has to be installed by hand**. AIO
looks for (in order):

1. `$ELECTRON_PATH` env var — set by the packaged Linux `AppRun` / Windows
   `run.bat`.
2. `./electron/` **beside the executable** — the runtime every packaged target
   already carries. Resolved against the executable, never the cwd, so
   double-clicking `myapp.exe` (which skips `run.bat` and therefore
   `$ELECTRON_PATH`) finds the Electron sitting in the same folder instead of
   downloading a second one. On macOS this is inside the bundle:
   `Counter.app/Contents/MacOS/electron/Electron.app`, which is exactly what
   `dirname(execPath)/electron/` resolves to once the binary is the
   `CFBundleExecutable`.
3. `node_modules/.bin/electron` — dev binary
4. in dev: auto-install via `deno install` (the npm package, with a fallback to
   its own `install.js` when the lifecycle script is skipped)
5. the runtime Electron publishes, fetched once into
   `~/.cache/aio/tools/
   electron/<version>-<platform>/` — THE path for a
   **compiled binary** (which has no `node_modules` and no `deno`), and the last
   resort for dev. The version is the one the build baked into
   `dist/electron.json` — always the Electron this aio is tested with.

aio ships **one** Electron version across the whole framework — the launcher's
fallback, `am create`'s scaffold pin, the examples and the framework's own
`package.json` all name the same release **exactly** (no `^` range, the same
rule `esbuild` follows), and `tests/electron-version-consistency.test.ts` makes
any drift a red gate. Before that, the framework default was `43.4.1` while a
freshly scaffolded app pinned nothing (`npm:electron` = whatever was latest at
install time) — so the same app could run one Chromium in dev and ship another,
and two apps scaffolded a month apart did not match each other.

**A stop during the first-run install ends the installer too.** The app's
shutdown kills the installer's whole process tree (`install.js` is a
grandchild), whether the stop comes from `am stop`, Ctrl-C, SIGTERM, or closing
the terminal (SIGHUP). So does the app exiting any other way (an exit call or a
crash). On Linux and macOS the download runs in its own session, so a hangup
would not reach it directly. A desktop app treats SIGHUP like SIGTERM and stops
gracefully, and an app started under `nohup` keeps ignoring it. On Windows the
tree is ended with `taskkill /T /F`.

### aio decides the Electron, not the app

aio is tested with one Electron, and a **build always ships that one**. The
app's `"electron": "npm:electron@x.y.z"` line and its `node_modules` runtime are
copies aio keeps in line — an app never picks a different Electron by editing
them:

| When                        | What happens                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `am pin <version>`          | the app's `electron` line moves to that aio's tested version, and an installed runtime is replaced (`--no-download` skips it) |
| `am fix`                    | same alignment, for the aio the app is pinned to (`dep/aio`) — the fix for any drift                                          |
| dev start (`am start`, dev) | a stale `node_modules` runtime is replaced once, loudly; offline, the old one runs and says so                                |
| build                       | ships the tested version; if the app's copies disagree, one line says so and names `am fix`                                   |

Before 1.0.5-beta the app's copies decided (installed runtime > import-map line

> default), so an app scaffolded by an older aio kept that aio's Electron under
> every later framework — a pairing no release had run.

The floor is the newest INSTALLABLE release, not blindly Electron's `latest`:
Deno's default 24-hour `minimumDependencyAge` (a supply-chain guard) refuses a
version published minutes ago, which fails every install. The consistency test
therefore REPORTS a newer upstream release (visible in the release log, and
enforceable with `AIO_REQUIRE_LATEST_ELECTRON=1`) instead of failing the build —
bumping is a deliberate act, done in one place.

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

Without it, the window ending ends the app, through the normal graceful shutdown
(drained, persisted). The exit code says how the window ended: **0** when it was
closed (or stopped by SIGTERM / SIGINT / SIGHUP), **1** when it crashed (any
other signal, such as SIGTRAP when the display refuses the window, or a non-zero
exit). A crash is logged as an ERROR, `electron crashed (…)`, quoting the
window's last stderr lines. With `keepServer` a crash is logged the same way and
the server keeps running.

A local Electron app binds **no TCP port** by default, so there is no
`localhost` address to open in a browser: the window talks to the server over a
local socket, and `am` reaches it the same way
([Zero TCP ports](#zero-tcp-ports--and-the-apps-own-routes)). To open the app in
a browser tab as well — beside the window, or after it closes under `keepServer`
— name a port: `--port=N` (or `AIO_PORT`, or `aio.run({ port })`). The app is
then served at `http://127.0.0.1:N`, and every tab and the window stay in sync.

### DevTools Protocol (`--cdp`)

`--cdp` (or `--cdp=<port>`, or the env `AIO_CDP=1|<port>` — `am start` inherits
it) launches the window with `--remote-debugging-port`, bound to 127.0.0.1 only.
It is opt-in: without it no debugging port exists, and a zero-port app really
binds zero ports. The port is printed on the boot line and recorded in the lock,
which is how `am shot` (a headless screenshot) finds it. Anything that speaks
CDP can attach to `http://127.0.0.1:<port>/json`.

A window that is hidden, minimised or fully occluded is **not composited**, so
it paints no frames and a screenshot of it shows whatever was last on screen.
`am shot` reports that as `"painted": false` rather than passing stale pixels
off as a fresh capture — see [`am shot`](app-manager.md#screenshots-am-shot).

## The Content-Security-Policy warning

Every Electron run — dev **and** packaged — used to print this:

```
Electron Security Warning (Insecure Content-Security-Policy)
This renderer process has either no Content Security Policy set or a policy with
"unsafe-eval" enabled. … This warning will not show up once the app is packaged.
```

**That last sentence is not true for aio's Electron target**, which is why the
warning had to be fixed rather than waited out. Electron only suppresses the
warning when its own executable has been renamed out of the way; an aio app runs
the stock `electron` binary from the shared runtime cache, so the check is armed
in a packaged app exactly as it is in dev.

**It is gone since 1.0.7-beta, by removing its cause.** Electron's check is
literally "does `eval` still run in this renderer", so nothing but a
`script-src` can answer it. The default policy (`"basic"`) now sends one that
names every source a page could already use and withholds exactly one
capability:

```
script-src * data: blob: 'unsafe-inline' 'wasm-unsafe-eval'
```

`*` covers every http(s) URL and — per CSP3's special case for the bare `*` —
any URL on the document's own scheme, which is what keeps `aio://app/app.js`
loading inside the packaged window. `data:`/`blob:` keep generated scripts and
blob-URL Workers, `'unsafe-inline'` keeps the shell's bootstrap and your own
inline scripts and `on…=` handlers, and `'wasm-unsafe-eval'` keeps WebAssembly.
The only thing that stops working is `eval`, `new Function` and
`setTimeout("…")` — in dev and in the packaged app identically, so an app that
needs them finds out under `deno task dev`, not after shipping.

An app that genuinely evaluates strings says so by name:

```ts
await aio.run({
  cells: [app],
  // Drop the directive entirely…
  security: { cspDirectives: { "script-src": false } },
  // …or keep it and re-add the capability:
  // security: { cspDirectives: { "script-src": "* data: blob: 'unsafe-inline' 'unsafe-eval'" } },
});
```

To go further than the default, `security: { csp: "strict" }` adds
`default-src 'self'` and per-type sources. Read
[`csp: "strict"`](../auth/auth.md#response-security-headers) first: it is opt-in
precisely because it **can** break a page that reaches off-origin. If your
renderer displays peer-controlled text or images — a chat, a feed, anything with
someone else's content in it — that trade is usually worth making, and
`img-src 'self' data: blob:` plus an explicit host is the usual adjustment.

## The `Invalid guestInstanceId` line after closing a `<webview>`

Closing an embedded page (a [`<Browser>`](webview.md) panel, or a bare
`<webview>` you removed yourself) makes Electron throw inside its own
isolated-world bundle. Measured on Electron 44.4.1:

```
window.onerror  message  Uncaught Error: Invalid guestInstanceId: 2
window.onerror  filename node:electron/js2c/isolated_bundle:1:7012
                stack    Error: Invalid guestInstanceId: 2      ← no app frames
```

It happens on **every** detach, the guest is already gone, nothing is retried,
and the page cannot prevent it — the throw is in an isolated world your code
cannot reach
([electron#53989](https://github.com/electron/electron/issues/53989)).

aio **annotates** it rather than hiding it:

- the log line stays, at **info** instead of error, reading
  `Uncaught Error: Invalid guestInstanceId: 2 — known upstream issue
  (electron#53989), not this app: …`.
  It is in `am logs` and in the app log like any other line.
- it does **not** count toward `errors=N`, and it does not light the dev
  overlay's problem badge or open its panel. It is listed there as a muted
  _notice_ whenever the panel is open for a real reason.

Why it is not simply filtered: an error indicator that is permanently lit for
something your app did not do is the same failure as one that never fires — both
teach you to ignore it. And why it is not a message filter either: the line is
recognised by its message **and** by its source file, both anchored. An app that
throws `Invalid guestInstanceId: 4` from its own bundle is a real error and
stays loud, and an Electron that renames the bundle or changes the wording stops
matching, so the line goes back to being ordinary and noisy rather than quietly
swallowed under a stale label.

The rule, its measurement and the reasoning live in
`src/diagnostics/upstream-noise.ts`; adding another one means adding both halves
and an issue number, which a test enforces.

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

- Deno writes NDJSON messages to a Unix socket in the app's 0700 lock dir
  (`$XDG_RUNTIME_DIR/aio/`, else `/tmp/aio/`), named after its lock:
  `{appId}.sock` for the default data home, `{appId}@{hash8(home)}.sock` for any
  other home — so two instances of one app never share a socket. A path over
  ~100 bytes falls back to `/tmp/aio/<appId>-<hash>.sock` (`/tmp/aio-u<uid>/`
  when `/tmp/aio` is not yours; the hash covers scope and home). On Windows it
  is the named pipe `\\.\pipe\aio-<lockKey>`. A
  [profile](app-manager.md#profiles-several-copies-of-one-app) is its own
  instance: `{appId}@{name}.sock` (pipe `\\.\pipe\aio-<appId>@<name>`) and its
  own Chromium profile, so its window shares no storage, cookies or
  `window-state.json` with the default one.
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
loopback port. (`--zero-port`, the pre-alpha66 opt-in, was removed in alpha76.)

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

| Mode                             | Page                                  | Custom `routes` / `/__aio/*` | TCP port |
| -------------------------------- | ------------------------------------- | ---------------------------- | -------- |
| prod, electron, dist/ on disk    | `aio://` off disk                     | `aio://app/<path>` → UDS     | none     |
| prod, electron, dist/ in the VFS | `aio://` → UDS (served from the VFS)  | `aio://app/<path>` → UDS     | none     |
| dev, electron (default)          | `aio://` → UDS                        | `aio://app/<path>` → UDS     | none     |
| dev or prod, `--port=N`          | `http://127.0.0.1:N`                  | same origin, TCP             | one      |
| any, Windows                     | as above — the socket is a named pipe | `aio://app/<path>` → pipe    | none     |

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

### Test what you ship — `AIO_ELECTRON_PROTOCOL=1`

A packaged app's window loads `aio://app/`: a privileged custom scheme served by
the Electron main process (dist/ from disk — with the same content types the
server sends, so a font, a `.webp` or an `.mp4` behaves identically — and the
app's routes proxied to its socket), with the IPC preload bridge as the page's
ONLY transport and the `<head>` config delivered by the server's `cfg` frame
instead of the shell. In dev, the window takes that same path only when the app
binds no TCP port; an app with a port (`--port`, `--expose`, `routes` you reach
from a browser) loads `http://localhost:PORT` — so the shipped path was
exercised by the artifact and by nothing else, and a renderer that died on it
died in the field first.

```sh
AIO_ELECTRON_PROTOCOL=1 deno task dev --client=electron --port=8000
# → [aio:electron] AIO_ELECTRON_PROTOCOL=1 — the window loads aio://app/ (the packaged path) proxied to http://localhost:8000
```

The window then loads over `aio://` exactly as the AppImage does — same handler,
same scheme privileges, same bridge — proxied to the dev server instead of a
socket or `dist/`. Everything else (hot reload, `am surface`, the trojan) keeps
working. Use it before a release for any app that has a port.

### The renderer's errors reach the log

The Electron main process forwards every way a page can fail into the framework
log at ERROR — `console.error`, uncaught throws and unhandled rejections (with
Chromium's file:line), `render-process-gone`, `preload-error`, `unresponsive`, a
main-frame load failure — and `console.warn` at WARN. They appear on the
console, in `logs/app.log`, and in `am logs`, tagged `renderer`:

```
ERROR  renderer    Uncaught ReferenceError: Buffer is not defined (aio://app/app.js:1:22073)
ERROR  renderer    ui did not mount within 15000ms of the page loading — #root is empty. The renderer errors above say why …
INFO   renderer    ui mounted 42 element(s)
```

The `ui mounted` line is the renderer's own positive signal (the preload watches
`#root`); the artifact e2e (`deno task test:electron`) and the onboarding lab
assert on it, so "the AppImage started" now means "the AppImage painted". Only
Electron's GPU device-probe chatter (`KMS: DRM_IOCTL_MODE_CREATE_DUMB`,
`MESA-LOADER`, `pci id for fd`, `failed to load driver`) is dropped — counted
and announced once — nothing else.

A caveat the pipe made visible: `deno task dev` evaluates the browser bundle in
a Deno worker and REFUSES a module that throws at load, so a throw that happens
only inside an Electron renderer (a dependency that branches on the `Electron`
user-agent into a Node code path, say) passes dev and passes a browser tab
pointed at the packaged app's `--port`, and kills the packaged window. The
renderer log is where it shows.

### Connection lifecycle

UDS connections have no idle timeout — local sockets are kept alive indefinitely
(the OS closes the socket if either process dies). When the server-side read
loop ends (client disconnect or error), the connection is explicitly closed via
`conn.close()`, which propagates to the Electron main process as a socket
`close` event, then to the renderer as `__aio:close`.

The socket belongs to the main process, so a **reload keeps the connection**
(Ctrl+R, Ctrl+Shift+Del, the app's own `location.reload()`) and the server never
hears about the new document. The shell therefore hands that document the
connection's `proto` hello and its `cfg` frame again, then the latest snapshot —
in accept order. On the packaged `aio://` shell `cfg` is the only carrier of
`syncCells`, `callTimeouts` and `renderBudget`, so without the re-seed one
Ctrl+R silently turned every localFirst cell back into a server round-trip.

**No IPC keepalive.** The bridge sends nothing on a timer: the envelope lists
`vitals-ping` as unsupported on UDS and IPC and rejects it loudly, so a
passively-viewed window (a dashboard, a monitoring screen) simply sends nothing
until it has something to say. `__aio:close`, below, is a real message and is
not a keepalive.

**Write error handling:** If `sock.write()` in the Electron main process fails
(broken pipe, destroyed socket), the socket is destroyed and the renderer is
notified via `__aio:close`, triggering the reconnection UI.

### Links, routes and reloads in the shell

Chromium hands an `<a>` click to the shell as a **navigation** before the page
sees it, so the main process decides what a same-app link is. Measured on
Electron 44 (`tests/electron-route-change-e2e.test.ts` drives the real shell;
`tests/electron-main-relay.test.ts` replays the measured event order against a
stub):

| You do                                  | The shell does                                                        |
| --------------------------------------- | --------------------------------------------------------------------- |
| click `<a href="/settings">`            | vetoes the load, hands the URL to the router — an in-app route change |
| `navigate("/x")`, `history.pushState`   | nothing to decide: a same-document navigation, the page stays         |
| `location.reload()` (or the dev reload) | lets it through — the url is the one on screen, so it is a **reload** |
| click `<a href="https://…">`            | opens it in the system browser; the window stays on the app           |

The rule for a same-app URL is **"the url already on screen = a reload; any
other = a route change"**. It used to be "the root path = a reload", which meant
every navigation _to_ `/` reloaded the whole window (a white flash, a re-mounted
tree, a new connection — on most apps' most frequent navigation), and a reload
on any other route was silently vetoed, so the dev live-reload did nothing off
the home page.

The relay behind this is stateful — a new document must announce itself before
frames are delivered to it — and one link click used to close it for the life of
the page (the uplink still worked, so actions landed and state changed while the
screen stayed frozen and `connected` stayed `true`). Now a vetoed navigation
reopens the relay at the veto, and a relay that stalls anyway is loud in three
places: the shell's log, the window's own connection banner (it is sent the
dropped-socket signal), and `/__aio/health` / `am status` as an `electron:relay`
client degradation — with the heal reported the same way. The banner is not only
a message: the renderer answers the dropped-socket signal the way it answers a
real drop — by reconnecting and re-announcing itself — and that re-announcement
reopens the relay. A stall on an Electron whose event order nobody has measured
yet therefore heals itself within the reconnect backoff, out loud.

## `<webview>` and other custom elements

`<webview>` renders fine — the runtime never cared. What TypeScript refuses is
its **attributes**: aio's intrinsic element map admits any tag name and hands
back the standard HTML attribute set, which has no `src` or `partition`.

Declare it once, and it is typed exactly the way you want:

```ts
// types/webview.d.ts
declare module "aio/jsx-runtime" {
  interface JsxIntrinsicElements {
    webview: {
      src?: string;
      partition?: string;
      allowpopups?: boolean;
      preload?: string;
    };
  }
}
```

```tsx
<webview src={url} partition="persist:session" allowpopups />;
```

The same four lines work for any web component. This is TypeScript's own
interface merging, so the declaration is yours: add exactly the attributes you
use, and a typo in one of them is still a compile error — which a blanket
"unknown elements take anything" would have cost you.

aio does not widen the map itself. Its index type is published surface, and the
compatibility promise has no exceptions — not even for a widening that provably
breaks nobody, because the value of the promise is that it has none.

## Child windows (`openWindow`)

With `aio.run({ childWindows: true })` the page can call
`__aioIPC.openWindow(url, { preload })` to open an http(s) page in a child
window. `preload` is required and must be a file inside the app directory; a
relative path is resolved against the app directory, never the process's working
directory, so dev and a packaged app agree. Every refusal is logged with its
reason (`[aio:electron] openWindow refused — …`). See [webview](webview.md) for
the inline alternative.

The child window is **sandboxed**. `openWindow(url, { sandbox: false })` — the
page-world injection escape hatch — is refused unless the app itself asked for
it:

```ts
await aio.run({
  childWindows: true,
  electron: { unsandboxedChildWindows: true },
});
```

The page asks, the app decides. Without the opt-in the request is refused with
its reason rather than quietly downgraded to a sandboxed window, because a
window that differs from the one requested is the silence this rule exists to
end. With it, every unsandboxed window is still announced in the log.

## The Chromium sandbox (`electron: { requireSandbox }`)

On a kernel that restricts unprivileged user namespaces (Ubuntu 24.04+ and every
container) with a `chrome-sandbox` that is not setuid-root — which an npm
install cannot make it — Chromium **aborts instead of starting**. aio measures
both conditions and launches with `--no-sandbox`, saying so every time. That is
the default, and it is why a desktop app starts on those hosts at all.

An app that would rather not open than open unsandboxed says so:

```ts
await aio.run({ electron: { requireSandbox: true } });
```

Then that host gets no window and a refusal naming the two commands that make
the sandbox usable (`chown root:root` + `chmod 4755` on the helper, then
`AIO_ELECTRON_SANDBOX=1`). Nothing changes on a host where the sandbox already
works — which is every stock Debian, Fedora, Arch and macOS or Windows machine.

**The process STOPS, exit code 1 — it does not keep serving.** Every other
Electron launch failure leaves the server up and tells you to open the page in a
browser, which is the right answer when a window simply could not be drawn. It
is the wrong answer here: an app that said it would rather not open than open
unsandboxed would have had its UI reachable anyway, in a client nothing
verified. Same downgrade, one step later. (Found by the verify round that
attacked this feature's own first version.)

One launch path cannot honour the key: `--client=electron` in CONNECT mode,
where the window belongs to no app config and there is nothing to read it from.
Declare `requireSandbox` in the app that opens its own window.

## Headless and VM hosts (`AIO_ELECTRON_ARGS`)

Electron on a real desktop needs nothing. On a VM, a container or a box with no
GPU it sometimes will not start at all — and the failure is a crash loop, not a
message: one console aborted on a GPU fault every ~90 seconds until the machine
got `LIBGL_ALWAYS_SOFTWARE=1`.

Environment variables reach Electron already (the spawn inherits them) — with
**two exceptions**, both removed before the window is spawned and each named in
the log when it was set:

| variable               | why it is removed                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ELECTRON_RUN_AS_NODE` | it makes the Electron binary run as plain Node — measured: the app's window never opens and the script it is handed runs instead |
| `NODE_OPTIONS`         | it injects `--require=<file>` / `--inspect` into the runtime before the app's own code runs                                      |

This is the same reasoning as the `AIO_ELECTRON_ARGS` allow-list below: the
launch environment is written by a `.desktop` file, a shell profile or a wrapper
script, which is not the app. It is a **partial** mitigation and the warning
says so — an environment you do not control can also set `PATH` or `LD_PRELOAD`,
which nothing here can take away. Screening one variable while inheriting a
wider one was the part worth fixing.

Chromium **switches** go in `AIO_ELECTRON_ARGS`, space separated:

```sh
# A VM or container with no GPU — the common case.
export LIBGL_ALWAYS_SOFTWARE=1
export AIO_ELECTRON_ARGS="--disable-gpu --disable-dev-shm-usage"

# A host whose /dev/shm is tiny (most Docker images: 64 MB). Without this the
# renderer dies with a bare "Out of memory" that names nothing.
export AIO_ELECTRON_ARGS="--disable-dev-shm-usage"

# Software rendering all the way down, when --disable-gpu is not enough.
export LIBGL_ALWAYS_SOFTWARE=1
export AIO_ELECTRON_ARGS="--disable-gpu --disable-software-rasterizer --use-gl=swiftshader"

# A headless box with no X server at all: give it one. A switch cannot
# substitute for a display, and Electron is not headless-capable the way
# Puppeteer is.
xvfb-run -a deno task dev --client=electron
```

### What it carries

An **allow-list**: the display, GPU, locale and logging vocabulary a headless
host or a VM needs, and nothing else.

| Group           | Switches                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPU / rendering | `--disable-gpu` · `--disable-gpu-compositing` · `--disable-software-rasterizer` · `--disable-accelerated-2d-canvas` · `--disable-accelerated-video-decode` · `--enable-unsafe-swiftshader` · `--use-gl=` · `--use-angle=` |
| Display         | `--ozone-platform=` · `--ozone-platform-hint=` · `--force-device-scale-factor=` · `--force-color-profile=` · `--disable-lcd-text` · `--disable-smooth-scrolling`                                                          |
| Memory          | `--disable-dev-shm-usage`                                                                                                                                                                                                 |
| Background work | `--disable-background-timer-throttling` · `--disable-backgrounding-occluded-windows` · `--disable-renderer-backgrounding`                                                                                                 |
| Locale / logs   | `--lang=` · `--enable-logging` · `--log-level=`                                                                                                                                                                           |

These switches are appended **last**, so they override aio's own — which is also
why the list is closed. Whoever controls the launch environment (a `.desktop`
file, a shell profile, a wrapper script) would otherwise add
`--remote-debugging-port=9222` and hold unauthenticated DevTools against the
renderer: arbitrary JavaScript in the page of a shipped app, with nothing in the
app's config able to refuse it. `--disable-web-security` and `--js-flags` were
the same door.

Anything outside the list is **refused and named in the log** with the reason,
and the ones you might reasonably reach for name their supported route instead:

| Instead of                                 | Use                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `--remote-debugging-port=N`, `--inspect`   | `--cdp[=N]` — aio binds it deliberately, on loopback                         |
| `--no-sandbox`, `--disable-setuid-sandbox` | nothing: aio decides (below), `electron: { requireSandbox }` is your control |
| `--user-data-dir=…`                        | nothing: the profile is keyed to the app's own identity                      |
| `--enable-features=UseOzonePlatform`       | `--ozone-platform=…`                                                         |

The rule is the same in dev and in a shipped app: a variable that works on a
developer's machine and is ignored in production is exactly the divergence this
project refuses.

`--no-sandbox` is **not** in these sets. aio adds it by itself, and only after
MEASURING that the kernel restricts unprivileged user namespaces and that
`chrome-sandbox` is not setuid-root — the two conditions under which Chromium
aborts rather than starts. It says so in the log when it does,
`AIO_ELECTRON_SANDBOX=1` forces the strict behaviour back, and
`electron: { requireSandbox: true }` refuses the launch outright (above). Adding
it by hand gives away isolation on every host, including the ones that did not
need it.

A token that is not a `--switch` at all is refused the same way, not silently
dropped: "I set the flag and nothing changed" is precisely the failure this
variable exists to end. Splitting is on whitespace, so a switch whose value
contains a space is not expressible — every switch above is a bare flag or a
simple `--key=value`.

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

## System tray (`ui.tray`)

```ts
await aio.run({
  ui: {
    tray: {
      tooltip: "Player",
      menu: [
        { label: "Pause", method: "player:pause" },
        { label: "Library", route: "/library" },
        "-",
      ],
      closeToTray: true,
    },
  },
});
```

`tray: true` is the icon with Show / Hide / Quit. Your items go above them: a
`method` (`"cell:method"`, with `args`) is dispatched by the page through the
same door a button uses — acks, validation, the offline queue — and a `route`
shows the window and navigates. `closeToTray` turns the window's close button
into hide; the tray's Quit, Cmd+Q and `app.quit()` still quit. Left-clicking the
icon toggles the window where the desktop delivers a click (macOS shows the menu
instead when one is set). The icon is the app's own — `icon.png`, or the
generated monogram — so the tray shows the same identity as the taskbar.

Both Electron shells carry it (the zero-port UDS one and the WebSocket one); the
browser and Android targets ignore the key, with nothing to configure away.
Linux needs the desktop's status-notifier support (GNOME: the AppIndicator
extension); without it the icon is simply absent.

## Window size and persistence

Declare the initial size on the app:

```ts
await aio.run({ ui: { width: 420, height: 620 } });
```

Priority:

1. Explicit CLI `--width=` / `--height=` (only when you pass them — there is no
   silent default that shadows `ui.width`)
2. `ui.width` / `ui.height`
3. Framework fallback `800×600` when neither is set

Across runs, Electron saves bounds to `window-state.json` under the app's
`userData` directory (slugified title, e.g. "My Dashboard" → `my-dashboard`). A
_user resize_ is kept while the declared size is unchanged. If you change
`ui.width` / `ui.height` (or pass a new `--width`), the new declaration wins for
size; position is kept. A window closed while **maximized** reopens maximized,
and un-maximizing it returns to the size and position it had before
(`window-state.json` stores that normal rect plus `"maximized": true`). Delete
`window-state.json` only if you want a clean slate for both.

## Thin client (`--server-url=X` / `--connect`)

Connect to a remote aio server without running a local server:

```sh
deno task dev --server-url=http://192.168.1.100:8000
```

**What happens:**

1. No local HTTP server starts
2. Electron launches with a connect page (`--connect`), or navigates directly
   when `--server-url=<url>` names a server
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

Manual entry always works too (type `192.168.1.100:8000`), and
`--server-url=<url>` still connects directly for shortcuts.

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
  per-host registry `am instances` uses. A probe is answered with _every_
  exposed app on the host, read live from that registry, so it doesn't matter
  which app's socket the OS hands the broadcast to. (Apps also all bind the UDP
  port via `SO_REUSEPORT`, so several can answer; the client dedups.)
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
- A probe may carry an optional nonce (`AIO_DISCOVER? v1 <nonce>`); a responder
  echoes it as `nonce` in each reply. A sweep that sends one keeps only echoing
  replies — a test-time filter so a test measures its own responder on a busy
  LAN. A production sweep sends none and accepts every responder.

### Window metadata

The server embeds window config in HTML `<meta>` tags (set via
`ui: { width, height }`):

```html
<meta name="aio:width" content="1200">
<meta name="aio:height" content="900">
```

The thin client reads these to auto-configure the Electron window. The `<title>`
tag is used for the window title.
