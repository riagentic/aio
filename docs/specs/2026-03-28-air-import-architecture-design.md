# AIR Import Architecture — Three-Tier Subpath Design

## Goal

Split the monolith `'aio'` import into three clean subpaths so that each import
path has exactly one responsibility: server/protocol, AIR rendering, or React
rendering. Enable copy-paste migration from React to AIR by exporting
React-compatible compat hooks from `'aio/air'`.

## Architecture

Three subpaths, one package:

```
aio         → server-side, protocol, feature defs, types (no renderer, no DOM)
aio/air     → AIR signal-based renderer + compat hooks + re-exports aio base
aio/react   → React hooks + re-exports aio base
```

**Litmus test:** `import { feature, aio, log } from 'aio'` must work in a
headless Deno process with zero DOM dependencies. If it pulls in React, signals,
or renderer code — it's wrong.

**Migration test:** Take any React component, change
`import { ... } from 'react'` to `import { ... } from 'aio/air'`. It must
compile, run correctly for standard patterns, and emit dev-mode hints explaining
AIR-native alternatives.

## Import Map (deno.json exports)

```json
{
  "exports": {
    ".": "./mod.ts",
    "./air": "./src/air.ts",
    "./react": "./src/react.ts",
    "./jsx-runtime": "./src/jsx-runtime.ts",
    "./adapters/react": "./src/adapters/react.ts",
    "./adapters/air": "./src/adapters/air.ts",
    "./state-core": "./src/state-core.ts",
    "./src/build": "./src/build.ts",
    "./src/am": "./src/am.ts",
    "./aiol": "./aiol/mod.ts"
  }
}
```

## File Structure

### New files

| File            | Purpose                                                                          | Size estimate      |
| --------------- | -------------------------------------------------------------------------------- | ------------------ |
| `src/air.ts`    | AIR entry point — re-exports `browser-air.ts` + `compat.ts` + base `mod.ts`      | ~60 lines (barrel) |
| `src/react.ts`  | React entry point — re-exports `browser.ts` + base `mod.ts`                      | ~30 lines (barrel) |
| `src/compat.ts` | React migration compat hooks — `useState`, `useEffect`, `useCallback`, `useMemo` | ~80 lines          |

### Modified files

| File        | Change                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `mod.ts`    | Strip renderer-specific exports (React hooks, AIR renderer, vdom, signals). Keep only server/protocol/types. |
| `deno.json` | Add `./air` and `./react` export entries                                                                     |

### Unchanged files

`browser-air.ts`, `browser.ts`, `browser-protocol.ts`, `aio-renderer.ts`,
`signal.ts`, `vdom.ts` — no modifications. New files are wiring only.

## Hook Categories

### Identical (same name, same behavior, no warnings)

These are genuinely the same API in React and AIR. Exported from both
`'aio/air'` and `'aio/react'`.

| Hook                                    | Source            |
| --------------------------------------- | ----------------- |
| `useRef<T>(initial): { current: T }`    | `aio-renderer.ts` |
| `createContext<T>(default): Context<T>` | `aio-renderer.ts` |
| `useContext<T>(ctx): T`                 | `aio-renderer.ts` |

### Migration compat (React names, dev-mode hints, linter flags)

Exported from `'aio/air'` only. Implemented in `src/compat.ts`. Work correctly
for standard patterns but use AIR primitives underneath.

**`useState<T>(initial: T): [T, setter]`**

- Signal-backed. `sig.value` auto-tracks in AIR render scope.
- Setter accepts value or updater function `(prev: T) => T`.
- Dev hint:
  `[aio] useState() is signal-backed in AIR. Recommended: useLocal() for object state, signal() for module-scoped. Docs: ...`

**`useEffect(fn, deps?): void`**

- Empty deps `[]` → delegates to `onMount()` + return cleanup → `onCleanup()`.
- No deps or non-empty deps → delegates to `effect()`. Deps array ignored
  (auto-tracked).
- Dev hint:
  `[aio] useEffect() mapped to AIR primitives. Deps ignored (auto-tracked). Recommended: onMount() for setup, effect() for reactive. Docs: ...`

**`useCallback<T>(fn: T, deps?): T`**

- Returns `fn` as-is. No-op.
- Dev hint:
  `[aio] useCallback() is unnecessary in AIR — components are auto-optimized. Safe to remove.`

**`useMemo<T>(fn: () => T, deps?): T`**

- Calls `fn()` and returns result. No caching (AIR re-renders are already
  signal-scoped).
- Dev hint:
  `[aio] useMemo() is unnecessary in AIR — use computed() for cached derivations. Safe to remove.`

**`memo<P>(Component, compare?): Component`**

- Returns Component as-is. No-op — AIR has built-in auto-memo via shallow prop
  comparison.
- Already exists in `browser-air.ts`. Move to `compat.ts` for clean separation.
- Dev hint:
  `[aio] memo() is unnecessary in AIR — components auto-memo via shallow prop compare. Safe to remove.`

**Dev hint rules:**

- Dev-mode only (never in production builds)
- Once per function name per session (Map of seen names)
- `console.info` level, not `warn`

### AIR-native (our API, recommended for new code)

Exported from `'aio/air'` only. These are the real API — no React equivalent.

**Hooks & lifecycle:**

- `useLocal<T>(initial): { local: T, set, patch }` — object state with partial
  updates
- `useFeature<S>(ref): { state, send, status }` — server-connected feature state
- `useAio<S>(): { state, send }` — full global state
- `useConnected(): boolean` — connection status
- `useProjection<T>(fn, deps?): T` — derived state with ref stability
- `onMount(fn): void` — run once after first render
- `onCleanup(fn): void` — cleanup on unmount
- `useTimeTravel(ref): TimeTravelState` — debug time travel

**Signal primitives:**

- `signal<T>(initial): Signal<T>` — reactive value
- `computed<T>(fn): Computed<T>` — cached derivation, auto-tracked
- `effect(fn): CleanupFn` — reactive side effect, auto-tracked
- `batch(fn): void` — batch multiple signal writes

**Rendering:**

- `h(tag, props, ...children): VNode` — JSX factory
- `mount(root, App): MountHandle` — mount AIR app
- `hydrate(root, App): MountHandle` — hydrate SSR'd AIR app

**Routing (signal-based):**

- `useRoute(pattern?): RouteState`
- `useNavigate(): NavigateFn`
- `Route`, `Outlet`, `Link`, `NavLink`, `Redirect`
- `navigate`, `matchPath`, `routePath`, `routeSearch`

**Types:**

- `Signal<T>`, `Computed<T>`, `Context<T>`, `MountHandle`
- `VNode`, `VChild`, `ComponentFn`, `Ref`
- `RouteState`, `RouteProps`, `LinkProps`

## mod.ts (base `'aio'`) — what stays

Server-side and protocol-only. No renderer, no DOM, no signals.

- **Framework core:** `aio` (config object), `feature()`, `bridge()`,
  `composeFeatures`, `bindFeature`, `testFeature`, `call`, `markAsync`
- **Runtime:** `aio.run()`, `lint()`, `parseCli()`
- **Factories:** `actions`, `effects`, `msg`, `schedule`
- **Database:** `createDB`, `sql`, `table`, `text`, `integer`, `real`, `pk`,
  `ref`
- **State derivation:** `createSelector`, `createSliceSelector`
- **Logger:** `log`, `LogConfig`, `LogLevel`
- **Middleware:** `composeMiddleware`, `middleware`, `MiddlewareFn`
- **Error infra:** error types, codes, context builders
- **Diagnostics types:** `DiagEvent`, related types
- **Vitals types:** `VitalAlert`, `VitalHint`, `VitalsConfig`, etc.
- **Electron utils:** `AioMeta`, `instances`, `resolveAppId`
- **CLI client:** `connectCli`, `connectCliUDS`, `CliApp`
- **Client API:** `client` (framework-agnostic subscribe/getState/send)
- **DevTools:** `connectDevTools`, `disconnectDevTools`
- **Utilities:** `draft`, `matchEffect`, `deepFreeze`
- **Types:** all config, feature, message, and protocol types

**What gets REMOVED from mod.ts:**

- React hooks: `useFeature`, `useAio`, `useLocal`, `useConnected`,
  `useProjection`, `memo`
- Routing hooks: `useRoute`, `useNavigate`
- Routing components: `Route`, `Outlet`, `Link`, `NavLink`, `Redirect`
- Navigation: `navigate`, `matchPath`, `routePath`, `routeSearch`,
  `ensureConnected`
- AIR renderer: `mount`, `hydrate`, `onMount`, `onCleanup`, `useRef`,
  `createContext`, `useContext`, `setDevMode`
- VDOM: `h`, `Fragment`, `ErrorBoundary`, `Portal`, `Suspense`, `lazy`,
  `renderToString`
- Signals: `signal`, `computed`, `effect`, `batch`
- AIR utilities: `useForm`, `useFieldArray`, `useSpring`, `useTransition`,
  `useVirtualList`
- Time travel: `useTimeTravel`
- Browser-specific: `_getArrayRefStats`, `_resetArrayRefStats`,
  `_checkWastedRenders`, all underscore-prefixed browser internals

## React Migration Table (for docs)

| React                   | AIR (recommended)                  | AIR (compat, works but migrate)          |
| ----------------------- | ---------------------------------- | ---------------------------------------- |
| `useState(init)`        | `useLocal(init)` or `signal(init)` | `useState(init)` ✅                      |
| `useEffect(fn, [])`     | `onMount(fn)`                      | `useEffect(fn, [])` ✅                   |
| `useEffect(fn)`         | `effect(fn)`                       | `useEffect(fn)` ✅                       |
| `useEffect(fn, [a,b])`  | `effect(fn)` (auto-tracked)        | `useEffect(fn, [a,b])` ✅ (deps ignored) |
| `useRef(init)`          | `useRef(init)`                     | Same ✅                                  |
| `useMemo(fn, deps)`     | `computed(fn)` or just inline      | `useMemo(fn, deps)` ✅ (no-op)           |
| `useCallback(fn, deps)` | Just use `fn` directly             | `useCallback(fn, deps)` ✅ (no-op)       |
| `React.memo(Comp)`      | Not needed (auto-memo)             | `memo(Comp)` ✅ (no-op)                  |
| `createContext(val)`    | `createContext(val)`               | Same ✅                                  |
| `useContext(ctx)`       | `useContext(ctx)`                  | Same ✅                                  |
| `useLayoutEffect`       | Not provided                       | —                                        |
| `useReducer`            | `useFeature` or `useLocal`         | Not provided                             |
| `forwardRef`            | Use `ref` prop directly            | Not provided                             |
| `useImperativeHandle`   | Not provided                       | —                                        |

## Breaking Changes

This is alpha — breaking changes are free. The only migration required:

1. **React apps:** Component files change `from 'aio'` → `from 'aio/react'`
2. **AIR apps:** Component files change `from 'aio'` → `from 'aio/air'`
3. **Feature definitions / server code:** No change — `from 'aio'` still works

## Testing Strategy

1. **Unit tests for `compat.ts`:** Each compat hook tested for correct
   delegation to AIR primitives
2. **Dev hint tests:** Verify hints fire once per name, only in dev mode
3. **Integration test:** Paste a real React component, change import, verify it
   renders
4. **Headless test:** `import { feature } from 'aio'` in Deno with no DOM — must
   not fail
5. **Existing tests:** All 1620 tests must continue passing
