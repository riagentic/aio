# Render Protection — Staleness-Driven React Overload Prevention

**Date:** 2026-03-25 **Status:** Draft **Type:** Feature — Measure + Protect +
Advise **Priority:** P1 **Targets:** Browser, Electron

---

## Problem

AIO monitors server-side dispatch (LoopProbe), transport (TransportProbe), and
detects main-thread freezes (RenderProbe via setTimeout drift). But **none of
these measure React rendering itself**. The result:

1. We don't know when React can't keep up with incoming state patches.
2. We can't warn developers before the UI becomes unresponsive.
3. We have no backpressure — server pushes at a fixed rate regardless of client
   capacity.
4. Developers get zero actionable feedback about render bottlenecks.

This is equivalent to monitoring server CPU but not the database — the most
common bottleneck is invisible.

### Bad Outcomes This Prevents

| # | Outcome          | Cause                                 | Consequence           |
| - | ---------------- | ------------------------------------- | --------------------- |
| 1 | **Stale UI**     | React can't paint fast enough         | User acts on old data |
| 2 | **Input lag**    | Main thread blocked by reconciliation | App feels broken      |
| 3 | **Total freeze** | Runaway re-renders or GC pause        | App unresponsive      |
| 4 | **OOM crash**    | Unbounded state growth                | Data loss             |

---

## Design Principle

**Staleness is the primary health signal.** It directly answers "is the UI
current?" All other metrics exist to explain WHY staleness is high and to drive
automatic mitigation. No metric exists without a purpose. No measurement runs
without being cheap enough to never burden the system it monitors.

```
PREVENT  stale UI, input lag, freezes, crashes
    |  detected by
STALENESS  primary health signal (is UI current?)
    |  explained by
FRAME TIME, PENDING PATCHES, PAINT RATE, MEMORY
    |  acted on by
COALESCING, BACKPRESSURE, LOGGING + HINTS
```

---

## Part 1: Measurement — RenderMeter

Replaces RenderProbe. One module, four cheap metrics, all driven by a single rAF
loop.

### Metrics

| Metric           | Measurement                                       | Per-frame cost        | Purpose                       |
| ---------------- | ------------------------------------------------- | --------------------- | ----------------------------- |
| `staleness`      | `now - lastPatchAt` (when unpainted patch exists) | 1 subtraction         | Primary: is UI current?       |
| `frameTime`      | rAF gap (ms since last rAF callback)              | 1 `performance.now()` | Diagnostic: render cycle cost |
| `pendingPatches` | counter, +1 on patch, reset on paint              | 1 increment/reset     | Diagnostic: queued work       |
| `paintRate`      | rAF callbacks counted over 1s window              | 1 increment           | Diagnostic: actual throughput |

No rolling windows. No percentile calculations. No typed arrays. Current values
only, updated every frame.

### API

```typescript
type RenderMeterConfig = {
  manualTick?: boolean; // for tests — disable auto rAF loop
  onStatusChange?: (status: VitalStatus, gauges: RenderGauges) => void;
  thresholds?: {
    staleness?: number; // ms, default 300
    pendingPatches?: number; // count, default 10
  };
};

type RenderGauges = {
  staleness: Gauge;
  frameTime: Gauge;
  pendingPatches: Gauge;
  paintRate: Gauge;
};

type Gauge = {
  name: string;
  current: number;
  capacity: number;
  percent: number; // clamped 0-100
};

type RenderMeterAPI = {
  recordPatch(): void; // called when _applyPatch runs
  recordAction(type: string, feature: string): void;
  getGauges(): RenderGauges;
  getStaleness(): number;
  getStatus(): VitalStatus; // healthy | degraded | warning | frozen
  tick(frameTime: number): void; // manual mode for tests
  destroy(): void;
};
```

### Gauge Definitions

| Gauge            | `current`              | `capacity` (default)                               |
| ---------------- | ---------------------- | -------------------------------------------------- |
| `staleness`      | measured ms            | 300ms (configurable)                               |
| `frameTime`      | measured ms            | 16.67ms (60fps)                                    |
| `pendingPatches` | count since last paint | 10 (configurable)                                  |
| `paintRate`      | measured fps           | 60 (inverted: gauge shows `(60 - fps) / 60 * 100`) |

Gauge percent: `Math.min(100, current / capacity * 100)`, clamped 0-100.
Exception: `paintRate` is inverted — lower fps = higher gauge.

### rAF Loop

```typescript
function onFrame() {
  const now = performance.now();

  // Self-budget: if our own measurement takes >1ms, bail
  const measureStart = now;

  frameTime = now - lastFrameAt;
  lastFrameAt = now;

  // Staleness: time since most recent patch that hasn't been painted yet
  if (lastPatchAt > lastPaintAt) {
    staleness = now - lastPatchAt;
  } else {
    staleness = 0;
  }
  lastPaintAt = now;

  // Paint rate: count frames in current 1s window
  frameCountInWindow++;
  if (now - windowStart >= 1000) {
    paintRate = frameCountInWindow;
    frameCountInWindow = 0;
    windowStart = now;
  }

  // Classify and notify on status change
  const newStatus = classify();
  if (newStatus !== status) {
    status = newStatus;
    onStatusChange?.(status, getGauges());
  }

  // Reset pending patches (they've been "painted")
  pendingPatches = 0;

  // Always reschedule — meter must never go dark
  requestAnimationFrame(onFrame);
}
```

### Visibility Guard

When tab is backgrounded, browsers throttle rAF to ~1fps or pause entirely. This
would produce false "frozen" readings.

```typescript
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // Pause measurement — don't count background time as staleness
    paused = true;
  } else {
    // Resume — reset baselines to avoid false spike
    paused = false;
    lastFrameAt = performance.now();
    lastPatchAt = 0;
    staleness = 0;
  }
});
```

### Status Classification

```
staleness < capacity:         healthy
staleness >= capacity × 1:    degraded
staleness >= capacity × 2:    warning
staleness >= capacity × 5:    frozen
(any non-healthy) → healthy:  recovered (transient, then healthy)
```

Uses staleness as the sole classifier. frameTime/pendingPatches/paintRate are
diagnostic detail, not status drivers. One signal, one classification, no
weighted averages.

The `recovered` status fires once on transition from any non-healthy state back
to healthy, consistent with existing RenderProbe and the hint engine's
death-spiral detection. Status sequence: `frozen → recovered → healthy`.

---

## Part 2: Client-Side Protection

### 2a. Notification Coalescing

The single highest-impact change. Multiple patches per frame produce one React
notification instead of N.

**Current flow (per patch):**

```
WS message → _applyPatch → _notify() → React schedules reconciliation
WS message → _applyPatch → _notify() → React schedules reconciliation
WS message → _applyPatch → _notify() → React schedules reconciliation
```

**New flow (coalesced):**

```
WS message → _applyPatch → mark dirty
WS message → _applyPatch → already dirty, skip
WS message → _applyPatch → already dirty, skip
rAF fires  → if dirty: _notify() once → React reconciles final state
```

Implementation: coalescing and measurement share a single rAF callback. This
avoids ordering ambiguity between two competing rAF registrations.

```typescript
let _dirty = false;

// Single rAF loop — handles both coalesced notification and measurement.
// RenderMeter's onFrame() is this callback. Flow per frame:
//   1. If dirty: _notify() → React reconciles with final state
//   2. Measure frame timing, staleness, paint rate
//   3. Reset dirty + pendingPatches
//   4. Reschedule
function onFrame() {
  const now = performance.now();

  // Step 1: flush coalesced notification FIRST — React renders this frame
  if (_dirty) {
    _dirty = false;
    _notify();
  }

  // Step 2: measure (see Part 1 rAF loop)
  // ... frameTime, staleness, paintRate, classify, etc.

  // Step 3: reset pending patches (painted this frame)
  pendingPatches = 0;

  // Step 4: always reschedule
  requestAnimationFrame(onFrame);
}

function _markDirty() {
  _dirty = true;
  // No separate rAF — the persistent onFrame loop handles it
}
```

In ws.onmessage / ipc.onMessage, replace `_notify()` with `_markDirty()`.

**Critical invariant:** `_applyPatch` remains synchronous and immediate. State
(`_state`) is always current. Only the notification to React is deferred. Any
code reading `_state` directly sees the latest value.

### 2b. Skip-Identical Suppression

After `_applyPatch`, if the resulting state reference is identical to the
previous state (no-op patch), skip marking dirty entirely.

```typescript
const prev = _state;
_state = _applyPatch(prev as Record<string, unknown>, data);
if (_state === prev) return; // nothing changed
_markDirty();
```

Cost: one reference comparison. Eliminates waste from server sending deltas that
don't affect visible state.

### 2c. Client-to-Server Backpressure

Client reports staleness in the existing vitals ping. Server adapts per-client
sync rate.

**Protocol change (additive — backward compatible):**

```
Current:  __vitals:ping:{"t1": 123456}
New:      __vitals:ping:{"t1": 123456, "ms": 85}
```

`ms` = current staleness in milliseconds. Short field name to minimize wire
cost.

**Server-side adaptation (per client):**

```
staleness < 100ms:    configured syncIntervalMs (default 50ms)
staleness 100-300ms:  syncIntervalMs × 2
staleness > 300ms:    syncIntervalMs × 4
```

Ramps back down when staleness drops in subsequent pings. Each client tracked
independently — a fast desktop keeps full rate while a struggling mobile gets
reduced rate. Delta compression remains correct because server already tracks
per-client `lastState`.

**Hysteresis:** Scale down immediately (one ping above threshold). Recovery is
stepped: 4x → 2x → 1x, each step requiring 3 consecutive pings below that step's
threshold. Example: client at 4x (staleness was >300ms), staleness drops to
150ms — after 3 pings at 150ms, step down to 2x. Then if staleness drops to
50ms, after 3 more pings, step down to 1x. Prevents oscillation.

**Per-client throttling note:** The current server broadcast uses a single
global `syncIntervalMs` timer. Per-client adaptation is implemented by
**skipping** the broadcast for throttled clients rather than running separate
timers. On each broadcast cycle, the server checks each client's
staleness-derived multiplier against elapsed time since that client's last send.
If not enough time has passed, the client is skipped (its `lastState` is NOT
updated, so the next cycle computes a correct cumulative delta). This requires
~10 lines in the existing broadcast loop — no architectural restructuring.

---

## Part 3: Capacity Gauges

Normalized 0-100% utilization metrics across all resource-sensitive layers.
Every gauge has a measurable capacity (tank) and a measurable current value
(float).

### Client Gauges (from RenderMeter)

| Gauge                   | Current           | Capacity (default) |
| ----------------------- | ----------------- | ------------------ |
| `render.staleness`      | measured ms       | 300ms              |
| `render.frameTime`      | measured ms       | 16.67ms            |
| `render.pendingPatches` | count             | 10                 |
| `render.paintRate`      | 60 - measured fps | 60                 |
| `memory`                | `usedJSHeapSize`  | `jsHeapSizeLimit`  |

Memory gauge: Chrome/Edge only (`performance.memory`). Sampled at 1/sec max.
Returns `null` on unsupported browsers — gauge simply absent, no fallback.

### Server Gauges (normalize existing metrics)

| Gauge                  | Current          | Capacity                     |
| ---------------------- | ---------------- | ---------------------------- |
| `server.queueDepth`    | from LoopProbe   | `queue.frozen` threshold     |
| `server.reduceTime`    | `p95ReduceTime`  | `perfBudget.reduce`          |
| `server.broadcastRate` | broadcasts/sec   | `rateThreshold`              |
| `server.bandwidth`     | bytes/sec/client | `bandwidthThreshold`         |
| `transport.rtt`        | measured RTT     | `transport.frozen` threshold |

### Transport

Client gauges reported to server via `__vitals:ping` (staleness field — see 2c).
Full gauge snapshot available at `/__aio/vitals` endpoint (extends existing
endpoint). Server gauges always available; client gauges included when at least
one client is connected and has reported.

### Gauge Type

```typescript
type Gauge = {
  name: string;
  current: number;
  capacity: number;
  percent: number; // Math.min(100, current / capacity * 100)
};
```

---

## Part 4: Logging and Developer Feedback

### Warning Escalation (staleness-driven)

When staleness exceeds threshold:

```
[aio:vitals] STALENESS WARNING — UI is 340ms behind server state
  frameTime:      45ms (2.7x budget)
  pendingPatches: 8
  paintRate:      18fps
  hint:           receiving patches faster than painting —
                  simplify components or raise syncIntervalMs
```

### Self-Protecting Log Suppression

Diagnostic logging must never contribute to the problem it's detecting.

```
1st breach:    warn immediately
2nd breach:    warn after 2s
3rd breach:    warn after 4s
4th breach:    warn after 8s
5th breach:    warn after 16s
6th+ breach:   one "suppressing further warnings until recovery" message
On recovery:   one "recovered after Xs" message, reset counter
```

Maximum 6 messages per incident. Zero risk of log-induced choking.

### Hint Engine (purpose-driven)

Each hint maps a metric pattern to a specific developer action:

| Pattern                                              | Hint                                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| High staleness + high frameTime + low pendingPatches | "Components too expensive — profile with React DevTools, consider React.memo() or simpler renders"                |
| High staleness + low frameTime + high pendingPatches | "Too many patches arriving — raise syncIntervalMs or batch server-side actions"                                   |
| High staleness + low frameTime + low pendingPatches  | "Main thread blocked by non-React work — check for heavy JS outside React (timers, workers, third-party scripts)" |
| High staleness + high memory gauge                   | "Memory pressure causing GC pauses — reduce state size or check for leaks"                                        |

### Integration with Existing Systems

- **Console output:** Same format as existing vitals/pressure warnings.
- **Diagnostic bus:** Emits `DiagEvent` with existing `kind: "pressure"` (same
  as PressureMonitor — no type extension needed). Apps receive via existing
  `onDiagnostic` hook or `window._aioDiag`.
- **`/__aio/vitals` endpoint:** Extended to include render gauges alongside
  server gauges.
- **Error catching:** Critical staleness (>10x threshold) emits via
  `console.error`. Apps can catch via standard error monitoring.

---

## Part 5: Changes to Existing Code

### browser.ts

| Change                                                              | Lines affected | Risk                                              |
| ------------------------------------------------------------------- | -------------- | ------------------------------------------------- |
| Replace `_notify()` calls with `_markDirty()` in onmessage handlers | ~4 lines       | Low — behavior change is intentional (coalescing) |
| Add skip-identical check before `_markDirty()`                      | ~2 lines       | Zero — pure optimization                          |
| Replace RenderProbe creation with RenderMeter creation              | ~20 lines      | Low — same location, new module                   |
| Migrate `recordDelta()` calls to `recordPatch()`                    | ~3 lines       | Low — 1:1 rename                                  |
| Add staleness to ping payload                                       | ~1 line        | Zero — additive field                             |
| Merge `_markDirty` into RenderMeter's rAF loop                      | ~10 lines new  | Low — single rAF, no ordering issues              |

### server.ts

| Change                                                 | Lines affected | Risk                                   |
| ------------------------------------------------------ | -------------- | -------------------------------------- |
| Read `ms` from ping payload                            | ~3 lines       | Zero — optional field, backward compat |
| Per-client sync interval multiplier based on staleness | ~10 lines      | Low — existing per-client tracking     |
| Normalize server gauges at `/__aio/vitals`             | ~20 lines      | Zero — additive                        |

### vitals/

| Change                         | Files                           | Risk                            |
| ------------------------------ | ------------------------------- | ------------------------------- |
| New `render-meter.ts`          | 1 new file (~200 lines)         | Zero — no existing code touched |
| Deprecate `render-probe.ts`    | Keep file, add deprecation note | Zero                            |
| Add `Gauge` type to `types.ts` | ~5 lines                        | Zero — additive                 |

### What Does NOT Change

- `useFeature` / `useAio` hook API — identical signatures
- `_applyPatch` — identical logic
- `_subscribe` / `_listeners` — identical
- WebSocket protocol — only ping payload extended (additive)
- Server broadcast logic — only per-client interval multiplier added
- Delta compression — identical
- All existing tests — pass without modification

---

## Part 6: Testing Strategy

### Unit Tests (Deno, manualTick mode)

| Test                                                | Verifies                                                      |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `staleness grows when patches arrive without paint` | recordPatch() without tick() increases staleness              |
| `staleness resets on paint`                         | tick() resets staleness to 0                                  |
| `frameTime reflects rAF gap`                        | tick(32) → frameTime = 32, gauge ~192%                        |
| `pendingPatches accumulates and resets`             | N recordPatch() → pendingPatches = N, tick() → 0              |
| `paintRate tracks frames per second`                | 60 ticks in 1s window → paintRate = 60                        |
| `status transitions on staleness thresholds`        | healthy → degraded → warning → frozen → recovered             |
| `visibility pause prevents false readings`          | pause → tick with large gap → no status change                |
| `log suppression after 5 warnings`                  | 5 breaches → messages emitted, 6th → suppressed               |
| `recovery resets suppression counter`               | recover after suppression → counter reset to 0                |
| `skip-identical prevents notification`              | applyPatch with no-op → _markDirty not called                 |
| `coalescing batches multiple patches`               | 5 patches → 1 notification                                    |
| `gauge percent clamped 0-100`                       | current > capacity → percent = 100, current = 0 → percent = 0 |

### Integration Tests (browser context)

| Test                                      | Verifies                                                     |
| ----------------------------------------- | ------------------------------------------------------------ |
| `backpressure reduces server sync rate`   | Simulated high staleness in ping → server increases interval |
| `backpressure recovers after 3 low pings` | Staleness drops → interval returns to configured value       |
| `vitals endpoint includes render gauges`  | GET `/__aio/vitals` → response contains render.* gauges      |

---

## Part 7: Configuration

All thresholds configurable via existing `aio.run()` config:

```typescript
aio.run({
  appId: "myapp",
  features: [...],

  // Existing
  syncIntervalMs: 50,

  // New (all optional, sensible defaults)
  renderBudget: {
    staleness: 300,        // ms — primary threshold
    pendingPatches: 10,    // count before warning
  },
});
```

No new top-level config keys beyond `renderBudget`. Server gauge capacities are
derived from existing config (`perfBudget`, `rateThreshold`, thresholds in
vitals config).

---

## Summary

| Component          | What                                                       | Lines (est.)   |
| ------------------ | ---------------------------------------------------------- | -------------- |
| RenderMeter        | rAF-based measurement, 4 metrics, gauge output, coalescing | ~200           |
| browser.ts changes | `_markDirty`, skip-identical, probe migration, ping field  | ~40            |
| Backpressure       | Staleness in ping, server adapts per-client interval       | ~20            |
| Server gauges      | Normalize existing metrics to Gauge type                   | ~25            |
| Logging            | Staleness warnings with hint engine + suppression          | ~50            |
| Vitals endpoint    | Extend `/__aio/vitals` with render gauges                  | ~25            |
| Types              | Gauge type, config extension                               | ~15            |
| Tests              | Unit + integration                                         | ~250           |
| **Total**          |                                                            | **~625 lines** |

Design keeps existing APIs stable, adds no new dependencies, and the measurement
loop is pure arithmetic that cannot burden the system it monitors.
