# Time travel

A **dev inspector with a bounded window** — not a replay mechanism, not
persistence. It answers "how did state get into this shape?" during development;
it is force-off in production, and its history is a ring that evicts. Anything
user-facing built on it will not survive a prod build.

## What it is

Every non-internal action appends an entry: the action, a timestamp, and the
committed state **by reference** — committed state is a fresh immutable tree per
action (Immer), so an entry costs nothing to record and history memory grows
with the _deltas_ between actions, not entries × state size. Undo / redo / goto
are O(1) — the entry's state is simply served.

- Window: **2000 entries**, oldest evicted.
- Dev only: `if (prod) return false` — by design, not by accident.
- Off switch: `diagnostics: { dev: { timeTravel: false } }`.
- UI: `useTimeTravel()` in any AIR component; server side drives it over the
  `tt-state` / `tt-cmd` frames.

## High-frequency apps: `skipActions`

A 60 fps `game:tick` fills 2000 entries in ~33 seconds — the window then holds
noise instead of a session. Keep tick-rate actions out of history:

```ts
await aio.run({
  cells: [game],
  diagnostics: { dev: { skipActions: ["game:tick"] } },
});
```

Skipped actions still dispatch, broadcast and persist normally — they are only
absent from the time-travel ring.

## "Replay the last game" is not this feature

For user-facing replay, record **inputs, not states**:

```ts
type Tape = {
  seed: number;
  events: { frame: number; key: string; down: boolean }[];
};
```

A few dozen events per session, re-run through a deterministic step function. It
works in production, survives restarts if you persist the tape in a cell, and is
the standard approach in games. See [real-time state](../state/real-time.md) for
where high-frequency state belongs in the first place.
