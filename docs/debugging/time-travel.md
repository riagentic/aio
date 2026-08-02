# Time travel

A **dev inspector with a bounded window** — not a replay mechanism, not
persistence. It answers "how did state get into this shape?" during development;
it is force-off in production, and its history is a ring that evicts. Anything
user-facing built on it will not survive a prod build.

## Building a user-facing replay: record inputs, not states

Time travel cannot back a replay FEATURE — it is dev-only and its window evicts,
so the feature would simply be absent in the build users run. The shape that
works is an **input tape**: the app records its own inputs (the actions, with
their arguments and a timestamp) into ordinary cell state, and replay
re-dispatches them from a known seed.

```ts
const game = cell("game", {
  state: {
    seed: 0,
    tape: [] as { at: number; type: string; args: unknown[] }[],
  },
  methods: {
    start(s, seed: number) {
      s.seed = seed;
      s.tape = [];
    },
    // Every input the simulation depends on goes on the tape as it happens.
    input(s, type: string, ...args: unknown[]) {
      s.tape.push({ at: Date.now(), type, args });
    },
  },
});
```

It persists, it survives a prod build, it is deterministic if the simulation is
(seed the RNG from state — never `Date.now()` inside a method), and it costs a
few lines. Time travel stays what it is: the thing you open while debugging it.

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
