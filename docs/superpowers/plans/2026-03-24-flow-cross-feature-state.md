# Flow Cross-Feature State Access — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable flows to read the full app state tree and wait for state
conditions, completing cross-feature observability in generators.

**Architecture:** Two additions to the flow system: (1) expose the existing
`getFullState` closure in `GenCtx`, (2) add a `when` primitive with a parallel
`StateListener` registry that piggybacks on the dispatch loop. Both follow
existing patterns (`getState`, `waitFor`).

**Tech Stack:** Deno 2.6+, TypeScript, existing AIO flow infrastructure

**Spec:** `docs/superpowers/specs/2026-03-24-flow-cross-feature-state-design.md`

---

## File Map

| File                     | Role                                                 | Change Type        |
| ------------------------ | ---------------------------------------------------- | ------------------ |
| `src/flow.ts`            | Flow primitives, GenCtx, FlowStep, runner, listeners | Modify             |
| `src/feature-compose.ts` | Root reducer — dispatch loop                         | Modify (1 line)    |
| `tests/flow.test.ts`     | Flow test suite                                      | Modify (add tests) |

---

### Task 1: Expose `getFullState()` on GenCtx — tests

**Files:**

- Test: `tests/flow.test.ts`

- [ ] **Step 1: Write failing test — flow reads own feature state via
      getFullState**

Append to `tests/flow.test.ts`:

```ts
// ── ctx.getFullState ────────────────────────────────────────────────

const fullStateReader = feature("fullStateReader", {
  state: { count: 5, seen: 0 },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      const full = ctx.getFullState();
      const own = full.fullStateReader as { count: number };
      yield* ctx.done((s) => {
        s.seen = own.count;
      });
    },
  },
});

Deno.test("flow: ctx.getFullState reads own feature state", async () => {
  const app = createTestApp([fullStateReader]);
  app.dispatch(fullStateReader.start());
  await app.flush();

  const s = app.getState().fullStateReader as { count: number; seen: number };
  assertEquals(s.seen, 5);
});
```

- [ ] **Step 2: Write failing test — flow reads other feature's state via
      getFullState**

Append to `tests/flow.test.ts`:

```ts
const provider = feature("provider", {
  state: { value: 42 },
  actions: {},
});

const consumer = feature("consumer", {
  state: { grabbed: 0 },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      const full = ctx.getFullState();
      const other = full.provider as { value: number };
      yield* ctx.done((s) => {
        s.grabbed = other.value;
      });
    },
  },
});

Deno.test("flow: ctx.getFullState reads other feature's state", async () => {
  const app = createTestApp([provider, consumer]);
  app.dispatch(consumer.start());
  await app.flush();

  assertEquals((app.getState().consumer as any).grabbed, 42);
});
```

- [ ] **Step 3: Write failing test — getFullState returns fresh state after
      mutation**

```ts
const fullStateFresh = feature("fullStateFresh", {
  state: { count: 0, seenOther: 0 },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      yield* ctx.mutate("inc", (s) => {
        s.count = 10;
      });
      // After mutation, getFullState should reflect the updated value
      const full = ctx.getFullState();
      const own = full.fullStateFresh as { count: number };
      yield* ctx.done((s) => {
        s.seenOther = own.count;
      });
    },
  },
});

Deno.test({
  name: "flow: ctx.getFullState returns fresh state after mutation step",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([fullStateFresh]);
  app.dispatch(fullStateFresh.start());
  await app.flush();

  const s = app.getState().fullStateFresh as {
    count: number;
    seenOther: number;
  };
  assertEquals(s.seenOther, 10);
});
```

- [ ] **Step 4: Run tests to confirm they fail**

Run: `deno test tests/flow.test.ts --filter "getFullState" --no-check` Expected:
FAIL — `ctx.getFullState is not a function`

---

### Task 2: Expose `getFullState()` on GenCtx — implementation

**Files:**

- Modify: `src/flow.ts:89` (GenCtx type)
- Modify: `src/flow.ts:294-306` (buildCtx return)

- [ ] **Step 1: Add `getFullState` to GenCtx type**

In `src/flow.ts`, add to the `GenCtx` type (after `getState` at ~line 139-140):

```ts
/** Read full app state tree (all features). Fresh after each flow step. */
getFullState: (() => Record<string, unknown>);
```

- [ ] **Step 2: Expose getFullState in buildCtx return**

In `src/flow.ts`, in the `buildCtx` function return block (~line 294-306), add
after the `getState` line:

```ts
getFullState: () => getFullState(),
```

- [ ] **Step 3: Run tests to confirm they pass**

Run: `deno test tests/flow.test.ts --filter "getFullState" --no-check` Expected:
PASS (both tests)

- [ ] **Step 4: Run full flow test suite to confirm no regressions**

Run: `deno test tests/flow.test.ts --no-check` Expected: All existing tests
still pass

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts tests/flow.test.ts
git commit -m "feat: expose getFullState() on GenCtx in flows"
```

---

### Task 3: Add `when` primitive — FlowStep type + generator helper + StateListener registry

**Files:**

- Modify: `src/flow.ts:57-75` (FlowStep union)
- Modify: `src/flow.ts:~262-276` (generator helpers section)
- Modify: `src/flow.ts:~294-306` (buildCtx)
- Modify: `src/flow.ts:~311-320` (FlowInstance type)
- Modify: `src/flow.ts:~327-355` (listener registry + resetFlows)

- [ ] **Step 1: Add `when` variant to FlowStep union**

In `src/flow.ts`, add to the `FlowStep` type union (after the `waitFor` variant
at line 75):

```ts
| { kind: "when"; predicate: (state: Record<string, unknown>) => boolean; timeout?: number };
```

- [ ] **Step 2: Add `whenGen` generator helper**

In `src/flow.ts`, add after `waitForGen` (around line 275):

```ts
function* whenGen(
  predicate: (appState: Record<string, unknown>) => boolean,
  opts?: { timeout?: number },
): Gen<void> {
  yield { kind: "when", predicate, timeout: opts?.timeout } as FlowStep;
}
```

- [ ] **Step 3: Add `when` to GenCtx type**

In `src/flow.ts`, add to the `GenCtx` type (after `waitFor`):

```ts
/** Wait until a state condition is true. Checks immediately, then after every dispatch.
 *  @param predicate — receives full app state, returns boolean
 *  @param opts.timeout — ms before the wait fails (default: no timeout) */
when: ((
  predicate: (appState: Record<string, unknown>) => boolean,
  opts?: { timeout?: number },
) => Gen<void>);
```

- [ ] **Step 4: Wire `when` into buildCtx return**

In `src/flow.ts`, in `buildCtx` return block, add:

```ts
when: whenGen,
```

- [ ] **Step 5: Add `stateListener` field to FlowInstance**

In `src/flow.ts`, add to the `FlowInstance` type (after `abortController` at
~line 319):

```ts
/** Active state listener for ctx.when — tracked for abort cleanup */
stateListener?: StateListener;
```

- [ ] **Step 6: Add StateListener type and registry**

In `src/flow.ts`, add after the `ActionListener` registry (~line 330):

```ts
// ── State listener registry for ctx.when ─────────────────────────────

type StateListener = {
  predicate: (state: Record<string, unknown>) => boolean;
  resolve: () => void;
};
const _stateListeners = new Set<StateListener>();

/** Notify waiting flows when state changes — called from the dispatch loop after every reduce */
export function notifyStateListeners(state: Record<string, unknown>): void {
  for (const listener of _stateListeners) {
    try {
      if (listener.predicate(state)) {
        listener.resolve();
        _stateListeners.delete(listener);
      }
    } catch (e) {
      log.debug("aio", `when() predicate threw: ${e}`);
    }
  }
}
```

- [ ] **Step 7: Clean state listeners in abortInstance**

In `src/flow.ts`, in `abortInstance` (line 342), add before
`instance.aborted = true`:

```ts
if (instance.stateListener) {
  _stateListeners.delete(instance.stateListener);
  instance.stateListener = undefined;
}
```

- [ ] **Step 8: Clean state listeners in resetFlows**

In `src/flow.ts`, in `resetFlows` (line 354), add after
`_actionListeners.clear()`:

```ts
_stateListeners.clear();
```

- [ ] **Step 9: Verify types compile**

Run: `deno check src/flow.ts` Expected: No type errors

- [ ] **Step 10: Commit**

```bash
git add src/flow.ts
git commit -m "feat: add when() FlowStep type, StateListener registry, GenCtx wiring"
```

---

### Task 4: Add `when` primitive — executeStep handler

**Files:**

- Modify: `src/flow.ts:502-691` (executeStep switch)

- [ ] **Step 1: Add `case "when"` to executeStep**

In `src/flow.ts`, in the `executeStep` function switch block, add after the
`case "waitFor"` block (before the closing `}`):

```ts
    case "when": {
      // Check immediately — if already true, no suspension needed
      const currentState = app.getState();
      try {
        if (step.predicate(currentState)) return undefined;
      } catch (e) {
        log.debug("aio", `when() predicate threw: ${e}`);
        // Fall through to register listener — treat throw as false
      }

      // Dispatch waiting action for visibility
      app.dispatch({
        type: `${flowPrefix}when`,
        payload: {
          _flow: instance.flowName,
          timeout: step.timeout,
        },
        _source: "Effect",
      });

      // AbortController for instant cancellation (same pattern as waitFor)
      const controller = new AbortController();
      instance.abortController = controller;

      let listener: StateListener;
      const statePromise = new Promise<void>((resolve) => {
        listener = { predicate: step.predicate, resolve };
        _stateListeners.add(listener);
        instance.stateListener = listener;

        controller.signal.addEventListener("abort", () => {
          _stateListeners.delete(listener);
          instance.stateListener = undefined;
          resolve(); // resolve with undefined on abort — abortInstance sets instance.aborted
        }, { once: true });
      });

      if (step.timeout !== undefined) {
        const timeoutSentinel = Symbol("timeout");
        let timeoutId: ReturnType<typeof setTimeout>;
        const result = await Promise.race([
          statePromise.then(() => undefined as undefined),
          new Promise<typeof timeoutSentinel>((resolve) => {
            timeoutId = setTimeout(() => resolve(timeoutSentinel), step.timeout);
          }),
        ]);
        clearTimeout(timeoutId!); // clear timer whether state won or timeout won
        instance.abortController = undefined;
        instance.stateListener = undefined;
        if (result === timeoutSentinel) {
          _stateListeners.delete(listener!);
          throw new Error(
            `when() timed out after ${step.timeout}ms`,
          );
        }
        return undefined;
      }

      // Dev mode: warn if when() has no timeout and has been waiting 30s
      let warnTimer: ReturnType<typeof setTimeout> | undefined;
      if ((globalThis as Record<string, unknown>).__aioDev) {
        warnTimer = setTimeout(() => {
          log.warn(
            "aio",
            `${instance.featureName} when() has been waiting 30s with no timeout — did you mean to add one?`,
          );
        }, 30_000);
      }

      await statePromise;
      if (warnTimer) clearTimeout(warnTimer);
      instance.abortController = undefined;
      instance.stateListener = undefined;
      return undefined;
    }
```

- [ ] **Step 2: Verify types compile**

Run: `deno check src/flow.ts` Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/flow.ts
git commit -m "feat: add when() executeStep handler with timeout and abort support"
```

---

### Task 5: Wire `notifyStateListeners` into dispatch loop

**Files:**

- Modify: `src/feature-compose.ts:10` (import)
- Modify: `src/feature-compose.ts:532` (call site)

- [ ] **Step 1: Add import**

In `src/feature-compose.ts`, add `notifyStateListeners` to the import from
`./flow.ts` (line 10):

```ts
notifyFlowListeners,
notifyStateListeners,
```

- [ ] **Step 2: Add call after notifyFlowListeners**

In `src/feature-compose.ts`, after `notifyFlowListeners(action);` at line 532,
add:

```ts
notifyStateListeners(currentState);
```

- [ ] **Step 3: Verify types compile**

Run: `deno check src/feature-compose.ts` Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/feature-compose.ts
git commit -m "feat: wire notifyStateListeners into dispatch loop"
```

---

### Task 6: Tests — `ctx.when` happy path

**Files:**

- Test: `tests/flow.test.ts`

- [ ] **Step 1: Write test — condition already true resolves immediately**

Append to `tests/flow.test.ts`:

```ts
// ── ctx.when ────────────────────────────────────────────────────────

const whenImmediate = feature("whenImmediate", {
  state: { ready: true, proceeded: false },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      // Condition is already true — should resolve instantly
      yield* ctx.when((s) =>
        (s.whenImmediate as { ready: boolean }).ready === true
      );
      yield* ctx.done((s) => {
        s.proceeded = true;
      });
    },
  },
});

Deno.test("flow: ctx.when resolves immediately when condition already true", async () => {
  const app = createTestApp([whenImmediate]);
  app.dispatch(whenImmediate.start());
  await app.flush();

  assertEquals((app.getState().whenImmediate as any).proceeded, true);
});
```

- [ ] **Step 2: Write test — condition becomes true after dispatch**

```ts
const whenTrigger = feature("whenTrigger", {
  state: { active: false },
  actions: { activate: () => ({}) },
  reduce: {
    activate(state) {
      state.active = true;
    },
  },
});

const whenWaiter = feature("whenWaiter", {
  state: { saw: false },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      yield* ctx.when((s) =>
        (s.whenTrigger as { active: boolean }).active === true
      );
      yield* ctx.done((s) => {
        s.saw = true;
      });
    },
  },
});

Deno.test("flow: ctx.when resolves when condition becomes true after dispatch", async () => {
  const app = createTestApp([whenTrigger, whenWaiter]);
  app.dispatch(whenWaiter.start());
  await new Promise((r) => setTimeout(r, 30));

  // Condition not yet true
  assertEquals((app.getState().whenWaiter as any).saw, false);

  // Trigger the condition
  app.dispatch(whenTrigger.activate());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenWaiter as any).saw, true);
});
```

- [ ] **Step 3: Run tests**

Run: `deno test tests/flow.test.ts --filter "ctx.when" --no-check` Expected:
PASS (both tests)

- [ ] **Step 4: Commit**

```bash
git add tests/flow.test.ts
git commit -m "test: ctx.when happy path — immediate and deferred resolution"
```

---

### Task 7: Tests — `ctx.when` edge cases

**Files:**

- Test: `tests/flow.test.ts`

- [ ] **Step 1: Write test — when with timeout fires**

```ts
const whenTimeout = feature("whenTimeout", {
  state: { timedOut: false },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      try {
        yield* ctx.when(() => false, { timeout: 50 }); // never true
        yield* ctx.done();
      } catch {
        yield* ctx.done((s) => {
          s.timedOut = true;
        });
      }
    },
  },
});

Deno.test("flow: ctx.when with timeout throws on expiry", async () => {
  const app = createTestApp([whenTimeout]);
  app.dispatch(whenTimeout.start());
  await new Promise((r) => setTimeout(r, 200));

  assertEquals((app.getState().whenTimeout as any).timedOut, true);
});
```

- [ ] **Step 2: Write test — predicate throws treated as false**

```ts
const whenThrows = feature("whenThrows", {
  state: { proceeded: false },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      try {
        yield* ctx.when(() => {
          throw new Error("boom");
        }, { timeout: 50 });
      } catch {
        // Timeout expected — predicate always throws so condition never true
        yield* ctx.done((s) => {
          s.proceeded = true;
        });
      }
    },
  },
});

Deno.test("flow: ctx.when predicate that throws is treated as false", async () => {
  const app = createTestApp([whenThrows]);
  app.dispatch(whenThrows.start());
  await new Promise((r) => setTimeout(r, 200));

  // Should have timed out (predicate throws → treated as false → never resolves → timeout)
  assertEquals((app.getState().whenThrows as any).proceeded, true);
});
```

- [ ] **Step 3: Write test — flow cancelled cleans up state listener**

```ts
const whenCancelled = feature("whenCancelled", {
  state: { done: false },
  actions: {
    start: () => ({}),
    stop: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.when(() => false); // waits forever
      yield* ctx.done((s) => {
        s.done = true;
      });
    },
  },
  cancelOn: { start: ["stop"] },
});

Deno.test({
  name: "flow: cancelling a flow waiting on ctx.when cleans up listener",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([whenCancelled]);
  app.dispatch(whenCancelled.start());
  await new Promise((r) => setTimeout(r, 30));

  // Cancel
  app.dispatch(whenCancelled.stop());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenCancelled as any).done, false);
});
```

- [ ] **Step 4: Write test — multiple when listeners resolve independently**

```ts
const whenMultiA = feature("whenMultiA", {
  state: { resolved: false },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      yield* ctx.when((s) => (s.whenMultiTrigger as { a: boolean }).a === true);
      yield* ctx.done((s) => {
        s.resolved = true;
      });
    },
  },
});

const whenMultiB = feature("whenMultiB", {
  state: { resolved: false },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      yield* ctx.when((s) => (s.whenMultiTrigger as { b: boolean }).b === true);
      yield* ctx.done((s) => {
        s.resolved = true;
      });
    },
  },
});

const whenMultiTrigger = feature("whenMultiTrigger", {
  state: { a: false, b: false },
  actions: {
    setA: () => ({}),
    setB: () => ({}),
  },
  reduce: {
    setA(state) {
      state.a = true;
    },
    setB(state) {
      state.b = true;
    },
  },
});

Deno.test("flow: multiple ctx.when listeners resolve independently", async () => {
  const app = createTestApp([whenMultiTrigger, whenMultiA, whenMultiB]);
  app.dispatch(whenMultiA.start());
  app.dispatch(whenMultiB.start());
  await new Promise((r) => setTimeout(r, 30));

  // Trigger A only
  app.dispatch(whenMultiTrigger.setA());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenMultiA as any).resolved, true);
  assertEquals((app.getState().whenMultiB as any).resolved, false);

  // Trigger B
  app.dispatch(whenMultiTrigger.setB());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenMultiB as any).resolved, true);
});
```

- [ ] **Step 5: Run all when tests**

Run: `deno test tests/flow.test.ts --filter "ctx.when" --no-check` Expected: All
PASS

- [ ] **Step 6: Commit**

```bash
git add tests/flow.test.ts
git commit -m "test: ctx.when edge cases — timeout, predicate throws, cancel, multi-listener"
```

---

### Task 8: Tests — integration (when + waitFor, when inside race)

**Files:**

- Test: `tests/flow.test.ts`

- [ ] **Step 1: Write test — when combined with waitFor in same flow**

```ts
const whenAndWaitFor = feature("whenAndWaitFor", {
  state: { phase: "init" },
  actions: {
    start: () => ({}),
    signal: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      // First wait for state condition
      yield* ctx.when((s) =>
        (s.whenAndWaitForTrigger as { ready: boolean }).ready === true
      );
      yield* ctx.mutate("phase1", (s) => {
        s.phase = "condition-met";
      });

      // Then wait for an action
      yield* ctx.waitFor("whenAndWaitFor:signal");
      yield* ctx.done((s) => {
        s.phase = "complete";
      });
    },
  },
});

const whenAndWaitForTrigger = feature("whenAndWaitForTrigger", {
  state: { ready: false },
  actions: { activate: () => ({}) },
  reduce: {
    activate(state) {
      state.ready = true;
    },
  },
});

Deno.test("flow: ctx.when + ctx.waitFor in same flow", async () => {
  const app = createTestApp([whenAndWaitForTrigger, whenAndWaitFor]);
  app.dispatch(whenAndWaitFor.start());
  await new Promise((r) => setTimeout(r, 30));

  assertEquals((app.getState().whenAndWaitFor as any).phase, "init");

  // Satisfy when condition
  app.dispatch(whenAndWaitForTrigger.activate());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenAndWaitFor as any).phase, "condition-met");

  // Satisfy waitFor
  app.dispatch(whenAndWaitFor.signal());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenAndWaitFor as any).phase, "complete");
});
```

- [ ] **Step 2: Write test — when inside ctx.race**

```ts
const whenRace = feature("whenRace", {
  state: { winner: "" },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      const result = yield* ctx.race({
        condition: ctx.when((s) =>
          (s.whenRaceTrigger as { flag: boolean }).flag === true
        ),
        timeout: ctx.sleep("timeout", 500),
      });
      yield* ctx.done((s) => {
        s.winner = result.condition !== undefined ? "condition" : "timeout";
      });
    },
  },
});

const whenRaceTrigger = feature("whenRaceTrigger", {
  state: { flag: false },
  actions: { setFlag: () => ({}) },
  reduce: {
    setFlag(state) {
      state.flag = true;
    },
  },
});

Deno.test({
  name: "flow: ctx.when inside ctx.race resolves when condition met",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([whenRaceTrigger, whenRace]);
  app.dispatch(whenRace.start());
  await new Promise((r) => setTimeout(r, 30));

  app.dispatch(whenRaceTrigger.setFlag());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenRace as any).winner, "condition");
});
```

- [ ] **Step 3: Run integration tests**

Run: `deno test tests/flow.test.ts --filter "ctx.when" --no-check` Expected: All
PASS

- [ ] **Step 4: Commit**

```bash
git add tests/flow.test.ts
git commit -m "test: ctx.when integration — when+waitFor combo, when inside race"
```

---

### Task 9: Full regression + type check

**Files:** All modified files

- [ ] **Step 1: Run full type check**

Run: `deno check src/flow.ts src/feature-compose.ts` Expected: No errors

- [ ] **Step 2: Run full flow test suite**

Run: `deno test tests/flow.test.ts --no-check` Expected: All tests pass
(existing + new)

- [ ] **Step 3: Run full project test suite**

Run: `deno test --no-check` Expected: No regressions

- [ ] **Step 4: Squash commits and final commit**

Squash all task commits into one:

```bash
git rebase -r HEAD~N  # where N = number of commits from tasks
git commit -m "feat: flow cross-feature state — getFullState() + ctx.when() primitive"
```
