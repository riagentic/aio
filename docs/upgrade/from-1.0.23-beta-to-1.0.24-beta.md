# Upgrading from 1.0.23-beta to 1.0.24-beta

Nothing is removed or renamed, and no option changes meaning. There is nothing
to change by hand in an app: an app that builds on 1.0.23-beta builds on
1.0.24-beta.

```sh
am pin v1.0.24-beta
am fix
```

## Tests that can go red

Each one was a test passing for the wrong reason:

- **`ui.X.click(); await ui.advance(ms)`** now runs the click before the clock
  moves. A "not fired yet" assertion after it may now see the timer fire.
- **An async predicate** (`waitFor(async () => …)`, `expectCell`,
  `t.expect.state`, `t.expect.invariant`, `waitForPatch`) is refused — it passed
  on the first look. Make the predicate synchronous.
- **`testComponent`** fails at `html()` / `unmount()` on a throwing event
  handler or re-render, as `testUI` does.
- **Surface names**: a name 1.0.23 renumbered after a Field or Modal
  (`AioRadioRc1Radio`) is back to what it was before (`AioRadioRc0Radio`); a
  `RetryButton2` next to a shown ErrorBoundary fallback is `RetryButton`.
- **`resolveUser` returning a user with no usable id** (a bare string, no `id`,
  an empty `id`) is refused in dev and in tests, and logged in prod. Return
  `{ id, role }`; a numeric id is fine.

## What you may notice

- A server stop or restart no longer resets open pages to the initial state;
  they keep the last real state until they reconnect.
- Signup with a failing mail transport answers 201 and a session instead of 503;
  under `requireVerified`, `verificationSent` is `false`.
- aiol reports a state key named like a method or selector as an error (it
  already threw at boot).
- Electron is 44.9.3 (was 44.9.0); `am fix` moves the pin.

## Worth a look

- **Call another aio app** by its appId: `peer()` —
  [Cross-app](../basics/cross-app.md). `@experimental`.
- **Your app's colour**: deno.json `"hue": 210`.
- **A "no splash at start" setting**: `aio.run({ splash: { show: () => … } })`.
- **`persist.exclude: ["feeds.*.busy"]`** — a `*` segment.
- **Tests that read server-only fields**: `bootCells(...).serverState()`.

## Retire

Each of these was a workaround for something 1.0.24 does itself:

- Importing another aio app's source, or a hand-written `fetch` to its trojan
  routes, to call it — `peer(appId)` (1.0.24).
- A hand-written `declare module` for `<webview>` attributes, or for
  `allowpopups` (1.0.24).
- `{ id: String(row.id) }` only to get past the dev user check — a numeric id is
  a user (1.0.24).
- `AIO_ELECTRON_ARGS=--use-angle=swiftshader` for a WebGL view under `am start`
  — its own display gets it (1.0.24).
- One `persist.exclude` entry per key of a record (`"feeds.a.busy"`,
  `"feeds.b.busy"`, …) — `"feeds.*.busy"` (1.0.24).
- A test-only route or a server read to see `visible.exclude` fields —
  `bootCells(...).serverState()` (1.0.24).
- A `setTimeout`/`await` before `ui.advance()` so a queued click runs first —
  `advance()` drains the queue (1.0.24).
