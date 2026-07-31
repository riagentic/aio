# Real-time and high-frequency state

The one question that decides everything: **at what cadence does this state
change, and who needs to agree on it?** aio's machinery — persistence, sync,
broadcast, time travel — is built for state worth sharing. State that changes
faster than anyone needs to agree on it should never touch that machinery.

| cadence / shape                                | where it belongs               | why                                                                    |
| ---------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| per-frame / per-tick simulation (game, canvas) | `scope: 'client'` cell         | never touches the wire, no broadcast, no persistence overhead          |
| animation & rendering                          | `useRaf` in the component      | frame work is renderer work                                            |
| client-only cadence (music beat, poll, clock)  | `useInterval` in the component | `schedule.every` runs on the SERVER — there is no `AudioContext` there |
| shared state that changes often (a ticker)     | server cell + `syncIntervalMs` | the broadcast throttle is the knob — see below                         |
| durable results (score, leaderboard, settings) | ordinary persisted server cell | this is aio's home turf: one line of `persist`, synced, testable       |

## The traps, named

- **`localFirst` is NOT the fix for a hot loop.** It moves method _execution_ to
  the caller, but every method still travels as a CRDT op — a 60 Hz tick still
  crosses the wire 60 times a second. Use `scope: 'client'` for state that no
  other client (and no restart) needs.
- **The default broadcast throttle is 50 ms** (`syncIntervalMs`, ≈20
  pushes/sec). A 60 fps rAF loop drawing from a server cell renders from a ~20
  Hz stream — smooth UI over server state at higher rates needs `syncIntervalMs`
  lowered deliberately, or the state moved client-side.
- **Time travel is a bounded dev inspector**, not replay — and a tick action
  floods its window. Keep tick actions out with
  `diagnostics: { dev: { skipActions: ["game:tick"] } }`, and build replay from
  an **input tape** (`{seed, events}` re-run through a deterministic step
  function). See [time travel](../debugging/time-travel.md).
- **The commit is the ceiling for a hot cell.** Every cell method commits an
  immutable snapshot (Immer draft → freeze); measured on a real game, a
  ~330-object tree cost ≈1.8 ms per tick against 0.03 ms of simulation logic —
  comfortable at 60 fps, but it scales with **tree size**, not change size. If a
  cell's cadence × tree size stops fitting the frame budget, the structural move
  is `scope: 'client'` with a plain object for the hot part — not a framework
  knob. There is deliberately no per-cell freeze opt-out: frozen immutable
  commits are what time travel, sync and the persistence snapshots rest on (dev
  == prod, no forked semantics).

## The pressure warning points here

`[aio:vitals] PRESSURE — N broadcasts/sec` firing on a loop you cannot debounce
means the state is in the wrong place, not that the loop is wrong. The decision
table in [cells](cells.md) (shared vs per-client) is the long form; the short
form: **if two clients or a restart never need to agree on it, it does not
belong in a server cell.**
