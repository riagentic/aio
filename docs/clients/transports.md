# Transports — what listens, where

One matrix answering "which sockets does this app open?" per mode and target.
Everything below is decided in one place — `resolveTransport()`
(`src/server/paths.ts`) plus the zero-port block in `src/server/aio-server.ts` —
and printed at boot, so the table is a reading aid, never the authority.

Two wires exist:

- **TCP** — an HTTP(S) server on a port (page, modules, `routes`, `/__aio/*`)
  and a WebSocket on the same port (state, method calls, sync, serverFns).
- **UDS** — a Unix domain socket in a `0700` directory
  (`<lockDir>/<appId>.sock`) speaking NDJSON: the same v2 envelope as WS —
  state, method calls, sync, serverFns, time travel. Only vitals stay WS-only
  (refused loudly on UDS).

`transport: "auto"` (the default) picks UDS for **electron on Linux/macOS
without `--expose`**, WS everywhere else. `--transport=ws` / `transport: "ws"`
forces TCP; `--transport=uds` forces the socket.

## The matrix

`client` is `aio.run({ client })` (default `"electron"`). Windows has no UDS —
every Windows row is the WS row (see [Windows](#windows-the-exception)).

| mode | client                               | linux / mac                                                                                    | windows       |
| ---- | ------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------- |
| dev  | electron                             | **UDS** (state) + **UDS** `<appId>.http.sock` (page, modules, routes, `/__aio/*`) — **no TCP** | TCP 127.0.0.1 |
| dev  | electron, `--port=N`                 | **UDS** (state) + **TCP** 127.0.0.1:N (page, modules, routes, trojan)                          | TCP 127.0.0.1 |
| dev  | browser                              | TCP 127.0.0.1                                                                                  | TCP 127.0.0.1 |
| dev  | server-only / cli                    | TCP 127.0.0.1                                                                                  | TCP 127.0.0.1 |
| prod | electron, `dist/` readable           | **UDS** only — page from disk (`aio://`), **no HTTP handler at all**                           | TCP 127.0.0.1 |
| prod | electron, `dist/` readable, `routes` | **UDS** (state) + **UDS** `<appId>.http.sock` (routes only) — **no TCP**                       | TCP 127.0.0.1 |
| prod | electron, `--port=N`                 | UDS (state) + TCP 127.0.0.1:N (page, routes)                                                   | TCP 127.0.0.1 |
| prod | electron, no `dist/` on disk         | UDS (state) + TCP 127.0.0.1 (page) — warns why                                                 | TCP 127.0.0.1 |
| prod | browser                              | TCP 127.0.0.1                                                                                  | TCP 127.0.0.1 |
| prod | server-only / cli                    | TCP 127.0.0.1                                                                                  | TCP 127.0.0.1 |
| any  | any, `--expose`                      | TCP 0.0.0.0 (or `--host`), HTTPS unless `--no-tls`; transport is WS                            | same          |

"No `dist/` on disk" is the compiled-binary case: the bundle is inside the
binary's embedded VFS, which Electron cannot open, so the page still needs a
server. Ship `dist/` next to the binary (the AppImage/AppDir layout) to reach
zero ports. The boot log says which case you are in:

```
prod+UDS: HTTP server skipped (zero TCP ports)
```

## Zero TCP ports is the default

A local desktop app that serves nothing to a browser or another service has no
reason to open a port. A port is a **cost**, not a feature: it is reachable by
every process and every browser tab on the machine, it has to be named in the
boot report and the lock file, and it is one more thing that can be found by
accident. So a local Electron app on a Unix socket binds **no TCP port**, in dev
and prod alike (`resolveZeroPort()` in `src/server/aio-server.ts` — one pure
function, pinned as a table by `tests/zero-port-decision.test.ts`).

- **dev** — modules are transpiled on demand, so the request handler still runs;
  it binds a second socket (`<appId>.http.sock`) instead of a port, and
  Electron's `aio://` handler proxies every request — page, modules, `/__aio/*`,
  your `routes` — to it (Node `http.request({ socketPath })`, streamed both
  ways). Hot reload travels the IPC bridge; the renderer never falls back to
  `ws://` on an `aio://` page.
- **prod** — with a readable `dist/` the page comes off disk and there is no
  handler at all; with `routes` the handler runs on the socket for the routes
  alone, and boot prints
  `N custom route(s) served over the socket
  (aio://app/<path>) — no TCP port`.

**The opt-out is a named port.** Anything that needs a URL keeps one: a browser
client, `--expose`, the thin client, prod without `dist/`, Windows — and an app
whose port was named: `--port=N`, `AIO_PORT`, or `aio.run({ port })`. A route
that **another process** must reach over TCP (a webhook receiver, a `curl`
probe, a browser tab beside the window) is exactly the case for naming the port,
and boot says so: `port N named explicitly — keeping a TCP listener`.

`--zero-port` (the dev opt-in before this was the default) is still accepted as
a no-op — scripts pass it — and prints one info line.

## Windows: the exception

Deno has no Unix-socket listener on Windows: `resolveTransport()` picks WS
there, so a Windows electron app is always the TCP row — a loopback-bound
(`127.0.0.1`) port, page and state over HTTP/WS — and the boot line says why in
one clause
(`running (dev, electron, tcp — Windows has no Unix-socket
listener)`).
Precisely what Deno's own declarations (Deno 2.9) say: the fetch-proxy
declaration states that a Unix domain socket is "_not supported on Windows_",
and the listener is built on a Unix-only primitive; aio does not attempt it
there. Electron's main process (Node) has no `AF_UNIX` on Windows either — what
it has is **named pipes** (`\\.\pipe\<name>`), native and portless.

What would close the gap without waiting for Deno: reverse the roles on Windows
— the Electron shell hosts the named pipe (`net.createServer().listen`), and
Deno dials it by opening the pipe path as a file (`Deno.open` returns a duplex
byte stream; no FFI). The NDJSON envelope, the control plane and the
page-over-socket path stay identical; only _who listens_ changes. It is on the
hardware-week list because it needs a real Windows machine to prove — the
shipped `.exe` is exercised under Wine, which does not emulate named pipes
faithfully.

## `routes` vs `serverFn` — what each costs you

| you declare                | it needs            | so                                                                                                                                                                                                  |
| -------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverFns(ns, {...})`     | the state wire      | crosses **UDS or WS** — never keeps a port open                                                                                                                                                     |
| `routes: { "/hook": ... }` | an HTTP entry point | local electron (dev, or prod from `dist/`): served over the app socket via `aio://`, **no TCP**, and boot names the count; with a named port (`--port=N`) or prod without `dist/`: on that TCP port |

A route is somebody _else's_ entry point (a webhook, an OAuth callback). Over a
socket it is reachable only from inside the Electron window, which is right for
an in-app endpoint and wrong for a webhook. If the endpoint is only ever called
by your own UI, make it a `serverFn` and it costs nothing. If another process on
this machine must reach it, name the port (`--port=N`); if a third party must
reach it, it is a port on the network, and `--expose` is the honest spelling.

## `--expose`

Flips everything to TCP: bind `0.0.0.0` (or one address with `--host`), HTTPS
with an auto-issued, self-re-issuing certificate (`--tls-cert`/`--tls-key` to
bring your own, `--no-tls` for an already-encrypted network path), transport WS,
a single shared key (`key: true`) or per-user auth. UDS is never used under
`--expose` — a remote client has no path to a local socket.

## The trojan port

The control plane (`/__aio/trojan/*`, what `am` and amui talk to) is **dev
only** — a prod build does not mount it and returns 404 if reached. It follows
the app's transport:

| the app listens on      | trojan is reached via                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| TCP, plain HTTP         | the same port, `http://127.0.0.1:<port>/__aio/trojan/*`                                                  |
| TCP, HTTPS (`--expose`) | a **second** plain-HTTP listener on `127.0.0.1`, port chosen by the OS, in the lock file as `trojanPort` |
| UDS                     | a `ctl` frame on the app socket — no port                                                                |

It is loopback-or-socket by construction: a request whose peer address is not
`127.0.0.1`/`::1`/a Unix socket is refused, `--expose` or not.

## Reading it off a running app

`am status` / `am state` read the lock file the app wrote — `port` (`0` when
nothing TCP is listening), `socketPath`, `trojanPort` — so an app that binds no
port at all is still fully inspectable. `am` never guesses a port.

## See also

- [Electron](electron.md) — the UDS + IPC bridge, packaging, window
- [Browser](browser.md) — WebSocket lifecycle, rate limits
- [Dev mode](../build/dev-mode.md) — `--transport`, `--port` in the dev loop
- [App Manager](app-manager.md) — trojan REST reference
