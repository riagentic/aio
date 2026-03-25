# PressureMonitor — Resource Pressure Warnings

## Problem

AIO has comprehensive crisis detection (DiagReporter fires when things are
broken — frozen, stale, slow, disconnected) and proactive memory monitoring
(warns at 75%/90% heap). But three resources have no "yellow light" before the
red:

1. **Broadcast payload size** — tracked per-client in `_payloadStats` but no
   threshold warning. A 500KB delta goes unnoticed until the client freezes.
2. **Broadcast rate** — throttle mechanism exists but no warning when dispatch
   frequency is abnormally high (e.g., tight dispatch loop).
3. **Client render degradation** — RenderProbe fires `degraded` (50ms drift) and
   `warning` (200ms drift) statuses, but the client-side DiagReporter only acts
   on `frozen` (2000ms) and `recovered`. The 50ms→2000ms gap is silent.

## Solution

A standalone `PressureMonitor` module that detects when resources approach
limits and emits `DiagEvent` with a new `"pressure"` kind. Console warnings +
`onDiagnostic` hook integration.

## Design Decisions

- **New DiagEvent kind `"pressure"`** — semantically distinct from `"slow"` or
  `"stale"`. Pressure means "approaching limit," not "already broken."
- **One threshold per resource** — no warn/critical split. One line, binary.
- **Console + `onDiagnostic`** — matches DiagReporter pattern. Console throttled
  (2s debounce), hook fires every time.
- **Dev-only by default** — on in dev, off in prod. Configurable.
- **Server/client split** — server-side PressureMonitor created inside
  `createVitalsSystem` (handles payload + rate). Client-side render pressure
  handled inline in `browser.ts` `onStatusChange` (same pattern as existing
  freeze/recovered handler) — builds DiagEvent, calls `formatDiagEvent`, outputs
  to console. No cross-boundary reference needed.
- **No trending, no backpressure, no new endpoints** — existing `/__aio/vitals`
  already exposes payload stats and feature sizes.

## New Type

```ts
// Added to DiagEvent.kind union in src/vitals/types.ts
kind: "freeze" | "stale" | "slow" | "disconnect" | "recovered" | "pressure";
```

## PressureMonitor API

### File: `src/vitals/pressure-monitor.ts`

**Server-side** (created in `createVitalsSystem`, handles payload + rate):

```ts
type PressureMonitorConfig = {
  payloadThreshold?: number; // bytes, default 512_000 (500KB)
  rateThreshold?: number; // broadcasts/sec, default 30
  onDiagnostic?: (event: DiagEvent) => void;
  onConsole?: (lines: string[]) => void; // override for testing
};

type PressureMonitorAPI = {
  // Called by server.ts broadcast() after each send
  onBroadcast(clientId: string, bytes: number): void;

  destroy(): void;
};

function createPressureMonitor(
  config: PressureMonitorConfig,
): PressureMonitorAPI;
```

**Client-side** (render pressure): handled inline in `browser.ts`
`onStatusChange` — no separate factory. Builds a `DiagEvent` with kind
`"pressure"` and calls `formatDiagEvent` for console output. Same pattern as the
existing freeze/recovered handler. The `report` parameter is
`RenderFreezeReport | null` — guard against null before accessing fields.

### Thresholds

| Resource        | Default               | Rationale                                                              |
| --------------- | --------------------- | ---------------------------------------------------------------------- |
| Payload size    | 512,000 bytes (500KB) | 500KB delta is heavy for WS; indicates fat state or failed compression |
| Broadcast rate  | 30/sec                | Normal apps 1-5/sec, dashboards 5-15/sec; 30+ means dispatch loop      |
| Render degraded | existing 50ms drift   | Already the probe threshold — just needs wiring                        |

### Severity Mapping

| Source  | Condition         | Severity        |
| ------- | ----------------- | --------------- |
| Payload | over threshold    | `"possible"`    |
| Rate    | over threshold    | `"possible"`    |
| Render  | `degraded` (50ms) | `"speculative"` |
| Render  | `warning` (200ms) | `"possible"`    |

### Rate Tracking

Tumbling 1s window — counter incremented on each `onBroadcast()`, checked and
reset every 1s via `setInterval`. Timer cleared on `destroy()`. (Tumbling
window, not sliding — can miss bursts straddling the boundary, acceptable for
advisory diagnostics.)

### Throttling

- Console: 2s debounce per source key (`payload:<clientId>`, `rate`, `render`).
  Same pattern as DiagReporter.
- `onDiagnostic`: fires every time, no throttle. Consistent with DiagReporter.

## Console Output

### Server — payload pressure

```
[aio:vitals] PRESSURE — broadcast payload 623KB to client abc12345
  threshold:  500KB
  hint:       large state delta — check feature sizes at /__aio/vitals
```

### Server — rate pressure

```
[aio:vitals] PRESSURE — 34 broadcasts/sec (threshold: 30/sec)
  hint:       high dispatch frequency — debounce or batch actions
```

### Client — render pressure

```
[aio:vitals] PRESSURE — render degraded (82ms drift, budget: 50ms)
  last action: portfolio:refresh
  hint:        main thread under load — may freeze if sustained
```

Uses existing `formatDiagEvent` — structured block when 2+ data points,
one-liner otherwise.

## Wiring

### Server-side creation: inside `createVitalsSystem` (mod.ts)

```ts
const pressureMonitor = config.pressure !== false
  ? createPressureMonitor({
    payloadThreshold: typeof config.pressure === "object"
      ? config.pressure.payloadThreshold
      : undefined,
    rateThreshold: typeof config.pressure === "object"
      ? config.pressure.rateThreshold
      : undefined,
    onDiagnostic: config.onDiagnostic,
  })
  : null;
```

Exposed on `VitalsSystem` type as `pressureMonitor: PressureMonitorAPI | null`.
The `VitalsSystem` type definition (mod.ts lines 23-32) must be updated to
include this field.

### Client-side wiring: inline in browser.ts onStatusChange

```ts
// In onStatusChange callback, after existing frozen/recovered block:
else if (status === "degraded" || status === "warning") {
  const detail: DiagEvent["detail"] = {};
  if (report) {
    detail.trigger = report.lastActionBefore ?? undefined;
    detail.frozenFor = report.frozenFor;  // drift ms, not actual freeze
  }
  detail.hint = "main thread under load — may freeze if sustained";

  const event: DiagEvent = {
    kind: "pressure",
    severity: status === "degraded" ? "speculative" : "possible",
    summary: `PRESSURE — render ${status} (${Math.round(report?.frozenFor ?? 0)}ms drift)`,
    detail,
    timestamp: Date.now(),
  };

  const lines = formatDiagEvent(event);
  // console output (same pattern as freeze handler)
}
```

No server reference needed — client builds and outputs DiagEvent locally.

### Touch points

| Where                            | Change                                                                                                | Size         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------ |
| `src/vitals/pressure-monitor.ts` | New file — server-side factory + rate timer + payload threshold                                       | ~60-80 lines |
| `src/vitals/types.ts`            | Add `"pressure"` to DiagEvent kind union, add `pressure` to VitalsConfig                              | ~5 lines     |
| `src/vitals/mod.ts`              | Create PressureMonitor in factory, add to VitalsSystem type, re-export                                | ~10 lines    |
| `src/server.ts` broadcast()      | After payload stats: `vitalsSystem.pressureMonitor?.onBroadcast(meta.id, _bytes)`                     | 1 line       |
| `src/browser.ts` onStatusChange  | `else if (status === "degraded" \|\| status === "warning")` → build DiagEvent, format, console output | ~15 lines    |
| `src/vitals/diag-formatter.ts`   | Handle `"pressure"` kind in `frozenFor` suppression check (line 51)                                   | ~1 line      |

### User configuration

```ts
aio.run({
  diagnostics: {
    dev: {
      vitals: {
        pressure: {
          payloadThreshold: 1_000_000, // 1MB for heavy app
          rateThreshold: 60, // real-time data
        },
      },
    },
    prod: {
      vitals: { pressure: false }, // off in prod (default)
    },
  },
});
```

- `pressure: false` — disabled, zero overhead
- `pressure: true` — enabled with defaults
- `pressure: { ... }` — enabled with custom thresholds
- omitted — default for mode (dev: on, prod: off)

## Edge Cases

| Case                                          | Behavior                                                     |
| --------------------------------------------- | ------------------------------------------------------------ |
| First broadcast is huge (app init full state) | Throttle handles it — warns once, suppresses for 2s          |
| Rate spikes briefly then drops                | 1s window — only fires if sustained for full second          |
| Multiple clients, one has big payload         | Warning includes clientId — per-client, not aggregate        |
| `pressure: false`                             | Monitor not created, `onBroadcast` not called, zero overhead |
| Payload just under threshold                  | Nothing. One threshold, binary.                              |

## Interaction With Existing Tools

```
Normal operation:
  PressureMonitor silent, DiagReporter silent

Approaching trouble:
  PressureMonitor fires "pressure" event (console + onDiagnostic)

Actual trouble:
  DiagReporter fires "slow"/"stale"/"freeze" (already exists)
  PressureMonitor continues firing "pressure" alongside
```

No dedup needed — different kinds, different information. Pressure says "why
it's building up," DiagReporter says "it broke."

## What This Does NOT Include

- No trending/regression (memory monitor's job)
- No warn/critical split (one threshold per resource)
- No new HTTP endpoint (`/__aio/vitals` already has payload stats + feature
  sizes)
- No health overlay integration (server-side data, wrong side of wire)
- No backpressure/auto-throttle (different feature entirely)
- No persistent logging to `perf.log` (console + `onDiagnostic` is enough)

## Testing

~15-20 tests in `tests/vitals/pressure-monitor.test.ts`:

- Payload over threshold → DiagEvent with kind `"pressure"`, correct bytes
- Payload under threshold → no event
- Rate over threshold → DiagEvent with kind `"pressure"`, correct rate
- Rate under threshold → no event
- Render degraded → DiagEvent with severity `"speculative"`
- Render warning → DiagEvent with severity `"possible"`
- Console throttling (2s debounce per source)
- `onDiagnostic` fires every time (no throttle)
- `destroy()` clears rate timer
- Custom thresholds override defaults
- `pressure: false` → no monitor created
