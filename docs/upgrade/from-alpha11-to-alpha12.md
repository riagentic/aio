# Upgrading from alpha11 to alpha12

## Breaking: `useTransition` hook removed

The `useTransition()` hook has been removed from `aio/air`. Use the
`<Transition>` component with transition functions (`fade`, `slide`, `scale`)
instead.

### Before

```tsx
import { useTransition } from "aio/air";

const fade = useTransition({ name: "fade", duration: 200 });

const App = () => (
  <div>
    <button onClick={() => fade.toggle()}>Toggle</button>
    {fade.mounted && <div className={fade.className}>Content</div>}
  </div>
);
```

### After

```tsx
import { fade, signal, Transition } from "aio/air";

const visible = signal(true);

const App = () => (
  <div>
    <button onClick={() => visible.set(!visible.peek())}>Toggle</button>
    <Transition enter={fade} exit={fade}>
      {visible.value && <div>Content</div>}
    </Transition>
  </div>
);
```

The `<Transition>` component handles DOM insertion/removal timing automatically.

---

## New: `cell.fx` — public effect catalog

Effect creators are now accessible via `cell.fx` instead of
`cell.__aio.effects`:

```ts
// Before (internal API)
return [counter.__aio.effects.persist(state.count)];

// After (public, typed, with autocomplete)
return [counter.fx.persist(state.count)];
```

`__aio.effects` still works but `fx` is the public API.

---

## New: `StateOf` type helper

Extract a cell's state type without casts:

```ts
import type { StateOf } from "aio";

type CounterState = StateOf<typeof counter>;
// { count: number }
```

---

## New: Typed `forUser` callback

The `forUser` callback in cell `ui` config now receives the properly typed
filtered state instead of `Record<string, unknown>`:

```ts
const admin = cell("admin", {
  state: { users: [] as string[], secret: "xxx" },
  ui: {
    include: ["users"],
    forUser: (exposed, user) => {
      // exposed is now Pick<State, "users"> — typed!
      return { ...exposed, filtered: true };
    },
  },
});
```

---

## Breaking: `useCell` removed from AIR

`useCell` has been removed from `aio/air`. AIR's signal tracking makes direct
cell access fully reactive — no hook needed.

```tsx
// Before (AIR)
import { useCell } from "aio/air";
const { state, send } = useCell(counter);
<span>{state.count}</span>
<button onClick={() => send.increment()}>+</button>

// After (AIR) — just import the cell
import { counter } from "./cell/counter.ts";
<span>{counter.count}</span>
<button onClick={() => counter.increment()}>+</button>
```

---

## Breaking: React renderer removed

The `aio/react` and `aio/adapters/react` subpaths have been removed. AIR is now
the sole renderer.

### Migration

1. Change imports from `"aio/react"` to `"aio/air"`
2. Update `deno.json` — remove `react`, `react-dom`, `@types/react` imports;
   change `"jsxImportSource"` from `"react"` to `"aio"`
3. Replace `createRoot(root).render(<App />)` with AIR's automatic mounting
   (just `export default function App()`)
4. AIR provides React compat hooks (`useState`, `useEffect`, `useMemo`,
   `useCallback`) — your existing React-style code compiles without changes
5. For optimal performance, migrate to AIR-native APIs: `signal()`,
   `computed()`, `effect()`, `onMount()`

### deno.json before/after

```diff
  "compilerOptions": {
    "jsx": "react-jsx",
-   "jsxImportSource": "react",
-   "jsxImportSourceTypes": "@types/react"
+   "jsxImportSource": "aio"
  },
  "imports": {
    "aio": "jsr:@riagentic/aio@1.0.0-alpha12",
-   "@types/react": "npm:@types/react@^18",
-   "react": "npm:react@^18",
-   "react-dom": "npm:react-dom@^18",
+   "aio/air": "jsr:@riagentic/aio@1.0.0-alpha12/air",
+   "aio/jsx-runtime": "jsr:@riagentic/aio@1.0.0-alpha12/jsx-runtime",
  }
```
