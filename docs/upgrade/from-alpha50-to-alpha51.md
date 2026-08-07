# Upgrade: alpha50 → alpha51

The zero-inbox release: every open field-report item resolved or refused, plus
the first pass of first-class support for the two canonical app architectures.
**Strictly additive — no code changes required.** Two behaviour changes are
observable; both fix something that was already wrong.

## 1. A denied cell action now rejects its caller

An `access`-denied network dispatch used to resolve exactly like a success (the
server warned and dropped). An awaited call now **rejects** with
`cell "name.method" — access denied`, matching serverFns.

If a client awaited a call it was never allowed to make and relied on the silent
resolve, it will now see the rejection — which is the truth it was missing.
Fire-and-forget dispatches are unaffected (no unhandled rejections).

## 2. `am --json` errors moved to stdout

Scripts parsing `am … --json` used to get an empty stdout on failure (the error
object went to stderr). The error JSON is now on **stdout** with the same
non-zero exit. If a script explicitly read errors from stderr, read stdout
instead — `--json` output is now a superset of plain mode.

## New, all additive

- `testUI(App, { user })` (+ `authFeatures`) — mount an authenticated app;
  `user: null` mounts anonymous. [ui-testing](../testing/ui-testing.md).
- `serverAuth()` from `aio` — the running app's user store, ambient.
- `totpCode` from `aio/testing`; `AuthFeatures` type from `aio`.
- `openExternal(target)` from `aio/server` — per-OS "open on the desktop".
- `connectCli`'s `token:` accepts `() => string | Promise<string>`, resolved
  before every (re)connect (expiring tokens).
- `readLock(appId)` from `aio/extras` — build `--status`/`--stop` flags for a
  service without internal imports.
- `await import("aio/server")` / `("aio/build")` are external in client bundles
  — the documented lazy pattern needs no opaque-specifier tricks.
- `am <cmd> --help` prints usage; `am status` sees UDS-only compiled apps.
- `deno task build` warns when a fleet declares `*-client` targets with no
  `server` target and no `build.server`.
- New doc: [App architectures](../basics/app-architectures.md) — "one app, many
  surfaces" vs "service + rich clients", each with the full recipe.
