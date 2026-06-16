# Scheduling

aio has a built-in scheduler for timers, intervals, daily triggers, and cron
jobs. Schedules are **pure effects** — returned from reducers or methods
(sync or async, AIO-381), handled by the runtime. No side effects in reducers,
no external cron daemons.

> Timers are one kind of owned resource. For disposables — file watchers,
> sockets, subprocesses — the same keyed replace semantics exist as
> [`own.set`](methods.md#owning-native-resources-ownset-aio-382).

## Two ways to schedule

### 1. Dynamic — from a reducer or method

Return a `ScheduleEffect` from any reducer or method (sync or async):

```ts
import { cell, schedule } from "aio";

const notifications = cell("notifications", {
  state: { pending: 0 },
  methods: {
    queue(s) {
      s.pending += 1;
      return schedule.after("flush", 2000, notifications.flush());
    },
    flush(s) {
      s.pending = 0;
    },
  },
});
```

Each call to `queue()` resets the 2-second debounce — the scheduler cancels the
previous timer and sets a new one.

### 2. Static — always-on at startup

Pass schedules to `aio.run()` for timers that always run regardless of app
state:

```ts
await aio.run({
  cells: [reports],
  schedules: [
    { id: "daily-report", cron: "0 8 * * 1-5", action: reports.generate() },
    { id: "hourly-ping", every: 60_000, action: health.ping() },
  ],
});
```

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
    return schedule.after('autosave', 3000, draft.save())
  },
}
```

### `schedule.every(id, ms, action)` — repeating interval

Fires `action` every `ms` milliseconds until cancelled.

```ts
// Poll every 30 seconds
return schedule.every("sync", 30_000, data.sync());
```

### `schedule.at(id, isoTime, action)` — one-shot at absolute time

Fires once at a specific UTC datetime. `isoTime` is any string parseable by
`new Date()`.

```ts
return schedule.at("promo-end", "2025-12-31T23:59:00Z", promo.expire());
```

### `schedule.cron(id, pattern, action)` — cron expression

Fires on a standard 5-field cron schedule (UTC).

```ts
return schedule.cron("daily-report", "0 8 * * 1-5", reports.generate());
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
  startSync(s) {
    s.syncing = true
    return schedule.every('sync', 5000, data.sync())
  },
  stopSync(s) {
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
schedule.every("orders.poll", 10_000, orders.refresh());
schedule.cron("reports:daily", "0 8 * * *", reports.generate());
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
    return schedule.after('search.debounce', 300, search.execute())
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
      return schedule.after('fetch.retry', s.retries * 2000, data.fetchData())
    }
  },
}
```

### Toggle polling on/off

```ts
methods: {
  enablePolling(s) {
    s.polling = true
    return schedule.every('prices.poll', 5000, prices.refresh())
  },
  disablePolling(s) {
    s.polling = false
    return schedule.cancel('prices.poll')
  },
}
```

### Session timeout

```ts
methods: {
  activity(s) {
    s.lastActive = Date.now()
    return schedule.after('session.timeout', 30 * 60_000, auth.logout())
  },
}
```

---

## With generators

Schedules work inside generators too — yield them like any other effect:

```ts
generators: {
  *processOrder(ctx, orderId: string) {
    yield* ctx.dispatch(schedule.after('order.timeout', 60_000, orders.timeout(orderId)))
    const result = yield* ctx.call('submit', () => submitOrder(orderId))
    yield* ctx.dispatch(schedule.cancel('order.timeout'))
    yield* ctx.done(s => { s.status = 'submitted' })
  },
}
```

---

## Testing schedules

`testCell` gives you `runEffects()` to process returned effects synchronously:

```ts
testCell(notifications, "queues autosave", (t) => {
  t.dispatch(notifications.queue());
  const effects = t.runEffects();
  const sched = effects.find((e) => e.type === "__schedule");
  assertEquals(sched?.kind, "after");
  assertEquals(sched?.id, "flush");
});
```
