# Scheduling

aio has a built-in scheduler for timers, intervals, daily triggers, and cron
jobs. Schedules are **pure effects** — returned from methods (sync or async,
AIO-381), handled by the runtime. No side effects in sync methods, no external
cron daemons.

> Timers are one kind of owned resource. For disposables — file watchers,
> sockets, subprocesses — the same keyed replace semantics exist as
> [`own.set`](methods.md#owning-native-resources-ownset-aio-382).

## Two ways to schedule

### 1. Dynamic — from a method

Return a `ScheduleEffect` from any method (sync or async):

```ts
import { cell, schedule } from "aio";
import type { ScheduleEffect } from "aio";

const notifications = cell("notifications", {
  state: { pending: 0 },
  methods: {
    queue(s): ScheduleEffect {
      s.pending += 1;
      return schedule.after("flush", 2000, notifications.flush.action());
    },
    flush(s) {
      s.pending = 0;
    },
  },
});
```

Each call to `queue()` resets the 2-second debounce — the scheduler cancels the
previous timer and sets a new one.

> **Build the action with `cell.method.action(...args)`.** It returns the
> `{ type, payload }` descriptor the scheduler re-dispatches — typed,
> refactor-safe (a rename is a **compile error**, not a silently dead timer),
> and arguments are passed straight through: `cart.setQty.action(3)`. Do **not**
> pass `cell.method()` — a called method returns `Promise<void>`, not an action.
> (`cell.method.type` is also available as the bare type string for
> `waitFor`/`listensTo`/`cancelOn`.)
>
> **Self-reference needs a return-type annotation.** When a method schedules an
> action on its _own_ cell (`notifications.flush` referenced inside
> `notifications`), TypeScript hits a circular-inference error (TS7022/TS7023 —
> _"implicitly has type any … referenced in its own initializer"_). Annotating
> the return breaks the cycle — use `CellEffect` (the union of every effect a
> method may return), or `CellEffect | void` / `Promise<CellEffect | void>` for
> conditional/async methods. Scheduling **another** cell's action needs no
> annotation. See
> [Referencing the cell inside its own methods](methods.md#referencing-the-cell-inside-its-own-methods-the-celleffect-annotation).

### 2. Static — always-on at startup

Pass schedules to `aio.run()` for timers that always run regardless of app
state:

```ts
await aio.run({
  cells: [reports],
  schedules: [
    {
      id: "daily-report",
      cron: "0 8 * * 1-5",
      action: reports.generate.action(),
    },
    { id: "hourly-ping", every: 60_000, action: health.ping.action() },
  ],
});
```

For pollers that need to change their own cadence (e.g. back off on API rate
limits), don't use a static `every` — seed a one-shot `after` and let the method
schedule its next run:
[Backoff on rate-limit](#backoff-on-rate-limit-dynamic-polling).

---

## Schedule types

### `schedule.after(id, ms, action)` — one-shot delay

Fires `action` once after `ms` milliseconds. Cancels any previous timer with the
same `id`.

```ts
// Save 3 seconds after last keystroke (debounce pattern)
methods: {
  type(s, text: string): ScheduleEffect {
    s.draft = text
    return schedule.after('autosave', 3000, draft.save.action())
  },
}
```

### `schedule.every(id, ms, action)` — repeating interval

Fires `action` every `ms` milliseconds until cancelled.

```ts
// Poll every 30 seconds
return schedule.every("sync", 30_000, data.sync.action());
```

> Intervals fire on a fixed clock and can't be deferred per-tick. If the poller
> must slow itself down (rate-limit backoff), use a self-scheduling `after`
> chain instead — see
> [Backoff on rate-limit](#backoff-on-rate-limit-dynamic-polling).

**Don't stack a slow poll on itself:**

```ts
// A tick is dropped while the previous one is still in flight.
return schedule.every("hw", 1000, hw.poll.action(), { skipIfRunning: true });
```

Without it, a poll that takes longer than its interval runs concurrently with
itself. The usual hand-rolled fix is a state flag:

```ts
async poll(s) {
  if (s.refreshing) return;   // ← the guard this replaces
  s.refreshing = true;
  try { … } finally { s.refreshing = false; }
}
```

That needs a field, a reset in a `finally`, and if the work throws between the
two the flag stays `true` and the poll is dead until a restart. The scheduler
already knows when a dispatch settles, so it clears on rejection as well.

A tick that never settles at all (an `await` that hangs — a fetch with no
timeout) still stops the poller, because that is what the option asks for. It is
no longer silent: after 10 consecutive skips the scheduler warns, naming the id
and the reason. Cancelling or re-issuing the schedule clears the guard, so
`schedule.cancel(id)` followed by a fresh `schedule.every(id, …)` genuinely
restarts a wedged poller.

It is **opt-in**: silently dropping a tick that used to fire would change
behaviour under existing apps, and some schedules overlap deliberately (each
tick is independent one-shot work). Sync ticks are never skipped — there is
nothing to overlap.

> **Delays longer than 24.85 days are handled for you.** `setTimeout` stores its
> delay in a 32-bit int, so a raw 35-day timer fires on the _next tick_ instead.
> `after`, `at` and `cron` all arm long deadlines with 24-hour re-checks and
> warn once when they do. Timers still do not survive a restart — if the
> deadline must, persist it and re-arm on boot.

### `schedule.at(id, isoTime, action)` — one-shot at absolute time

Fires once at a specific UTC datetime. `isoTime` is any string parseable by
`new Date()`.

```ts
return schedule.at("promo-end", "2025-12-31T23:59:00Z", promo.expire.action());
```

A time that has already passed does **not** fire and is **not** registered — the
scheduler warns, naming the id and how long ago it was, because the usual cause
is a UTC/local mix-up or a deadline restored from disk.

### `schedule.cron(id, pattern, action)` — cron expression

Fires on a standard 5-field cron schedule (UTC).

```ts
return schedule.cron("daily-report", "0 8 * * 1-5", reports.generate.action());
//                                    ^ ^ ^ ^ ^
//                                    | | | | └── day of week (Mon-Fri)
//                                    | | | └──── month (*)
//                                    | | └────── day of month (*)
//                                    | └──────── hour (8 UTC)
//                                    └────────── minute (0)
```

**Cron field syntax:**

| Syntax  | Example     | Meaning                 |
| ------- | ----------- | ----------------------- |
| `*`     | `* * * * *` | Every minute            |
| `n`     | `30`        | At value 30             |
| `n-m`   | `1-5`       | Range 1 to 5            |
| `*/n`   | `*/15`      | Every n (0, 15, 30, 45) |
| `n-m/s` | `0-59/10`   | Range with step         |
| `a,b`   | `1,15`      | List                    |

> **Note:** cron fires against **UTC time**. `0 9 * * *` = 09:00 UTC. Offset the
> hour field for local time zones.

**Sparse patterns are fine.** `0 0 29 2 *` (29 February) is valid and fires on
the next leap day, up to eight years out across a century boundary — the
scheduler searches that far and keeps the schedule armed in between.

**Impossible patterns are refused at the call site**, with the reason:
`0 0 30 2 *` throws
`"0 0 30 2 *" can never fire — day-of-month 30 does not
exist in month 2`. A
pattern that can never match a calendar day is a typo, and a typo should fail
where it is written, not quietly disappear at the first fire attempt.

A failing cron tick is logged and the schedule keeps its cadence (one bad tick
does not switch a nightly job off). If the dispatch loop is closing — the app is
shutting down — the schedule stops instead of re-arming into the drain.

### `schedule.backoff(id, attempt, opts, action)` — exponential retry delay

A one-shot `after` whose delay grows exponentially with `attempt`:
`base * factor^attempt`, capped at `max` (`factor` defaults to 2). Track the
attempt counter in state — reset it on success, bump it on failure.

`max` is optional; omitted, it caps at the timer ceiling (~24.85 days). Give it
a real value — `60_000` is the usual one — or a runaway `attempt` counter buys
you a delay measured in weeks.

```ts
return schedule.backoff(
  "prices:refresh",
  s.attempt, // 0 → base, 1 → base*2, 2 → base*4, … capped at max
  { base: 5_000, max: 60_000 },
  prices.refresh.action(),
);
```

### `schedule.poll(id, attempt, opts, action)` — self-pacing poller

The first-class polling loop: constant `every` interval while healthy (`attempt`
= 0), backing off by `backoff^attempt` (capped at `max`) while failing. Re-issue
it each cycle with the current attempt — the delay self-adjusts, no hand-rolled
after-chain or backoff clock in state.

```ts
methods: {
  async tick(s): Promise<ScheduleEffect> {
    try {
      s.data = await call(() => api.poll())
      s.attempt = 0                       // healthy → constant cadence
    } catch {
      s.attempt += 1                      // failing → back off
    }
    return schedule.poll('rpc', s.attempt, { every: 5000, backoff: 2, max: 60000 }, rpc.tick.action())
  },
}
```

### `schedule.next(id, action)` — defer to the next tick

Runs the action right after the current method returns — the honest primitive
for "not now, but immediately after this commit" (replaces the
`schedule.after(id, 1, …)` sentinel). Same-id replace applies, so repeated calls
dedup.

```ts
return schedule.next("recalc", totals.recalc.action());
```

### `schedule.cancel(id)` — cancel any timer

```ts
methods: {
  startSync(s): ScheduleEffect {
    s.syncing = true
    return schedule.every('sync', 5000, data.sync.action())
  },
  stopSync(s): ScheduleEffect {
    s.syncing = false
    return schedule.cancel('sync')
  },
}
```

### `schedule.blocking(id, fn, arg?)` — run it off the main thread

The odd one out: imperative (returns a Promise) because it moves **work**, not
an action. The function runs on a worker pool — a real thread — so CPU-bound or
FFI work can't freeze rendering, the dispatch loop, or anyone else's actions.

```ts
methods: {
  async build(s, raw: number[]) {
    s.status = "building"; // instant
    s.rows = await schedule.blocking("report:build", (input) => {
      // Self-contained: no closures — everything arrives as `arg`.
      return (input as number[]).map((n) => ({ id: n, score: Math.sqrt(n) * n }));
    }, raw); // seconds of CPU, off-thread
    s.status = "done";
  },
  stop() {
    schedule.blocking.cancel("report:build"); // terminates the worker
  },
}
```

The function is serialized to source, so it must be **self-contained** (no
closures — pass data as `arg`), and `arg`/result must be structured-cloneable.
Full contract and the "which tool for which work" table:
[performance → move it off-thread](../debugging/performance.md#move-it-off-thread).

---

## ID rules

Schedule IDs must match `/^[\w\-:.]+$/` — alphanumeric, hyphens, underscores,
colons, dots.

Good convention: `cellName.timerPurpose` or `cellName:action`.

```ts
schedule.every("orders.poll", 10_000, orders.refresh.action());
schedule.cron("reports:daily", "0 8 * * *", reports.generate.action());
```

Returning a schedule effect with an existing ID **replaces** the previous timer
— useful for debouncing.

---

## Common patterns

### Debounce

```ts
methods: {
  search(s, query: string): ScheduleEffect {
    s.query = query
    return schedule.after('search.debounce', 300, search.execute.action())
  },
}
```

### Retry with backoff

```ts
methods: {
  async fetchData(s): Promise<ScheduleEffect | void> {
    try {
      s.data = await call(() => api.getData())
    } catch {
      s.retries += 1
      return schedule.after('fetch.retry', s.retries * 2000, data.fetchData.action())
    }
  },
}
```

### Backoff on rate-limit (dynamic polling)

A static `every` schedule fires on a fixed clock — it cannot be deferred
per-tick, so a rate-limited API forces you to hand-roll `backoffUntil` state and
waste wakeups. Instead, own the loop: seed one `after` and let the method
schedule its own next run. Replace-by-ID means each return sets the next delay
dynamically — no clock state in the cell, no wasted ticks.

```ts
// ❌ static every + manual backoff clock (wasted wakeups, bespoke state)
// schedules: [{ id: 'prices:refresh', every: 30_000, action: prices.refresh.action() }]
// if (Date.now() < s.backoffUntil) return  // guard every tick

// ✅ schedule.backoff owns the exponential arithmetic — track `attempt` in state
methods: {
  async refresh(s): Promise<ScheduleEffect> {
    try {
      s.byId = await call(() => api.prices())
      s.attempt = 0 // success → reset the backoff
      return schedule.after('prices:refresh', 30_000, prices.refresh.action())
    } catch {
      s.attempt = (s.attempt ?? 0) + 1 // failure → grow the delay
      return schedule.backoff(
        'prices:refresh',
        s.attempt,
        { base: 5_000, max: 60_000 },
        prices.refresh.action(),
      )
    }
  },
}

// seed the loop at startup (ms must be >= 1)
schedules: [
  { id: 'prices:refresh', after: 1, action: prices.refresh.action() },
]
```

### Toggle polling on/off

```ts
methods: {
  enablePolling(s): ScheduleEffect {
    s.polling = true
    return schedule.every('prices.poll', 5000, prices.refresh.action())
  },
  disablePolling(s): ScheduleEffect {
    s.polling = false
    return schedule.cancel('prices.poll')
  },
}
```

### Session timeout

```ts
methods: {
  activity(s): ScheduleEffect {
    s.lastActive = Date.now()
    return schedule.after('session.timeout', 30 * 60_000, auth.logout.action())
  },
}
```

---

## Testing schedules

`testUI` and `bootCells` run the **real scheduler** on a virtual clock:
`ui.advance(ms)` / `handle.advance(ms)` moves time forward and fires everything
that comes due — `after`, `every` (including `skipIfRunning`), `at` and `cron`
alike. Only the clock is swapped, so every rule production enforces is enforced
in the test too: an `every` under 10 ms, an `after` under 1 ms and an id outside
`/^[\w\-:.]+$/` are refused in the harness exactly as they are in the app.

```ts
await using h = await bootCells([prices]);
await prices.enablePolling();
await h.advance(15_000); // three 5s ticks, instantly and deterministically
```

`testCell` lets you assert on the schedule effects a method returns — `t.send.*`
dispatches, `t.getEffects()` returns what it emitted. (testCell does not run a
live scheduler, so it checks the _effect_, not the eventual timer fire.)

```ts
import { assertEquals } from "@std/assert";
import { testCell } from "aio/testing";
import { isScheduleEffect } from "aio/schedule";
import { notifications } from "./cell/notifications/index.ts";

testCell(notifications, "queues autosave", (t) => {
  t.init();
  t.send.queue();
  const sched = t.getEffects().find(isScheduleEffect);
  assertEquals(sched?.kind, "after");
  assertEquals(sched?.id, "flush");
});
```
