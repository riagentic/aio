# PressureMonitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add resource pressure warnings that fire before things break — payload
size, broadcast rate, and client render degradation.

**Architecture:** Server-side `PressureMonitor` factory (payload + rate checks)
created inside `createVitalsSystem`. Client-side render pressure handled inline
in `browser.ts` `onStatusChange`. Both emit `DiagEvent` with new `"pressure"`
kind via console + `onDiagnostic` hook.

**Tech Stack:** TypeScript, Deno 2.6+, AIO vitals system

**Spec:** `docs/superpowers/specs/2026-03-24-pressure-monitor-design.md`

---

### Task 1: Add `"pressure"` to DiagEvent kind union and `pressure` config to VitalsConfig

**Files:**

- Modify: `src/vitals/types.ts:67` (DiagEvent kind union)
- Modify: `src/vitals/types.ts:141-148` (VitalsConfig)

- [ ] **Step 1: Add `"pressure"` to DiagEvent kind union**

In `src/vitals/types.ts` line 67, change:

```ts
kind: "freeze" | "stale" | "slow" | "disconnect" | "recovered";
```

to:

```ts
kind: "freeze" | "stale" | "slow" | "disconnect" | "recovered" | "pressure";
```

- [ ] **Step 2: Add `pressure` config to VitalsConfig**

In `src/vitals/types.ts` after line 145 (`backpressure?: boolean;`), add:

```ts
pressure?: boolean | { payloadThreshold?: number; rateThreshold?: number };
```

- [ ] **Step 3: Run type check**

Run: `deno check src/vitals/types.ts` Expected: PASS (no consumers break —
`"pressure"` widens the union)

- [ ] **Step 4: Commit**

```bash
git add src/vitals/types.ts
git commit -m "feat(vitals): add pressure kind to DiagEvent and pressure config to VitalsConfig"
```

---

### Task 2: Create PressureMonitor with tests (TDD)

**Files:**

- Create: `tests/vitals/pressure-monitor.test.ts`
- Create: `src/vitals/pressure-monitor.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/vitals/pressure-monitor.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { createPressureMonitor } from "../../src/vitals/pressure-monitor.ts";
import type { DiagEvent } from "../../src/vitals/types.ts";

Deno.test("pressure: payload over threshold emits pressure event", () => {
  const events: DiagEvent[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 100,
    rateThreshold: 30,
    onDiagnostic: (e) => events.push(e),
  });
  pm.onBroadcast("client-1", 150);
  assertEquals(events.length, 1);
  assertEquals(events[0]!.kind, "pressure");
  assertEquals(events[0]!.detail.payloadBytes, 150);
  assertEquals(events[0]!.detail.trigger, "client-1");
  assertEquals(events[0]!.severity, "possible");
  pm.destroy();
});

Deno.test("pressure: payload under threshold emits nothing", () => {
  const events: DiagEvent[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 100,
    rateThreshold: 30,
    onDiagnostic: (e) => events.push(e),
  });
  pm.onBroadcast("client-1", 50);
  assertEquals(events.length, 0);
  pm.destroy();
});

Deno.test("pressure: rate over threshold emits pressure event", async () => {
  const events: DiagEvent[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 512_000,
    rateThreshold: 5, // low threshold for test
    onDiagnostic: (e) => events.push(e),
  });
  // Send 10 broadcasts (over threshold of 5)
  for (let i = 0; i < 10; i++) pm.onBroadcast("c1", 100);
  // Wait for tumbling window check (1s interval)
  await new Promise((r) => setTimeout(r, 1100));
  const rateEvents = events.filter(
    (e) => e.summary.includes("broadcasts/sec"),
  );
  assertEquals(rateEvents.length, 1);
  assertEquals(rateEvents[0]!.kind, "pressure");
  assertEquals(rateEvents[0]!.severity, "possible");
  pm.destroy();
});

Deno.test("pressure: rate under threshold emits nothing", async () => {
  const events: DiagEvent[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 512_000,
    rateThreshold: 50,
    onDiagnostic: (e) => events.push(e),
  });
  pm.onBroadcast("c1", 100);
  pm.onBroadcast("c1", 100);
  await new Promise((r) => setTimeout(r, 1100));
  const rateEvents = events.filter(
    (e) => e.summary.includes("broadcasts/sec"),
  );
  assertEquals(rateEvents.length, 0);
  pm.destroy();
});

Deno.test("pressure: console throttling suppresses repeated warnings", () => {
  const events: DiagEvent[] = [];
  const consoleLogs: string[][] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 100,
    rateThreshold: 30,
    onDiagnostic: (e) => events.push(e),
    onConsole: (lines) => consoleLogs.push(lines),
  });
  pm.onBroadcast("c1", 200);
  pm.onBroadcast("c1", 200);
  pm.onBroadcast("c1", 200);
  // onDiagnostic fires every time
  assertEquals(events.length, 3);
  // Console throttled — only first fires (2s debounce)
  assertEquals(consoleLogs.length, 1);
  pm.destroy();
});

Deno.test("pressure: destroy clears rate timer", async () => {
  const events: DiagEvent[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 512_000,
    rateThreshold: 2,
    onDiagnostic: (e) => events.push(e),
  });
  for (let i = 0; i < 10; i++) pm.onBroadcast("c1", 100);
  pm.destroy();
  await new Promise((r) => setTimeout(r, 1100));
  // No rate event — timer was cleared
  const rateEvents = events.filter(
    (e) => e.summary.includes("broadcasts/sec"),
  );
  assertEquals(rateEvents.length, 0);
});

Deno.test("pressure: custom thresholds override defaults", () => {
  const events: DiagEvent[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 1_000_000, // 1MB
    rateThreshold: 100,
    onDiagnostic: (e) => events.push(e),
  });
  // 500KB — under 1MB threshold
  pm.onBroadcast("c1", 512_000);
  assertEquals(events.length, 0);
  // 1.1MB — over threshold
  pm.onBroadcast("c1", 1_100_000);
  assertEquals(events.length, 1);
  pm.destroy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/vitals/pressure-monitor.test.ts --no-check` Expected: FAIL
— module `pressure-monitor.ts` does not exist

- [ ] **Step 3: Implement PressureMonitor**

Create `src/vitals/pressure-monitor.ts`:

```ts
// ─── Vital Signs — Pressure Monitor ────────────────────────────────────────
// Detects when resources approach limits. Emits DiagEvent with kind "pressure".
// Server-side only: payload size + broadcast rate.

import type { DiagEvent } from "./types.ts";
import { formatDiagEvent } from "./diag-formatter.ts";

const THROTTLE_MS = 2000;
const DEFAULT_PAYLOAD_THRESHOLD = 512_000; // 500KB
const DEFAULT_RATE_THRESHOLD = 30; // broadcasts/sec

export type PressureMonitorConfig = {
  payloadThreshold?: number;
  rateThreshold?: number;
  onDiagnostic?: (event: DiagEvent) => void;
  onConsole?: (lines: string[]) => void;
};

export type PressureMonitorAPI = {
  onBroadcast(clientId: string, bytes: number): void;
  destroy(): void;
};

export function createPressureMonitor(
  config: PressureMonitorConfig,
): PressureMonitorAPI {
  const payloadThreshold = config.payloadThreshold ?? DEFAULT_PAYLOAD_THRESHOLD;
  const rateThreshold = config.rateThreshold ?? DEFAULT_RATE_THRESHOLD;
  const lastConsoleEmit = new Map<string, number>();

  let _broadcastCount = 0;

  const log = config.onConsole ?? ((lines: string[]) => {
    if (lines.length === 1) {
      console.warn(lines[0]);
    } else {
      console.group(lines[0]);
      for (let i = 1; i < lines.length; i++) console.warn(lines[i]);
      console.groupEnd();
    }
  });

  function emit(event: DiagEvent, throttleKey: string): void {
    config.onDiagnostic?.(event);

    const now = Date.now();
    const lastEmit = lastConsoleEmit.get(throttleKey) ?? 0;
    if (now - lastEmit >= THROTTLE_MS) {
      lastConsoleEmit.set(throttleKey, now);
      log(formatDiagEvent(event));
    }
  }

  function onBroadcast(clientId: string, bytes: number): void {
    _broadcastCount++;

    if (bytes >= payloadThreshold) {
      const kb = (bytes / 1024).toFixed(0);
      emit({
        kind: "pressure",
        severity: "possible",
        summary: `PRESSURE — broadcast payload ${kb}KB to client ${
          clientId.slice(0, 8)
        }`,
        detail: {
          payloadBytes: bytes,
          trigger: clientId,
          hint: "large state delta — check feature sizes at /__aio/vitals",
        },
        timestamp: Date.now(),
      }, `payload:${clientId}`);
    }
  }

  // Tumbling 1s window for rate detection
  const _rateTimer = setInterval(() => {
    if (_broadcastCount >= rateThreshold) {
      emit({
        kind: "pressure",
        severity: "possible",
        summary:
          `PRESSURE — ${_broadcastCount} broadcasts/sec (threshold: ${rateThreshold}/sec)`,
        detail: {
          drainRate: _broadcastCount,
          hint: "high dispatch frequency — debounce or batch actions",
        },
        timestamp: Date.now(),
      }, "rate");
    }
    _broadcastCount = 0;
  }, 1000);

  return {
    onBroadcast,
    destroy() {
      clearInterval(_rateTimer);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/vitals/pressure-monitor.test.ts --no-check` Expected: 7
passed, 0 failed

- [ ] **Step 5: Run type check**

Run: `deno check src/vitals/pressure-monitor.ts` Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/vitals/pressure-monitor.ts tests/vitals/pressure-monitor.test.ts
git commit -m "feat(vitals): PressureMonitor — payload + rate pressure detection with tests"
```

---

### Task 3: Wire PressureMonitor into VitalsSystem (mod.ts)

**Files:**

- Modify: `src/vitals/mod.ts:14` (imports)
- Modify: `src/vitals/mod.ts:23-32` (VitalsSystem type)
- Modify: `src/vitals/mod.ts:53-88` (createVitalsSystem factory)
- Modify: `src/vitals/mod.ts:166` (destroy)
- Modify: `src/vitals/mod.ts:170-187` (re-exports)

- [ ] **Step 1: Add import**

In `src/vitals/mod.ts` after line 14
(`import { createServerDiagReporter } from "./diag-reporter.ts";`), add:

```ts
import {
  createPressureMonitor,
  type PressureMonitorAPI,
} from "./pressure-monitor.ts";
```

- [ ] **Step 2: Add `pressureMonitor` to VitalsSystem type**

In `src/vitals/mod.ts` after line 30 (`computeFeatureSizes: ...`), add:

```ts
pressureMonitor: PressureMonitorAPI | null;
```

- [ ] **Step 3: Create PressureMonitor in factory**

In `src/vitals/mod.ts` after the `reporter` creation block (after line 88), add:

```ts
// Note: dev/prod gating is the caller's responsibility. The diagnostics layer
// in aio.ts resolves VitalsConfig per mode — prod config should set
// `pressure: false` to disable. Default (undefined) = enabled.
const pressureCfg = config.pressure;
const pressureMonitor = pressureCfg !== false
  ? createPressureMonitor({
    payloadThreshold: typeof pressureCfg === "object"
      ? pressureCfg.payloadThreshold
      : undefined,
    rateThreshold: typeof pressureCfg === "object"
      ? pressureCfg.rateThreshold
      : undefined,
    onDiagnostic: config.onDiagnostic,
  })
  : null;
```

- [ ] **Step 4: Expose on return object and wire destroy**

In the return block, add `pressureMonitor,` after `serverTransport,` (line 138).

Update `destroy` (line 166) to:

```ts
destroy: () => { loopProbe.reset(); serverTransport.destroy(); pressureMonitor?.destroy(); },
```

- [ ] **Step 5: Add re-exports**

After line 187, add:

```ts
export { createPressureMonitor } from "./pressure-monitor.ts";
export type {
  PressureMonitorAPI,
  PressureMonitorConfig,
} from "./pressure-monitor.ts";
```

- [ ] **Step 6: Run type check and existing tests**

Run: `deno check src/vitals/mod.ts && deno test tests/vitals/ --no-check`
Expected: Type check PASS, all vitals tests pass (78 existing + 7 new = 85)

- [ ] **Step 7: Commit**

```bash
git add src/vitals/mod.ts
git commit -m "feat(vitals): wire PressureMonitor into VitalsSystem"
```

---

### Task 4: Wire `onBroadcast` in server.ts

**Files:**

- Modify: `src/server.ts:573` (after payload stats update)

- [ ] **Step 1: Add onBroadcast call**

In `src/server.ts` after line 573 (the `_payloadStats.set(...)` line), add the
following line **inside the try block** (before the `} catch` on line 574):

```ts
config.vitalsSystem?.pressureMonitor?.onBroadcast(meta.id, _bytes);
```

- [ ] **Step 2: Run type check**

Run: `deno check src/server.ts` Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat(vitals): wire pressure monitor onBroadcast in server broadcast loop"
```

---

### Task 5: Wire client-side render pressure in browser.ts

**Files:**

- Modify: `src/browser.ts:863-865` (after freeze/recovered block in
  onStatusChange)

- [ ] **Step 1: Add render pressure handler**

In `src/browser.ts`, the `onStatusChange` callback currently has (lines
824-865):

```ts
if (status === "frozen" || status === "recovered") {
  // ... existing freeze/recovered handler
}
// blank line
},
```

After the closing `}` of the `if` block (line 863) and before the `},` (line
865), add:

```ts
          // Client-side render pressure: degraded/warning → "pressure" DiagEvent
          // Note: console-only on client side — no onDiagnostic hook available
          // (same pattern as existing freeze/recovered handler above).
          // Server-side PressureMonitor handles onDiagnostic for payload/rate.
          else if (status === "degraded" || status === "warning") {
            const detail: DiagEvent["detail"] = {};
            if (report) {
              detail.trigger = report.lastActionBefore ?? undefined;
              detail.frozenFor = report.frozenFor; // drift ms, not actual freeze
            }
            detail.hint = "main thread under load — may freeze if sustained";

            const event: DiagEvent = {
              kind: "pressure",
              severity: status === "degraded" ? "speculative" : "possible",
              summary: `PRESSURE — render ${status} (${Math.round(report?.frozenFor ?? 0)}ms drift)`,
              detail,
              timestamp: now,
            };

            const lines = formatDiagEvent(event);
            if (lines.length === 1) {
              console.warn(lines[0]);
            } else {
              console.group(lines[0]);
              for (let i = 1; i < lines.length; i++) console.warn(lines[i]);
              console.groupEnd();
            }
          }
```

- [ ] **Step 2: Run type check**

Run: `deno check src/browser.ts` Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/browser.ts
git commit -m "feat(vitals): client-side render pressure warnings for degraded/warning"
```

---

### Task 6: Update diag-formatter for pressure kind

**Files:**

- Modify: `src/vitals/diag-formatter.ts:51`

- [ ] **Step 1: Update frozenFor suppression check**

In `src/vitals/diag-formatter.ts` line 51, change:

```ts
if (detail.frozenFor !== undefined && kind !== "freeze") {
```

to:

```ts
if (detail.frozenFor !== undefined && kind !== "freeze" && kind !== "pressure") {
```

This prevents pressure events from showing "frozen for: 0.1s" when `frozenFor`
actually holds drift milliseconds (not a freeze duration).

- [ ] **Step 2: Run existing formatter tests**

Run: `deno test tests/vitals/diag-formatter.test.ts --no-check` Expected: All
pass (no behavior change for existing kinds)

- [ ] **Step 3: Commit**

```bash
git add src/vitals/diag-formatter.ts
git commit -m "fix(vitals): suppress misleading frozenFor display in pressure events"
```

---

### Task 7: Update documentation

**Files:**

- Modify: `docs/vitals.md`
- Modify: `docs/diagnostics.md`
- Modify: `docs/troubleshooting.md`
- Modify: `docs/changelog.md`

- [ ] **Step 1: Add PressureMonitor section to vitals.md**

After the "Re-render storm detection" section (~line 274), add:

````markdown
### Resource pressure warnings

Detects when resources approach limits before things break. Three sources:

| Source             | Where  | Default                     | What it warns           |
| ------------------ | ------ | --------------------------- | ----------------------- |
| Payload size       | Server | 500KB per broadcast         | Large state deltas      |
| Broadcast rate     | Server | 30/sec                      | High dispatch frequency |
| Render degradation | Client | 50ms drift (existing probe) | Main thread under load  |

Pressure events use kind `"pressure"` and fire via console + `onDiagnostic`.
Configure via `vitals.pressure`:

```ts
diagnostics: {
  dev: {
    vitals: {
      pressure: {
        payloadThreshold: 1_000_000,  // 1MB
        rateThreshold: 60,            // real-time data
      },
    },
  },
}
```
````

`pressure: false` disables. Default: on in dev, off in prod.

```
- [ ] **Step 2: Add to diagnostics.md default table**

In `docs/diagnostics.md`, add row to the "What's On By Default" table:
```

| Resource pressure (payload/rate) | on | off |

```
- [ ] **Step 3: Add to troubleshooting.md**

In `docs/troubleshooting.md`, update the decision tree to include pressure:
```

├─ "PRESSURE" warning? → §10 Pressure Warnings

````
Add new section §10:

```markdown
## §10 — Pressure Warnings

Early warnings before things break.

**Payload pressure:**
````

[aio:vitals] PRESSURE — broadcast payload 623KB to client abc12345 threshold:
500KB hint: large state delta — check feature sizes at /__aio/vitals

```
Fix: Reduce feature state size, improve delta compression, or raise threshold.

**Rate pressure:**
```

[aio:vitals] PRESSURE — 34 broadcasts/sec (threshold: 30/sec) hint: high
dispatch frequency — debounce or batch actions

```
Fix: Debounce rapid dispatches, batch related actions. Real-time apps: raise
`rateThreshold`.

**Render pressure:**
```

[aio:vitals] PRESSURE — render degraded (82ms drift, budget: 50ms) last action:
portfolio:refresh hint: main thread under load — may freeze if sustained

```
Fix: Check for heavy synchronous work. See §2 if it escalates to frozen.
```

- [ ] **Step 4: Add to changelog.md**

In `docs/changelog.md` under Unreleased, add after the DiagReporter section:

```markdown
**PressureMonitor — resource pressure warnings**

- Payload size warnings when broadcast exceeds 500KB (configurable)
- Broadcast rate warnings at 30/sec (configurable, tumbling 1s window)
- Client render degradation warnings (50ms/200ms drift — previously silent)
- New DiagEvent kind `"pressure"` — fires via console + `onDiagnostic` hook
- Server-side: `createPressureMonitor()` in vitals system
- Client-side: inline render pressure in `onStatusChange`
- Dev-only by default. Kill switch: `vitals: { pressure: false }`
```

- [ ] **Step 5: Commit**

```bash
git add docs/vitals.md docs/diagnostics.md docs/troubleshooting.md docs/changelog.md
git commit -m "docs: PressureMonitor — resource pressure warnings"
```

---

### Task 8: Run full test suite and lint

**Files:** None (verification only)

- [ ] **Step 1: Run all vitals tests**

Run: `deno test tests/vitals/ --no-check` Expected: 85 passed (78 existing + 7
new), 0 failed

- [ ] **Step 2: Run type check on all modified files**

Run:
`deno check src/vitals/mod.ts src/vitals/pressure-monitor.ts src/server.ts src/browser.ts src/vitals/diag-formatter.ts`
Expected: PASS

- [ ] **Step 3: Run lint**

Run: `deno lint src/vitals/ src/server.ts src/browser.ts` Expected: PASS
