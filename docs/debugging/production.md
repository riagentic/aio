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
- [ ] **Backups** — `am data` shows every path; back up `~/.<appId>/data/` (the
      whole of it, nothing else) and test a restore once with `am restore`
      ([where files live](../persistence/where-files-live.md)).
- [ ] **State versioning** — cells that will evolve have `version` + `onMigrate`
      ([pitfalls](../basics/pitfalls.md#persistence)).
- [ ] **Monitoring wired** — scraper on `GET /__aio/metrics`, alert on
      `aio_cell_enabled == 0` (circuit breaker tripped), `aio_cell_errors_total`
      slope, and RSS growth (below).
- [ ] **Health endpoint** — supervisor/loadbalancer checks `/__aio/health`.
- [ ] **Limits reviewed** — `wsLimits` (message rate/size), `maxConnections`,
      `dispatchStorm` left ON ([run config](../state/lifecycle.md)).
- [ ] **Logs rotating** — `~/.<appId>/logs/` grows; ship or rotate it.
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

## What an app tells you at startup

The boot report answers "what exactly am I running?" without anyone opening a
config file — and, for the decisions that have more than one possible source,
**who decided**:

```
running (dev, server-only)
  web       http://localhost:8000
  ws        ws://localhost:8000/ws
  id        wallet
  version   1.4.0
  aio       1.0.0-alpha55
  build     compiled (appimage)
  artifact  /opt/wallet/wallet-x86_64.AppImage
  platform  linux/x86_64 · deno 2.9.1
  pid       4242
  client    electron (deno.json)      ← flag / config / deno.json / default
  entry     /opt/wallet/src/app.ts (default)
  bind      127.0.0.1 — loopback only
  port      8000 (flag)
  tls       off (plain http)
  heap      8.0 GB max of 32.0 GB RAM
  data      /home/u/.wallet
  logs      /home/u/.wallet/logs · info
  journal   /home/u/.wallet/data/journal
  cells     3 (ledger, index, prefs)
  workers   index
  sync      ledger
  routes    3
  serverfns billing, admin
  updates   stable · manifest · every 6h · ask first
```

`client (deno.json)` is the shape that matters: a target can come from a
`--client=` flag, `aio.run({ client })`, deno.json, or the framework's default,
and the running app used to be the one thing that could not say which. `bind`
spells out the security posture that `expose` only implied; `workers` and `sync`
name the cells that are not ordinary (own thread, second writer), because both
change how a symptom is read.

A line is omitted only when the thing does not exist — never when it is merely
inconvenient, since "absent" and "unknown" read identically in a log.

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

Three different problems wear the same symptom, so the monitor names which one
it saw (`report.reason`):

- **`pressure`** — near the V8 ceiling; the app is about to OOM.
- **`machine`** — a large share of the WHOLE machine (default: half), even
  though the ceiling is not close. This is the one that freezes a desktop: with
  a 47 GB ceiling, 75%-of-ceiling is 35 GB, and a 64 GB machine is already
  swapping by then. Tune with `memory.machineWarnFraction`.
- **`growth`** — climbing steadily with nothing near a threshold. A leak shows
  up here hours before it shows up anywhere else; reporting it only at 75% turns
  a slow diagnosis into an emergency. Tune with `memory.growthReportRatio`.

- Samples `Deno.memoryUsage()` every `interval` ms (near-zero cost)
- At/above threshold: measures per-cell state sizes, reports largest cell and
  growing field
- Trend detection: 3 consecutive rising samples = `'rising'`
- Memory pressure errors also hit `onError` as `MEMORY_PRESSURE` /
  `MEMORY_CRITICAL`
- Not available in browser mode (no `Deno.memoryUsage` API)

### V8 heap limits

aio sizes the heap for you: **25% of physical RAM, never below 4 GB**. V8's own
default is ~4 GB regardless of the machine, which is how an app dies of "out of
memory" on a 32 GB box with 28 GB free.

- `am start`, `run.sh` and the test harness resolve it for the machine they are
  on and pass `--v8-flags=--max-old-space-size=N`. That is the rule working as
  written: the number is decided where the app runs.
- **A compiled binary is the exception, and it is a hard one.** Measured: a
  compiled artifact **ignores `DENO_V8_FLAGS`**, and V8 fixes the ceiling when
  the isolate is created, so `deno compile --v8-flags=` is the only channel and
  the number is frozen at build time. A build therefore bakes only what travels:
  an absolute `memory.maxHeap`. An app that declares nothing ships with V8's ~4
  GB default — the floor, identical on every machine — and the boot report names
  `memory.maxHeap` when the machine it lands on allows more. (A percentage such
  as `"25%"` is honoured but resolved against the BUILD machine; the build log
  says so. It once shipped silently: a binary cross-compiled on a 187 GB host
  greeted an 8 GB VM with a 46.7 GB ceiling.)
- A bare `deno run src/app.ts` gets V8's default; the app warns at boot, naming
  the flag to add.
- Override per app with `"memory": { "maxHeap": "12GB" }` in deno.json (`"25%"`,
  `"512MB"`, a number of MB, or `"default"`). An explicit value is honoured even
  above 25%; the boot line says so rather than clamping it.
- The boot line reports the ceiling this process actually has, against the RAM
  of the machine reading it — and says when the ceiling exceeds that RAM, which
  means V8 will grow past physical memory before it collects.

**Workers inherit the ceiling.** Measured on Deno 2.9 in both `deno run` and a
compiled binary: a Worker isolate reports the same `heap_size_limit` as the main
one (4192 MB by default, 16480 MB with the flag). Earlier versions of this page
claimed workers were stuck at ~1.7 GB and that `DENO_V8_FLAGS` did not
propagate; both were wrong.

Key points:

- SQLite's page cache is NATIVE memory (`PRAGMA cache_size`, 64 MB per
  connection), outside the JS heap: no V8 flag governs it and the memory monitor
  cannot see it. Raise it deliberately with `dbPragmas` if a workload needs it,
  remembering it is per reader as well as the writer.
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
- **Auto-persist (`aio_kv` snapshot)**: fire-and-forget with error logging.
  Failed write means state restores from last successful write on restart.

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

Persistence is crash-safe (SQLite, WAL mode). Kill during write either commits
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

Offline queue (in memory, lost on reload) caps at 1000 actions. Beyond that,
actions dropped. Intentional -- stale actions from hours-offline shouldn't
replay.

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
