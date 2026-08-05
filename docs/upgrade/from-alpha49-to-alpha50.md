# Upgrade: alpha49 → alpha50

A bug-hunt release (hunts 7, 8 and 9 — the same series that produced
alpha46–49). No new capability, nothing removed from the public surface.

**No code changes required.** Five behaviours change observably; each fixes
something that was already wrong.

## 1. `isConnectionDegraded()` is finally importable — and now looks at both queues

Hunt 7 found it was real but exported from nowhere (two doc pages told you to
call it and the import failed). It's now exported from `aio/air`. Hunt 8 found
it only consulted the cell-method dispatch queue, not the `send()` queue, so a
caller could back up to dropping actions with the indicator reporting healthy.
Both queues feed it now.

If your UI already renders a "reconnecting / slow connection" indicator from
this function, it now tells the truth during a send-side backup.

## 2. A `port: 0` app no longer bricks itself on shutdown

`port: 0` ("pick a free port") was written into the lock file verbatim and then
validated with truthiness, so a graceful shutdown cleaned nothing up — and the
leftover could never be recognised as stale, so the next launch refused to start
forever with "Already running". Fields are now validated by shape.

No app code change. If you've ever hit "Already running" after a clean exit of a
`port: 0` app, this is the fix.

## 3. Dispatch while time travel is paused now rejects, not resolves

Pressing undo in the debug panel paused time travel, and every call made while
paused settled as SUCCESS with nothing applied — an async method then hung the
full call timeout and rejected with a false message. A dropped action now
REJECTS. If your app retries on rejection, that retry is now meaningful during
an undo/paused state instead of silently no-op.

## 4. `access`-gated cells with no `ui` warn at boot

`access` gates method calls, `ui` gates reads — and a cell declaring `access`
with no `ui` leaves the read side of the gate undecided. It now warns at boot,
naming the exposed fields. Any explicit `ui` (including `ui: "all"`) is an
answer that silences it. If your app has such a cell, add an explicit `ui` to
make the intent unambiguous (or verify the exposed fields really are public).

## 5. Stale `app.key` is cleared on a mode switch to per-user auth

Moving a `key: true --expose` app to `auth: true` / `users:` / `resolveUser`
left a dead shared key that `am profile` kept exporting as current. It's now
cleared on the per-user path. Deliberately NOT cleared on "unexposed": a plain
local boot of a keyed app must keep its key, or the next `--expose` mints a
different one and breaks every paired device.

Plus the rest of the hunt fixes (worker-cell shutdown durability, a deep-merge
cycle branch that was silent data loss, the diagnostic bus reporting suppressed
events, Electron's backoff sharing one decider, `/__aio/<src>.ts` removed from
prod, three tests that were wrong in ways that hid real regressions). None
require code changes.
