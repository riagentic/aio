# Upgrading from alpha65 to alpha66

Four behaviours change; three can break an app. Each names its opt-out or fix.

## A local Electron app binds no TCP port by default

Dev + electron + UDS (Linux, macOS) now serves the page, its modules and the
app's `routes` over the Unix socket, exactly as prod already did with a readable
`dist/`. `ss -ltnp` shows nothing owned by the process; the window loads; `am`
drives it over the control socket as before.

```
running (dev, electron, uds — no TCP port)
  http      /run/user/1000/aio/<app>.http.sock
```

**Breaks**: anything that reached the dev app over `http://localhost:<port>` — a
`curl` probe, a browser tab beside the window, a webhook receiver another
process posts to. **Fix**: name a port and the listener stays:

```sh
deno task dev -- --port=8000     # or AIO_PORT=8000, or aio.run({ port })
```

`--zero-port` is accepted as a no-op (one info line) so existing scripts keep
working. Windows is the exception — Deno has no Unix-socket listener there, so
Windows stays WS over a loopback-bound TCP port and the boot line says so. The
full matrix, and the named-pipe design that will close Windows, is in
[transports.md](../clients/transports.md).

## Routes are served through `aio://`

`<img src="/nft-image/x">` on the zero-port page resolves to
`aio://app/nft-image/x` and reaches your `routes["/nft-image/*"]` handler
unchanged — same `Request` in, same `Response` out, streamed, headers intact.
Nothing in your app changes; the "move it into a serverFn" warning is gone.

## Hidden-field reads throw in every context

A client-context read of a `visible: { exclude }` field used to throw in dev and
return `undefined` in prod (after one warning). It throws in prod too now,
naming the field, the cell and the two fixes.

**Breaks**: prod code that branched on that `undefined` as though it were data
(a selector like `hasVault()` reading the secret itself). **Fix**: publish a
non-secret fact field (`hasVault: boolean`) or read the secret in a
server-side/async method. `aiol` flags the pattern statically
(`sync-method-reads-hidden-field`).

## `sync: true` + a `persist` filter is refused

The op-log is a sync cell's durable home; `persist: { exclude }` (or `include`,
or `"none"`) never applied to it, so the combination was a promise aio could not
keep. `cell()` now throws, naming the cell, the fields and the three ways out:
remove the filter, turn `sync` off, or keep the transient data in a non-sync
cell. The same applies to `cellDefaults.persist` at `aio.run`.

## Sync cells carry a `version`

Ops and compaction snapshots are stamped with the cell's declared `version`.
Older ops replay through `onMigrate` at each boundary; older ops without a hook
and newer ops are skipped, never applied blind. Any skip or failure refuses boot
in dev and quarantines the cell in prod (it stays at its last snapshot; no
compaction writes the emptiness; `am migrations` shows it). A persisted log on a
cell with no `version` warns at boot — declare `version: 1` and the warning is
gone.

## Also changed (low risk, `aio/extras`)

`readLock`, `lockPath` and `removeLock` now take a **lock key** rather than a
bare appId, and `LockData` gained `home`. For the default home the key IS the
appId, so `readLock(appId)` keeps working unchanged; an instance booted from a
different `appDir` has the key `<appId>@<hash8>` and is invisible to a caller
that passes the bare appId — list them with `am instances`, which parses both.

## Retire

Workarounds you may still carry for bugs that are fixed. If you are on alpha66
you are past all of them — delete the guard.

| workaround you may have                                                                                      | fixed in    | what to do now                                                                                                              |
| ------------------------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| A test that refuses any cell with a persisted op-log (shape change replayed blind)                           | **alpha66** | delete it; declare `version` + `onMigrate` on the cell — aio refuses/quarantines instead                                    |
| A source-scanning test forbidding I/O in cell methods because an awaited call rejected while it kept running | **alpha66** | keep the pattern (fetch outside, commit with a sync reducer — now documented), delete the scanner; `timeout: "warn"` exists |
| An app-side browser-graph test for static `*.server.ts` imports and a hand-rolled boot smoke                 | **alpha66** | delete both; the validator blocks it and `smoke()` on `aio/testing` fetches every eager module                              |
| Booting a second isolated instance under a different `AIO_APPS_DIR` to dodge the singleton lock              | **alpha66** | `appDir` alone is enough — the lock and sockets follow the home; `am --home=<dir>` targets it                               |
| A `typeof cell.__aio.methods === "function"` guard in a test                                                 | **alpha66** | delete it — `__aio.<unknown>` throws under the harness; drive reducers with `testCell`                                      |
| Two workarounds for method return values lost over the Electron bridge                                       | **alpha34** | `return` the value — see the alpha65 guide's Retire list                                                                    |
