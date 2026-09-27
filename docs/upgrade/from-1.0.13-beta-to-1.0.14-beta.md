# Upgrading from 1.0.13-beta to 1.0.14-beta

Nothing is removed and nothing changes shape. No app needs a code change.

```sh
am pin --latest
```

## What you may notice

- **New: the `web` build target** — a standalone PWA directory (manifest, Apple
  Home Screen tags, an offline service worker) you can host on any static
  server, also under a sub-path. See [Targets](../build/targets.md).
- **A write that changes a persisted field's declared type** (a string field set
  to a number) is refused in dev and by the test harnesses (`testCell`,
  `bootCells`, `testUI`, worker cells), and warned in prod. A `Date` written to
  a string field is fine (it is stored as its JSON string).
- **`testUI` refuses what a browser refuses**: a `confirm()` / `alert()` /
  `prompt()` the test did not answer throws, naming the dialog and how to answer
  it; a click on a control disabled by a `<fieldset disabled>` ancestor or
  inside an `inert` subtree is refused. A test that relied on the silent no-op
  must answer the dialog or target an enabled control.
- **Dev warns once per element** when a controlled input still shows text its
  handler did not store a second later. Prod says nothing; the DOM is never
  rewritten.
- **Shutdown**: `onStopping`, the worker close and the drain share one 3 s
  budget; a hung `onStop` is cut after at most 4.5 s, and the log, the lock and
  the databases still close. A call the server refuses at the door while it
  stops is re-sent by the browser after the restart (it never ran); a call
  refused inside a running method is not.
- **Desktop**: launching a running app again brings its window to the front and
  exits 0 (was 1). A window whose renderer dies reloads instead of staying
  blank.
- **Cron**: a day step that reads differently from Vixie cron is said once (dev
  and prod), naming both readings. The schedule itself is unchanged.
- **Auth**: a route whose user or session store fails answers 503
  `auth_unavailable` (was 400 or a crash). Boot warns when a static `users:`
  token is under 16 characters. `POST /__aio/auth/verify/resend` re-sends an
  expired verification token.
- **Logs** mask the share-link token and the pair code in every log file; the
  terminal keeps them whole.

## Retire

- A test-side stub that silenced `window.confirm` under `testUI`: answer the
  dialog through the harness instead (the error names how).
- A hand-made PWA folder (manifest, service worker) next to an aio app: build
  the `web` target.
