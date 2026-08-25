# Upgrading from alpha64 to alpha65

Nothing in your app code changes. Four behaviours change, and each one changes
toward leaving less behind.

## aio no longer opens your browser

A `client: "browser"` app used to hand its URL to the desktop after boot. It now
prints it:

```
running (dev, browser)
  web       http://localhost:49206
open http://localhost:49206 in your browser (or pass --open)
```

**Why**: a tab opened in an already-running browser belongs to that browser. The
app exits, the tab stays — so a watch loop, a restart-on-crash or a test suite
that boots an app twenty times left twenty tabs of the same app, each having
taken focus as it appeared, none of them aio's to close.

**If you liked it**, pass `--open`:

```sh
deno task dev --open
```

An **Electron** window is different in kind — a child process aio owns and
closes on shutdown — so a `client: "electron"` app still opens its window by
default.

`openExternal()` (the "reveal in Finder" / "open in browser" helper you call
from a cell method or serverFn) is **unchanged**. That is an explicit call, not
a framework guess.

## An Electron app no longer falls back to a browser tab

If Electron is missing and cannot be auto-installed, the app used to open a
browser tab instead. It now stays a desktop app, says so, and prints where the
server is:

```
electron client, but Electron is not installed — this app is a desktop app and
will NOT be opened in a browser instead
install it with: deno task install:electron (then re-run). The server is up
meanwhile at http://localhost:49206 …
```

And an electron app on a machine with **no desktop session** (ssh, a container,
CI) no longer dies trying to open a window. It warns and keeps serving — before,
the failed launch took the whole app down, because "the window went away" is
what stops a desktop app.

## `am` no longer guesses port 8000

`am` used to fall back to port 8000 when it could not work out which app you
meant. 8000 is not a port aio binds — the runtime picks a free one — so this was
a made-up number, and `app not running on port 8000` read as a diagnosis when
the truth was "am does not know which app you mean".

It now refuses and names the failed question:

```
am does not know which app to target: no app named "x" is running and none
declares a port (AIO_PORT, or aio.run({ port }) in the app entry). 2 apps are
running: notes @ :51204, wallet @ uds. Name one with --app=<id>, or point at a
listener with --port=N.
```

**If you relied on the 8000 fallback**, name the app (`--app=<id>`) or the
listener (`--port=N`). Both were always available; only the guess is gone.

Related: `am` no longer reads a top-level `port` from `deno.json`. The runtime
never read it either — it warns that aio config there "is silently doing
nothing" — so `am` was aiming at a number the app had been told it was ignoring.
Move it into `aio.run({ port })`, or set `AIO_PORT`. `am` says so once if it
finds one.

## New: `AIO_PORT`, `am trust`, `--zero-port`

**`AIO_PORT`** is the operator rung in the port chain, for the places that have
no command line to hang a flag on — a systemd unit, a container, a compiled
binary:

```
--port=N  >  AIO_PORT  >  aio.run({ port })  >  the runtime picks a free one
```

A malformed value is refused at boot, never ignored. aio still does not read
`.env` itself: `deno run --env-file`, `EnvironmentFile=` and `docker --env-file`
all deliver `AIO_PORT`, and `am` already forwards `--env-file` to the child.

**`am trust`** ends browser certificate warnings for every aio app on the
machine, at once and for good:

```sh
deno task am trust
```

It prints this machine's aio root and the install steps for your OS. Install it
once and every aio app you run over HTTPS is recognised — including apps you
have not written yet, and across every network change.

It never installs anything itself, and the root is **name-constrained**: it can
only ever vouch for `localhost`, `.local` and private LAN addresses, and is
cryptographically incapable of vouching for a public website even for whoever
holds its key.

You do not have to run it. A self-signed warning has never meant "unencrypted" —
the traffic is fully encrypted either way; the warning is about
_authentication_. `am trust` just stops you being asked.

**`--zero-port`** (experimental in alpha65) makes a dev electron+UDS app bind no
TCP port at all, serving its page and modules over a second socket. In alpha65
it is opt-in; the next release makes zero the default and `--port=N` the opt-out
(`docs/clients/transports.md`).

## Certificates now re-issue themselves

Nothing to do — this is the fix for a failure you may have hit without knowing
what it was.

An exposed app's certificate was generated once and cached forever, so its
address list was a snapshot of whatever network the machine was on that day.
Change network, take a new DHCP lease, bring up a VPN, and the app served a
certificate that did not name the address clients now used: a handshake failure
on an app nobody had touched.

The certificate is now re-issued automatically whenever the machine's addresses
change, and it is issued from a root that names no address at all — so a client
that trusted the app once stays trusted through every network change.

**If you pinned a certificate** (`am profile`, `DENO_CERT=…`, the aio client's
`--cert=`), nothing changes: the file those point at now carries both the leaf
and the root that signed it, so it keeps working as a trust anchor.

The one exception: an app whose cached certificate was ALREADY stale (issued on
a different network) is re-issued on this upgrade, and clients that pinned the
old one must pair once more. That app was already unreachable at its current
address, so there was nothing working to break.

## Retire

Workarounds you may still carry for bugs that are fixed. Each was fixed in the
version named; if you are on alpha65 you are past all of them, and the code that
guarded against them is dead weight — delete it.

| workaround you may have                                                                                                          | fixed in    | what to do now                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Writing a method's result into state (or a side channel) because `await cell.method()` in the browser resolved `undefined`       | **alpha34** | `return` the value. JSON-serializable returns cross the bridge, sync and async — [the bridge](../state/the-bridge.md) |
| Polling state after calling a `worker: true` cell's async method because the promise resolved before the value/error arrived     | **alpha42** | `await` it. Return values and thrown errors cross the thread (`tests/cell-workers.test.ts`)                           |
| A `key` or wrapper element forcing re-creation of a deep, unchanged subtree because a leaf ended up appended instead of replaced | **alpha22** | remove it. The `_static` fast path hands DOM handles all the way down, and a static subtree diffs correctly           |
| Batching or delaying Electron dispatches so patches would not be lost mid-throttle on UDS                                        | **alpha22** | remove it. The UDS transport buffers patches across the throttle window instead of dropping them                      |

One line of test is the safe way to retire each: a `testCell` that awaits the
call and asserts the returned value, a `testUI` that mounts the subtree and
asserts the leaf text after a change.
