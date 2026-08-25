# Upgrading from alpha66 to alpha67

Nothing in your app code changes. One behaviour changes, on Windows only.

## Windows: a local Electron app binds no TCP port

alpha66 made zero TCP ports the default for a local Electron app on Linux and
macOS and left Windows on WebSocket + a loopback port, because Deno has no
Unix-socket listener there. alpha67 closes that: on Windows the same NDJSON
transport, the control plane `am` uses, and the page/route handler run over a
**named pipe** hosted by Deno — `\\.\pipe\aio-<app>` and `…-http` — with an
owner-only ACL. Electron's main process and `am` connect natively.

```
running (dev, electron, pipe — no TCP port)
  pipe      \\.\pipe\aio-<app>
```

**Breaks**: anything on Windows that reached the dev app over
`http://localhost:<port>`. **Fix**: the same opt-out as on the other desktops —
`--port=N` (or `AIO_PORT`, or `aio.run({ port })`); `--transport=ws` forces the
old transport outright.

**Status**: proven under Wine in CI (`deno task test:wine`); one pass on a real
Windows machine is still pending — if you run it there first, a boot line that
says `pipe — no TCP port` and a working window is the whole check. Report
anything else.

## Retire

| workaround you may have                                                      | fixed in    | what to do now                                                     |
| ---------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| A Windows-only `--port` / firewall rule / "allow localhost" note for the app | **alpha67** | delete it — there is no listener to allow                          |
| A per-OS branch in a launcher choosing `ws` on Windows                       | **alpha67** | delete it — `resolveTransport()` picks the local socket everywhere |
