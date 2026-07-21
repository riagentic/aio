# Production

Memory monitoring, cell health, common error patterns, and production failure
scenarios.

## Going-to-production checklist

Work top to bottom — each item links to the details.

- [ ] **`deno task doctor`** passes — config, import map, Deno version.
- [ ] **Compile the target** (`deno task compile`) and boot the binary once —
      prod serving differs from dev transpile ([targets](../build/targets.md)).
- [ ] **Secrets audited** — every cell reviewed for `ui`/`persist` exposure; no
      boot-time visibility warnings left
      ([cell visibility](../state/cell-visibility.md),
      [pitfalls](../basics/pitfalls.md#persistence)).
- [ ] **Auth decided** — `users` map, `resolveUser` hook, or a conscious
      "public" ([auth](../auth/auth.md)). Exposed servers: `--expose` gives
      TLS + token; put a CA-signed cert on anything real.
- [ ] **appId pinned** — zero-config inference follows the project
      directory/title; renaming would orphan your data and locks. Set `appId` in
      deno.json explicitly before shipping
      ([pitfalls](../basics/pitfalls.md#state--cells)).
- [ ] **Persistence location** — know where your KV/SQLite files live
      (`resolveDataDir`), and back them up; test a restore once.
- [ ] **State versioning** — cells that will evolve have `version` + `onMigrate`
      ([pitfalls](../basics/pitfalls.md#persistence)).
- [ ] **Monitoring wired** — scraper on `GET /__aio/metrics`, alert on
      `aio_cell_enabled == 0` (circuit breaker tripped), `aio_cell_errors_total`
      slope, and RSS growth (below).
- [ ] **Health endpoint** — supervisor/loadbalancer checks `/__aio/health`.
- [ ] **Limits reviewed** — `wsLimits` (message rate/size), `maxConnections`,
      `dispatchStorm` left ON ([run config](../state/lifecycle.md)).
- [ ] **Logs rotating** — `.aio/log/` grows; ship or rotate it.
- [ ] **Soak once** — `deno task soak` (or the 72h variant) against a
      prod-shaped build; heap slope must stay flat.
- [ ] **systemd unit** (service targets) — `Restart=on-failure`; the server
      exits(1) on a dead listener by design, so restarts are the recovery path.
      (No `WatchdogSec` — aio doesn't sd_notify; a watchdog would kill a healthy
      service.)

## Prometheus metrics

`GET /__aio/metrics` serves Prometheus/OpenMetrics text — point your scraper at
it (no config needed):

```
aio_uptime_seconds            seconds since the server started
aio_memory_rss_bytes          resident set size
aio_memory_heap_used_bytes    V8 heap used (also heap_total)
aio_clients_connected         connected WebSocket clients
aio_cell_errors_total{cell}   errors observed per cell
aio_cell_enabled{cell}        cell enabled flag (circuit breaker)
aio_broadcast_bytes_total{kind} / aio_broadcast_messages_total{kind}
```

Pairs with `/__aio/health` (JSON, per-cell detail) and `am metrics` (CLI).

## Memory pressure monitor

AIO monitors heap usage and alerts before OOM. Critical for long-running apps.

### What you see

```
+-  AIO WARNING -------------------------------------------+
| MEMORY_PRESSURE -- heap at 78% (1.56 GB / 2.0 GB)       |
| GC reclaimed only 2.1% on last cycle                     |
|                                                          |
| Top cells by state size:                              |
|   1. barHistory  -- 847 MB (state.candles: 1,240,000)    |
|   2. orderer     -- 12 MB                                |
|   3. portfolio   -- 3 MB                                 |
|                                                          |
| Tip: barHistory state is growing -- consider pruning     |
|      old entries or using external storage.              |
+----------------------------------------------------------+
```

### Configuration

```ts
await aio.run({
  memory: {
    enabled: true, // default: true
    interval: 10_000, // sampling every 10s
    warnThreshold: 0.75, // warn at 75% heap
    criticalThreshold: 0.90, // critical at 90%
    onMemoryPressure(report) {
      // report.level: 'warn' | 'critical'
      // report.heapUsed, report.heapTotal, report.heapPct
      // report.cellStates: sorted by size, largest first
      // report.trend: 'rising' | 'stable' | 'falling'
      if (report.level === "critical") {
        barHistory.pruneOldEntries(1000);
      }
    },
  },
});
```

### How it works

- Samples `Deno.memoryUsage()` every `interval` ms (near-zero cost)
- At/above threshold: measures per-cell state sizes, reports largest cell and
  growing field
- Trend detection: 3 consecutive rising samples = `'rising'`
- Memory pressure errors also hit `onError` as `MEMORY_PRESSURE` /
  `MEMORY_CRITICAL`
- Not available in browser mode (no `Deno.memoryUsage` API)

### V8 heap limits

`--v8-flags=--max-old-space-size=16384` only applies to the main V8 isolate.
Deno Workers get their own isolate with the default ~1.7 GB heap limit.
`DENO_V8_FLAGS` does not propagate to Workers.

Key points:

- AIO's DB Worker runs in a Worker isolate -- heavy SQLite workloads can hit the
  default limit
- Keep Worker-resident data small -- push bulk results back to main isolate
- Memory monitor runs in the main isolate and reports main-isolate stats only
- Monitor uses `heap_size_limit` from `node:v8` as the correct denominator

---

## Cell health audit

Inspect cell health at runtime:

```ts
const app = await aio.run({ cells: [counter, wallet] });

app.cells!.health();
// [
//   { name: 'counter', status: 'idle', enabled: true, errors: 0, lastAction: 'counter:increment' },
//   { name: 'wallet', status: 'saving', enabled: true, errors: 0, lastAction: 'wallet:save' },
// ]

app.cells!.status("counter"); // 'idle'
app.cells!.list(); // ['counter', 'wallet']
app.cells!.disable("wallet"); // dispatches wallet:__destroy, stops routing
```

HTTP endpoint: `GET /__aio/health` returns JSON with per-cell status.

---

## Common error patterns

### Guarded actions (no state change)

A method with a
[guard line](../state/methods.md#guard-lines--machine-states-without-a-machine)
(`if (s.status !== "idle") return`) returns early on purpose — the dispatch
lands, state doesn't change. If a click "does nothing", check the guard against
the current `status` field before suspecting routing.

### "uses reserved key(s): _status"

The `_status` and `__aio_*` keys are reserved. Rename your field (e.g.,
`_status` -> `currentStatus`).

### "already bound"

Same cell instance passed to `aio.run()` twice, or `aio.run()` called twice
without creating new instances.

---

## Diagnostic bus and health overlay

The diagnostic bus surfaces silent failures. In dev mode, a health indicator
appears bottom-right:

- **Green dot** -- no issues
- **Yellow dot + badge** -- warnings (dropped actions, stripped keys)
- **Red dot + badge** -- errors (state sync failure, persist failure)

Click to expand recent events with severity, type, message, fix hint, and age.

Enabled by default in dev. To disable:

```ts
aio.run({ diagnostics: { dev: { diagnosticBus: false } } });
```

Events older than 60s auto-dismiss. Same event type deduplicated within 5s
windows.

---

## Startup linter

Runs on `aio.run()` and reports config issues:

```
[aio] check-mark state (3 keys) check-mark methods check-mark App.tsx
      warning state has reserved key(s): $p -- rename
      info App.tsx has `import React` -- not needed, JSX transforms are automatic
```

Categories: check-mark ok, warning, info hint, fatal (prevents startup).

---

## Production failure scenarios

### DB Worker crashes mid-transaction

- **Callback transactions** (`db.transaction(fn)`): Promise rejects, write lock
  released, memory state unaffected.
- **Batch transactions** (`db.transaction([stmts])`): atomic failure, nothing
  committed.
- **Auto-persist (Deno.Kv)**: fire-and-forget with error logging. Failed write
  means state restores from last successful write on restart.

Recovery: restart process. SQLite WAL recovery handles partial writes
automatically.

### WebSocket drops during an async method

Async methods run server-side -- client disconnect doesn't affect them. The
method continues, state accumulates, client gets latest on reconnect via
full-state sync.

If the _server_ crashes mid-method: the in-flight method is lost (in-memory). On
restart, cells reinitialize to persisted state. Design workflows to be resumable
-- check state in `onInit`.

### Electron process killed during state flush

Deno.Kv is crash-safe (SQLite internally). Kill during write either commits
fully or not at all.

### `deno compile` binary can't find assets

Compiled binaries embed `dist/app.js` and `dist/style.css` at build time. If
build didn't run first, binary serves empty responses. Fix: always run build
before compilation.

### Server restart while clients are connected

Each server start generates a boot ID. Client reconnects with different boot ID
triggers page reload for fresh code. Automatic.

### `until()` never resolves

`until(pred)` fails loud: it rejects with `UntilTimeoutError` after 30s by
default instead of hanging. If a workflow seems stuck, check the error log for
the timeout message and tune `{ timeoutMs }` (or fix the predicate).

### Offline queue overflow

Offline queue (IndexedDB) caps at 100 actions. Beyond that, actions silently
dropped. Intentional -- stale actions from hours-offline shouldn't replay.

### Cell error accumulation

Effect errors increment a per-cell counter visible via `health()`. Cell keeps
running -- errors don't auto-disable. Use `onError` or periodic health checks to
detect high error counts.

### Memory growth in long-running apps

Common causes:

- **Unbounded state arrays**: memory monitor catches this -- look for
  `MEMORY_PRESSURE` with per-cell sizing
- **Time-travel history**: capped at 200 entries (dev only, zero in prod)
- **Stuck async methods**: an `until()` that can never become true holds its
  method in-flight until the 30s default timeout rejects it
- **WebSocket client state**: each client holds a delta cache. Disconnected
  clients cleaned up on close. Check `am status` for connection count
