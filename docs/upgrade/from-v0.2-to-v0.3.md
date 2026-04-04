# Upgrade from v0.2 to v0.3

### New features

- **Performance budgets** — dispatch loop timing with configurable thresholds.
  `perfMode: 'strict' | 'soft'` and `perfBudget: { reduce?, effect? }` in
  config. Violations call `onError({ source: 'performance', ... })` or warn
  (soft). Per-action perf metrics recorded in time-travel history. See
  [scaling.md — Performance budgets](scaling.md#performance-budgets)
- **Redux DevTools** — connect to the Redux DevTools browser extension for state
  inspection and action history. `connectDevTools()` / `disconnectDevTools()`
  from `'aio'`. See [ui.md — Redux DevTools](ui.md#redux-devtools-integration)
- **Incremental SQLite sync** — tables with a `pk()` column now use row-level
  INSERT/UPDATE/DELETE diffs instead of full table replacement. Significantly
  faster for large datasets. No migration needed — PK detection is automatic
- **Memoized selectors** — `createSelector(...inputFns, resultFn)` and
  `createSliceSelector`. Caches derived values until inputs change, preventing
  redundant recalculations.
- **`matchEffect(effect, handlers, fallback?)`** — typed alternative to
  switch/case in `execute()`. Scales better for large effect catalogs.
- **`composeMiddleware(...fns)`** — compose multiple `beforeReduce` functions
  into a single pipeline. Return `null` from any function to drop the action.
- **Android schedule warning** — unsupported schedule effects on Android now log
  `console.warn` instead of silently dropping

### Breaking changes

None. All v0.2 code runs unchanged on v0.3.

### Upgrade steps

1. Replace `dep/aio/` with the v0.3 folder
2. Run `deno install`
3. Run `deno task dev` — no linter warnings expected for v0.2 code

### Optional improvements

Take advantage of new features at your own pace:

```ts
// Performance budgets (catch slow reducers in CI)
await aio.run(state, {
  reduce,
  execute,
  perfMode: "strict",
  perfBudget: { reduce: 50, effect: 3000 },
  onError: ({ source, error }) => console.error(`[${source}]`, error),
});
```

```tsx
// Redux DevTools (add to App.tsx in dev)
import { connectDevTools, useAio } from "aio";
export default function App() {
  const { state, send } = useAio<AppState>();
  useEffect(() => {
    connectDevTools();
  }, []);
  // ...
}
```

```ts
// Memoized selectors (avoid recomputing expensive derivations)
import { createSelector } from "aio";
const selectFiltered = createSelector(
  (s: AppState) => s.items,
  (s: AppState) => s.filter,
  (items, filter) => items.filter((i) => i.status === filter),
);
```
