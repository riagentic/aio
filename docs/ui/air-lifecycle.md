# AIR Lifecycle, Context & Error Handling

All lifecycle hooks must be called **inside a component function body** during
render. Unlike React, you _can_ call them conditionally or in loops.

---

## onMount()

```ts
function onMount(fn: () => void): void;
```

Runs **once** after the component's first render.

```tsx
import { onCleanup, onMount, signal } from "aio/air";

const Timer = () => {
  const elapsed = signal(0);

  onMount(() => {
    const id = setInterval(() => elapsed.set(elapsed.peek() + 1), 1000);
    onCleanup(() => clearInterval(id));
  });

  return <span>{elapsed.value}s</span>;
};
```

---

## onCleanup()

```ts
function onCleanup(fn: () => void): void;
```

Behavior depends on **where** it's called:

| Context                     | Runs on re-render | Runs on unmount |
| --------------------------- | ----------------- | --------------- |
| Component body              | Yes               | Yes             |
| Inside `onMount()` callback | No                | Yes             |

**Inside onMount()** — cleanup only on unmount (like `useEffect(fn, [])`):

```tsx
onMount(() => {
  const handler = (e: KeyboardEvent) => console.log(e.key);
  document.addEventListener("keydown", handler);
  onCleanup(() => document.removeEventListener("keydown", handler));
});
```

Throwing inside a cleanup callback does not break subsequent cleanups.

---

## useRef()

```ts
function useRef<T>(initial: T): { current: T };
```

Persist a mutable value across re-renders. Mutations do **not** trigger
re-render. Multiple `useRef` calls maintain independent identity.

---

## useId()

```ts
function useId(): string;
```

Generate a unique, SSR-stable ID. Format: `:r{N}:`.

```tsx
const FormField = ({ label }: { label: string }) => {
  const id = useId();
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <input id={id} />
    </div>
  );
};
```

IDs are deterministic — same component tree produces same IDs on server and
client. Each `mount()` root has its own counter.

---

## useOptimistic()

```ts
function useOptimistic<T, A = T>(
  passthrough: T,
  updateFn: (current: T, optimistic: A) => T,
): [T, (action: A) => void];
```

Show an immediate UI update while an async action is in flight. When
`passthrough` changes (server confirms), the optimistic overlay clears.

```tsx
const TodoList = () => {
  const { state, send } = useCell(todoCell);

  const [items, addOptimistic] = useOptimistic(
    state.items,
    (current, newItem: { id: number; text: string }) => [...current, newItem],
  );

  function handleAdd(text: string) {
    addOptimistic({ id: Date.now(), text });
    send.addTodo(text);
  }

  return <ul>{items.map((item) => <li key={item.id}>{item.text}</li>)}</ul>;
};
```

Multiple `addOptimistic()` calls stack. When `passthrough` reference changes,
all pending overlays clear.

---

## Context

Pass values down the component tree without prop drilling.

### createContext()

```tsx
import { createContext } from "aio/air";

const ThemeCtx = createContext<"light" | "dark">("light");
```

### useContext()

```tsx
const ThemedBox = () => {
  const theme = useContext(ThemeCtx);
  return <div className={theme}>themed</div>;
};
```

### Context.Provider

```tsx
const App = () => (
  <ThemeCtx.Provider value="dark">
    <ThemedBox />
  </ThemeCtx.Provider>
);
```

**Key difference from React:** Context values are signals internally. When a
Provider's value changes, **only components that called `useContext`**
re-render. No context re-render storm.

### useContextSelector()

```ts
function useContextSelector<T, R>(
  ctx: Context<T>,
  selector: (value: T) => R,
): R;
```

Select a subset of context — re-renders only when the selected value changes.

```tsx
const AppCtx = createContext({ theme: "light", locale: "en", count: 0 });

// Only re-renders when theme changes
const ThemedBox = () => {
  const theme = useContextSelector(AppCtx, (ctx) => ctx.theme);
  return <div className={theme}>themed</div>;
};
```

---

## Error Handling

Catches render errors in children. One line — no class component needed.

```tsx
import { ErrorBoundary } from "aio/air";

const App = () => (
  <ErrorBoundary
    fallback={(error: Error) => (
      <div className="error">Oops: {error.message}</div>
    )}
  >
    <RiskyComponent />
  </ErrorBoundary>
);
```

| Prop       | Type                      | Description                                  |
| ---------- | ------------------------- | -------------------------------------------- |
| `fallback` | `(error: Error) => VNode` | Render function called with the caught error |
| `children` | any                       | The subtree to protect                       |

Catches errors during initial render, signal-triggered re-render, and lazy
component rejection. Event handler errors are **not** caught (same as React).

---

## Redux DevTools Integration

Connect to the Redux DevTools browser extension for state inspection.

```tsx
import { connectDevTools, useAio } from "aio";

export default function App() {
  const { state, send } = useAio<AppState>();

  useEffect(() => {
    if (import.meta.env.DEV) connectDevTools();
  }, []);
  // ...
}
```

**What you see:** State tree, action history with type and payload, state diffs.

**Limitations:** Time-travel via DevTools is not supported (use Ctrl+. panel
instead). DevTools must be installed and enabled in browser.

---

## Time-Travel Panel

In dev mode, aio records every action and state snapshot. Press **Ctrl+.**
(Ctrl + Period) to toggle a floating panel. Zero cost in prod.

### useTimeTravel()

For custom UIs, use the hook instead of the built-in panel:

```tsx
import { useAio, useTimeTravel } from "aio";

export default function App() {
  const { state, send } = useAio<AppState>();
  const tt = useTimeTravel();

  if (!state) return <div>Connecting...</div>;

  return (
    <div>
      <div>Count: {state.counter}</div>
      {tt && (
        <div>
          <b>Time Travel</b> — {tt.index + 1}/{tt.entries.length}
          <button onClick={tt.undo} disabled={tt.index <= 0}>Undo</button>
          <button onClick={tt.redo}>Redo</button>
          {tt.paused
            ? <button onClick={tt.resume}>Resume</button>
            : <button onClick={tt.pause}>Pause</button>}
        </div>
      )}
    </div>
  );
}
```

### Return value

`useTimeTravel()` returns `null` in prod. In dev mode:

| Field      | Type                   | Description                                             |
| ---------- | ---------------------- | ------------------------------------------------------- |
| `entries`  | `{ id, type, ts }[]`   | Action history (type name only, no payload/state)       |
| `index`    | `number`               | Current position in history                             |
| `paused`   | `boolean`              | Whether dispatch is frozen                              |
| `undo()`   | `() => void`           | Step back one action (auto-pauses)                      |
| `redo()`   | `() => void`           | Step forward one action (stays paused)                  |
| `goto(id)` | `(id: number) => void` | Jump to specific entry by id (auto-pauses)              |
| `pause()`  | `() => void`           | Freeze state — new actions are dropped                  |
| `resume()` | `() => void`           | Unfreeze — truncates forward history (branch, not tree) |

### Behavior

- **Auto-pause on undo/goto**: Prevents new actions from overwriting history
- **Resume truncates forward**: Standard undo/redo semantics
- **200 entry cap**: Oldest entries evicted (~200KB max)
- **Zero cost in prod**: TT code only instantiated behind dev-mode guard
