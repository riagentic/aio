# Upgrading from alpha10 to alpha11

## Breaking: feature() → cell()

The core API has been renamed. "Cell" reflects what it actually is — a state
cell, one building block of your app. Not an isolated feature, but an honest
building block that cooperates with other cells.

### Quick migration

Find-and-replace covers 95% of cases:

| Find                            | Replace         |
| ------------------------------- | --------------- |
| `feature(`                      | `cell(`         |
| `useFeature(`                   | `useCell(`      |
| `testFeature(`                  | `testCell(`     |
| `composeFeatures(`              | `composeCells(` |
| `features:` (in aio.run config) | `cells:`        |
| `FeatureDef`                    | `CellDef`       |
| `FeatureEntry`                  | `CellEntry`     |
| `FeatureRef`                    | `CellRef`       |
| `ComposedFeatures`              | `ComposedCells` |

### Import changes

```typescript
// Before
import { composeFeatures, feature, testFeature } from "aio";
import { useFeature } from "aio/react";
import { useFeature } from "aio/adapters/air";

// After
import { cell, composeCells, testCell } from "aio";
import { useCell } from "aio/react";
import { useCell } from "aio/adapters/air";
```

### aio.run() config

```typescript
// Before
await aio.run({
  appId: "my-app",
  features: [counter, auth],
  ...
});

// After
await aio.run({
  appId: "my-app",
  cells: [counter, auth],
  ...
});
```

### Type renames

All `Feature*` types are now `Cell*`:

| Before                   | After                 |
| ------------------------ | --------------------- |
| `FeatureDef<N, A, E, S>` | `CellDef<N, A, E, S>` |
| `FeatureAio<A, E, S>`    | `CellAio<A, E, S>`    |
| `FeatureEntry`           | `CellEntry`           |
| `FeatureRef`             | `CellRef`             |
| `FeatureReduceFn`        | `CellReduceFn`        |
| `FeatureExecuteFn`       | `CellExecuteFn`       |
| `FeatureStatus`          | `CellStatus`          |
| `FeatureMethods<S>`      | `CellMethods<S>`      |
| `MethodsFeatureConfig`   | `MethodsCellConfig`   |
| `ActionsFeatureConfig`   | `ActionsCellConfig`   |
| `ComposedFeatures`       | `ComposedCells`       |
| `FeaturesConfig`         | `CellsConfig`         |

### Recommended project structure (new)

alpha11 introduces a new recommended project layout. Optional but recommended:

```
src/
  app.ts              ← aio.run({ cells }) — wiring only
  App.tsx             ← root layout + routing only
  cell/               ← cell definitions (state + behavior)
  type/               ← all exported types
  lib/                ← pure functions, no aio imports
  ui/                 ← components
  test/               ← tests, mirrors source
```

See [Project Structure](../basics/project-structure.md) for full details.

### `am` CLI

`am new feature <name>` is now `am new cell <name>`.

### Linter

The aiol linter now detects `cell()` instead of `feature()`. If you have custom
linter configs referencing feature checks, update them.

### Migration effort

- Small apps (1-5 cells): 5 minutes (find-replace)
- Medium apps (5-15 cells): 15 minutes
- Large apps (15+ cells): 30 minutes

No logic changes needed — this is a pure rename.

---

## Cell-Level Visibility & Persistence

### Breaking Changes

> **⚠️ Superseded in alpha13.** This `"none"` default applied only to
> alpha11–alpha12. alpha13 reverted the default back to `"all"` (zero-config
> persists and syncs again) — see
> [from-alpha12-to-alpha13](./from-alpha12-to-alpha13.md). If you are on
> alpha13+, ignore the `"none"` guidance below.

**`persist` default changed to `"none"`.** Cells no longer persist state by
default. Add `persist: "all"` to cells that need persistence, or set a default
for all cells:

```ts
await aio.run({
  cells: [counter, auth],
  cellDefaults: { persist: "all" },
});
```

**New `ui` config — default `"none"`.** Cells are not exposed to the browser by
default. Add `ui: "all"` to cells that should be visible:

```ts
await aio.run({
  cells: [counter, auth],
  cellDefaults: { ui: "all", persist: "all" },
});
```

### One-Line Migration

For most apps, add one line to `aio.run()` to match previous behavior:

```ts
cellDefaults: { ui: "all", persist: "all" },
```

Then progressively tighten per-cell as needed.

### Removed: `stateForDB` and `stateForUI`

Both app-level god-functions are removed. Cell-level `persist` and `ui` configs
replace them entirely.

| Before                                    | After                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `stateForDB: (s) => ({ count: s.count })` | `persist: { include: ["count"] }` on the cell                          |
| `stateForUI: (s) => ({ count: s.count })` | `ui: { include: ["count"] }` on the cell                               |
| `stateForUI: (s, user?) => ...`           | `ui: { include: [...], forUser: (exposed, user?) => ... }` on the cell |

If you used `stateForUI` for cross-cell derived views, move that logic to a
client-side selector or component.

### Patch optimization

Cells with structural UI filters (`include`/`exclude` without `forUser`) now use
patch-based broadcasts — only changed, visible fields are sent over the wire.
This is automatic. No config needed.

| Cell UI config            | Broadcast method                                          |
| ------------------------- | --------------------------------------------------------- |
| `ui: "all"`               | Raw Immer patches (most efficient)                        |
| `ui: "none"`              | Nothing sent                                              |
| `ui: { include/exclude }` | Filtered Immer patches                                    |
| `ui: { ..., forUser }`    | Full filtered state (per-user transform prevents patches) |

---

## Direct Cell Access (New)

Cells now expose state fields directly. No hooks, no `send`, no loading guards.

### Before (useCell + send)

```tsx
import { useCell } from "aio/air";
import { counter } from "./app.ts";

export default function App() {
  const { state, send } = useCell(counter);
  if (!state) return <div>Connecting...</div>;
  return (
    <div>
      <h1>{state.count}</h1>
      <button onClick={() => send.increment()}>+</button>
    </div>
  );
}
```

### After (direct access)

```tsx
import { counter } from "./app.ts";

export default function App() {
  return (
    <div>
      <h1>{counter.count}</h1>
      <button onClick={() => counter.increment()}>+</button>
    </div>
  );
}
```

One import, zero ceremony. State reads are reactive (signal-backed in the
browser). Methods dispatch directly (already worked since binding).

**Note:** `useCell` was removed from public exports in alpha12. Use the direct
pattern shown above.

If a state key and method share a name (e.g., `error`), the method takes
priority on the cell object. State is still accessible via the signal
internally.

---

### What Still Works

- `persist: { exclude: [...] }` syntax is unchanged
- All existing cell configs continue to work
- `useCell` was removed in alpha12 — use direct cell access
