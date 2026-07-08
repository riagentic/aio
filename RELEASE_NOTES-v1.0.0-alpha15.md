# v1.0.0-alpha15 — Deno 2.9 blank-app fix, kata test sweep, runtime hardening

Critical compatibility release plus a big step in test depth: **every aio
version ≤ alpha14 crashes on Deno ≥ 2.9 the moment a UI connects** — fixed here,
together with four more real-app bugs the new kata-driven test suites flushed
out, and runtime hardening from a watcher-feedback-loop field report.

> ⚠️ **Update urgency: high.** If your Deno is ≥ 2.9, apps on older aio show a
> blank window (the server dies on the first WebSocket connect). Vendored apps:
> `git -C dep/aio pull`.

## 🚑 The blank-app fix

`Deno.upgradeWebSocket()` consumes the request on Deno ≥ 2.9; aio read a header
_after_ upgrading, so every WS connect threw `Request closed` and killed the
serve callback. Present since alpha3 — surfaced everywhere when Deno 2.9 landed.
Headers are now read before the upgrade.

## ✨ Highlights

- **Every compile target has a runnable, tested example** —
  `examples/targets/<target>/` (all 10), runtime-smoked over WS/HTTP and
  UI-functionally tested (real clicks/typing through the AIR renderer) in CI.
- **Coverage ratchet** — `deno task coverage:check` enforces a src/ line
  coverage floor in CI (currently 69%, actual ~71%); every public runtime export
  is now referenced by at least one real test (was: 11 untested).
- **`DISPATCH_STORM` guard** — a runaway action type (default >200/s for 5s) is
  named in a warning + diagnostic; `dispatchStorm: { breaker: true }` drops it
  while the storm lasts. Born from a real incident: a workspace watcher
  observing aio's own log writes → 500 dispatches/s → dead server.
- **Zombie-proofing** — logs moved to `.aio/log/` (dot-dir, watcher-safe),
  buffered + repeat-suppressed log sink, `info` file-log default, event-loop
  stall detector, listener-death → loud exit, and the single-instance lock now
  verifies the port actually responds before saying "Already running".

## 🐛 Real-app bugs fixed (found by the new tests)

- Delegated event handlers received the mount root as `e.currentTarget` — the
  documented `e.currentTarget.value` pattern read `undefined` everywhere.
- Nested `<Route>` + `<Outlet>` crashed the renderer (array component returns).
- `cell("app", { state: {}, methods: {} })` (the remote-electron/android
  scaffold stub) crashed the cell factory.
- Flat-layout apps got no browser import map (`immer` unresolvable → blank).

## ⚠️ Behavior changes (not API-breaking)

| Was                         | Now                                                 |
| --------------------------- | --------------------------------------------------- |
| logs in `./log/`            | `.aio/log/` (configure: `logging: { dir }`)         |
| file log level `trace`      | `info` (opt back in: `logging: { level: "trace" }`) |
| one fs write per log line   | 250ms batched writes, identical lines collapsed     |
| zombie server spins forever | exits loudly for the supervisor                     |
| lock trusts pid only        | pid alive **and** port responds                     |

Full details in `CHANGELOG.md`.
