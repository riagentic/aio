# Scheduling

aio has a built-in scheduler for timers, intervals, daily triggers, and cron
jobs. Schedules are **pure effects** — dispatched from methods (sync or async)
through `s.$do`, handled by the runtime. No side effects in sync methods, no
external cron daemons.

> Timers are one kind of owned resource. For disposables — file watchers,
> sockets, subprocesses — the same keyed replace semantics exist as
> [`own.set`](methods.md#owning-native-resources-ownset-aio-382).

## Two ways to schedule

### 1. Dynamic — from a method

Run a `ScheduleEffect` from any method (sync or async) through `s.$do`:

```ts
import { cell, schedule, self } from "aio";

const notifications = cell("notifications", {
  state: { pending: 0 },
  methods: {
    queue(s) {
      s.pending += 1;
      s.$do(schedule.after("flush", 2000, self("flush")));
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
> **Own cell: use `self("method")`.** Naming the cell inside its own initializer
> (`notifications.flush` referenced inside `notifications`) trips TypeScript's
> circular-inference guard (TS7022/TS7023 — _"implicitly has type any …
> referenced in its own initializer"_). `self("flush")` builds the same
> descriptor without the self-reference, so the cycle never forms. Scheduling
> **another** cell's action keeps using `otherCell.method.action(...)`. See
> [Referencing the cell inside its own methods: `self()`](methods.md#referencing-the-cell-inside-its-own-methods-self).

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

Every entry is validated as config, before the app boots — so a malformed one
never reaches the first tick:

- `every` and `after` are **plain numbers of milliseconds**. `every: "5m"` is
  refused by name; aio's CLI takes `60s` spellings (`am cost --window=60s`), the
  config does not.
- `action` is an action **object** — `cell.method.action()`, or
  `{ type: "cell:method", payload }`. A bare `"cell:method"` string is refused
  here rather than failing on the first tick, which for an `at`/`cron` entry can
  be days after the deploy.
- Each entry declares exactly one of `every` / `after` / `at` / `cron`, ids are
  unique (a duplicate would silently replace the earlier entry), and an unknown
  key gets a did-you-mean.

The dev server transpiles without type-checking, so the `ScheduleDef` type alone
does not catch these in your app — the runtime check is what holds.

---

## Schedule types

### `schedule.after(id, ms, action)` — one-shot delay

Fires `action` once after `ms` milliseconds. Cancels any previous timer with the
same `id`.

```ts
// Save 3 seconds after last keystroke (debounce pattern)
methods: {
  type(s, text: string) {
    s.draft = text
    s.$do(schedule.after('autosave', 3000, draft.save.action()))
  },
}
```

### `schedule.every(id, ms, action)` — repeating interval

Fires `action` every `ms` milliseconds until cancelled.

```ts
// Poll every 30 seconds
s.$do(schedule.every("sync", 30_000, data.sync.action()));
```

> Intervals fire on a fixed clock and can't be deferred per-tick. If the poller
> must slow itself down (rate-limit backoff), use a self-scheduling `after`
> chain instead — see
> [Backoff on rate-limit](#backoff-on-rate-limit-dynamic-polling).

**Don't stack a slow poll on itself:**

```ts
// A tick is dropped while the previous one is still in flight.
s.$do(schedule.every("hw", 1000, hw.poll.action(), { skipIfRunning: true }));
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
> warn once when they do. `every` is the exception: an interval has no deadline
> to re-check, and `setInterval` would truncate it to a 1ms hot loop, so an
> `every` past 24.85 days is **refused** — at config time and at the call site.
> A monthly cadence is `cron` (`"0 9 1 * *"`). Timers still do not survive a
> restart — if the deadline must, persist it and re-arm on boot.

### `schedule.at(id, isoTime, action)` — one-shot at absolute time

Fires once at a specific UTC datetime. `isoTime` is any string parseable by
`new Date()`.

```ts
s.$do(schedule.at("promo-end", "2025-12-31T23:59:00Z", promo.expire.action()));
```

A time that has already passed does **not** fire and is **not** registered — the
scheduler warns, naming the id and how long ago it was, because the usual cause
is a UTC/local mix-up or a deadline restored from disk.

### `schedule.cron(id, pattern, action)` — cron expression

Fires on a standard 5-field cron schedule (UTC).

```ts
s.$do(schedule.cron("daily-report", "0 8 * * 1-5", reports.generate.action()));
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

### `schedule.backoff(id, attempt, action, opts)` — exponential retry delay

A one-shot `after` whose delay grows exponentially with `attempt`:
`base * factor^attempt`, capped at `max` (`factor` defaults to 2). Track the
attempt counter in state — reset it on success, bump it on failure. The action
is the 3rd argument, same as after/every (alpha52 — the old
`(id, attempt, opts, action)` order is detected by shape and still accepted,
with a one-time hint).

`max` is optional; omitted, it caps at the timer ceiling (~24.85 days). Give it
a real value — `60_000` is the usual one — or a runaway `attempt` counter buys
you a delay measured in weeks.

```ts
s.$do(schedule.backoff(
  "prices:refresh",
  s.attempt, // 0 → base, 1 → base*2, 2 → base*4, … capped at max
  prices.refresh.action(),
  { base: 5_000, max: 60_000 },
));
```

### `schedule.poll(id, attempt, action, opts)` — self-pacing poller

The first-class polling loop: constant `every` interval while healthy (`attempt`
= 0), backing off by `factor^attempt` (capped at `max`) while failing. Re-issue
it each cycle with the current attempt — the delay self-adjusts, no hand-rolled
after-chain or backoff clock in state. (alpha52: the option key is `factor`; the
old `backoff` key still works with a hint, and `aiol --safe-fix` renames it. The
action moved to the 3rd argument, old order accepted with a hint.)

```ts
methods: {
  async tick(s) {
    try {
      s.data = await call(() => api.poll())
      s.attempt = 0                       // healthy → constant cadence
    } catch {
      s.attempt += 1                      // failing → back off
    }
    s.$do(schedule.poll('rpc', s.attempt, self('tick'), { every: 5000, factor: 2, max: 60000 }))
  },
}
```

### `schedule.next(id, action)` — defer to the next tick

Runs the action right after the current method returns — the honest primitive
for "not now, but immediately after this commit". A true 0ms timer since alpha52
(`schedule.after` accepts 0 now, so the 1ms sentinel is gone). Same-id replace
applies, so repeated calls dedup.

```ts
s.$do(schedule.next("recalc", totals.recalc.action()));
```

### `schedule.cancel(id)` — cancel any timer

```ts
methods: {
  startSync(s) {
    s.syncing = true
    s.$do(schedule.every('sync', 5000, data.sync.action()))
  },
  stopSync(s) {
    s.syncing = false
    s.$do(schedule.cancel('sync'))
  },
}
```

### `blocking(id, fn, arg?)` — run it off the main thread

The odd one out: imperative (returns a Promise) because it moves **work**, not
an action — which is why it is a top-level export of `"aio"`, not a `schedule`
member (`schedule` ships to every runtime; `blocking` is server-only and
refuses, by name, on a browser/WebView runtime). The function runs on a worker
pool — a real thread — so CPU-bound or FFI work can't freeze rendering, the
dispatch loop, or anyone else's actions.

```ts
methods: {
  async build(s, raw: number[]) {
    s.status = "building"; // instant
    s.rows = await blocking("report:build", (input) => {
      // Self-contained: no closures — everything arrives as `arg`.
      return (input as number[]).map((n) => ({ id: n, score: Math.sqrt(n) * n }));
    }, raw); // seconds of CPU, off-thread
    s.status = "done";
  },
  stop() {
    blocking.cancel("report:build"); // terminates the worker
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
  search(s, query: string) {
    s.query = query
    s.$do(schedule.after('search.debounce', 300, search.execute.action()))
  },
}
```

### Retry with backoff

```ts
methods: {
  async fetchData(s) {
    try {
      s.data = await call(() => api.getData())
    } catch {
      s.retries += 1
      s.$do(schedule.after('fetch.retry', s.retries * 2000, data.fetchData.action()))
    }
  },
}
```

### Backoff on rate-limit (dynamic polling)

A static `every` schedule fires on a fixed clock — it cannot be deferred
per-tick, so a rate-limited API forces you to hand-roll `backoffUntil` state and
waste wakeups. Instead, own the loop: seed one `after` and let the method
schedule its own next run. Replace-by-ID means each `$do` sets the next delay
dynamically — no clock state in the cell, no wasted ticks.

```ts
// ❌ static every + manual backoff clock (wasted wakeups, bespoke state)
// schedules: [{ id: 'prices:refresh', every: 30_000, action: prices.refresh.action() }]
// if (Date.now() < s.backoffUntil) return  // guard every tick

// ✅ schedule.backoff owns the exponential arithmetic — track `attempt` in state
methods: {
  async refresh(s) {
    try {
      s.byId = await call(() => api.prices())
      s.attempt = 0 // success → reset the backoff
      s.$do(schedule.after('prices:refresh', 30_000, prices.refresh.action()))
    } catch {
      s.attempt = (s.attempt ?? 0) + 1 // failure → grow the delay
      // (id, attempt, ACTION, opts) — the action is 3rd, as in after/every/at/
      // cron. The old order is refused BY NAME at runtime.
      s.$do(schedule.backoff(
        'prices:refresh',
        s.attempt,
        prices.refresh.action(),
        { base: 5_000, max: 60_000 },
      ))
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
  enablePolling(s) {
    s.polling = true
    s.$do(schedule.every('prices.poll', 5000, prices.refresh.action()))
  },
  disablePolling(s) {
    s.polling = false
    s.$do(schedule.cancel('prices.poll'))
  },
}
```

### Session timeout

```ts
methods: {
  activity(s) {
    s.lastActive = Date.now()
    s.$do(schedule.after('session.timeout', 30 * 60_000, auth.logout.action()))
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
import { isScheduleEffect } from "aio/extras";
import { notifications } from "./cell/notifications/index.ts";

testCell(notifications, "queues autosave", (t) => {
  t.init();
  t.send.queue();
  const sched = t.getEffects().find(isScheduleEffect);
  assertEquals(sched?.kind, "after");
  assertEquals(sched?.id, "flush");
});
```
