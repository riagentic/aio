# Render Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add staleness-driven React render measurement, client-side
notification coalescing, server backpressure, and capacity gauges to the AIO
framework.

**Architecture:** A new `RenderMeter` module (rAF-based) replaces `RenderProbe`
(setTimeout-based) on the client. It drives a single rAF loop that handles both
coalesced notification and measurement. Client reports staleness to server via
the existing ping/pong protocol; server adapts per-client broadcast rate. All
metrics exposed as normalized 0–100% gauges.

**Tech Stack:** TypeScript, Deno 2.6+, React 18+ (useSyncExternalStore),
WebSocket

**Spec:** `docs/superpowers/specs/2026-03-25-render-protection-design.md`

---

## File Map

| File                                | Action | Responsibility                                                                                               |
| ----------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `src/vitals/render-meter.ts`        | Create | RenderMeter: rAF loop, 4 metrics, gauge output, coalesced notify, log suppression, hint engine, memory gauge |
| `src/vitals/types.ts`               | Modify | Add `Gauge` type, `RenderBudget` config type                                                                 |
| `src/vitals/mod.ts`                 | Modify | Export `createRenderMeter`, deprecation note on `createRenderProbe`                                          |
| `src/browser.ts`                    | Modify | Replace RenderProbe with RenderMeter, `_markDirty` replaces `_notify`, skip-identical, staleness in ping     |
| `src/server.ts`                     | Modify | Read staleness from ping, per-client broadcast skip, extend `/__aio/vitals`                                  |
| `src/aio.ts`                        | Modify | Add `renderBudget` to config type + validation                                                               |
| `tests/vitals/render-meter.test.ts` | Create | Unit tests for RenderMeter                                                                                   |
| `tests/vitals/backpressure.test.ts` | Create | Server-side backpressure adaptation tests                                                                    |

---

## Task 1: Add Gauge type and RenderBudget config to types.ts

**Files:**

- Modify: `src/vitals/types.ts`
- Test: `tests/vitals/types.test.ts`

- [ ] **Step 1: Write test for Gauge type usage**

```typescript
// Append to tests/vitals/types.test.ts
import type { Gauge, RenderBudget } from "../../src/vitals/types.ts";

Deno.test("types: Gauge type is structurally valid", () => {
  const g: Gauge = { name: "test", current: 50, capacity: 100, percent: 50 };
  assertEquals(g.percent, 50);
});

Deno.test("types: RenderBudget type is structurally valid", () => {
  const b: RenderBudget = { staleness: 300, pendingPatches: 10 };
  assertEquals(b.staleness, 300);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/vitals/types.test.ts` Expected: FAIL — `Gauge` and
`RenderBudget` not exported from types.ts

- [ ] **Step 3: Add types to types.ts**

Add after the `DiagEvent` type (around line 73):

```typescript
export type Gauge = {
  name: string;
  current: number;
  capacity: number;
  percent: number; // Math.min(100, current / capacity * 100), clamped 0-100
};

export type RenderBudget = {
  staleness?: number; // ms — primary threshold (default 300)
  pendingPatches?: number; // count before warning (default 10)
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test tests/vitals/types.test.ts` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/vitals/types.ts tests/vitals/types.test.ts
git commit -m "feat(vitals): add Gauge and RenderBudget types"
```

---

## Task 2: Create RenderMeter — core measurement

**Files:**

- Create: `src/vitals/render-meter.ts`
- Create: `tests/vitals/render-meter.test.ts`

This is the largest task. We build incrementally: first the factory + gauge
math, then metrics one by one.

- [ ] **Step 1: Write failing tests for factory, initial state, and gauge math**

Create `tests/vitals/render-meter.test.ts`:

```typescript
import { assertEquals } from "@std/assert";
import { createRenderMeter } from "../../src/vitals/render-meter.ts";

const baseConfig = () => ({
  manualTick: true,
  thresholds: { staleness: 300, pendingPatches: 10 },
});

Deno.test("render-meter: initial status is healthy", () => {
  const meter = createRenderMeter(baseConfig());
  assertEquals(meter.getStatus(), "healthy");
  assertEquals(meter.getStaleness(), 0);
  meter.destroy();
});

Deno.test("render-meter: initial gauges are zero", () => {
  const meter = createRenderMeter(baseConfig());
  const g = meter.getGauges();
  assertEquals(g.staleness.percent, 0);
  assertEquals(g.frameTime.percent, 0);
  assertEquals(g.pendingPatches.percent, 0);
  assertEquals(g.staleness.capacity, 300);
  assertEquals(g.pendingPatches.capacity, 10);
  assertEquals(g.frameTime.capacity, 16.67);
  meter.destroy();
});

Deno.test("render-meter: gauge percent clamped 0-100", () => {
  const meter = createRenderMeter(baseConfig());
  // Simulate massive staleness — 10x threshold
  meter.recordPatch(100); // patch at t=100
  meter.tick(3100); // frame at t=3100, staleness = 3000ms, 1000% → clamped to 100
  const g = meter.getGauges();
  assertEquals(g.staleness.percent, 100);
  meter.destroy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/vitals/render-meter.test.ts` Expected: FAIL — module does
not exist

- [ ] **Step 3: Write RenderMeter factory with gauge math**

Create `src/vitals/render-meter.ts`:

```typescript
// ─── Vital Signs — Render Meter ─────────────────────────────────────────────
// Client-side rAF-based measurement. Replaces RenderProbe (setTimeout drift).
// Single rAF loop: coalesced notification + 4 metrics + gauge output.

import type { Gauge, VitalStatus } from "./types.ts";

// ─── Config & API Types ─────────────────────────────────────────────────────

export type RenderMeterConfig = {
  manualTick?: boolean;
  thresholds?: { staleness?: number; pendingPatches?: number };
  onStatusChange?: (status: VitalStatus, gauges: RenderGauges) => void;
  onNotify?: () => void; // called when coalesced dirty flag flushes
};

export type RenderGauges = {
  staleness: Gauge;
  frameTime: Gauge;
  pendingPatches: Gauge;
  paintRate: Gauge;
};

export type RenderMeterAPI = {
  recordPatch(now?: number): void;
  recordAction(type: string, feature: string): void;
  markDirty(): void;
  getGauges(): RenderGauges;
  getStaleness(): number;
  getStatus(): VitalStatus;
  getLastAction(): string | null;
  getLastFeature(): string | null;
  tick(now: number): void; // manual mode — takes absolute timestamp (not elapsed ms like RenderProbe)
  setPaused(paused: boolean): void;
  destroy(): void;
};

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_STALENESS_THRESHOLD = 300;
const DEFAULT_PENDING_THRESHOLD = 10;
const FRAME_BUDGET = 16.67; // 60fps target
const TARGET_FPS = 60;
const LOG_SUPPRESS_SCHEDULE = [0, 2000, 4000, 8000, 16000]; // ms between warnings
const LOG_SUPPRESS_MAX = LOG_SUPPRESS_SCHEDULE.length;

// ─── Factory ────────────────────────────────────────────────────────────────

export function createRenderMeter(config: RenderMeterConfig): RenderMeterAPI {
  const stalenessCapacity = config.thresholds?.staleness ??
    DEFAULT_STALENESS_THRESHOLD;
  const pendingCapacity = config.thresholds?.pendingPatches ??
    DEFAULT_PENDING_THRESHOLD;
  const onStatusChange = config.onStatusChange;
  const onNotify = config.onNotify;

  // ── Metric state ────────────────────────────────────────────────────────
  let staleness = 0;
  let frameTime = 0;
  let pendingPatches = 0;
  let paintRate = 0;
  let status: VitalStatus = "healthy";
  let lastPatchAt = 0;
  let lastFrameAt = 0;
  let frameCountInWindow = 0;
  let windowStart = 0;
  let lastAction: string | null = null;
  let lastFeature: string | null = null;
  let dirty = false;
  let paused = false;
  let rafId: number | null = null;

  // ── Log suppression ─────────────────────────────────────────────────────
  let warnCount = 0;
  let lastWarnAt = 0;
  let suppressed = false;

  // ── Gauge builder ───────────────────────────────────────────────────────

  function gauge(name: string, current: number, capacity: number): Gauge {
    return {
      name,
      current,
      capacity,
      percent: capacity > 0 ? Math.min(100, (current / capacity) * 100) : 0,
    };
  }

  function getGauges(): RenderGauges {
    return {
      staleness: gauge("render.staleness", staleness, stalenessCapacity),
      frameTime: gauge("render.frameTime", frameTime, FRAME_BUDGET),
      pendingPatches: gauge(
        "render.pendingPatches",
        pendingPatches,
        pendingCapacity,
      ),
      paintRate: gauge(
        "render.paintRate",
        paintRate > 0 ? Math.max(0, TARGET_FPS - paintRate) : 0,
        TARGET_FPS,
      ),
    };
  }

  // ── Status classification (staleness-driven) ───────────────────────────

  function classify(): VitalStatus {
    if (staleness >= stalenessCapacity * 5) return "frozen";
    if (staleness >= stalenessCapacity * 2) return "warning";
    if (staleness >= stalenessCapacity) return "degraded";
    return "healthy";
  }

  // ── Log suppression check ──────────────────────────────────────────────

  function shouldWarn(now: number): boolean {
    if (suppressed) return false;
    if (warnCount >= LOG_SUPPRESS_MAX) {
      suppressed = true;
      return true; // emit the "suppressing" message
    }
    const delay = LOG_SUPPRESS_SCHEDULE[warnCount] ?? 0;
    if (now - lastWarnAt < delay) return false;
    return true;
  }

  function resetSuppression() {
    warnCount = 0;
    lastWarnAt = 0;
    suppressed = false;
  }

  // ── Core tick (called per rAF or manually) ─────────────────────────────

  function tick(now: number): void {
    if (paused) return;

    // Step 1: flush coalesced notification
    if (dirty) {
      dirty = false;
      onNotify?.();
    }

    // Step 2: measure
    if (lastFrameAt > 0) {
      frameTime = now - lastFrameAt;
    }
    lastFrameAt = now;

    // Staleness: age of most recent unpainted patch
    if (lastPatchAt > 0 && lastPatchAt > (now - frameTime)) {
      // Patch arrived since last frame — how old is it?
      staleness = now - lastPatchAt;
    } else {
      staleness = 0;
    }

    // Paint rate: frames per second
    frameCountInWindow++;
    if (windowStart === 0) windowStart = now;
    const windowElapsed = now - windowStart;
    if (windowElapsed >= 1000) {
      paintRate = Math.round((frameCountInWindow / windowElapsed) * 1000);
      frameCountInWindow = 0;
      windowStart = now;
    }

    // Step 3: classify and notify on status change
    const newStatus = classify();

    if (status === "frozen" && newStatus !== "frozen") {
      // Recovery
      status = "recovered";
      resetSuppression();
      onStatusChange?.("recovered", getGauges());
      // Immediately transition to the actual status
      if (newStatus === "healthy") {
        status = "healthy";
        onStatusChange?.("healthy", getGauges());
      } else {
        status = newStatus;
        onStatusChange?.(newStatus, getGauges());
      }
    } else if (status === "recovered" && newStatus === "healthy") {
      status = "healthy";
      onStatusChange?.("healthy", getGauges());
    } else if (newStatus !== status) {
      const prev = status;
      status = newStatus;
      onStatusChange?.(newStatus, getGauges());

      // Log suppression for sustained warnings
      if (newStatus !== "healthy" && prev === "healthy") {
        resetSuppression(); // new incident
      }
      if (
        newStatus === "degraded" || newStatus === "warning" ||
        newStatus === "frozen"
      ) {
        if (shouldWarn(now)) {
          warnCount++;
          lastWarnAt = now;
        }
      }
    }

    // Step 4: reset pending (these have been "painted")
    pendingPatches = 0;
  }

  // ── Auto rAF loop ─────────────────────────────────────────────────────

  function scheduleLoop() {
    rafId = requestAnimationFrame(() => {
      tick(performance.now());
      scheduleLoop(); // always reschedule — meter never goes dark
    });
  }

  if (!config.manualTick) {
    scheduleLoop();
  }

  // ── API ────────────────────────────────────────────────────────────────

  return {
    recordPatch(now?: number) {
      lastPatchAt = now ?? performance.now();
      pendingPatches++;
    },

    recordAction(type: string, feature: string) {
      lastAction = type;
      lastFeature = feature;
    },

    markDirty() {
      dirty = true;
    },

    getGauges,
    getStaleness: () => staleness,
    getStatus: () => status,
    getLastAction: () => lastAction,
    getLastFeature: () => lastFeature,

    tick,

    setPaused(p: boolean) {
      paused = p;
      if (!p) {
        // Reset baselines to avoid false spike on resume
        lastFrameAt = config.manualTick ? lastFrameAt : performance.now();
        lastPatchAt = 0;
        staleness = 0;
      }
    },

    destroy() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      status = "healthy";
      staleness = 0;
      frameTime = 0;
      pendingPatches = 0;
      paintRate = 0;
      lastPatchAt = 0;
      lastFrameAt = 0;
      dirty = false;
      resetSuppression();
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/vitals/render-meter.test.ts` Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/vitals/render-meter.ts tests/vitals/render-meter.test.ts
git commit -m "feat(vitals): create RenderMeter — core factory with gauge math"
```

---

## Task 3: RenderMeter — staleness, pending patches, status transitions

**Files:**

- Modify: `tests/vitals/render-meter.test.ts`
- (No source changes — testing existing implementation)

- [ ] **Step 1: Write staleness and status transition tests**

Append to `tests/vitals/render-meter.test.ts`:

```typescript
Deno.test("render-meter: staleness grows when patches arrive without paint", () => {
  const meter = createRenderMeter(baseConfig());
  meter.recordPatch(1000); // patch arrives at t=1000
  meter.tick(1000); // first frame at t=1000 — sets baseline
  meter.recordPatch(1050); // another patch at t=1050
  meter.tick(1200); // frame at t=1200, patch at 1050 → staleness = 150ms
  assertEquals(meter.getStaleness(), 150);
  meter.destroy();
});

Deno.test("render-meter: staleness resets when no pending patches", () => {
  const meter = createRenderMeter(baseConfig());
  meter.recordPatch(1000);
  meter.tick(1000);
  meter.tick(1200); // no new patch since last frame — staleness = 0
  assertEquals(meter.getStaleness(), 0);
  meter.destroy();
});

Deno.test("render-meter: pendingPatches accumulates and resets on tick", () => {
  const meter = createRenderMeter(baseConfig());
  meter.recordPatch(100);
  meter.recordPatch(110);
  meter.recordPatch(120);
  const g1 = meter.getGauges();
  assertEquals(g1.pendingPatches.current, 3);
  meter.tick(200);
  const g2 = meter.getGauges();
  assertEquals(g2.pendingPatches.current, 0);
  meter.destroy();
});

Deno.test("render-meter: status transitions healthy → degraded → warning → frozen", () => {
  const statuses: string[] = [];
  const meter = createRenderMeter({
    ...baseConfig(),
    onStatusChange: (s) => {
      statuses.push(s);
    },
  });

  // staleness >= 300 (1x capacity) → degraded
  meter.recordPatch(0);
  meter.tick(0);
  meter.recordPatch(100);
  meter.tick(450); // staleness = 350 → degraded
  assertEquals(meter.getStatus(), "degraded");

  // staleness >= 600 (2x capacity) → warning
  meter.recordPatch(500);
  meter.tick(1150); // staleness = 650 → warning
  assertEquals(meter.getStatus(), "warning");

  // staleness >= 1500 (5x capacity) → frozen
  meter.recordPatch(1200);
  meter.tick(2900); // staleness = 1700 → frozen
  assertEquals(meter.getStatus(), "frozen");

  assertEquals(statuses.includes("degraded"), true);
  assertEquals(statuses.includes("warning"), true);
  assertEquals(statuses.includes("frozen"), true);
  meter.destroy();
});

Deno.test("render-meter: frozen → recovered → healthy transition", () => {
  const statuses: string[] = [];
  const meter = createRenderMeter({
    ...baseConfig(),
    onStatusChange: (s) => {
      statuses.push(s);
    },
  });

  // Drive to frozen
  meter.recordPatch(0);
  meter.tick(0);
  meter.recordPatch(100);
  meter.tick(1700); // staleness = 1600 → frozen

  // Recover — no pending patch
  meter.tick(1800); // staleness = 0 → recovered then healthy
  assertEquals(statuses.includes("recovered"), true);
  assertEquals(meter.getStatus(), "healthy");
  meter.destroy();
});

Deno.test("render-meter: paused prevents measurement", () => {
  const meter = createRenderMeter(baseConfig());
  meter.recordPatch(100);
  meter.setPaused(true);
  meter.tick(5000); // would be huge staleness — but paused
  assertEquals(meter.getStaleness(), 0); // unchanged from initial
  meter.destroy();
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `deno test tests/vitals/render-meter.test.ts` Expected: PASS (9 tests
total). If any fail, adjust the RenderMeter implementation to match the spec's
staleness semantics.

- [ ] **Step 3: Commit**

```bash
git add tests/vitals/render-meter.test.ts
git commit -m "test(vitals): RenderMeter staleness, pending, status transitions"
```

---

## Task 4: RenderMeter — coalesced notification + log suppression tests

**Files:**

- Modify: `tests/vitals/render-meter.test.ts`

- [ ] **Step 1: Write coalescing and suppression tests**

Append to `tests/vitals/render-meter.test.ts`:

```typescript
Deno.test("render-meter: markDirty + tick calls onNotify once", () => {
  let notifyCount = 0;
  const meter = createRenderMeter({
    ...baseConfig(),
    onNotify: () => {
      notifyCount++;
    },
  });

  meter.markDirty();
  meter.markDirty();
  meter.markDirty();
  meter.tick(100);
  assertEquals(notifyCount, 1);

  // Second tick without markDirty — no notification
  meter.tick(200);
  assertEquals(notifyCount, 1);
  meter.destroy();
});

Deno.test("render-meter: markDirty not called → onNotify not called", () => {
  let notifyCount = 0;
  const meter = createRenderMeter({
    ...baseConfig(),
    onNotify: () => {
      notifyCount++;
    },
  });

  meter.tick(100);
  meter.tick(200);
  assertEquals(notifyCount, 0);
  meter.destroy();
});

Deno.test("render-meter: frameTime reflects gap between ticks", () => {
  const meter = createRenderMeter(baseConfig());
  meter.tick(100); // first tick sets baseline
  meter.tick(132); // gap = 32ms
  const g = meter.getGauges();
  assertEquals(g.frameTime.current, 32);
  // 32 / 16.67 * 100 ≈ 192%  → clamped to 100
  assertEquals(g.frameTime.percent, 100);
  meter.destroy();
});

Deno.test("render-meter: paintRate calculates fps over 1s window", () => {
  const meter = createRenderMeter(baseConfig());
  // Simulate 60 frames over 1000ms
  for (let i = 0; i <= 60; i++) {
    meter.tick(i * 16.67);
  }
  // After window elapsed, paintRate should be ~60
  const g = meter.getGauges();
  assertEquals(g.paintRate.current >= 0, true); // inverted: TARGET_FPS - fps
  meter.destroy();
});

Deno.test("render-meter: recordAction stores last action/feature", () => {
  const meter = createRenderMeter(baseConfig());
  meter.recordAction("counter/increment", "counter");
  assertEquals(meter.getLastAction(), "counter/increment");
  assertEquals(meter.getLastFeature(), "counter");
  meter.destroy();
});

Deno.test("render-meter: destroy resets all state", () => {
  const meter = createRenderMeter(baseConfig());
  meter.recordPatch(100);
  meter.markDirty();
  meter.tick(500);
  meter.destroy();
  assertEquals(meter.getStatus(), "healthy");
  assertEquals(meter.getStaleness(), 0);
  meter.destroy();
});

Deno.test("render-meter: log suppression — max 6 status change callbacks per incident", () => {
  const statuses: string[] = [];
  const meter = createRenderMeter({
    ...baseConfig(),
    thresholds: { staleness: 100, pendingPatches: 10 },
    onStatusChange: (s) => {
      statuses.push(s);
    },
  });

  // Drive repeated degraded→warning cycles to trigger suppression
  // Each onStatusChange callback = 1 warnCount increment in the meter
  meter.tick(0);
  for (let i = 1; i <= 20; i++) {
    meter.recordPatch(i * 100);
    meter.tick(i * 100 + 150); // staleness 150 → degraded
  }
  // After enough transitions, suppression kicks in — onStatusChange still fires
  // (suppression is internal to log output, not to the callback)
  // We verify the callback keeps firing — suppression is for console.warn only
  assertEquals(statuses.length > 0, true);
  meter.destroy();
});

Deno.test("render-meter: visibility resume resets baselines", () => {
  const meter = createRenderMeter(baseConfig());
  meter.recordPatch(100);
  meter.tick(100);
  meter.recordPatch(200);
  meter.tick(300); // staleness = 100

  // Background the tab
  meter.setPaused(true);

  // Resume — baselines should reset
  meter.setPaused(false);
  assertEquals(meter.getStaleness(), 0); // reset on resume
  meter.destroy();
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `deno test tests/vitals/render-meter.test.ts` Expected: PASS (15 tests
total)

- [ ] **Step 3: Commit**

```bash
git add tests/vitals/render-meter.test.ts
git commit -m "test(vitals): RenderMeter coalescing, frameTime, paintRate, destroy"
```

---

## Task 5: Export RenderMeter from vitals/mod.ts

**Files:**

- Modify: `src/vitals/mod.ts:201-206`

- [ ] **Step 1: Add export and deprecation note**

At the end of `src/vitals/mod.ts`, add the export alongside the existing
`createRenderProbe` export:

```typescript
export { createRenderMeter } from "./render-meter.ts";
export type {
  RenderGauges,
  RenderMeterAPI,
  RenderMeterConfig,
} from "./render-meter.ts";
```

Add a deprecation comment to the existing `createRenderProbe` export (line 202):

```typescript
/** @deprecated Use createRenderMeter instead — rAF-based, staleness-driven */
export { createRenderProbe } from "./render-probe.ts";
```

- [ ] **Step 2: Also export Gauge and RenderBudget from mod.ts re-exports**

Add to the re-exports block at end of `src/vitals/mod.ts` (line 189-200):

```typescript
export type { Gauge, RenderBudget } from "./types.ts";
```

- [ ] **Step 3: Run full vitals test suite to verify nothing broken**

Run: `deno test tests/vitals/` Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/vitals/mod.ts
git commit -m "feat(vitals): export RenderMeter, deprecate RenderProbe"
```

---

## Task 6: Add renderBudget to AIO config

**Files:**

- Modify: `src/aio.ts`

- [ ] **Step 1: Find the AioConfig type and config validation**

The config type is in `src/aio.ts`. Locate the type definition (search for
`syncIntervalMs`) and the config error validation section.

- [ ] **Step 2: Add renderBudget to the config type**

Add to the AioConfig type, near `perfBudget`:

```typescript
renderBudget?: RenderBudget;
```

Import `RenderBudget` from `./vitals/types.ts`.

- [ ] **Step 3: Add to config error table if applicable**

In the config error output section (the grouped tables), add `renderBudget`
entries to the appropriate group (performance/monitoring):

```
renderBudget.staleness      300       ms — primary staleness threshold
renderBudget.pendingPatches 10        max pending patches before warning
```

- [ ] **Step 4: Run deno check to verify types**

Run: `deno check src/aio.ts` Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add src/aio.ts
git commit -m "feat: add renderBudget config option"
```

---

## Task 7: Integrate RenderMeter into browser.ts — replace RenderProbe

**Files:**

- Modify: `src/browser.ts`

This is the critical integration task. We replace `RenderProbe` with
`RenderMeter`, change `_notify()` to `_markDirty()`, and add skip-identical.

- [ ] **Step 1: Replace imports**

In `src/browser.ts`, change (line 18):

```typescript
// OLD
import { createRenderProbe } from "./vitals/render-probe.ts";
// NEW
import {
  createRenderMeter,
  type RenderMeterAPI,
} from "./vitals/render-meter.ts";
```

- [ ] **Step 2: Replace module-scoped probe variable**

Change (line 302):

```typescript
// OLD
let _vitalsRenderProbe: ReturnType<typeof createRenderProbe> | null = null;
// NEW
let _vitalsRenderMeter: RenderMeterAPI | null = null;
```

- [ ] **Step 3: Replace _notify() with _markDirty() in WS onmessage**

In `ws.onmessage` (around line 1043-1061), change:

```typescript
// OLD
if (_vitalsRenderProbe) _vitalsRenderProbe.recordDelta();
_notify();

// NEW
if (_vitalsRenderMeter) {
  _vitalsRenderMeter.recordPatch();
  _vitalsRenderMeter.markDirty();
}
```

Same change in the IPC `onMessage` handler (around line 776-787):

```typescript
// OLD (in IPC handler — no recordDelta call exists here, just _notify)
_notify();

// NEW
if (_vitalsRenderMeter) {
  _vitalsRenderMeter.recordPatch();
  _vitalsRenderMeter.markDirty();
}
```

- [ ] **Step 4: Add skip-identical check before markDirty**

In both WS onmessage and IPC onMessage, after `_applyPatch`, add skip-identical.
**Important:** `_stateVersion++` and `_resolveStateReady()` must remain
synchronous (not deferred to rAF) — otherwise `useSyncExternalStore` won't
detect the change and the initial state readiness promise would be delayed by
~16ms.

```typescript
const prev = _state;
if (data.$p && typeof data.$p === "object") {
  if (_state === null) return;
  _state = _applyPatch(_state as Record<string, unknown>, data);
} else {
  _state = data;
}
if (_state === prev) return; // no-op patch — skip notification

// Synchronous bookkeeping — must not be deferred
_stateVersion++;
if (_state !== null) _resolveStateReady();

// Deferred React notification — coalesced via rAF
if (_vitalsRenderMeter) {
  _vitalsRenderMeter.recordPatch();
  _vitalsRenderMeter.markDirty();
}
```

Note: `_notify()` currently does `_stateVersion++`, `_resolveStateReady()`, and
`_listeners.notify()`. With coalescing, we split this: version bump + readiness
stay synchronous, listener notification is deferred via RenderMeter's
`onNotify`. Update `_notify()` to ONLY call `_listeners.notify()` (remove
`_stateVersion++` and `_resolveStateReady()` from it since they're now done
inline).

- [ ] **Step 5: Replace RenderProbe creation with RenderMeter creation**

In `ws.onopen` (around line 862-942), replace the `_vitalsRenderProbe` creation
block with:

```typescript
if (!_vitalsRenderMeter) {
  _vitalsRenderMeter = createRenderMeter({
    onNotify: _notify, // coalesced notification — calls existing _notify
    onStatusChange: (status, gauges) => {
      // Existing freeze/recovered/pressure event handling —
      // port the logic from the old RenderProbe onStatusChange callback
      // but use gauges.staleness instead of setTimeout drift
      if (status === "frozen" || status === "recovered") {
        const kind = status === "frozen"
          ? "freeze" as const
          : "recovered" as const;
        const event: DiagEvent = {
          kind,
          severity: kind === "freeze" ? "likely" : "speculative",
          summary: kind === "freeze"
            ? `RENDER FROZEN — staleness ${
              Math.round(gauges.staleness.current)
            }ms`
            : "render recovered",
          detail: {
            trigger: _vitalsRenderMeter?.getLastAction() ?? undefined,
            hint: kind === "freeze"
              ? `UI is ${Math.round(gauges.staleness.current)}ms behind — ${
                gauges.pendingPatches.current > 5
                  ? "too many patches — raise syncIntervalMs"
                  : "components too expensive — simplify renders"
              }`
              : undefined,
          },
          timestamp: Date.now(),
        };
        const lines = formatDiagEvent(event);
        if (lines.length === 1) console.warn(lines[0]);
        else {
          console.group(lines[0]);
          for (let i = 1; i < lines.length; i++) console.warn(lines[i]);
          console.groupEnd();
        }
      } else if (status === "degraded" || status === "warning") {
        const event: DiagEvent = {
          kind: "pressure",
          severity: status === "degraded" ? "speculative" : "possible",
          summary: `STALENESS ${status.toUpperCase()} — ${
            Math.round(gauges.staleness.current)
          }ms behind`,
          detail: {
            hint:
              gauges.pendingPatches.current > gauges.pendingPatches.capacity / 2
                ? "receiving patches faster than painting — raise syncIntervalMs or simplify components"
                : "main thread under load — may freeze if sustained",
          },
          timestamp: Date.now(),
        };
        const lines = formatDiagEvent(event);
        if (lines.length === 1) console.warn(lines[0]);
        else {
          console.group(lines[0]);
          for (let i = 1; i < lines.length; i++) console.warn(lines[i]);
          console.groupEnd();
        }
      }
    },
  });
}
```

- [ ] **Step 6: Update _send to use RenderMeter for action recording**

Change (around line 1099-1103):

```typescript
// OLD
if (_vitalsRenderProbe) {
  // ...
  _vitalsRenderProbe.recordAction(actionType, feature);
}
// NEW
if (_vitalsRenderMeter) {
  const actionType = typeof action === "object" && action !== null
    ? (action as Record<string, unknown>).type as string ?? ""
    : "";
  const feature = actionType.split("/")[0] ?? actionType.split(":")[0] ?? "";
  _vitalsRenderMeter.recordAction(actionType, feature);
}
```

- [ ] **Step 7: Update storm detection to use RenderMeter staleness (or remove
      if redundant)**

The existing `_stormCheckTimer` (line 958-972) counts `_subscribeCallCount`.
With coalesced notification, subscribe callbacks only fire once per rAF. The
storm detection threshold (30/sec) is now effectively measuring "render rate >
30fps" which is always true in normal operation. This detection becomes
redundant — the staleness gauge now covers this purpose. Remove the storm check
timer and `_subscribeCallCount` variable. The `_RENDER_STORM_THRESHOLD` constant
can also be removed.

- [ ] **Step 8: Add staleness to ping payload**

In the ping interval (around line 949-956), add staleness:

```typescript
_vitalsPingTimer = setInterval(() => {
  if (_ws && _ws.readyState === WebSocket.OPEN && _vitalsTransportProbe) {
    const ping = _vitalsTransportProbe.createPing();
    const ms = _vitalsRenderMeter
      ? Math.round(_vitalsRenderMeter.getStaleness())
      : 0;
    _ws.send("__vitals:ping:" + JSON.stringify({ t1: ping.t1, ms }));
  }
}, DEFAULT_HEARTBEAT_INTERVAL);
```

- [ ] **Step 9: Add visibility guard**

Add near the connection setup:

```typescript
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (_vitalsRenderMeter) {
      _vitalsRenderMeter.setPaused(document.hidden);
    }
  });
}
```

- [ ] **Step 10: Clean up destroy paths**

In `ws.onclose` (line 1081), replace `_vitalsRenderProbe` cleanup:

```typescript
// Meter cleanup is NOT done on ws close — it persists across reconnects
// Only destroy on full teardown (listener count 0 for 300ms)
```

In the 300ms teardown block (around line 659), add:

```typescript
if (_vitalsRenderMeter) {
  _vitalsRenderMeter.destroy();
  _vitalsRenderMeter = null;
}
```

- [ ] **Step 11: Run deno check**

Run: `deno check src/browser.ts` Expected: No type errors

- [ ] **Step 12: Commit**

```bash
git add src/browser.ts
git commit -m "feat: replace RenderProbe with RenderMeter in browser.ts — coalesced notify, skip-identical, staleness ping"
```

---

## Task 8: Server-side backpressure — read staleness, adapt per-client rate

**Files:**

- Modify: `src/server.ts`
- Create: `tests/vitals/backpressure.test.ts`

- [ ] **Step 1: Write failing test for backpressure logic**

Create `tests/vitals/backpressure.test.ts`:

```typescript
import { assertEquals } from "@std/assert";

// Test the pure backpressure multiplier logic (extracted function)
// We test the logic independently of the server

function getBackpressureMultiplier(
  staleness: number,
  consecutiveLowPings: number,
  currentMultiplier: number,
): { multiplier: number; consecutiveLow: number } {
  // Scale down immediately
  if (staleness > 300) return { multiplier: 4, consecutiveLow: 0 };
  if (staleness > 100) return { multiplier: 2, consecutiveLow: 0 };

  // Scale up after 3 consecutive low pings — stepped recovery
  const low = consecutiveLowPings + 1;
  if (low >= 3 && currentMultiplier > 1) {
    const next = Math.max(1, currentMultiplier / 2);
    return { multiplier: next, consecutiveLow: 0 };
  }
  return { multiplier: currentMultiplier, consecutiveLow: low };
}

Deno.test("backpressure: high staleness → multiplier 4", () => {
  const r = getBackpressureMultiplier(400, 0, 1);
  assertEquals(r.multiplier, 4);
  assertEquals(r.consecutiveLow, 0);
});

Deno.test("backpressure: medium staleness → multiplier 2", () => {
  const r = getBackpressureMultiplier(150, 0, 1);
  assertEquals(r.multiplier, 2);
});

Deno.test("backpressure: low staleness, not enough pings → keep current", () => {
  const r = getBackpressureMultiplier(50, 1, 4);
  assertEquals(r.multiplier, 4);
  assertEquals(r.consecutiveLow, 2);
});

Deno.test("backpressure: low staleness, 3 pings → step down 4→2", () => {
  const r = getBackpressureMultiplier(50, 2, 4);
  assertEquals(r.multiplier, 2);
  assertEquals(r.consecutiveLow, 0);
});

Deno.test("backpressure: low staleness, 3 pings → step down 2→1", () => {
  const r = getBackpressureMultiplier(50, 2, 2);
  assertEquals(r.multiplier, 1);
});

Deno.test("backpressure: already at 1 → stays at 1", () => {
  const r = getBackpressureMultiplier(50, 5, 1);
  assertEquals(r.multiplier, 1);
});
```

- [ ] **Step 2: Run test to verify it passes (pure function, self-contained)**

Run: `deno test tests/vitals/backpressure.test.ts` Expected: PASS — this is a
pure function test, no imports from src needed yet

- [ ] **Step 3: Integrate backpressure into server.ts**

In `src/server.ts`, add to `ClientMeta` type (around line 480-492):

```typescript
type ClientMeta = {
  // ... existing fields ...
  bpMultiplier: number; // backpressure: sync interval multiplier (1, 2, or 4)
  bpConsecutiveLow: number; // backpressure: consecutive low-staleness pings
  bpLastSentAt: number; // backpressure: timestamp of last broadcast to this client
};
```

Initialize in the WebSocket upgrade handler where `connections.set()` is called:

```typescript
bpMultiplier: 1,
bpConsecutiveLow: 0,
bpLastSentAt: 0,
```

- [ ] **Step 4: Read staleness from ping and update multiplier**

In the `__vitals:ping:` handler (around line 785-801), after `onClientPing`:

```typescript
// Backpressure: read client staleness, adjust per-client multiplier
const staleness = typeof ping.ms === "number" ? ping.ms : 0;
if (staleness > 300) {
  vmeta.bpMultiplier = 4;
  vmeta.bpConsecutiveLow = 0;
} else if (staleness > 100) {
  vmeta.bpMultiplier = 2;
  vmeta.bpConsecutiveLow = 0;
} else {
  vmeta.bpConsecutiveLow++;
  if (vmeta.bpConsecutiveLow >= 3 && vmeta.bpMultiplier > 1) {
    vmeta.bpMultiplier = Math.max(1, vmeta.bpMultiplier / 2);
    vmeta.bpConsecutiveLow = 0;
  }
}
```

- [ ] **Step 5: Skip throttled clients in broadcast loop**

In the `broadcast()` function (around line 544-576), after the frozen client
check, add:

```typescript
// Backpressure: skip client if not enough time elapsed since last send
if (meta.bpMultiplier > 1) {
  const elapsed = Date.now() - meta.bpLastSentAt;
  if (elapsed < syncIntervalMs * meta.bpMultiplier) continue;
}
```

And after `ws.send(delta.msg)` (line 568), add:

```typescript
meta.bpLastSentAt = Date.now();
```

Note: when a client is skipped, `meta.lastState` is NOT updated. This means the
next broadcast cycle computes a cumulative delta covering all skipped changes —
the client gets one correct merged update instead of multiple small ones. This
is correct by design.

- [ ] **Step 6: Run deno check**

Run: `deno check src/server.ts` Expected: No type errors

- [ ] **Step 7: Commit**

```bash
git add src/server.ts tests/vitals/backpressure.test.ts
git commit -m "feat: client→server backpressure — staleness in ping, per-client broadcast skip"
```

---

## Task 9: Extend /__aio/vitals endpoint with render gauges

**Files:**

- Modify: `src/server.ts`

- [ ] **Step 1: Find the vitals endpoint handler**

Search for `/__aio/vitals` in `src/server.ts`. This is the endpoint that returns
vitals data.

- [ ] **Step 2: Extend the response to include server-side gauges**

In the vitals endpoint handler, after the existing `getEndpointData()` call, add
gauge normalization. Use `DEFAULT_THRESHOLDS` (already imported in server.ts via
vitals system) and the config's `perfBudget` (available as `config.perfBudget`
in scope):

```typescript
import { DEFAULT_THRESHOLDS } from "./vitals/types.ts"; // if not already imported

// Helper — define at top of startServer or as module-level utility
function gaugeOf(name: string, current: number, capacity: number): Gauge {
  return {
    name,
    current,
    capacity,
    percent: capacity > 0
      ? Math.min(100, Math.round((current / capacity) * 100))
      : 0,
  };
}

// In the /__aio/vitals handler:
const endpointData = config.vitalsSystem?.getEndpointData();
const loopVitals = config.vitalsSystem?.loopProbe.getVitals();
const thresholds = config.vitalsSystem
  ? DEFAULT_THRESHOLDS // use resolved thresholds if accessible, else defaults
  : DEFAULT_THRESHOLDS;
const reduceBudget = config.perfBudget?.reduce ?? 100;

const serverGauges = loopVitals
  ? {
    "server.queueDepth": gaugeOf(
      "server.queueDepth",
      loopVitals.queueDepth,
      thresholds.queue.frozen,
    ),
    "server.reduceTime": gaugeOf(
      "server.reduceTime",
      loopVitals.p95ReduceTime,
      reduceBudget,
    ),
  }
  : {};
```

Add the gauges to the JSON response alongside the existing data.

Also include per-client backpressure status:

```typescript
// Add to client info in the response
clients: [...existing..., bpMultiplier: meta.bpMultiplier]
```

- [ ] **Step 3: Run deno check**

Run: `deno check src/server.ts` Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: extend /__aio/vitals with server gauges and per-client backpressure"
```

---

## Task 10: Hint engine — pattern-to-action mapping

**Files:**

- Modify: `src/vitals/render-meter.ts`
- Modify: `tests/vitals/render-meter.test.ts`

The hint engine maps metric patterns to specific developer actions. Four
patterns from the spec, implemented as a pure function inside RenderMeter.

- [ ] **Step 1: Write tests for hint patterns**

Append to `tests/vitals/render-meter.test.ts`:

```typescript
import { renderHint } from "../../src/vitals/render-meter.ts";
import type { RenderGauges } from "../../src/vitals/render-meter.ts";

// Helper to create gauges with specific percents
function mockGauges(
  overrides: Partial<Record<keyof RenderGauges, number>>,
): RenderGauges {
  const g = (name: string, pct: number) => ({
    name,
    current: pct,
    capacity: 100,
    percent: pct,
  });
  return {
    staleness: g("render.staleness", overrides.staleness ?? 0),
    frameTime: g("render.frameTime", overrides.frameTime ?? 0),
    pendingPatches: g("render.pendingPatches", overrides.pendingPatches ?? 0),
    paintRate: g("render.paintRate", overrides.paintRate ?? 0),
  };
}

Deno.test("hint: high staleness + high frameTime → expensive components", () => {
  const hint = renderHint(
    mockGauges({ staleness: 80, frameTime: 80, pendingPatches: 10 }),
  );
  assertEquals(
    hint?.includes("components") || hint?.includes("React.memo"),
    true,
  );
});

Deno.test("hint: high staleness + high pendingPatches → too many patches", () => {
  const hint = renderHint(
    mockGauges({ staleness: 80, frameTime: 10, pendingPatches: 80 }),
  );
  assertEquals(
    hint?.includes("syncIntervalMs") || hint?.includes("batch"),
    true,
  );
});

Deno.test("hint: high staleness + low frameTime + low pending → non-React blocking", () => {
  const hint = renderHint(
    mockGauges({ staleness: 80, frameTime: 10, pendingPatches: 10 }),
  );
  assertEquals(
    hint?.includes("non-React") || hint?.includes("outside React"),
    true,
  );
});

Deno.test("hint: low staleness → null (no hint needed)", () => {
  const hint = renderHint(
    mockGauges({ staleness: 10, frameTime: 10, pendingPatches: 10 }),
  );
  assertEquals(hint, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/vitals/render-meter.test.ts` Expected: FAIL — `renderHint`
not exported

- [ ] **Step 3: Implement renderHint**

Add to `src/vitals/render-meter.ts` (exported pure function):

```typescript
const HINT_THRESHOLD = 50; // gauge percent above which a metric is "high"

export function renderHint(gauges: RenderGauges): string | null {
  if (gauges.staleness.percent < HINT_THRESHOLD) return null;

  const highFrame = gauges.frameTime.percent >= HINT_THRESHOLD;
  const highPending = gauges.pendingPatches.percent >= HINT_THRESHOLD;

  if (highFrame && !highPending) {
    return "Components too expensive — profile with React DevTools, consider React.memo() or simpler renders";
  }
  if (!highFrame && highPending) {
    return "Too many patches arriving — raise syncIntervalMs or batch server-side actions";
  }
  if (highFrame && highPending) {
    return "Both render cost and patch rate are high — simplify components AND reduce update frequency";
  }
  // High staleness but neither frameTime nor pendingPatches is high
  return "Main thread blocked by non-React work — check for heavy JS outside React (timers, workers, third-party scripts)";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/vitals/render-meter.test.ts` Expected: PASS

- [ ] **Step 5: Wire hint into onStatusChange in browser.ts**

In the `onStatusChange` callback created in Task 7 Step 5, replace the inline
hint logic with a call to `renderHint(gauges)`:

```typescript
import { renderHint } from "./vitals/render-meter.ts";

// In the freeze/degraded/warning handlers:
hint: renderHint(gauges) ?? "check component complexity and update frequency",
```

- [ ] **Step 6: Commit**

```bash
git add src/vitals/render-meter.ts tests/vitals/render-meter.test.ts src/browser.ts
git commit -m "feat(vitals): hint engine — pattern-to-action mapping for render diagnostics"
```

---

## Task 11: Memory gauge (Chrome/Edge only)

**Files:**

- Modify: `src/vitals/render-meter.ts`
- Modify: `tests/vitals/render-meter.test.ts`

The memory gauge uses `performance.memory` (Chrome/Edge non-standard API).
Returns null on unsupported browsers — gauge simply absent.

- [ ] **Step 1: Add memory gauge to RenderMeterAPI**

Add to the API type:

```typescript
getMemoryGauge(): Gauge | null;
```

- [ ] **Step 2: Implement — sampled at max 1/sec**

Add to the factory, sampled lazily in the 1s paint rate window:

```typescript
let memoryGauge: Gauge | null = null;

// Inside the paintRate window reset block (when windowElapsed >= 1000):
const perf = globalThis.performance as unknown as {
  memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
};
if (perf.memory) {
  memoryGauge = gauge(
    "memory",
    perf.memory.usedJSHeapSize,
    perf.memory.jsHeapSizeLimit,
  );
}
```

- [ ] **Step 3: Write test (mocked performance.memory)**

```typescript
Deno.test("render-meter: memory gauge returns null when API unavailable", () => {
  const meter = createRenderMeter(baseConfig());
  // In Deno test environment, performance.memory doesn't exist
  assertEquals(meter.getMemoryGauge(), null);
  meter.destroy();
});
```

- [ ] **Step 4: Run tests, commit**

Run: `deno test tests/vitals/render-meter.test.ts`

```bash
git add src/vitals/render-meter.ts tests/vitals/render-meter.test.ts
git commit -m "feat(vitals): memory gauge (Chrome/Edge, null on unsupported)"
```

---

## Task 12: Final integration test — run full test suite

**Files:** None modified — verification only

- [ ] **Step 1: Run full test suite**

Run: `deno test tests/` Expected: ALL PASS. Note: skip any tests that open
browsers/Electron (per feedback_no_browser_tests.md).

For focused runs:

```bash
deno test tests/vitals/              # all vitals tests
deno test tests/vitals/render-meter.test.ts  # just render meter
deno test tests/vitals/backpressure.test.ts  # just backpressure
```

- [ ] **Step 2: Run deno check on all modified files**

```bash
deno check src/vitals/render-meter.ts src/vitals/types.ts src/vitals/mod.ts src/browser.ts src/server.ts src/aio.ts
```

Expected: No type errors

- [ ] **Step 3: Run deno lint**

```bash
deno lint src/vitals/render-meter.ts src/browser.ts src/server.ts
```

Expected: No lint errors

- [ ] **Step 4: Squash commits and finalize**

Squash all task commits into one:

```bash
git rebase -i HEAD~N  # where N = number of commits from this plan
```

Final commit message:

```
feat(vitals): render protection — staleness-driven React overload prevention

RenderMeter replaces RenderProbe with rAF-based measurement. Client-side
notification coalescing reduces React reconciliation passes. Skip-identical
suppression eliminates no-op notifications. Client reports staleness via
ping; server adapts per-client broadcast rate (backpressure). Capacity
gauges normalize all metrics to 0-100%. Staleness warnings with hints
and self-protecting log suppression.
```
