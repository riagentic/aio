# v1.0.0-alpha26 — sync cursor hardening + field-report P1 closure

Fix/test/field-report release (per the alpha25 feature freeze — the one
integration finished here is `am create --target`, which shipped half-wired).

## Every open field-report P1 is closed

- **`Deno is not defined` blank screen** — the graph validator always ran at dev
  boot, but its findings went to the debug channel. They are now loud in every
  `deno task dev` terminal: blocking client-breaks with `file:line`, conditional
  `Deno.*` usage with the exact `*.server.ts` fix.
- **Silent post-await write loss** — `s.users.find(…)` handed back a detached
  snapshot: a write after an `await` vanished in prod while `testCell` applied
  it. `find` now resolves the element's index and returns the live proxy —
  writes batch exactly like `s.users[i].field = x`.
- **`ui.surface()` staleness** — after a parent re-render memo-skipped a child,
  the child's own signal-driven branch swap (login form → header) updated the
  DOM but not the walked tree: the new button was visible yet unresolvable. Root
  cause: the memo skip never re-pointed the component instance at the fresh tree
  vnode. One-line fix, pinned by a structural-swap regression test.

## CRDT sync: the catch-up cursor is now race-free

`server_ts` is strictly monotonic and restart-safe (re-seeded from the op-log);
the echoed `lastServerTs` is a per-cell cursor reserved under the cell's lock —
previously it was computed from the client's own request and never advanced, so
the fast path was dead code and the HLC fallback could silently lose concurrent
ops. Reconnect-flushed pending ops are acked and dispatched exactly once (no
more server counter drift / client double-apply).

## testUI quality-of-life

Disabled controls are on the surface (`disabled: true`) and resolvable; unknown
actions fail with the aio name listing + a shadowing hint instead of
`TypeError: not a function`; `waitFor(pred, "msg")`; `navigate()` works with
zero shims (owned-window `location`/`history` installed automatically).

## am create --target, finished

```sh
am create my-app --target=electron   # deno task dev runs electron
am create my-app --target=android    # deno task dev boots the emulator
```

The scaffolded `target` in deno.json is read by `aio.run()` as the client
default, Electron auto-installs on first run, and a typo'd target fails loud.

## Gates

Full suite **2497/0** · onboard e2e **10/10** · coverage **74.5%** (floor 73) ·
fmt / lint / check / api / docs / boundaries / publish-dry-run all green.
