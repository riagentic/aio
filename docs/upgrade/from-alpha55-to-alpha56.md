# alpha55 → alpha56

**Nothing to do.** No removals, no renames, no deprecations — a bug-fix release.
Two changes can be _noticed_, and one is a refusal you might meet at boot.

## If your app stopped booting on alpha54 or alpha55, this fixes it

An app whose `src/app.ts` ends in `await aio.run({ … })` — the documented shape
— could hang at boot with:

```
error: Module evaluation is still pending after multiple event loop iterations,
but no stalled top-level await was found. This is a bug in Deno.
```

Nothing in your app was wrong, and no `am fix` could have repaired it: aio was
issuing a dynamic import from inside the call your module top-level-awaits.
Upgrading is the fix; no change on your side.

## A route pattern with a non-trailing `*` is now refused

```jsonc
routes: { "/files/*/x": handler } // ✗ refused at boot from alpha56
```

`matchRoute` returns the moment it reaches a `*`, so everything written after it
was never checked: that pattern matched `/files/foo` and `/files/a/b/c` alike,
and the `/x` it demanded was never verified. It was answering requests it did
not describe, which is worse than not matching them.

Only a **trailing** wildcard was ever advertised, and only that is accepted now.
The refusal names the pattern to use instead:

```jsonc
routes: { "/files/*": handler } // then branch on match["*"] inside the handler
```

If your app booted before this, it was over-matching; the fix is the same
one-liner the error prints.

## An OIDC token must name a key that exists

Key selection used to fall back to "the only published key" whenever the issuer
published exactly one, ignoring the token's declared `kid`. This was never an
auth bypass — the signature still had to verify against that key — but it made
key **rotation** meaningless, and "correct until the issuer publishes a second
key" is not a property worth keeping.

A token declaring a `kid` must now match one. An issuer that publishes no `kid`
at all still works (some don't, and refusing them would break a working setup to
enforce a field they never send). If your IdP publishes one key and your tokens
declare a _different_ `kid`, they were being accepted by accident and will now
be refused — which is the correct behaviour, and worth checking before you
deploy if you have ever rotated.

## Shared-key mode now works in a browser

Previously, opening a `key:`-protected app in a browser loaded the shell and
then 401'd every asset — nothing carried the credential past the first request.
Following the share link now also sets an `HttpOnly`, `SameSite=Strict`, per-app
cookie, so the page's own requests authenticate.

Nothing to change: if it worked before (native clients), it still works
identically. If it did not work (browsers), it does now.

## Everything else

Bug fixes, in the sense that behaviour you were relying on did not change and
behaviour that was wrong did:

- a held sync ack no longer loses a write that the snapshot predates
- a throwing live-query subscriber no longer makes a committed `db.execute()`
  reject
- a corrupt offline queue is reported instead of silently discarded (and the raw
  document is kept beside it)
- `useEffect(fn, [])` cleanup no longer runs before every re-render — if you
  worked around this by using a non-empty deps array, you can stop
- a hard-timed-out effect no longer holds `drain()` open forever
- a synchronous `sendFn` throw rejects immediately instead of after 15 seconds
- worker patches dropped by a disabled cell are recorded
- `feedback.refresh()` and `updates.check()` record their failures in state
- a `set-remove` merge reports a conflict when one side removed what the other
  edited (the merged value is unchanged: remove still wins)
- `electronBinReady` no longer reports a missing Electron binary as ready

## New, if you want it

- **`build.server`** is baked into client artifacts — an APK or AppImage
  connects to the address the build recorded instead of asking the user to type
  it. Rebuild to pick it up.
- **The boot report** says where each decision came from
  (`client electron (deno.json)`), and adds pid, bind posture, tls, heap
  ceiling, log dir, journal, worker cells, synced cells, routes and serverFns.
