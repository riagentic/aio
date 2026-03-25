# Vitals DiagReporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface actionable diagnostics to developers when UI freezes, shows
stale data, or dispatches slowly.

**Architecture:** Split DiagReporter (server + client halves) correlates probe
data into `DiagEvent`s, formatted by a pure formatter, output to console with
throttling. `onDiagnostic` hook for app telemetry. Plus: `_applyPatch` reference
stability, `useAio()` dev warning, re-render storm detection, broadcast payload
tracking.

**Tech Stack:** TypeScript, Deno 2.6+, AIO framework internals

**Spec:** `docs/superpowers/specs/2026-03-24-vitals-diag-reporter-design.md`

---

## File Structure

| File                                  | Responsibility                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/vitals/types.ts`                 | **Modify** — add `DiagEvent`, `DiagEventDetail` types                                            |
| `src/vitals/diag-formatter.ts`        | **NEW** — pure `formatDiagEvent()` function                                                      |
| `src/vitals/diag-reporter.ts`         | **NEW** — `createServerDiagReporter()`, `createClientDiagReporter()`, throttling, recovery dedup |
| `src/vitals/hints.ts`                 | **Modify** — add rule #7 (re-render storm)                                                       |
| `src/vitals/mod.ts`                   | **Modify** — wire server reporter, internalize `onVitalAlert`                                    |
| `src/diagnostics/types.ts`            | **Modify** — add `onDiagnostic` to `DiagnosticsConfig`                                           |
| `src/server.ts`                       | **Modify** — wire `onClientStateSent()`, payload size tracking                                   |
| `src/browser.ts`                      | **Modify** — client reporter, `_applyPatch` fix, `useAio()` warning, subscribe counting          |
| `tests/vitals/diag-formatter.test.ts` | **NEW** — formatter tests                                                                        |
| `tests/vitals/diag-reporter.test.ts`  | **NEW** — reporter correlation tests                                                             |
| `tests/vitals/hints.test.ts`          | **Modify** — add rule #7 test                                                                    |

---

### Task 1: DiagEvent type + DiagEventDetail

**Files:**

- Modify: `src/vitals/types.ts:~52` (after VitalAlert type)

- [ ] **Step 1: Add DiagEvent and DiagEventDetail types**

In `src/vitals/types.ts`, after the `VitalAlert` type (line ~51), add:

```ts
export type DiagEventDetail = {
  trigger?: string;
  reduceMs?: number;
  p95Ms?: number;
  queueDepth?: number;
  drainRate?: number;
  rtt?: number;
  skipCount?: number;
  frozenFor?: number;
  payloadBytes?: number;
  hint?: string;
};

export type DiagEvent = {
  kind: "freeze" | "stale" | "slow" | "disconnect" | "recovered";
  severity: "likely" | "possible" | "speculative";
  summary: string;
  detail: DiagEventDetail;
  timestamp: number;
};
```

- [ ] **Step 2: Verify types compile**

Run: `deno check src/vitals/types.ts` Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/vitals/types.ts
git commit -m "feat(vitals): add DiagEvent type"
```

---

### Task 2: Pure formatter — `formatDiagEvent()`

**Files:**

- Create: `src/vitals/diag-formatter.ts`
- Create: `tests/vitals/diag-formatter.test.ts`

- [ ] **Step 1: Write failing tests for formatter**

Create `tests/vitals/diag-formatter.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { formatDiagEvent } from "../../src/vitals/diag-formatter.ts";
import type { DiagEvent } from "../../src/vitals/types.ts";

function makeEvent(overrides: Partial<DiagEvent> = {}): DiagEvent {
  return {
    kind: "slow",
    severity: "likely",
    summary: "SLOW DISPATCH — orders.execute took 340ms",
    detail: {},
    timestamp: Date.now(),
    ...overrides,
  };
}

Deno.test("formatter: structured block for likely severity with 2+ data points", () => {
  const event = makeEvent({
    kind: "slow",
    severity: "likely",
    summary: "SLOW DISPATCH — orders.execute took 340ms (budget: 50ms)",
    detail: {
      trigger: "orders.execute",
      reduceMs: 340,
      p95Ms: 28,
      queueDepth: 8,
      drainRate: 1.4,
      hint: "single slow reducer — profile orders.execute",
    },
  });
  const lines = formatDiagEvent(event);
  assertEquals(lines.length > 1, true, "should produce structured block");
  assertEquals(lines[0].includes("[aio:vitals]"), true);
  assertEquals(lines[0].includes("SLOW DISPATCH"), true);
  assertEquals(lines.some((l) => l.includes("trigger")), true);
  assertEquals(lines.some((l) => l.includes("hint")), true);
});

Deno.test("formatter: one-liner for speculative severity", () => {
  const event = makeEvent({
    kind: "recovered",
    severity: "speculative",
    summary: "transport recovered (was degraded for 1.2s, RTT back to 28ms)",
    detail: { rtt: 28 },
  });
  const lines = formatDiagEvent(event);
  assertEquals(lines.length, 1, "should produce one-liner");
  assertEquals(lines[0].includes("[aio:vitals]"), true);
  assertEquals(lines[0].includes("recovered"), true);
});

Deno.test("formatter: freeze event includes all correlated data", () => {
  const event = makeEvent({
    kind: "freeze",
    severity: "likely",
    summary: "RENDER FROZEN — no update for 3.2s",
    detail: {
      trigger: "portfolio.refresh",
      reduceMs: 1847,
      p95Ms: 45,
      queueDepth: 12,
      drainRate: 2.1,
      rtt: 23,
      frozenFor: 3200,
      hint: "slow reducer blocking main thread — consider async",
    },
  });
  const lines = formatDiagEvent(event);
  assertEquals(lines.length > 1, true);
  assertEquals(lines.some((l) => l.includes("trigger")), true);
  assertEquals(lines.some((l) => l.includes("queue")), true);
  assertEquals(lines.some((l) => l.includes("transport")), true);
  assertEquals(lines.some((l) => l.includes("hint")), true);
});

Deno.test("formatter: stale event shows transport + delta info", () => {
  const event = makeEvent({
    kind: "stale",
    severity: "possible",
    summary: "STALE STATE — 4 broadcasts skipped, client degraded",
    detail: {
      rtt: 890,
      skipCount: 4,
      p95Ms: 12,
      hint: "network latency spike — check connection",
    },
  });
  const lines = formatDiagEvent(event);
  assertEquals(lines.length > 1, true);
  assertEquals(lines.some((l) => l.includes("transport")), true);
});

Deno.test("formatter: one-liner when likely but only 1 data point", () => {
  const event = makeEvent({
    kind: "disconnect",
    severity: "likely",
    summary: "transport lost — client unreachable",
    detail: { frozenFor: 5000 },
  });
  const lines = formatDiagEvent(event);
  assertEquals(lines.length, 1, "only 1 data point = one-liner");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/vitals/diag-formatter.test.ts` Expected: FAIL — module not
found

- [ ] **Step 3: Implement formatter**

Create `src/vitals/diag-formatter.ts`:

```ts
import type { DiagEvent } from "./types.ts";

const KIND_LABELS: Record<DiagEvent["kind"], string> = {
  freeze: "RENDER FROZEN",
  stale: "STALE STATE",
  slow: "SLOW DISPATCH",
  disconnect: "DISCONNECTED",
  recovered: "recovered",
};

/** Count non-undefined values in detail (excluding hint) */
function dataPointCount(detail: DiagEvent["detail"]): number {
  let count = 0;
  const { hint: _, ...rest } = detail;
  for (const v of Object.values(rest)) {
    if (v !== undefined) count++;
  }
  return count;
}

/**
 * Pure formatter: DiagEvent → console-ready lines.
 * Structured block when severity is likely/possible AND 2+ data points.
 * One-liner otherwise.
 */
export function formatDiagEvent(event: DiagEvent): string[] {
  const { kind, summary, detail } = event;
  const isBlock =
    (event.severity === "likely" || event.severity === "possible") &&
    dataPointCount(detail) >= 2;

  const header = `[aio:vitals] ${summary}`;

  if (!isBlock) return [header];

  const lines: string[] = [header];

  if (detail.trigger !== undefined) {
    const extra = detail.reduceMs !== undefined
      ? ` reduce took ${detail.reduceMs}ms${
        detail.p95Ms !== undefined ? ` (p95: ${detail.p95Ms}ms)` : ""
      }`
      : "";
    lines.push(`  trigger:    ${detail.trigger}${extra}`);
  }

  if (detail.queueDepth !== undefined) {
    const dr = detail.drainRate !== undefined
      ? `, drain rate ${detail.drainRate}/s`
      : "";
    lines.push(`  queue:      ${detail.queueDepth} actions pending${dr}`);
  }

  if (detail.rtt !== undefined) {
    const status = detail.rtt > 500
      ? "degraded"
      : detail.rtt > 100
      ? "warning"
      : "healthy";
    lines.push(`  transport:  ${status} (RTT ${detail.rtt}ms)`);
  }

  if (detail.skipCount !== undefined) {
    lines.push(`  skipped:    ${detail.skipCount} broadcasts`);
  }

  if (detail.frozenFor !== undefined && kind !== "freeze") {
    lines.push(`  frozen for: ${(detail.frozenFor / 1000).toFixed(1)}s`);
  }

  if (detail.payloadBytes !== undefined) {
    const kb = (detail.payloadBytes / 1024).toFixed(1);
    lines.push(`  payload:    ${kb}KB`);
  }

  if (detail.hint !== undefined) {
    lines.push(`  hint:       ${detail.hint}`);
  }

  return lines;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/vitals/diag-formatter.test.ts` Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/vitals/diag-formatter.ts tests/vitals/diag-formatter.test.ts
git commit -m "feat(vitals): pure DiagEvent formatter with structured block + one-liner"
```

---

### Task 3: Server-side DiagReporter

**Files:**

- Create: `src/vitals/diag-reporter.ts`
- Create: `tests/vitals/diag-reporter.test.ts`

- [ ] **Step 1: Write failing tests for server reporter**

Create `tests/vitals/diag-reporter.test.ts`:

```ts
import { assertEquals, assertExists } from "@std/assert";
import { createServerDiagReporter } from "../../src/vitals/diag-reporter.ts";
import type { DiagEvent } from "../../src/vitals/types.ts";
import type { VitalAlert } from "../../src/vitals/types.ts";

function makeAlert(overrides: Partial<VitalAlert> = {}): VitalAlert {
  return {
    id: "test-1",
    layer: "loop",
    status: "warning",
    duration: 500,
    measured: 340,
    threshold: 50,
    hint: null,
    ts: Date.now(),
    ...overrides,
  };
}

Deno.test("server-reporter: slow dispatch from loop alert", () => {
  const events: DiagEvent[] = [];
  const reporter = createServerDiagReporter({
    onDiagnostic: (e) => events.push(e),
    getLoopSnapshot: () => ({
      status: "warning",
      queueDepth: 8,
      drainRate: 1.4,
      lastReduceTime: 340,
      lastReduceAction: "orders/execute",
      lastReduceFeature: "orders",
      p95ReduceTime: 28,
      effectBacklog: 3,
      circuitBreakers: [],
      firstDegradedAt: null,
    }),
    getTransportSnapshot: () => ({ clients: [] }),
  });
  reporter.onAlert(
    makeAlert({ layer: "loop", status: "warning", measured: 340 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "slow");
  assertExists(events[0].detail.reduceMs);
});

Deno.test("server-reporter: disconnect from transport frozen", () => {
  const events: DiagEvent[] = [];
  const reporter = createServerDiagReporter({
    onDiagnostic: (e) => events.push(e),
    getLoopSnapshot: () => ({
      status: "healthy",
      queueDepth: 0,
      drainRate: 50,
      lastReduceTime: 5,
      lastReduceAction: "",
      lastReduceFeature: "",
      p95ReduceTime: 8,
      effectBacklog: 0,
      circuitBreakers: [],
      firstDegradedAt: null,
    }),
    getTransportSnapshot: () => ({
      clients: [{ id: "c1", status: "frozen" as const, frozenFor: 5000 }],
    }),
  });
  reporter.onAlert(
    makeAlert({ layer: "transport", status: "frozen", measured: 5000 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "disconnect");
});

Deno.test("server-reporter: recovery deduplication", () => {
  const events: DiagEvent[] = [];
  const reporter = createServerDiagReporter({
    onDiagnostic: (e) => events.push(e),
    getLoopSnapshot: () => ({
      status: "healthy",
      queueDepth: 0,
      drainRate: 50,
      lastReduceTime: 5,
      lastReduceAction: "",
      lastReduceFeature: "",
      p95ReduceTime: 8,
      effectBacklog: 0,
      circuitBreakers: [],
      firstDegradedAt: null,
    }),
    getTransportSnapshot: () => ({ clients: [] }),
  });
  // First: trigger slow
  reporter.onAlert(
    makeAlert({ layer: "loop", status: "warning", measured: 340 }),
  );
  // Then: recover
  reporter.onAlert(
    makeAlert({ layer: "loop", status: "healthy", measured: 5 }),
  );
  const recoveries = events.filter((e) => e.kind === "recovered");
  assertEquals(recoveries.length, 1);
  // Recover again without degradation — no duplicate
  reporter.onAlert(
    makeAlert({ layer: "loop", status: "healthy", measured: 5 }),
  );
  assertEquals(events.filter((e) => e.kind === "recovered").length, 1);
});

Deno.test("server-reporter: console throttling suppresses rapid same-kind events", () => {
  let consoleCount = 0;
  const reporter = createServerDiagReporter({
    onConsole: () => {
      consoleCount++;
    },
    getLoopSnapshot: () => ({
      status: "warning",
      queueDepth: 8,
      drainRate: 1.4,
      lastReduceTime: 340,
      lastReduceAction: "orders/execute",
      lastReduceFeature: "orders",
      p95ReduceTime: 28,
      effectBacklog: 3,
      circuitBreakers: [],
      firstDegradedAt: null,
    }),
    getTransportSnapshot: () => ({ clients: [] }),
  });
  reporter.onAlert(
    makeAlert({ layer: "loop", status: "warning", measured: 340 }),
  );
  reporter.onAlert(
    makeAlert({ layer: "loop", status: "warning", measured: 340 }),
  );
  reporter.onAlert(
    makeAlert({ layer: "loop", status: "warning", measured: 340 }),
  );
  assertEquals(
    consoleCount,
    1,
    "should throttle repeated same-kind console output",
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/vitals/diag-reporter.test.ts` Expected: FAIL — module not
found

- [ ] **Step 3: Implement server reporter**

Create `src/vitals/diag-reporter.ts`:

```ts
import type { DiagEvent, VitalAlert } from "./types.ts";
import { formatDiagEvent } from "./diag-formatter.ts";

const THROTTLE_MS = 2000;

export type LoopSnapshot = {
  status: string;
  queueDepth: number;
  drainRate: number;
  lastReduceTime: number;
  lastReduceAction: string;
  lastReduceFeature: string;
  p95ReduceTime: number;
  effectBacklog: number;
  circuitBreakers: string[];
  firstDegradedAt: number | null;
};

export type TransportSnapshot = {
  clients: Array<{ id: string; status: string; frozenFor?: number }>;
  // Note: RTT is client-side only (transport-probe client). Server has no per-client RTT.
};

export type ServerDiagReporterConfig = {
  onDiagnostic?: (event: DiagEvent) => void;
  onConsole?: (lines: string[]) => void; // override for testing; defaults to console.warn
  getLoopSnapshot: () => LoopSnapshot;
  getTransportSnapshot: () => TransportSnapshot;
};

export function createServerDiagReporter(config: ServerDiagReporterConfig) {
  const lastStatus = new Map<string, DiagEvent["kind"]>();
  const lastConsoleEmit = new Map<string, number>();

  const log = config.onConsole ?? ((lines: string[]) => {
    if (lines.length === 1) {
      console.warn(lines[0]);
    } else {
      console.group(lines[0]);
      for (let i = 1; i < lines.length; i++) console.warn(lines[i]);
      console.groupEnd();
    }
  });

  function mapAlertToKind(
    alert: VitalAlert,
    loop: LoopSnapshot,
    transport: TransportSnapshot,
  ): DiagEvent["kind"] | null {
    // Priority: disconnect > stale > slow > recovered (freeze is client-only, not handled here)
    const frozenClients = transport.clients.filter((c) =>
      c.status === "frozen"
    );
    if (alert.layer === "transport" && frozenClients.length > 0) {
      return "disconnect";
    }

    const degradedClients = transport.clients.filter((c) =>
      c.status === "degraded" || c.status === "warning"
    );
    if (alert.layer === "transport" && degradedClients.length > 0) {
      return "stale";
    }

    if (
      alert.layer === "loop" &&
      (alert.status === "warning" || alert.status === "degraded" ||
        alert.status === "frozen")
    ) return "slow";

    if (alert.status === "healthy") return "recovered";

    return null;
  }

  function buildEvent(
    kind: DiagEvent["kind"],
    alert: VitalAlert,
    loop: LoopSnapshot,
    transport: TransportSnapshot,
  ): DiagEvent {
    const detail: DiagEvent["detail"] = {};
    const hint = alert.hint;

    if (kind === "slow") {
      detail.trigger = loop.lastReduceAction || loop.lastReduceFeature ||
        undefined;
      detail.reduceMs = loop.lastReduceTime;
      detail.p95Ms = loop.p95ReduceTime;
      detail.queueDepth = loop.queueDepth;
      detail.drainRate = loop.drainRate;
      detail.hint = hint?.suggestion;
    } else if (kind === "disconnect") {
      const frozen = transport.clients.find((c) => c.status === "frozen");
      detail.frozenFor = frozen?.frozenFor;
      detail.hint = hint?.suggestion ??
        "client unreachable — check network or process";
    } else if (kind === "stale") {
      // RTT not available server-side — only transport status
      detail.p95Ms = loop.p95ReduceTime;
      detail.hint = hint?.suggestion ??
        "network latency spike — check connection";
    } else if (kind === "recovered") {
      detail.hint = undefined;
    }

    const summaries: Record<string, string> = {
      slow: `SLOW DISPATCH — ${detail.trigger ?? "unknown"} took ${
        detail.reduceMs ?? "?"
      }ms (budget: ${alert.threshold}ms)`,
      disconnect: `DISCONNECTED — client unreachable for ${
        ((detail.frozenFor ?? 0) / 1000).toFixed(1)
      }s`,
      stale: `STALE STATE — client degraded, dispatch p95 ${
        detail.p95Ms ?? "?"
      }ms`,
      recovered: `${alert.layer} recovered`,
    };

    return {
      kind,
      severity: hint?.severity ??
        (kind === "recovered" ? "speculative" : "possible"),
      summary: summaries[kind] ?? kind,
      detail,
      timestamp: alert.ts,
    };
  }

  return {
    onAlert(alert: VitalAlert) {
      const loop = config.getLoopSnapshot();
      const transport = config.getTransportSnapshot();
      const kind = mapAlertToKind(alert, loop, transport);
      if (!kind) return;

      // Recovery deduplication
      const key = alert.layer;
      const prevKind = lastStatus.get(key);
      if (kind === "recovered") {
        if (!prevKind || prevKind === "recovered") return; // no prior degradation
        lastStatus.set(key, "recovered");
      } else {
        lastStatus.set(key, kind);
      }

      const event = buildEvent(kind, alert, loop, transport);

      // Always fire hook (no throttling)
      config.onDiagnostic?.(event);

      // Console throttling
      const throttleKey = `${kind}:${event.detail.trigger ?? ""}`;
      const now = Date.now();
      const lastEmit = lastConsoleEmit.get(throttleKey) ?? 0;
      if (now - lastEmit >= THROTTLE_MS) {
        lastConsoleEmit.set(throttleKey, now);
        log(formatDiagEvent(event));
      }
    },
    /** Expose for testing */
    _lastStatus: lastStatus,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/vitals/diag-reporter.test.ts` Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/vitals/diag-reporter.ts tests/vitals/diag-reporter.test.ts
git commit -m "feat(vitals): server-side DiagReporter with correlation, throttling, recovery dedup"
```

---

### Task 4: Wire server reporter into `createVitalsSystem()` + add `onDiagnostic` config

**Files:**

- Modify: `src/vitals/mod.ts:~51-137`
- Modify: `src/diagnostics/types.ts:7-10`

- [ ] **Step 1: Add `onDiagnostic` to `DiagnosticsConfig`**

In `src/diagnostics/types.ts`, change the `DiagnosticsConfig` type (lines 7-10):

```ts
// Before:
export type DiagnosticsConfig = false | {
  dev?: DiagnosticsOptions;
  prod?: DiagnosticsOptions;
};

// After:
export type DiagnosticsConfig = false | {
  dev?: DiagnosticsOptions;
  prod?: DiagnosticsOptions;
  onDiagnostic?: (event: import("../vitals/types.ts").DiagEvent) => void;
};
```

- [ ] **Step 2: Wire reporter into `createVitalsSystem()`**

In `src/vitals/mod.ts`, import and wire the server reporter:

Add import at top:

```ts
import { createServerDiagReporter } from "./diag-reporter.ts";
```

Inside `createVitalsSystem()` (after line ~54 where `onAlert` is set), create
the reporter and make it the alert handler:

```ts
const reporter = createServerDiagReporter({
  onDiagnostic: config.onDiagnostic,
  onConsole: undefined, // use default console output
  getLoopSnapshot: () => ({
    ...loopProbe.getVitals(),
    status: loopProbe.getStatus(),
    firstDegradedAt: loopProbe.getFirstDegradedAt(),
  }),
  getTransportSnapshot: () => ({
    clients: serverTransport.getAllClients().map((c) => ({
      id: c.clientId,
      status: c.status,
      frozenFor: c.frozenSince ? Date.now() - c.frozenSince : undefined,
      // Note: no RTT server-side — RTT is tracked by client transport probe only
    })),
  }),
});
```

Replace the direct `onAlert` call inside `fireAlert()` with
`reporter.onAlert(alert)`. Keep `onVitalAlert` as internal — the reporter IS the
consumer now.

**Important:** `loopProbe` has no `getSnapshot()` method. Build the composite
from `getVitals()` + `getStatus()` + `getFirstDegradedAt()`. `ClientLiveness`
has `frozenSince` (not `frozenFor`) — compute `frozenFor` as
`Date.now() - frozenSince`.

- [ ] **Step 3: Add `onDiagnostic` to VitalsConfig type**

In `src/vitals/types.ts`, add to `VitalsConfig`:

```ts
onDiagnostic?: (event: DiagEvent) => void;
```

- [ ] **Step 4: Update re-exports in mod.ts**

Add `DiagEvent` and `DiagEventDetail` to the re-exports in `src/vitals/mod.ts`.

- [ ] **Step 5: Run existing vitals tests**

Run: `deno test tests/vitals/` Expected: All existing tests PASS (mod.test.ts
`onVitalAlert` test still works because reporter wraps it)

- [ ] **Step 6: Commit**

```bash
git add src/vitals/mod.ts src/vitals/types.ts src/diagnostics/types.ts
git commit -m "feat(vitals): wire DiagReporter into VitalsSystem, add onDiagnostic config"
```

---

### Task 5: Wire `onClientStateSent()` + broadcast payload tracking in server.ts

**Files:**

- Modify: `src/server.ts:~567-568` (broadcast loop)

- [ ] **Step 1: Add payload tracking map**

In `src/server.ts`, near the connections map, add:

```ts
const _payloadStats = new Map<
  string,
  { lastPayloadBytes: number; totalBytes: number; count: number }
>();
```

- [ ] **Step 2: Wire `onClientStateSent()` and payload tracking after
      `ws.send()`**

In the broadcast loop (after line ~567 `ws.send(delta.msg)`), add:

```ts
config.vitalsSystem?.serverTransport.onClientStateSent(meta.id, Date.now());
// Track payload size
const bytes = delta.msg.length;
const stats = _payloadStats.get(meta.id);
if (stats) {
  stats.lastPayloadBytes = bytes;
  stats.totalBytes += bytes;
  stats.count++;
} else {
  _payloadStats.set(meta.id, {
    lastPayloadBytes: bytes,
    totalBytes: bytes,
    count: 1,
  });
}
```

- [ ] **Step 3: Clean up payload stats on disconnect**

Near the existing `removeClient` call (line ~834), add:

```ts
_payloadStats.delete(meta.id);
```

- [ ] **Step 4: Expose payload stats in vitals endpoint**

In the `/__aio/vitals` endpoint handler (line ~1022), include payload stats in
response:

```ts
const payloadStats = Object.fromEntries(_payloadStats);
// Add to response: { ...data, payloadStats }
```

- [ ] **Step 5: Run type check**

Run: `deno check src/server.ts` Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "fix(vitals): wire onClientStateSent + broadcast payload size tracking"
```

---

### Task 6: `_applyPatch` reference stability

**Files:**

- Modify: `src/browser.ts:53-69` (_applyPatch function)

- [ ] **Step 1: Add `shallowEqual` helper**

Add above `_applyPatch` in `src/browser.ts`:

```ts
/** Shallow-equal comparison for one level of properties. */
function _shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== "object" || typeof b !== "object" || a === null || b === null
  ) return false;
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  for (const k of ka) {
    if (objA[k] !== objB[k]) return false;
  }
  return true;
}
```

- [ ] **Step 2: Apply shallow-equal check in `_applyPatch` for patched keys**

Two insertion points in `_applyPatch`:

**Path A — Nested feature patch (after line 89, `next[k] = merged`):**

```ts
next[k] = merged;
// Preserve reference if patch didn't actually change anything
if (prev && _shallowEqual(merged, prev[k])) {
  next[k] = prev[k] as Record<string, unknown>;
}
```

**Path B — Top-level new object (after line 97, `next[k] = safe`):**

```ts
next[k] = safe;
// Preserve reference if new object is shallow-equal to previous
if (prev && _shallowEqual(safe, prev[k])) {
  next[k] = prev[k] as Record<string, unknown>;
}
```

Note: line 99 (`next[k] = v` for primitives/arrays) does NOT need the check —
primitives use `===` naturally and arrays are always new references from the
server.

- [ ] **Step 3: Run type check**

Run: `deno check src/browser.ts` Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/browser.ts
git commit -m "fix(vitals): _applyPatch shallow-equal preserves references for unchanged patched keys"
```

---

### Task 7: `useAio()` dev warning

**Files:**

- Modify: `src/browser.ts:~1065` (useAio hook)

- [ ] **Step 1: Add call-site deduplication set**

Near the top of the browser module (near other module-level state):

```ts
const _useAioWarned = new Set<string>();
```

- [ ] **Step 2: Add dev warning inside `useAio()`**

Inside the `useAio()` function body, add at the top. Note: browser.ts has no
`_devMode` flag — but browser.ts is only served in dev mode (the file itself is
the dev UI bundle). So the warning always fires:

```ts
const stack = new Error().stack ?? "";
const key = stack.split("\n")[2] ?? "unknown"; // caller line
if (!_useAioWarned.has(key)) {
  _useAioWarned.add(key);
  console.warn(
    "[aio:vitals] useAio() subscribes to full state tree — re-renders on every change. Use useFeature(ref) instead.",
  );
}
```

This is safe because browser.ts IS the dev mode UI module — production apps
don't load it.

- [ ] **Step 3: Run type check**

Run: `deno check src/browser.ts` Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/browser.ts
git commit -m "feat(vitals): useAio() dev warning for full-state subscription"
```

---

### Task 8: Client-side DiagReporter + subscribe counting

**Files:**

- Modify: `src/browser.ts:~579` (_subscribe function)
- Modify: `src/browser.ts:~782-792` (render probe init)

- [ ] **Step 1: Add subscribe notification counter**

Near the vitals probe declarations in browser.ts:

```ts
let _subscribeCallCount = 0;
let _subscribeWindowStart = 0;
const RENDER_STORM_THRESHOLD = 30;
const _useAioActive = { value: false }; // set to true when useAio() is called
```

- [ ] **Step 2: Instrument `_subscribe` to count notifications**

In the `_subscribe` function (line ~579), wrap the callback to count:

```ts
function _subscribe(onStoreChange: () => void): () => void {
  const unsub = _listeners.add(() => {
    _subscribeCallCount++;
    onStoreChange();
  });
  // ... rest unchanged
```

- [ ] **Step 3: Add static import for formatter at top of browser.ts**

Add near the other vitals imports (line ~18-20):

```ts
import { formatDiagEvent } from "./vitals/diag-formatter.ts";
import type { DiagEvent } from "./vitals/types.ts";
```

- [ ] **Step 4: Add client-side reporter logic to render probe onStatusChange**

Replace the existing render probe `onStatusChange` handler (lines ~786-789)
with:

```ts
onStatusChange: (status, report) => {
  const now = Date.now();

  // Recovery deduplication — track last status
  const prevStatus = _clientLastDiagStatus;
  if (status === "frozen" || status === "recovered") {
    if (status === "recovered" && prevStatus !== "freeze") return; // no prior freeze
    _clientLastDiagStatus = status === "frozen" ? "freeze" : "recovered";

    const kind = status === "frozen" ? "freeze" as const : "recovered" as const;
    const detail: DiagEvent["detail"] = {};
    if (report) {
      detail.trigger = report.lastActionBefore ?? undefined;
      detail.frozenFor = report.frozenFor;
    }
    // Include last pong loop data if available
    if (_vitalsTransportProbe) {
      detail.rtt = _vitalsTransportProbe.getRTT();
      const loop = _vitalsTransportProbe.getLastLoop?.();
      if (loop) {
        detail.reduceMs = loop.lastReduceTime;
        detail.p95Ms = loop.p95ReduceTime;
        detail.queueDepth = loop.queueDepth;
      }
    }

    const event: DiagEvent = {
      kind,
      severity: kind === "freeze" ? "likely" : "speculative",
      summary: kind === "freeze"
        ? `RENDER FROZEN — no update for ${((detail.frozenFor ?? 0) / 1000).toFixed(1)}s`
        : `render recovered`,
      detail,
      timestamp: now,
    };

    const lines = formatDiagEvent(event);
    if (lines.length === 1) console.warn(lines[0]);
    else { console.group(lines[0]); lines.slice(1).forEach(l => console.warn(l)); console.groupEnd(); }
  }

  // Re-render storm detection (check every 1s window)
  if (now - _subscribeWindowStart > 1000) {
    if (_subscribeCallCount >= RENDER_STORM_THRESHOLD) {
      const useAioNote = _useAioActive.value ? "yes (full-state subscription active)" : "no";
      console.warn(
        `[aio:vitals] RE-RENDER STORM — ${_subscribeCallCount} subscribe callbacks in last 1s\n` +
        `  useAio() detected:  ${useAioNote}\n` +
        `  hint:               ${_useAioActive.value ? "switch from useAio() to useFeature(ref)" : "check selectors for unnecessary re-renders"}`
      );
    }
    _subscribeCallCount = 0;
    _subscribeWindowStart = now;
  }
},
```

Add module-level state for recovery dedup:

```ts
let _clientLastDiagStatus: string = "recovered";
```

- [ ] **Step 4: Mark `_useAioActive` in useAio()**

In the `useAio()` function, set `_useAioActive.value = true;`.

- [ ] **Step 5: Run type check**

Run: `deno check src/browser.ts` Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/browser.ts
git commit -m "feat(vitals): client-side DiagReporter with freeze output + re-render storm detection"
```

---

### Task 9: Per-feature state size tracking

**Files:**

- Modify: `src/vitals/mod.ts` (add size computation)
- Modify: `src/server.ts` (expose in endpoint)

- [ ] **Step 1: Add `computeFeatureSizes` to VitalsSystem**

In `src/vitals/mod.ts`, add a function that takes the current state and returns
per-feature sizes:

```ts
function computeFeatureSizes(
  state: Record<string, unknown>,
): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const [name, featureState] of Object.entries(state)) {
    sizes[name] = JSON.stringify(featureState).length;
  }
  return sizes;
}
```

Expose via the `VitalsSystem` return object:

```ts
computeFeatureSizes,
```

- [ ] **Step 2: Include in vitals endpoint**

In `src/server.ts` `/__aio/vitals` handler, add feature sizes to response (using
current state):

```ts
const featureSizes = config.vitalsSystem?.computeFeatureSizes?.(currentState) ??
  {};
// Include in response: { ...data, featureSizes }
```

Note: The endpoint handler needs access to current state. Check how state is
accessed — likely via `getState()` that already exists in server scope.

- [ ] **Step 3: Run type check**

Run: `deno check src/server.ts && deno check src/vitals/mod.ts` Expected: No
errors

- [ ] **Step 4: Commit**

```bash
git add src/vitals/mod.ts src/server.ts
git commit -m "feat(vitals): per-feature state size tracking on heartbeat + endpoint"
```

---

### Task 10: Hint rule #7 — re-render storm (server-side awareness)

**Files:**

- Modify: `src/vitals/hints.ts:~140` (before return null)
- Modify: `tests/vitals/hints.test.ts`

Note: The actual re-render storm detection happens client-side (Task 8). This
rule adds server-side awareness if the information reaches the server
(future-proofing). For now, add the rule structure with a note that it's
client-side only.

- [ ] **Step 1: Write failing test**

Add to `tests/vitals/hints.test.ts`:

```ts
Deno.test("hints: rule 7 — re-render storm (client-only, server snapshot field)", () => {
  // Rule 7 is detected client-side. Server hints.ts only documents it.
  // This test verifies the snapshot type accepts the field for future use.
  const snap = makeSnapshot({
    render: { status: "warning", measured: 100, previousFreezeCount: 5 },
  });
  // Rule 7 currently fires client-side only; server evaluateHints returns
  // based on existing rules. This test ensures no regression.
  const hints = evaluateHints(snap, DEFAULT_THRESHOLDS);
  // With only render warning and no other probes degraded, should be rule 4 (client-only freeze)
  assertExists(hints);
});
```

- [ ] **Step 2: Run test to verify it passes** (this is additive documentation,
      not a behavior change)

Run: `deno test tests/vitals/hints.test.ts` Expected: PASS

- [ ] **Step 3: Add rule #7 documentation comment to hints.ts**

In `src/vitals/hints.ts`, update the rule list comment (line ~35-41) to include:

```ts
*   7. Re-render storm        → client-side only (>30 subscribe/sec)
```

- [ ] **Step 4: Commit**

```bash
git add src/vitals/hints.ts tests/vitals/hints.test.ts
git commit -m "docs(vitals): document rule #7 re-render storm in hints rule list"
```

---

### Task 11: Integration test + final verification

**Files:**

- Modify: `tests/vitals/integration.test.ts` (or create if needed)

- [ ] **Step 1: Add integration test for DiagReporter → console flow**

Add test that creates a VitalsSystem, triggers a condition, and verifies
DiagEvent flows through:

```ts
Deno.test("integration: VitalsSystem fires onDiagnostic on loop degradation", () => {
  const events: DiagEvent[] = [];
  const sys = createVitalsSystem({
    onDiagnostic: (e) => events.push(e),
  });
  // Trigger slow dispatch
  sys.loopProbe.updateQueueDepth(1500); // above frozen threshold
  sys.checkAndAlert();
  assertEquals(events.length >= 1, true);
  assertEquals(events[0].kind, "slow");
  sys.destroy();
});
```

- [ ] **Step 2: Run all vitals tests**

Run: `deno test tests/vitals/` Expected: All tests PASS

- [ ] **Step 3: Run full type check**

Run:
`deno check src/vitals/mod.ts && deno check src/server.ts && deno check src/browser.ts`
Expected: No errors

- [ ] **Step 4: Run linter**

Run:
`deno lint src/vitals/ src/browser.ts src/server.ts src/diagnostics/types.ts`
Expected: No errors

- [ ] **Step 5: Commit integration test**

```bash
git add tests/vitals/
git commit -m "test(vitals): integration test for DiagReporter flow"
```

- [ ] **Step 6: Final squash commit (if requested before push)**

All work across Tasks 1-11 ready for review.
