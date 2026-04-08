# Cell Config Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the dead `dispatchTo` config category and restructure docs into L1/L2/L3 progressive tiers so new users see only `state + methods + selectors + persist` first.

**Architecture:** Two independent changes: (1) remove dispatchTo from types, runtime, tests, and docs; (2) restructure existing docs content into tiered progression without changing any other API surface.

**Tech Stack:** Deno 2.6+, TypeScript

---

## File Map

**Part 1 — dispatchTo removal:**
- Modify: `src/cell-types.ts` (remove `crossDispatchPrefixes` field)
- Modify: `src/cell-create.ts` (remove config property, delete `resolveCrossDispatchPrefixes` function, remove 2 callsites)
- Modify: `src/cell-compose.ts` (remove dispatch guard block)
- Modify: `tests/cell.test.ts` (remove 3 test cases)
- Modify: `tests/reactive.test.ts` (remove 1 test case)
- Modify: `tests/reduce-breakdown.test.ts` (remove mock field)
- Modify: `aiol/checks.ts` (update hint message)
- Modify: 7 doc files (remove dispatchTo references)

**Part 2 — doc tiers:**
- Modify: `docs/state/README.md` (restructure into L1/L2/L3)
- Modify: `docs/basics/quickstart.md` (trim to L1 only)
- Modify: `docs/state/cells.md` (remove dispatchTo from table)
- Modify: `docs/state/actions-reduce.md` (remove dispatchTo section)

---

### Task 1: Remove dispatchTo from type definitions

**Files:**
- Modify: `src/cell-types.ts:124`
- Modify: `src/cell-create.ts:86-90,161-165`

- [ ] **Step 1: Remove `crossDispatchPrefixes` from CellAio type in `src/cell-types.ts`**

Delete lines 123-124:

```ts
  /** Prefixes this executor is allowed to cross-dispatch to */
  crossDispatchPrefixes: Set<string>;
```

- [ ] **Step 2: Remove `dispatchTo` from MethodsCellConfig in `src/cell-create.ts`**

Delete lines 86-90:

```ts
  /** Cells this cell's execute() is allowed to dispatch to.
   *  Acts as an explicit dependency declaration — prevents accidental
   *  cross-cell dispatch and makes dependencies visible at a glance.
   *  @example dispatchTo: [wallet, notifications] */
  dispatchTo?: (string | { name: string })[];
```

- [ ] **Step 3: Remove `dispatchTo` from ActionsCellConfig in `src/cell-create.ts`**

Delete lines 161-165:

```ts
  /** Cells this cell's execute() is allowed to dispatch to.
   *  Acts as an explicit dependency declaration — prevents accidental
   *  cross-cell dispatch and makes dependencies visible at a glance.
   *  @example dispatchTo: [wallet, notifications] */
  dispatchTo?: (string | { name: string })[];
```

- [ ] **Step 4: Run type check**

Run: `deno check src/cell-types.ts src/cell-create.ts`
Expected: Errors in cell-create.ts and cell-compose.ts (references to removed fields). This confirms the type removal propagates correctly.

- [ ] **Step 5: Commit**

```bash
git add src/cell-types.ts src/cell-create.ts
git commit -m "refactor: remove dispatchTo from type definitions"
```

---

### Task 2: Remove dispatchTo runtime logic

**Files:**
- Modify: `src/cell-create.ts:609,700-713,908`
- Modify: `src/cell-compose.ts:819-847`

- [ ] **Step 1: Delete `resolveCrossDispatchPrefixes` function from `src/cell-create.ts`**

Delete lines 700-713:

```ts
/** Resolve cross-dispatch prefixes from dispatchTo config (cell refs → prefix strings) */
function resolveCrossDispatchPrefixes(
  dispatchTo: (string | CellDef | { name: string })[] | undefined,
): Set<string> {
  return new Set(
    (dispatchTo ?? []).map((f) =>
      typeof f === "string"
        ? f
        : ("__aio" in f
          ? (f as CellDef).__aio.id
          : (f as { name: string }).name)
    ),
  );
}
```

- [ ] **Step 2: Remove `crossDispatchPrefixes` assignment in methods-style cell creation (line 609)**

Change:

```ts
    crossDispatchPrefixes: resolveCrossDispatchPrefixes(config.dispatchTo),
```

To: delete this line entirely.

- [ ] **Step 3: Remove `crossDispatchPrefixes` assignment in actions-style cell creation (line 908)**

Change:

```ts
    crossDispatchPrefixes: resolveCrossDispatchPrefixes(config.dispatchTo),
```

To: delete this line entirely.

- [ ] **Step 4: Remove dispatch guard in `src/cell-compose.ts`**

Replace lines 819-848 (the scoped dispatch block):

```ts
    // Scoped dispatch — runtime guard: own actions + dispatchTo allowlist
    const ownPrefix = f.__aio.id + ":";
    const crossPrefixes = f.__aio.crossDispatchPrefixes;
    const cellName = f.__aio.id;
    const scopedApp: ScopedApp & {
      _isDisabled?: () => boolean;
      _onError?: (err: AioError) => void;
    } = {
      _isDisabled: () => disabledCells.has(cellName),
      _onError: _reportError,
      dispatch: (a: Msg) => {
        if (typeof a?.type !== "string") return;
        if (!a.type.startsWith(ownPrefix)) {
          // Check dispatchTo allowlist
          const colonIdx = a.type.indexOf(":");
          const targetPrefix = colonIdx !== -1 ? a.type.slice(0, colonIdx) : "";
          if (!crossPrefixes.has(targetPrefix)) {
            const msg =
              `[${f.__aio.id}] cross-dispatch blocked → '${targetPrefix}'. Fix: add dispatchTo: [${targetPrefix}]`;
            countCellError(f.__aio.id);
            _reportError?.(
              createAioError("MACHINE_BLOCKED", msg, {
                cellName: f.__aio.id,
                actionType: a.type,
              }),
            );
            throw new Error(msg);
          }
        }
        app.dispatch(tagSource(a, "Effect"));
      },
```

With:

```ts
    const cellName = f.__aio.id;
    const scopedApp: ScopedApp & {
      _isDisabled?: () => boolean;
      _onError?: (err: AioError) => void;
    } = {
      _isDisabled: () => disabledCells.has(cellName),
      _onError: _reportError,
      dispatch: (a: Msg) => {
        if (typeof a?.type !== "string") return;
        app.dispatch(tagSource(a, "Effect"));
      },
```

- [ ] **Step 5: Run type check**

Run: `deno check src/cell-create.ts src/cell-compose.ts`
Expected: PASS — all references to crossDispatchPrefixes and dispatchTo removed.

- [ ] **Step 6: Commit**

```bash
git add src/cell-create.ts src/cell-compose.ts
git commit -m "refactor: remove dispatchTo runtime logic and dispatch guard"
```

---

### Task 3: Remove dispatchTo tests

**Files:**
- Modify: `tests/cell.test.ts:674-802`
- Modify: `tests/reactive.test.ts:505-517`
- Modify: `tests/reduce-breakdown.test.ts:62`

- [ ] **Step 1: Delete 3 test cases from `tests/cell.test.ts`**

Delete lines 674-802 (the entire block):

```ts
// ── Fix C: dispatchTo allowlist ──

Deno.test("compose: dispatchTo allows dispatching to allowlisted cells", () => {
  // ... entire test ...
});

Deno.test("compose: dispatchTo blocks non-allowlisted cells", () => {
  // ... entire test ...
});

Deno.test("compose: dispatch without dispatchTo blocks all foreign actions", () => {
  // ... entire test ...
});
```

- [ ] **Step 2: Delete 1 test case from `tests/reactive.test.ts`**

Delete lines 505-517:

```ts
Deno.test("cell(methods): dispatchTo config", () => {
  const source = cell("source", {
    state: { value: 0 },
    dispatchTo: ["target"],
    methods: {
      set(s, v: number) {
        s.value = v;
      },
    },
  });

  assertEquals(source.__aio.crossDispatchPrefixes.has("target"), true);
});
```

- [ ] **Step 3: Remove `crossDispatchPrefixes` from mock in `tests/reduce-breakdown.test.ts`**

Delete line 62:

```ts
      crossDispatchPrefixes: new Set<string>(),
```

- [ ] **Step 4: Run all tests**

Run: `deno test -A --unstable-kv tests/`
Expected: ALL PASS (minus the 4 deleted tests).

- [ ] **Step 5: Commit**

```bash
git add tests/cell.test.ts tests/reactive.test.ts tests/reduce-breakdown.test.ts
git commit -m "test: remove dispatchTo test cases"
```

---

### Task 4: Remove dispatchTo from linter

**Files:**
- Modify: `aiol/checks.ts:1171`

- [ ] **Step 1: Update linter hint message**

Change line 1171 from:

```ts
`${file.relative}: accesses "${f.name}" state directly — use selectors or dispatchTo for loose coupling`
```

To:

```ts
`${file.relative}: accesses "${f.name}" state directly — use selectors for loose coupling`
```

- [ ] **Step 2: Commit**

```bash
git add aiol/checks.ts
git commit -m "fix: update linter hint — remove dispatchTo reference"
```

---

### Task 5: Remove dispatchTo from documentation

**Files:**
- Modify: `docs/state/cells.md:62-70`
- Modify: `docs/state/actions-reduce.md:129-156`
- Modify: `docs/debugging/production.md:124-129`
- Modify: `docs/state/composition.md` (if dispatchTo mentioned)
- Modify: `docs/upgrade/from-v0.7-to-v0.8.md:120-130,252`
- Modify: `docs/upgrade/from-v0.6-to-v0.7.md:19`
- Modify: `docs/testing/linter.md:156`
- Modify: `docs/examples/02-checkout-workflow.md:226-228`

- [ ] **Step 1: Remove dispatchTo row from `docs/state/cells.md` API table**

Delete the `dispatchTo` row from the config reference table (around line 62-70).

- [ ] **Step 2: Remove dispatchTo section from `docs/state/actions-reduce.md`**

Delete the "## dispatchTo" section and the scoped dispatch rules mentioning dispatchTo (lines 129-156).

- [ ] **Step 3: Remove "dispatch blocked" error section from `docs/debugging/production.md`**

Delete the dispatchTo fix example (lines 124-129).

- [ ] **Step 4: Remove dispatchTo from `docs/upgrade/from-v0.7-to-v0.8.md`**

Delete the migration section about dispatchTo accepting feature objects (lines 120-130) and migration step 9 (line 252).

- [ ] **Step 5: Remove dispatchTo from `docs/upgrade/from-v0.6-to-v0.7.md`**

Change line 19 from:

```
- Selectors, dispatchTo, onInit/onDestroy hooks all work
```

To:

```
- Selectors, onInit/onDestroy hooks all work
```

- [ ] **Step 6: Update `docs/testing/linter.md`**

Change line 156 from:

```
- Direct state access across cells (use selectors or `dispatchTo`)
```

To:

```
- Direct state access across cells (use selectors)
```

- [ ] **Step 7: Update `docs/examples/02-checkout-workflow.md`**

Remove or rewrite the "Direct calling vs dispatchTo" comparison (lines 226-228). Replace with:

```
> **Direct calling:** Request/response style — call a method, get a result.
> Cross-cell communication uses direct method calls or effects.
```

- [ ] **Step 8: Commit**

```bash
git add docs/
git commit -m "docs: remove all dispatchTo references"
```

---

### Task 6: Restructure state README into L1/L2/L3 tiers

**Files:**
- Modify: `docs/state/README.md`

- [ ] **Step 1: Rewrite `docs/state/README.md` with tiered structure**

Replace entire file with:

```md
# State Management

Defining cells, managing state, and coordinating workflows.

## L1 — Every App

Start here. Covers 90% of what you need.

- [Cells](cells.md) — cell() anatomy and config reference
- [Methods](methods.md) — sync/async methods, selectors, Immer

## L2 — Complex Apps

Add when you need sequential workflows, state machines, or lifecycle hooks.

- [Generators](generators.md) — sequential async workflows
- [Generators API](generators-api.md) — GenCtx method reference
- [State Machines](machines.md) — guards and transitions
- [Lifecycle](lifecycle.md) — onInit, onDestroy, validate
- [Composition](composition.md) — cross-cell communication
- [Scheduling](scheduling.md) — timers, intervals, cron

## L3 — Explicit Pipeline

For time-travel debugging, action replay, or strict pure/impure separation. Methods do everything this tier does — use L3 when you need the decomposition.

- [Actions & Reduce](actions-reduce.md) — explicit action/reduce/execute/effects style
```

- [ ] **Step 2: Commit**

```bash
git add docs/state/README.md
git commit -m "docs: restructure state README into L1/L2/L3 tiers"
```

---

### Task 7: Trim quickstart to L1 only

**Files:**
- Modify: `docs/basics/quickstart.md:104-131`

- [ ] **Step 1: Remove the "Choosing a programming style" comparison table and generators example**

Replace lines 104-131 (the style comparison table + generators code example) with:

```md
## Programming style

**Start with `methods`.** They handle state changes, async work, and side effects
in one place. This covers the vast majority of apps.

When you outgrow methods, aio has generators for sequential async workflows and
an explicit actions/reduce pipeline for strict state machines — see the
[State Management](../state/README.md) guide for L2 and L3 patterns.
```

- [ ] **Step 2: Commit**

```bash
git add docs/basics/quickstart.md
git commit -m "docs: trim quickstart to L1 — methods only, link to advanced tiers"
```

---

### Task 8: Verify and final commit

- [ ] **Step 1: Run full type check**

Run: `deno check src/mod.ts`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `deno test -A --unstable-kv tests/`
Expected: ALL PASS

- [ ] **Step 3: Grep for any remaining dispatchTo references in source code**

Run: `grep -r "dispatchTo\|crossDispatchPrefixes" src/ tests/ aiol/ --include="*.ts"`
Expected: Zero matches.

- [ ] **Step 4: Grep for remaining dispatchTo in docs (expect only upgrade guides as historical notes if any remain)**

Run: `grep -r "dispatchTo" docs/`
Expected: Zero matches (all removed in Task 5).
