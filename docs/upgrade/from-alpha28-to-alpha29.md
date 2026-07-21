# Upgrade: 1.0.0-alpha28 → 1.0.0-alpha29

alpha29's headline is the wire-protocol v2 bump. For app code this upgrade is
**zero-change** — the wire is framework-internal. What you must do is
**rebuild**, because both sides must speak v2.

## The one action: rebuild everything that talks to a server

- **Dev mode**: nothing — the server serves the matching client bundle.
- **Compiled binaries**: rebuild with `deno task compile*`. A binary built
  from ≤alpha28 sources cannot talk to an alpha29 server (and vice versa).
- **CLI clients** (`connectCli` / `connectCliUDS`): rerun from alpha29 sources.

Mixed versions fail LOUDLY, not silently: the peer is refused with a readable
reason and WebSocket close code 4505 — "this server speaks wire protocol v2+ —
rebuild/update the client".

## Behavior fixes that may be visible

- **`ui.exclude` is now airtight.** If your UI accidentally depended on
  reading an excluded field client-side, that read now fails/returns nothing —
  that was the point.
- **testUI** is stricter about colliding/disabled targets — tests that passed
  by accident (clicking through a disabled or ambiguous element) now fail with
  a precise message.
- **CRDT sync** dedups op ids on both sides — if you relied on double-apply
  (you didn't, it was a bug), sequences converge differently now.

## Automatic (no code changes)

- Sync + serverFns now work over UDS/IPC (Electron apps get full parity).
- Vitals/time-travel over UDS are rejected with a clear message (WS-only
  diagnostics) instead of silently dropped.
