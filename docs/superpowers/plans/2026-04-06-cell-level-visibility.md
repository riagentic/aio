# Cell-Level Visibility & Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move state visibility (UI) and persistence (DB) config from app-level to cell-level with unified `CellFieldFilter` / `CellVisibility` types, defaulting to `"none"` for both. Add `cellDefaults` to `CellsConfig` so apps can set defaults once in `aio.run()`.

**Architecture:** Add `CellFieldFilter` and `CellVisibility` types to `cell-types.ts`. Update both cell config types (`MethodsCellConfig`, `ActionsCellConfig`) to accept the new `persist` and `ui` shapes. Add `cellDefaults` to `CellsConfig`. Normalize configs in `cell-create.ts` into internal `persistFilter` / `uiFilter` / `uiForUser` on `CellAio`. In `aio.ts` composition, apply `cellDefaults` fallback, then build `autoGetDBState` and `autoGetUIState` from resolved per-cell filters.

**Tech Stack:** Deno 2.6+, TypeScript

---

## File Map

**Types:**
- Modify: `src/cell-types.ts` — add `CellFieldFilter`, `CellVisibility` types; add `persistFilter`, `uiFilter`, `uiForUser` to `CellAio`; remove `persistExclude`

**Cell config:**
- Modify: `src/cell-create.ts` — update `persist` type on both config types; add `ui` config; normalize into new CellAio fields

**App config:**
- Modify: `src/aio.ts` — add `cellDefaults` to `CellsConfig`; apply defaults during composition; rewrite `autoGetDBState` builder; add `autoGetUIState` builder; update patch validity logic

**Broadcast:**
- Modify: `src/server.ts` — no structural changes needed (already uses `getUIState` + `hasStateFilter`)
- Modify: `src/uds.ts` — same

**Config validation:**
- Modify: `src/config.ts` — add `cellDefaults` to `VALID_FEATURES_CONFIG_KEYS`

**Tests:**
- Modify: `tests/cell.test.ts` — update persist tests, add ui config tests
- Modify: `tests/reduce-breakdown.test.ts` — update mock CellAio

**Docs:**
- Modify: `docs/persistence/auto-persist.md`
- Modify: `docs/state/cells.md`
- Create: `docs/upgrade/from-alpha10-to-alpha11.md`

---

### Task 1: Add CellFieldFilter and CellVisibility types

**Files:**
- Modify: `src/cell-types.ts:138-139`

- [ ] **Step 1: Add CellFieldFilter and CellVisibility types to `src/cell-types.ts`**

Add after the `ActionSource` type (after line 49):

```ts
/** Shared filter type — used by both persist and ui cell config */
export type CellFieldFilter =
  | "all"
  | "none"
  | { include: string[] }
  | { exclude: string[] };

/** Cell-level UI visibility — CellFieldFilter + optional per-user transform */
export type CellVisibility = CellFieldFilter | {
  include: string[];
  exclude?: never;
  forUser?: (
    exposed: Record<string, unknown>,
    user?: AioUser,
  ) => Record<string, unknown>;
} | {
  exclude: string[];
  include?: never;
  forUser?: (
    exposed: Record<string, unknown>,
    user?: AioUser,
  ) => Record<string, unknown>;
};
```

Note: `AioUser` is defined in `src/aio.ts`. To avoid circular deps, import it:

```ts
import type { AioUser } from "./aio.ts";
```

Check if this creates a circular dependency. `cell-types.ts` is a leaf module (comment on line 3 says so). If `aio.ts` imports from `cell-types.ts`, adding this import would create a cycle. In that case, define a minimal user type inline:

```ts
/** Minimal user shape for forUser — avoids importing from aio.ts */
type FilterUser = { id?: string; role?: string; [k: string]: unknown };
```

And use `FilterUser` instead of `AioUser` in the `CellVisibility` type.

- [ ] **Step 2: Replace `persistExclude` with new fields on CellAio**

In `src/cell-types.ts`, replace line 138-139:

```ts
  /** State keys to exclude from KV persistence */
  persistExclude?: string[];
```

With:

```ts
  /** Persistence filter — "all" | "none" | { include/exclude } */
  persistFilter?: CellFieldFilter;
  /** UI visibility filter — "all" | "none" | { include/exclude } */
  uiFilter?: CellFieldFilter;
  /** Optional per-user UI transform — receives structuredClone of filtered state */
  uiForUser?: (
    exposed: Record<string, unknown>,
    user?: FilterUser,
  ) => Record<string, unknown>;
```

- [ ] **Step 3: Run type check**

Run: `deno check src/cell-types.ts`
Expected: Errors in `cell-create.ts` and `aio.ts` (references to removed `persistExclude`). This confirms propagation.

- [ ] **Step 4: Commit**

```bash
git add src/cell-types.ts
git commit -m "refactor: add CellFieldFilter, CellVisibility types; replace persistExclude on CellAio"
```

---

### Task 2: Update cell config types and normalization in cell-create.ts

**Files:**
- Modify: `src/cell-create.ts:88-89,158-159,607,887`

- [ ] **Step 1: Update `persist` type on MethodsCellConfig (line 88-89)**

Replace:

```ts
  /** State keys to exclude from KV persistence — e.g. { exclude: ['htmlCache', 'largeBlob'] } */
  persist?: { exclude?: string[] };
```

With:

```ts
  /** Persistence filter — "all" persists everything, "none" (default) persists nothing.
   *  { include: [...] } or { exclude: [...] } for field-level control. */
  persist?: CellFieldFilter;
  /** UI visibility — "all" exposes everything, "none" (default) hides cell from clients.
   *  { include: [...] } or { exclude: [...] } for field-level control.
   *  Add forUser for per-user filtering on the already-filtered state. */
  ui?: CellVisibility;
```

- [ ] **Step 2: Update `persist` type on ActionsCellConfig (line 158-159)**

Replace:

```ts
  /** State keys to exclude from KV persistence — e.g. { exclude: ['htmlCache', 'largeBlob'] } */
  persist?: { exclude?: string[] };
```

With:

```ts
  /** Persistence filter — "all" persists everything, "none" (default) persists nothing.
   *  { include: [...] } or { exclude: [...] } for field-level control. */
  persist?: CellFieldFilter;
  /** UI visibility — "all" exposes everything, "none" (default) hides cell from clients.
   *  { include: [...] } or { exclude: [...] } for field-level control.
   *  Add forUser for per-user filtering on the already-filtered state. */
  ui?: CellVisibility;
```

- [ ] **Step 3: Add import for CellFieldFilter and CellVisibility**

Add to the import block from `"./cell-types.ts"` at the top of `cell-create.ts`:

```ts
import type { CellFieldFilter, CellVisibility } from "./cell-types.ts";
```

- [ ] **Step 4: Add `normalizePersistFilter` helper function**

Add after the imports in `cell-create.ts`:

```ts
/** Normalize persist config into CellFieldFilter for CellAio internals */
function normalizePersistFilter(
  persist: CellFieldFilter | undefined,
): CellFieldFilter | undefined {
  if (!persist) return undefined; // default: "none" (handled by composition)
  return persist;
}

/** Extract forUser from CellVisibility if present */
function extractForUser(
  ui: CellVisibility | undefined,
): ((exposed: Record<string, unknown>, user?: unknown) => Record<string, unknown>) | undefined {
  if (!ui || ui === "all" || ui === "none") return undefined;
  if ("forUser" in ui) return ui.forUser;
  return undefined;
}

/** Normalize ui config into CellFieldFilter (strip forUser) */
function normalizeUiFilter(
  ui: CellVisibility | undefined,
): CellFieldFilter | undefined {
  if (!ui) return undefined;
  if (ui === "all" || ui === "none") return ui;
  if ("include" in ui) return { include: ui.include };
  if ("exclude" in ui) return { exclude: ui.exclude };
  return undefined;
}
```

- [ ] **Step 5: Update methods-style internals assignment (line 607)**

Replace:

```ts
    persistExclude: config.persist?.exclude,
```

With:

```ts
    persistFilter: normalizePersistFilter(config.persist),
    uiFilter: normalizeUiFilter(config.ui),
    uiForUser: extractForUser(config.ui),
```

- [ ] **Step 6: Update actions-style internals assignment (line 887)**

Replace:

```ts
    persistExclude: config.persist?.exclude,
```

With:

```ts
    persistFilter: normalizePersistFilter(config.persist),
    uiFilter: normalizeUiFilter(config.ui),
    uiForUser: extractForUser(config.ui),
```

- [ ] **Step 7: Run type check**

Run: `deno check src/cell-create.ts`
Expected: Errors in `aio.ts` only (still references `persistExclude`). `cell-create.ts` itself should be clean.

- [ ] **Step 8: Commit**

```bash
git add src/cell-create.ts
git commit -m "refactor: update cell config types — persist as CellFieldFilter, add ui as CellVisibility"
```

---

### Task 3: Add cellDefaults to CellsConfig and apply during composition

**Files:**
- Modify: `src/aio.ts:242-293` (CellsConfig type)
- Modify: `src/aio.ts:386-412` (composition logic)
- Modify: `src/config.ts:67-114` (VALID_FEATURES_CONFIG_KEYS)

- [ ] **Step 1: Add `cellDefaults` to `CellsConfig` type in `src/aio.ts`**

Add after the `cells` field (around line 246):

```ts
  /** Default persist and ui config for all cells — individual cells override these */
  cellDefaults?: {
    ui?: import("./cell-types.ts").CellFieldFilter;
    persist?: import("./cell-types.ts").CellFieldFilter;
  };
```

- [ ] **Step 2: Add `cellDefaults` to `VALID_FEATURES_CONFIG_KEYS` in `src/config.ts`**

Add to the set:

```ts
  "cellDefaults",
```

- [ ] **Step 3: Apply cellDefaults during composition in `src/aio.ts`**

After `composeCells()` (around line 384), before the autoGetDBState builder, add:

```ts
      // Apply cellDefaults to cells that don't have explicit config
      const cellDefaults = fc.cellDefaults;
      if (cellDefaults) {
        for (const f of composed.cells) {
          if (!f.__aio.persistFilter && cellDefaults.persist) {
            f.__aio.persistFilter = cellDefaults.persist;
          }
          if (!f.__aio.uiFilter && cellDefaults.ui) {
            f.__aio.uiFilter = cellDefaults.ui;
          }
        }
      }
```

- [ ] **Step 4: Commit**

```bash
git add src/aio.ts src/config.ts
git commit -m "feat: add cellDefaults to CellsConfig — app-level defaults for cell persist/ui"
```

---

### Task 4: Rewrite autoGetDBState and add autoGetUIState

**Files:**
- Modify: `src/aio.ts:386-412,573-577,828-843,1281-1285`

- [ ] **Step 1: Add `applyCellFieldFilter` helper to `src/aio.ts`**

Add near the top of the file (after imports, before the main function):

```ts
/** Apply a CellFieldFilter to a cell's state slice — returns filtered object or undefined if "none" */
function applyCellFieldFilter(
  filter: import("./cell-types.ts").CellFieldFilter | undefined,
  cellState: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!filter || filter === "none") return undefined;
  if (filter === "all") return cellState;
  if ("include" in filter) {
    const result: Record<string, unknown> = {};
    for (const key of filter.include) {
      if (key in cellState) result[key] = cellState[key];
    }
    return result;
  }
  if ("exclude" in filter) {
    const result = { ...cellState };
    for (const key of filter.exclude) delete result[key];
    return result;
  }
  return undefined;
}
```

- [ ] **Step 2: Rewrite autoGetDBState builder (lines 386-412)**

Replace the entire block:

```ts
      // Build auto-stateForDB from per-cell persist excludes (if user didn't supply one)
      let autoGetDBState = fc.stateForDB;
      if (!fc.stateForDB) {
        const cellExcludes = new Map<string, string[]>();
        for (const f of composed.cells) {
          if (f.__aio.persistExclude?.length) {
            cellExcludes.set(f.__aio.id, f.__aio.persistExclude);
          }
        }
        if (cellExcludes.size > 0) {
          autoGetDBState = (s: unknown) => {
            const result = { ...(s as Record<string, unknown>) };
            for (const [cellName, excludeKeys] of cellExcludes) {
              if (
                result[cellName] && typeof result[cellName] === "object"
              ) {
                const filtered = {
                  ...(result[cellName] as Record<string, unknown>),
                };
                for (const key of excludeKeys) delete filtered[key];
                result[cellName] = filtered;
              }
            }
            return result;
          };
        }
      }
```

With:

```ts
      // Build auto-stateForDB from per-cell persist filters (if user didn't supply stateForDB)
      let autoGetDBState = fc.stateForDB;
      if (!fc.stateForDB) {
        // Collect cells that have any persist config (cells without persist config default to "none" = not persisted)
        const cellPersistFilters = new Map<string, import("./cell-types.ts").CellFieldFilter>();
        for (const f of composed.cells) {
          if (f.__aio.persistFilter) {
            cellPersistFilters.set(f.__aio.id, f.__aio.persistFilter);
          }
        }
        if (cellPersistFilters.size > 0) {
          autoGetDBState = (s: unknown) => {
            const full = s as Record<string, unknown>;
            const result: Record<string, unknown> = {};
            for (const [cellName, filter] of cellPersistFilters) {
              const cellState = full[cellName];
              if (!cellState || typeof cellState !== "object") continue;
              const filtered = applyCellFieldFilter(filter, cellState as Record<string, unknown>);
              if (filtered) result[cellName] = filtered;
            }
            return result;
          };
        } else {
          // No cells opted into persistence — persist nothing (default: "none")
          autoGetDBState = () => ({});
        }
      }
```

- [ ] **Step 3: Build autoGetUIState from per-cell ui filters**

Add after the autoGetDBState block (before the "Log cell composition" comment):

```ts
      // Build auto-stateForUI from per-cell ui filters (if user didn't supply stateForUI)
      let autoGetUIState = fc.stateForUI;
      let _hasForUser = false;
      if (!fc.stateForUI) {
        type UiEntry = {
          filter: import("./cell-types.ts").CellFieldFilter;
          forUser?: (exposed: Record<string, unknown>, user?: unknown) => Record<string, unknown>;
        };
        const cellUiEntries = new Map<string, UiEntry>();
        for (const f of composed.cells) {
          if (f.__aio.uiFilter) {
            cellUiEntries.set(f.__aio.id, {
              filter: f.__aio.uiFilter,
              forUser: f.__aio.uiForUser,
            });
            if (f.__aio.uiForUser) _hasForUser = true;
          }
        }
        if (cellUiEntries.size > 0) {
          // Structural cache — recomputed only when state ref changes
          let _structCache: Record<string, unknown> | null = null;
          let _structStateRef: unknown = null;
          const getStructural = (s: unknown): Record<string, unknown> => {
            if (s === _structStateRef && _structCache) return _structCache;
            _structStateRef = s;
            const full = s as Record<string, unknown>;
            const result: Record<string, unknown> = {};
            for (const [cellName, entry] of cellUiEntries) {
              const cellState = full[cellName];
              if (!cellState || typeof cellState !== "object") continue;
              const filtered = applyCellFieldFilter(entry.filter, cellState as Record<string, unknown>);
              if (filtered) result[cellName] = filtered;
            }
            _structCache = result;
            return result;
          };

          if (_hasForUser) {
            autoGetUIState = (s: unknown, user?: unknown) => {
              const structural = getStructural(s);
              const result: Record<string, unknown> = { ...structural };
              for (const [cellName, entry] of cellUiEntries) {
                if (!entry.forUser || !result[cellName]) continue;
                try {
                  result[cellName] = entry.forUser(
                    structuredClone(result[cellName] as Record<string, unknown>),
                    user as Record<string, unknown> | undefined,
                  );
                } catch (e) {
                  log.error(`[${cellName}] ui.forUser threw — using structural filter: ${e}`);
                  // fallback: keep structural result (already in result[cellName])
                }
              }
              return result;
            };
          } else {
            autoGetUIState = (s: unknown) => getStructural(s);
          }
        }
      }
```

- [ ] **Step 4: Pass autoGetUIState into the legacy AioConfig (line 573-577)**

Replace:

```ts
        stateForUI: fc.stateForUI as AioConfig<
          Record<string, unknown>,
          unknown,
          unknown
        >["stateForUI"],
```

With:

```ts
        stateForUI: autoGetUIState as AioConfig<
          Record<string, unknown>,
          unknown,
          unknown
        >["stateForUI"],
```

- [ ] **Step 5: Update hasStateFilter for patch validity**

The `hasStateFilter` flag (passed to `server.ts`) currently disables patches when `stateForUI` is set. Since we now pass `autoGetUIState` as `stateForUI`, any cell with `ui` config would disable patches.

**V1 approach (simple):** Keep patches disabled whenever any cell-level UI filtering is active. This is correct behavior — per-cell structural filtering changes which fields appear in the state, making patches computed against full state invalid. Optimization (filtering patches by cell+field path) can come in a follow-up.

This means no changes needed at lines 1281-1285 or 1549 — the existing `config.stateForUI != null` check already covers it because `autoGetUIState` is passed as `stateForUI`.

Verify: when no cells have `ui` config and no app-level `stateForUI` is set, `autoGetUIState` stays `undefined`, so `config.stateForUI` is `null` and patches work. Correct.

**V1 tradeoff:** When any cell has `ui` config (even `ui: "all"`), patches are globally disabled because `autoGetUIState` is set as `stateForUI`. Full filtered state is sent instead. This is safe — filtered states are smaller, so the perf impact is reduced. A follow-up can add per-cell patch filtering: keep patches for `ui: "all"` cells, filter patches by field for `include`/`exclude` cells, disable only for `forUser` cells.

- [ ] **Step 6: Run type check**

Run: `deno check src/aio.ts`
Expected: PASS (or minor type issues to fix).

- [ ] **Step 7: Commit**

```bash
git add src/aio.ts
git commit -m "feat: build autoGetDBState and autoGetUIState from per-cell filters"
```

---

### Task 5: Update tests

**Files:**
- Modify: `tests/cell.test.ts:778-813`
- Modify: `tests/reduce-breakdown.test.ts:64`

- [ ] **Step 1: Update existing persist tests in `tests/cell.test.ts`**

Replace lines 778-813 (the three persist tests) with:

```ts
// ── cell persist + ui config ──────────────────────────────────

Deno.test("cell persist: 'all' sets persistFilter on internals", () => {
  const f = cell("rich", {
    state: { name: "", htmlCache: "" },
    actions: { noop: () => ({}) },
    machine: false,
    persist: "all",
  });
  assertEquals(f.__aio.persistFilter, "all");
});

Deno.test("cell persist: { exclude } sets persistFilter on internals", () => {
  const f = cell("doc", {
    state: { title: "", body: "", rendered: "", thumbnail: "" },
    methods: {
      setTitle(s, t: string) { s.title = t; },
    },
    persist: { exclude: ["rendered", "thumbnail"] },
  });
  assertEquals(f.__aio.persistFilter, { exclude: ["rendered", "thumbnail"] });
});

Deno.test("cell persist: { include } sets persistFilter on internals", () => {
  const f = cell("small", {
    state: { count: 0, cache: "" },
    methods: { inc(s) { s.count++; } },
    persist: { include: ["count"] },
  });
  assertEquals(f.__aio.persistFilter, { include: ["count"] });
});

Deno.test("cell persist: absent defaults to undefined (none)", () => {
  const f = cell("plain", {
    state: { x: 0 },
    actions: { inc: () => ({}) },
    machine: false,
  });
  assertEquals(f.__aio.persistFilter, undefined);
});

Deno.test("cell ui: 'all' sets uiFilter on internals", () => {
  const f = cell("visible", {
    state: { count: 0 },
    methods: { inc(s) { s.count++; } },
    ui: "all",
  });
  assertEquals(f.__aio.uiFilter, "all");
});

Deno.test("cell ui: { include } sets uiFilter on internals", () => {
  const f = cell("partial", {
    state: { count: 0, secret: "" },
    methods: { inc(s) { s.count++; } },
    ui: { include: ["count"] },
  });
  assertEquals(f.__aio.uiFilter, { include: ["count"] });
});

Deno.test("cell ui: { exclude } sets uiFilter on internals", () => {
  const f = cell("filtered", {
    state: { count: 0, cache: "" },
    methods: { inc(s) { s.count++; } },
    ui: { exclude: ["cache"] },
  });
  assertEquals(f.__aio.uiFilter, { exclude: ["cache"] });
});

Deno.test("cell ui: forUser is extracted", () => {
  const fn = (exposed: Record<string, unknown>) => exposed;
  const f = cell("admin", {
    state: { users: [] as string[] },
    methods: { add(s, u: string) { s.users.push(u); } },
    ui: { include: ["users"], forUser: fn },
  });
  assertEquals(f.__aio.uiFilter, { include: ["users"] });
  assertEquals(f.__aio.uiForUser, fn);
});

Deno.test("cell ui: absent defaults to undefined (none)", () => {
  const f = cell("hidden", {
    state: { x: 0 },
    methods: { inc(s) { s.x++; } },
  });
  assertEquals(f.__aio.uiFilter, undefined);
  assertEquals(f.__aio.uiForUser, undefined);
});
```

- [ ] **Step 2: Update mock CellAio in `tests/reduce-breakdown.test.ts`**

At line 64, the mock has no `persistExclude` (it was removed in the earlier cell-simplification work). Verify the mock doesn't reference `persistExclude`. If any reference remains, replace with `persistFilter: undefined`. Also add `uiFilter: undefined` and `uiForUser: undefined` to the mock.

- [ ] **Step 3: Run tests**

Run: `deno test -A --unstable-kv tests/cell.test.ts tests/reduce-breakdown.test.ts`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/cell.test.ts tests/reduce-breakdown.test.ts
git commit -m "test: update persist tests, add ui config tests"
```

---

### Task 6: Verify config validation

- [ ] **Step 1: Verify config validation passes**

`cellDefaults` was already added to `VALID_FEATURES_CONFIG_KEYS` in Task 3. Cell-level `ui` and `persist` are on cell config objects (not `CellsConfig`), so no additional keys needed.

Run: `deno check mod.ts`
Expected: PASS — confirming no config validation issues.

---

### Task 7: Integration test — persist and ui filter in composition

**Files:**
- Modify: `tests/cell.test.ts` (append)

- [ ] **Step 1: Add integration test for persist filter composition**

Append to `tests/cell.test.ts`:

```ts
// ── Persist filter in composition ──────────────────────────────

Deno.test("compose: persist 'all' cell included, persist 'none' cell excluded from DB state", () => {
  const a = cell("kept", {
    state: { val: 1 },
    methods: { set(s, v: number) { s.val = v; } },
    persist: "all",
  });
  const b = cell("dropped", {
    state: { tmp: 0 },
    methods: { set(s, v: number) { s.tmp = v; } },
    // no persist → "none"
  });

  const composed = composeCells(
    [["kept", a], ["dropped", b]] as unknown as CellEntry[],
    {},
  );

  // Verify internals
  assertEquals(composed.cells[0].__aio.persistFilter, "all");
  assertEquals(composed.cells[1].__aio.persistFilter, undefined);
});

Deno.test("compose: persist { include } filters fields", () => {
  const f = cell("data", {
    state: { count: 0, cache: "", name: "x" },
    methods: { inc(s) { s.count++; } },
    persist: { include: ["count", "name"] },
  });

  assertEquals(f.__aio.persistFilter, { include: ["count", "name"] });
});
```

- [ ] **Step 2: Add integration test for ui filter composition**

Append to `tests/cell.test.ts`:

```ts
// ── UI filter in composition ──────────────────────────────

Deno.test("compose: ui 'all' cell visible, ui absent cell hidden", () => {
  const visible = cell("vis", {
    state: { count: 0 },
    methods: { inc(s) { s.count++; } },
    ui: "all",
  });
  const hidden = cell("bg", {
    state: { queue: [] as string[] },
    methods: { push(s, v: string) { s.queue.push(v); } },
    // no ui → "none"
  });

  const composed = composeCells(
    [["vis", visible], ["bg", hidden]] as unknown as CellEntry[],
    {},
  );

  assertEquals(composed.cells[0].__aio.uiFilter, "all");
  assertEquals(composed.cells[1].__aio.uiFilter, undefined);
});
```

- [ ] **Step 3: Add test for cellDefaults behavior**

Note: `cellDefaults` is applied in `aio.ts` composition, not in `cell-create.ts` or `composeCells()`. So this test verifies that cells without explicit config have `undefined` filters (cellDefaults applied later at app level). Testing the actual default application requires an integration test with `aio.run()` — add a note but don't require a full app boot test here.

```ts
// ── cellDefaults behavior ──────────────────────────────

Deno.test("cell without persist/ui has undefined filters (cellDefaults applied at app level)", () => {
  const f = cell("bare", {
    state: { x: 0 },
    methods: { inc(s) { s.x++; } },
  });

  assertEquals(f.__aio.persistFilter, undefined);
  assertEquals(f.__aio.uiFilter, undefined);
  assertEquals(f.__aio.uiForUser, undefined);
});

Deno.test("cell with explicit config overrides cellDefaults", () => {
  const f = cell("explicit", {
    state: { count: 0, secret: "" },
    methods: { inc(s) { s.count++; } },
    persist: { include: ["count"] },
    ui: { exclude: ["secret"] },
  });

  // These are set at cell level — cellDefaults won't overwrite them
  assertEquals(f.__aio.persistFilter, { include: ["count"] });
  assertEquals(f.__aio.uiFilter, { exclude: ["secret"] });
});
```

- [ ] **Step 4: Run tests**

Run: `deno test -A --unstable-kv tests/cell.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/cell.test.ts
git commit -m "test: add persist, ui filter, and cellDefaults composition tests"
```

---

### Task 8: Full test suite + type check

- [ ] **Step 1: Run full type check**

Run: `deno check mod.ts`
Expected: PASS — no type errors anywhere.

- [ ] **Step 2: Run full test suite**

Run: `deno test -A --unstable-kv tests/`
Expected: ALL PASS. Existing `stateForDB` and `stateForUI` tests in `tests/standalone.test.ts`, `tests/integration.test.ts`, and `tests/multi-user.test.ts` should still pass (app-level escape hatch preserved).

- [ ] **Step 3: Grep for stale references**

Run: `grep -r "persistExclude" src/ tests/ --include="*.ts"`
Expected: Zero matches.

- [ ] **Step 4: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: resolve any remaining type or test issues"
```

---

### Task 9: Update documentation

**Files:**
- Modify: `docs/persistence/auto-persist.md`
- Modify: `docs/state/cells.md`

- [ ] **Step 1: Update `docs/persistence/auto-persist.md`**

Update the per-cell persist section to document the new `CellFieldFilter` API:

```md
## Per-Cell Persistence

Each cell declares what gets persisted. Default: `"none"` (not persisted).

```ts
// Persist everything
persist: "all",

// Persist nothing (default — omit or set explicitly)
persist: "none",

// Only persist these fields
persist: { include: ["count", "name"] },

// Persist everything except these fields
persist: { exclude: ["cache", "htmlCache"] },
```

`stateForDB` at `aio.run()` level overrides all per-cell `persist` configs.
```

- [ ] **Step 2: Update `docs/state/cells.md`**

Add `ui` to the cell config reference table and update the `persist` entry to show new syntax.

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs: update persistence and cells docs for cell-level visibility"
```

---

### Task 10: Migration guide entry

**Files:**
- Modify: `docs/upgrade/from-alpha10-to-alpha11.md` (create if not exists)

- [ ] **Step 1: Add migration guide for cell-level visibility**

Add a section covering:

1. `persist` default changed from "persist everything" to `"none"` — add `persist: "all"` to cells that need persistence
2. New `ui` config — add `ui: "all"` to cells that should be visible in the browser
3. `persist: { exclude: [...] }` syntax unchanged — no migration needed for this form
4. App-level `stateForUI` and `stateForDB` still work as overrides

- [ ] **Step 2: Commit**

```bash
git add docs/upgrade/
git commit -m "docs: add alpha10 → alpha11 migration guide — cell-level visibility"
```

---

### Task 11: Final verification

- [ ] **Step 1: Run full type check**

Run: `deno check mod.ts`
Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run: `deno test -A --unstable-kv tests/`
Expected: ALL PASS.

- [ ] **Step 3: Verify no stale references**

Run: `grep -r "persistExclude" src/ tests/ aiol/ --include="*.ts"`
Expected: Zero matches.

- [ ] **Step 4: Verify existing stateForUI/stateForDB tests still pass**

Run: `deno test -A --unstable-kv tests/standalone.test.ts tests/integration.test.ts tests/multi-user.test.ts`
Expected: ALL PASS — app-level escape hatch preserved.
