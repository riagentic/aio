# Scheduling

aio has a built-in scheduler for timers, intervals, daily triggers, and cron
jobs. Schedules are **pure effects** — returned from reducers or methods (sync
or async, AIO-381), handled by the runtime. No side effects in reducers, no
external cron daemons.

> Timers are one kind of owned resource. For disposables — file watchers,
> sockets, subprocesses — the same keyed replace semantics exist as
> [`own.set`](methods.md#owning-native-resources-ownset-aio-382).

## Two ways to schedule

### 1. Dynamic — from a reducer or method

Return a `ScheduleEffect` from any reducer or method (sync or async):

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

### `schedule.at(id, isoTime, action)` — one-shot at absolute time

Fires once at a specific UTC datetime. `isoTime` is any string parseable by
`new Date()`.

```ts
return schedule.at("promo-end", "2025-12-31T23:59:00Z", promo.expire.action());
```

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

## With generators

Schedules work inside generators too — yield them like any other effect:

```ts
generators: {
  *processOrder(ctx, orderId: string) {
    yield* ctx.dispatch(schedule.after('order.timeout', 60_000, orders.timeout.action(orderId)))
    const result = yield* ctx.call('submit', () => submitOrder(orderId))
    yield* ctx.dispatch(schedule.cancel('order.timeout'))
    yield* ctx.done(s => { s.status = 'submitted' })
  },
}
```

---

## Testing schedules

`testCell` lets you assert on the schedule effects a method returns — `t.send.*`
dispatches, `t.getEffects()` returns what it emitted. (testCell does not run a
live scheduler, so it checks the _effect_, not the eventual timer fire.)

```ts
import { isScheduleEffect } from "aio";

testCell(notifications, "queues autosave", (t) => {
  t.init();
  t.send.queue();
  const sched = t.getEffects().find(isScheduleEffect);
  assertEquals(sched?.kind, "after");
  assertEquals(sched?.id, "flush");
});
```
