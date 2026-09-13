# Upgrading from 1.0.0-beta to 1.0.1-beta

**Nothing breaks.** The public surface is byte-identical to 1.0.0-beta —
`check:api` reports no drift — so there is no step to perform.

```sh
am pin --latest
```

1.0.1-beta is a fix round: bugs found by running a live aio from every side,
each fixed with a test that is red without the fix. The full account is
`CHANGELOG.md`.

## Stricter now — where a 1.0.0-beta app can notice

Each of these refuses something that was already wrong. If your app relied on
one, the log line names what happened and what to do.

| behaviour                                                                                                                                     | what to do if you hit it                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| a POST/PUT/DELETE/PATCH with a foreign `Origin` carrying a cookie, or to an unexposed/open app, is 403                                        | name the calling page's origin in `allowedOrigins`                   |
| a full-origin `allowedOrigins` entry (`https://app.example.com`) no longer admits other ports or schemes                                      | list each origin you actually serve                                  |
| OIDC: an email without `email_verified: true` is not stored or passed to `role`; `azp`/`issuer` mismatches are refused                        | configure the provider to verify email; fix the issuer URL           |
| a pairing PIN burns after 20 wrong guesses                                                                                                    | run `am pair` again                                                  |
| a WebSocket peer more than 4 MB behind on raw/sync frames is closed `1013`                                                                    | nothing — the aio client reconnects and resyncs                      |
| under per-user auth, a refused call (unknown cell, `validate`, disabled cell) now rejects the caller                                          | handle the rejection — the write never landed                        |
| a database restored below the journal's compaction point refuses the replay (`PERSIST_ERROR`)                                                 | follow the message: the journal is parked beside the damaged copy    |
| `testUI` applies `visible.forUser`, call ceilings and worker-cell isolation; `onInit` calling a method throws; `Date.now()` follows `advance` | the test was passing on behaviour production never had — fix the app |
| a `$call` chain across `await` is refused past 10 000 steps                                                                                   | it is a cycle — break it                                             |

## Retire

Workarounds an app may still carry for bugs fixed here — each safe to delete
now, with the version that fixed it.

| workaround                                                                                                    | fixed in   |
| ------------------------------------------------------------------------------------------------------------- | ---------- |
| a forced persist right after `loadSnapshot` so a crash could not replay onto the old state                    | 1.0.1-beta |
| a periodic no-op write to a `sync: true` cell to push acked writes to disk sooner                             | 1.0.1-beta |
| reading a worker cell's own state through the method draft only, because the getter lied                      | 1.0.1-beta |
| an explicit `<tbody>` in a server-rendered table only to keep hydration from discarding it                    | 1.0.1-beta |
| a Provider re-declared inside a server-rendered route because SSR lost the outer one                          | 1.0.1-beta |
| a keyed remount of an `ErrorBoundary` to reclaim what its failed attempts leaked                              | 1.0.1-beta |
| dispatching `popstate` by hand after `history.back()` in a `testUI` test                                      | 1.0.1-beta |
| a `try/catch` inside an async `onError`/`onConnect`/`onDisconnect` only to keep the process up                | 1.0.1-beta |
| a synchronous rewrite of a `visible.forUser` filter only to avoid an unhandled rejection                      | 1.0.1-beta |
| deleting `.DS_Store`/`Thumbs.db` from an app home before boot                                                 | 1.0.1-beta |
| splitting a long Markdown line before rendering it                                                            | 1.0.1-beta |
| a local re-implementation of `self()` / `until` / `race` written because the browser build refused the import | 1.0.1-beta |
| `import type { AirEvent } from "aio/jsx-runtime"`                                                             | 1.0.1-beta |
| `--force` on `am pin` because plain object keys (`execute:`, `machine:`) read as removed APIs                 | 1.0.1-beta |
| a `// aio-ok` that never suppressed aiol's post-await read rule                                               | 1.0.1-beta |
