# Reduce Phase Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add granular reduce-phase timing breakdown (produce, clone, spread,
routing, listeners) to the existing perf system — zero-cost when
`perfCheck: "off"`, visible in time-travel and perf.log when on.

**Architecture:** `composeFeatures` gains a `perfCheck` flag and exposes a
`lastBreakdown()` side-channel getter. When enabled, `reduceFeature` and
`rootReduce` time each phase and store the result. `dispatch.ts` reads the
breakdown after each reduce call and includes it in `PerfTiming` → `onPerf` →
`PerfMetric` → time-travel. The logger's `perf()` method gains an optional
breakdown parameter for richer perf.log entries.

**Tech Stack:** Deno 2.6+, TypeScript, `performance.now()`

---

### Task 1: Add `ReduceBreakdown` type to `time-travel.ts`

**Files:**

- Modify: `src/time-travel.ts:1-9`

- [ ] **Step 1: Write the failing test**

```ts
// tests/reduce-breakdown.test.ts
import { assertEquals } from "jsr:@std/assert";
import {
  createTT,
  type PerfMetric,
  record,
  toBroadcast,
} from "../src/time-travel.ts";

Deno.test("PerfMetric with breakdown flows through record → toBroadcast", () => {
  let tt = createTT<Record<string, unknown>, { type: string }>();
  const perf: PerfMetric = {
    reduce: 42,
    effects: 3,
    budget: { reduce: 100, effect: 5 },
    breakdown: { produce: 30, clone: 8, spread: 1, routing: 2, listeners: 1 },
  };
  tt = record(tt, { type: "test:action" }, { test: {} }, perf);
  assertEquals(tt.entries[0]!.perf?.breakdown?.produce, 30);
  assertEquals(tt.entries[0]!.perf?.breakdown?.clone, 8);

  const broadcast = toBroadcast(tt);
  assertEquals(broadcast.entries[0]!.perf?.breakdown?.produce, 30);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/reduce-breakdown.test.ts` Expected: FAIL — `breakdown`
does not exist on `PerfMetric`

- [ ] **Step 3: Add `ReduceBreakdown` type and extend `PerfMetric`**

In `src/time-travel.ts`, add:

```ts
/** Phase-level timing breakdown inside a single reduce cycle (ms) */
export type ReduceBreakdown = {
  produce: number; // Immer produce() — reducer execution
  clone: number; // structuredClone() — effect detachment
  spread: number; // state object construction
  routing: number; // owner feature lookup + reduce
  listeners: number; // foreign action listener fan-out
};

/** Performance timing for a single action (dev mode only) */
export type PerfMetric = {
  reduce: number;
  effects: number;
  budget: { reduce: number; effect: number };
  breakdown?: ReduceBreakdown; // populated when perfCheck is on
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test tests/reduce-breakdown.test.ts` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/time-travel.ts tests/reduce-breakdown.test.ts
git commit -m "feat: add ReduceBreakdown type to PerfMetric"
```

---

### Task 2: Add `PerfTiming.breakdown` to `dispatch.ts`

**Files:**

- Modify: `src/dispatch.ts:27-33`

- [ ] **Step 1: Write the failing test**

Append to `tests/reduce-breakdown.test.ts`:

```ts
import type { PerfTiming } from "../src/dispatch.ts";

Deno.test("PerfTiming accepts optional breakdown field", () => {
  const timing: PerfTiming = {
    actionType: "test:click",
    reduce: 50,
    effects: 2,
    budget: { reduce: 100, effect: 5 },
    breakdown: { produce: 35, clone: 10, spread: 2, routing: 2, listeners: 1 },
  };
  assertEquals(timing.breakdown?.produce, 35);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/reduce-breakdown.test.ts` Expected: FAIL — `breakdown`
does not exist on `PerfTiming`

- [ ] **Step 3: Add breakdown to `PerfTiming`**

In `src/dispatch.ts`, extend `PerfTiming`:

```ts
import type { ReduceBreakdown } from "./time-travel.ts";

/** Per-action performance timing */
export type PerfTiming = {
  actionType: string;
  reduce: number;
  effects: number;
  budget: { reduce: number; effect: number };
  breakdown?: ReduceBreakdown;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test tests/reduce-breakdown.test.ts` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dispatch.ts tests/reduce-breakdown.test.ts
git commit -m "feat: add breakdown field to PerfTiming"
```

---

### Task 3: Wire `composeFeatures` — perfCheck flag + breakdown side-channel

**Files:**

- Modify: `src/feature-compose.ts:34-70` (ComposedFeatures type)
- Modify: `src/feature-compose.ts:147-153` (composeFeatures opts)
- Modify: `src/feature-compose.ts:206-317` (reduceFeature — machine path)
- Modify: `src/feature-compose.ts:319-368` (reduceFeature — simple path)
- Modify: `src/feature-compose.ts:416-535` (rootReduce)
- Modify: `src/feature-compose.ts:821-831` (return object)

This is the core task. It:

1. Adds `perfCheck?: boolean` to `composeFeatures` opts
2. Adds `lastBreakdown(): ReduceBreakdown | undefined` to `ComposedFeatures`
3. Instruments `reduceFeature` (both machine and simple paths) and `rootReduce`
   when perfCheck is on
4. Reverts the inline probe hack (the `_t0`, `_rr0` etc. variables)

- [ ] **Step 1: Write the failing test**

Append to `tests/reduce-breakdown.test.ts`:

```ts
import { composeFeatures } from "../src/feature-compose.ts";
import type { ReduceBreakdown } from "../src/time-travel.ts";

// Minimal feature for testing
function testFeature(id: string) {
  return {
    __aio: {
      id,
      state: { count: 0 },
      actions: { increment: `${id}:increment` },
      effects: {},
      selectors: {},
      actionKeys: ["increment"],
      effectKeys: [] as string[],
      actionTypeToKey: new Map([[`${id}:increment`, "increment"]]),
      foreignActions: [] as string[],
      machine: false as const,
      bound: false,
      reduce: (draft: Record<string, unknown>, _action: { type: string }) => {
        (draft as { count: number }).count++;
      },
      initType: `${id}:Init`,
      destroyType: `${id}:Destroy`,
      crossDispatchPrefixes: new Set<string>(),
      flowTriggers: undefined,
      flows: undefined,
      validate: undefined,
      execute: undefined,
      onInit: undefined,
      onDestroy: undefined,
    },
  };
}

Deno.test("composeFeatures with perfCheck exposes lastBreakdown()", () => {
  const composed = composeFeatures([testFeature("counter")], {
    perfCheck: true,
  });

  // Before any reduce — no breakdown
  assertEquals(composed.lastBreakdown?.(), undefined);

  // After reduce — breakdown populated
  const result = composed.reduce(composed.initialState, {
    type: "counter:increment",
    payload: {},
  });
  assertEquals(typeof result.state, "object");

  const bd = composed.lastBreakdown!();
  assertEquals(typeof bd?.produce, "number");
  assertEquals(typeof bd?.clone, "number");
  assertEquals(typeof bd?.spread, "number");
  assertEquals(typeof bd?.routing, "number");
  assertEquals(typeof bd?.listeners, "number");
  assertEquals(bd!.produce >= 0, true);
});

Deno.test("composeFeatures without perfCheck — no lastBreakdown", () => {
  const composed = composeFeatures([testFeature("counter")]);
  assertEquals(composed.lastBreakdown, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/reduce-breakdown.test.ts` Expected: FAIL — `lastBreakdown`
does not exist on `ComposedFeatures`

- [ ] **Step 3: Implement breakdown instrumentation in composeFeatures**

Key changes to `src/feature-compose.ts`:

1. Import `ReduceBreakdown` from `time-travel.ts`
2. Add to `ComposedFeatures` type:
   ```ts
   /** Last reduce breakdown — populated when perfCheck is on */
   lastBreakdown?: () => ReduceBreakdown | undefined;
   ```
3. Add `perfCheck?: boolean` to opts parameter
4. In `composeFeatures` body, add state:
   ```ts
   const _perfCheck = opts?.perfCheck ?? false;
   let _lastBreakdown: ReduceBreakdown | undefined;
   ```
5. In `reduceFeature` — both machine and simple paths — wrap
   produce/clone/spread in timing when `_perfCheck`:
   ```ts
   // Machine path timing
   let tProduce = 0, tClone = 0;
   if (_perfCheck) {
     const t0 = performance.now();
     // ... produce call ...
     tProduce = performance.now() - t0;
   } else {
     // ... produce call (no timing) ...
   }
   ```

   **Important:** To avoid duplicating the produce/clone logic, use a helper
   pattern:
   ```ts
   const t0 = _perfCheck ? performance.now() : 0;
   // ... existing produce call unchanged ...
   const tProduce = _perfCheck ? performance.now() - t0 : 0;
   ```
   This adds only two branches per phase, no code duplication.

6. Return breakdown data from `reduceFeature` by extending the return type to
   include an optional `_breakdown` partial:
   ```ts
   type ReduceResult = {
     state: Record<string, unknown>;
     effects: (Msg | ScheduleEffect)[];
     _bd?: { produce: number; clone: number; spread: number };
   };
   ```

7. In `rootReduce`, time the owner routing and listener phases, then assemble
   the full breakdown:
   ```ts
   const rt0 = _perfCheck ? performance.now() : 0;
   // ... owner reduce ...
   const tRouting = _perfCheck ? performance.now() - rt0 : 0;

   const lt0 = _perfCheck ? performance.now() : 0;
   // ... listener loop ...
   const tListeners = _perfCheck ? performance.now() - lt0 : 0;

   if (_perfCheck) {
     _lastBreakdown = {
       produce: ownerBd?.produce ?? 0,
       clone: ownerBd?.clone ?? 0,
       spread: ownerBd?.spread ?? 0,
       routing: tRouting,
       listeners: tListeners,
     };
   }
   ```

8. **Revert the inline probe hack** — remove all `_t0`, `_t1`, `_t2`,
   `_tProduce`, `_tClone`, `_tSpread`, `_rr0`, `_rr1`, `_rrOwner`,
   `_rrListeners`, `_rrTotal` variables and their associated
   `log.warn("perf", ...)` calls.

9. Add `lastBreakdown` to the return object:
   ```ts
   return {
     initialState,
     reduce: rootReduce,
     execute: rootExecute,
     features,
     featureNames: features.map((f) => f.__aio.id),
     initAll,
     destroyAll,
     registry,
     ...(_perfCheck ? { lastBreakdown: () => _lastBreakdown } : {}),
   };
   ```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test tests/reduce-breakdown.test.ts` Expected: PASS

- [ ] **Step 5: Run existing feature-compose tests to verify no regression**

Run: `deno test tests/feature-compose.test.ts` Expected: All existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/feature-compose.ts tests/reduce-breakdown.test.ts
git commit -m "feat: reduce breakdown instrumentation in composeFeatures"
```

---

### Task 4: Wire dispatch.ts to read breakdown and include in onPerf

**Files:**

- Modify: `src/dispatch.ts:395-403`

- [ ] **Step 1: Write the failing test**

Append to `tests/reduce-breakdown.test.ts`:

```ts
import { createDispatch } from "../src/dispatch.ts";
import type { ReduceBreakdown } from "../src/time-travel.ts";

Deno.test("dispatch passes breakdown from reduce to onPerf callback", async () => {
  let state = { counter: { count: 0 } };
  let capturedBreakdown: ReduceBreakdown | undefined;

  const fakeBreakdown: ReduceBreakdown = {
    produce: 10,
    clone: 2,
    spread: 1,
    routing: 3,
    listeners: 1,
  };

  const dispatch = createDispatch({
    reduce: (_s, _a) => {
      state = { counter: { count: state.counter.count + 1 } };
      return { state, effects: [] };
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s as typeof state;
    },
    onDone: () => {},
    log: { debug: () => {}, warn: () => {}, error: () => {} },
    debug: false,
    onPerf: (timing) => {
      capturedBreakdown = timing.breakdown;
    },
    perfCheck: "on",
    reduceBreakdown: () => fakeBreakdown,
  });

  await dispatch({ type: "counter:increment", payload: {} });
  assertEquals(capturedBreakdown, fakeBreakdown);
});

Deno.test("dispatch omits breakdown when reduceBreakdown not provided", async () => {
  let state = { counter: { count: 0 } };
  let capturedTiming: PerfTiming | undefined;

  const dispatch = createDispatch({
    reduce: (_s, _a) => {
      state = { counter: { count: state.counter.count + 1 } };
      return { state, effects: [] };
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s as typeof state;
    },
    onDone: () => {},
    log: { debug: () => {}, warn: () => {}, error: () => {} },
    debug: false,
    onPerf: (timing) => {
      capturedTiming = timing;
    },
    perfCheck: "on",
  });

  await dispatch({ type: "counter:increment", payload: {} });
  assertEquals(capturedTiming?.breakdown, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/reduce-breakdown.test.ts` Expected: FAIL —
`reduceBreakdown` not in DispatchDeps type

- [ ] **Step 3: Add `reduceBreakdown` to DispatchDeps and wire to onPerf**

In `src/dispatch.ts`:

1. Add to `DispatchDeps`:
   ```ts
   /** Optional getter for reduce phase breakdown — provided by composeFeatures when perfCheck is on */
   reduceBreakdown?: () => ReduceBreakdown | undefined;
   ```

2. In `createDispatch`, destructure it:
   ```ts
   const { ..., reduceBreakdown } = deps; // (note: add to existing destructure, not new `const` — but keeping the new field as `deps.reduceBreakdown` to avoid name collision with the `reduce` function is cleaner)
   ```

   Actually, read it from deps directly to avoid name collision with the
   existing `reduce`:
   ```ts
   const getBreakdown = deps.reduceBreakdown;
   ```

3. In the `onPerf` call (line ~396-403), include breakdown:
   ```ts
   if (onPerf && actionType) {
     onPerf({
       actionType,
       reduce: reduceDuration,
       effects: totalEffectDuration,
       budget: { reduce: reduceBudget, effect: effectBudget },
       breakdown: getBreakdown?.(),
     });
   }
   ```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test tests/reduce-breakdown.test.ts` Expected: PASS

- [ ] **Step 5: Run existing dispatch tests**

Run: `deno test tests/dispatch.test.ts` Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/dispatch.ts tests/reduce-breakdown.test.ts
git commit -m "feat: wire reduce breakdown through dispatch to onPerf"
```

---

### Task 5: Wire aio.ts — pass perfCheck to composeFeatures + breakdown to onPerf

**Files:**

- Modify: `src/aio.ts` (composeFeatures call + dispatch deps)

- [ ] **Step 1: Find the composeFeatures call and dispatch wiring in aio.ts**

Grep for `composeFeatures(` and `onPerf` in `src/aio.ts` to locate exact lines.

- [ ] **Step 2: Pass `perfCheck` to composeFeatures**

Where `composeFeatures(entries, { onFeatureError, circuitBreaker })` is called,
add `perfCheck`:

```ts
const perfEnabled = config.perfCheck !== "off";
const composed = composeFeatures(entries, {
  onFeatureError,
  circuitBreaker: config.circuitBreaker,
  perfCheck: perfEnabled,
});
```

- [ ] **Step 3: Pass `reduceBreakdown` to createDispatch**

In the dispatch deps object, add:

```ts
reduceBreakdown: composed.lastBreakdown,
```

- [ ] **Step 4: Update onPerf callback inline type + include breakdown in
      PerfMetric**

In the `onPerf` callback (~line 1746), the `timing` parameter uses an inline
type. Either replace with `PerfTiming` import from `dispatch.ts`, or add
`breakdown?: ReduceBreakdown` to the inline type. Then include breakdown in
`lastPerf`:

```ts
// Option A: use PerfTiming import (preferred — DRY)
import type { PerfTiming } from "./dispatch.ts";
const onPerf = tt
  ? (timing: PerfTiming) => {
    lastPerf = {
      reduce: timing.reduce,
      effects: timing.effects,
      budget: timing.budget,
      breakdown: timing.breakdown,
    };
  }
  : undefined;

// Option B: extend inline type (if import creates circular dep)
// Add `breakdown?: ReduceBreakdown` to the inline timing type
```

- [ ] **Step 5: Run full test suite**

Run: `deno test` Expected: All PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add src/aio.ts
git commit -m "feat: wire perfCheck + breakdown through aio.ts"
```

---

### Task 6: Enhance logger perf() with optional breakdown

**Files:**

- Modify: `src/logger.ts:377-394`

- [ ] **Step 1: Extend logger.perf() signature**

(No separate test needed — `deno check` validates the type, and the end-to-end
flow is tested by existing dispatch→onPerf tests. Logger file-write behavior is
covered by existing logger tests.)

- [ ] **Step 2: Implement the change**

In `src/logger.ts`, modify the `perf` method:

```ts
perf(
  source: "reduce" | "effect",
  type: string,
  duration: number,
  budget: number,
  breakdown?: { produce: number; clone: number; spread: number; routing: number; listeners: number },
): void {
  const entry: LogEntry = {
    ts: now(),
    lvl: "perf",
    cat: `perf:${source}`,
    msg: breakdown
      ? `${type} exceeded budget: ${Math.round(duration)}ms > ${budget}ms (produce=${Math.round(breakdown.produce)}ms clone=${Math.round(breakdown.clone)}ms spread=${Math.round(breakdown.spread)}ms routing=${Math.round(breakdown.routing)}ms listeners=${Math.round(breakdown.listeners)}ms)`
      : `${type} exceeded budget: ${Math.round(duration)}ms > ${budget}ms`,
    data: { type, duration: Math.round(duration), budget, ...(breakdown ? { breakdown } : {}) },
  };
  this.write(this.path("perf"), entry);
  this.write(this.path("debug"), entry);
  if (this.cfg.console) printConsole(entry);
}
```

- [ ] **Step 3: Wire breakdown in dispatch perfLog call (aio.ts)**

In `src/aio.ts`, where `perfLog` is defined in the dispatch deps, update to pass
breakdown:

Find the line that calls `getLogger()?.perf(source, type, duration, budget)` and
update:

```ts
perfLog: (source, type, duration, budget) =>
  getLogger()?.perf(source, type, duration, budget),
```

This already works — the breakdown gets logged separately through `onPerf` →
time-travel. But for budget violations specifically, we should pass the
breakdown too.

Update `reportPerf` in `dispatch.ts` or the `perfLog` callback signature to
accept an optional breakdown parameter:

In `src/dispatch.ts` update `perfLog` type:

```ts
perfLog?: (
  source: "reduce" | "effect",
  type: string,
  duration: number,
  budget: number,
  breakdown?: ReduceBreakdown,
) => void;
```

And in `reportPerf`, pass it:

```ts
function reportPerf(source, duration, budget, type) {
  // ... existing error reporting ...
  if (perfLog && type) {
    perfLog(source, type, duration, budget, getBreakdown?.());
  }
}
```

And in `aio.ts`:

```ts
perfLog: (source, type, duration, budget, breakdown) =>
  getLogger()?.perf(source, type, duration, budget, breakdown),
```

- [ ] **Step 4: Run tests**

Run: `deno test` Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/logger.ts src/dispatch.ts src/aio.ts tests/reduce-breakdown.test.ts
git commit -m "feat: include breakdown in perf.log budget violation entries"
```

---

### Task 7: Final cleanup + deno check + deno lint

- [ ] **Step 1: Run type checker**

Run: `deno check src/mod.ts` Expected: No type errors

- [ ] **Step 2: Run linter**

Run: `deno lint` Expected: No lint errors

- [ ] **Step 3: Run full test suite**

Run: `deno test` Expected: All PASS, no regressions

- [ ] **Step 4: Verify the inline probes are fully removed**

Grep for `_t0`, `_t1`, `_t2`, `_rr0`, `_rr1`, `_tProduce`, `_tClone`,
`_tSpread`, `_rrOwner`, `_rrListeners`, `_rrTotal` in `src/feature-compose.ts` —
should find zero matches.

- [ ] **Step 5: Squash commits**

```bash
git reset --soft HEAD~7
git commit -m "feat: reduce phase breakdown in perf system"
```

- [ ] **Step 6: Export `ReduceBreakdown` from public API**

Check `src/mod.ts` — add `ReduceBreakdown` to the re-exports from
`time-travel.ts` so consumers can type the breakdown (e.g., custom dashboards).
