# AIR vs React -- Comparison & Migration

Side-by-side comparison and step-by-step migration guides in both directions.

---

## At a Glance

|                      | AIR (`aio/air`)                       | React (`aio/react`)                             |
| -------------------- | ------------------------------------- | ----------------------------------------------- |
| **Reactivity model** | Signals (auto-tracked)                | React hooks (manual deps)                       |
| **Memoization**      | Automatic                             | Manual (`React.memo`, `useCallback`, `useMemo`) |
| **Dependencies**     | Zero                                  | React 18+, ReactDOM                             |
| **Bundle size**      | ~8KB                                  | ~40KB+ (React + ReactDOM)                       |
| **Events**           | Native DOM events                     | React synthetic events                          |
| **Forms**            | Built-in `useForm`                    | Bring your own                                  |
| **Animation**        | Built-in `useSpring`, `useTransition` | Bring your own                                  |
| **Virtual scroll**   | Built-in `useVirtualList`             | Bring your own                                  |
| **Error boundaries** | `<ErrorBoundary>` (one line)          | Class component (15+ LOC)                       |
| **SSR**              | Built-in `renderToString` + `hydrate` | `react-dom/server` + `react-dom/client`         |
| **Server state**     | `useFeature`, `useAio`, `useLocal`    | `useFeature`, `useAio`, `useLocal`              |
| **Routing**          | Built-in (signal-based)               | Built-in (same API)                             |

---

## API Comparison

### Identical API

Same name, same behavior, same types in both renderers:

`useFeature(ref)`, `useAio()`, `useLocal(init)`, `useConnected()`,
`useProjection(fn)`, `useTimeTravel(ref)`, `useRoute(pattern?)`,
`useNavigate()`, `Route`, `Outlet`, `Link`, `NavLink`, `Redirect`,
`useRef(init)`, `createContext(default)`, `useContext(ctx)`, `page(key, routes)`

### AIR-Only API

| API                          | Purpose                          |
| ---------------------------- | -------------------------------- |
| `signal(init)`               | Reactive value                   |
| `computed(fn)`               | Lazy derived value               |
| `effect(fn)`                 | Reactive side effect             |
| `batch(fn)`                  | Coalesce signal updates          |
| `onMount(fn)` / `onCleanup`  | Lifecycle hooks                  |
| `mount(root, App)`           | Mount AIR app to DOM             |
| `useForm(config)`            | Signal-based form state          |
| `useSpring(config)`          | Spring physics animation         |
| `useVirtualList(config)`     | Windowed scrolling               |
| `<ErrorBoundary>`            | One-line error catching          |
| `<Defer trigger="viewport">` | Trigger-based lazy loading       |
| `resource()`                 | Signal-based async data          |
| `island()`                   | Mount React/Vue/Solid inside AIR |

### React-Only Patterns

| Pattern                      | AIR alternative                |
| ---------------------------- | ------------------------------ |
| `useState`                   | `signal()` or `useLocal()`     |
| `useEffect`                  | `effect()` or `onMount()`      |
| `useCallback`                | Not needed (no stale closures) |
| `useMemo`                    | `computed()`                   |
| `React.memo`                 | Not needed (auto-memo)         |
| `createRoot` / `hydrateRoot` | `mount()` / `hydrate()`        |

---

## Side-by-Side Examples

### Counter

**React:**

```tsx
import { useState } from "react";
function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount((c) => c + 1)}>Count: {count}</button>;
}
```

**AIR:**

```tsx
import { mount, signal } from "aio/air";
const count = signal(0);
const Counter = () => (
  <button onClick={() => count.set(count.peek() + 1)}>
    Count: {count.value}
  </button>
);
```

### Todo List

**React:** `useState` + `useMemo` + `useCallback` + dependency arrays.

**AIR:**

```tsx
const todos = signal<{ id: number; text: string; done: boolean }[]>([]);
const input = signal("");
const remaining = computed(() => todos.value.filter((t) => !t.done).length);
const add = () => {
  if (!input.peek().trim()) return;
  todos.set([...todos.peek(), {
    id: Date.now(),
    text: input.peek(),
    done: false,
  }]);
  input.set("");
};
```

No dep arrays, no `useCallback`, `onChange` -> `onInput` (native DOM).

### Data Fetching

**React:** `useState` + `useEffect` + manual `cancelled` flag + dep array.

**AIR:**

```tsx
const userId = signal(1);
const user = signal(null);
const loading = signal(true);

effect(() => {
  const id = userId.value;
  const controller = new AbortController();
  loading.set(true);
  fetch(`/api/users/${id}`, { signal: controller.signal })
    .then((r) => r.json())
    .then((data) => {
      user.set(data);
      loading.set(false);
    });
  return () => controller.abort();
});
```

No `cancelled` flag, no dep array. `AbortController` handles cleanup.

### Theme Context

**React:** `createContext` + `useState` + `useCallback` + every consumer
re-renders.

**AIR:**

```tsx
const ThemeCtx = createContext<"light" | "dark">("light");
const theme = signal<"light" | "dark">("light");
const toggle = () => theme.set(theme.peek() === "light" ? "dark" : "light");
```

AIR context is signal-backed — only components that read the value re-render.

### Forms

**React:** Requires `react-hook-form` or manual state management.

**AIR:** Built-in `useForm` with signal-based field-level reactivity:

```tsx
const form = useForm({
  email: { initial: "", rules: [(v) => v.includes("@") ? null : "Invalid"] },
});
const LoginForm = () => (
  <form
    onSubmit={(e: Event) => {
      e.preventDefault();
      form.validate();
    }}
  >
    <input {...form.bind("email")} />
    {form.fields.email.error && <span>{form.fields.email.error}</span>}
  </form>
);
```

---

## Migration: React to AIR

### Step 1: Change Import

```diff
- import { useState, useEffect, useCallback, useMemo } from "react";
+ import { useState, useEffect, useCallback, useMemo } from "aio/air";
```

AIR provides compat versions. Your code compiles and runs immediately.

### Step 2: Compat Hooks (automatic)

In dev mode, one-time `console.info` hints suggest AIR-native alternatives.

### Step 3: Optimize (optional)

```diff
- const [count, setCount] = useState(0);
+ const count = signal(0);

- useEffect(() => { ... }, []);
+ onMount(() => { ... });

- useEffect(() => { ... }, [dep1, dep2]);
+ effect(() => { ... });  // deps auto-tracked

- const memoized = useMemo(() => expensive(), [dep]);
+ const memoized = computed(() => expensive());

- const handler = useCallback(() => doStuff(), [dep]);
+ const handler = () => doStuff();  // plain function
```

### Event Differences

| React                   | AIR                                    |
| ----------------------- | -------------------------------------- |
| `onChange` on `<input>` | `onInput`                              |
| `SyntheticEvent`        | `Event` / `MouseEvent` / etc.          |
| `e.target.value`        | `(e.target as HTMLInputElement).value` |

---

## Migration: AIR to React

### Step 1: Change Import

```diff
- import { mount, signal, useFeature } from "aio/air";
+ import { useFeature } from "aio/react";
+ import { useState } from "react";
+ import { createRoot } from "react-dom/client";
```

### Step 2: Replace Signal Patterns

```diff
- const count = signal(0);
+ const [count, setCount] = useState(0);

- const derived = computed(() => items.value.length);
+ const derived = useMemo(() => items.length, [items]);

- effect(() => { console.log(count.value); });
+ useEffect(() => { console.log(count); }, [count]);
```

### Step 3: Replace AIR Utilities

| AIR                      | React replacement                     |
| ------------------------ | ------------------------------------- |
| `mount(root, App)`       | `createRoot(root).render(<App />)`    |
| `useForm(config)`        | `react-hook-form` or manual state     |
| `useSpring(config)`      | `react-spring` or `framer-motion`     |
| `useVirtualList(config)` | `react-window` or `react-virtualized` |
| `<ErrorBoundary>`        | Class component error boundary        |

---

## Hook Migration Table

| React                   | AIR (recommended)                  | AIR (compat)                       |
| ----------------------- | ---------------------------------- | ---------------------------------- |
| `useState(init)`        | `useLocal(init)` or `signal(init)` | `useState(init)` from `aio/air`    |
| `useEffect(fn, [])`     | `onMount(fn)`                      | `useEffect(fn, [])` from `aio/air` |
| `useEffect(fn)`         | `effect(fn)`                       | `useEffect(fn)` from `aio/air`     |
| `useEffect(fn, [a, b])` | `effect(fn)` (auto-tracked)        | deps ignored in compat             |
| `useMemo(fn, deps)`     | `computed(fn)`                     | calls fn() immediately             |
| `useCallback(fn, deps)` | Just use `fn` directly             | identity (no-op)                   |
| `React.memo(Comp)`      | Not needed (auto-memo)             | identity (no-op)                   |
| `useRef(init)`          | `useRef(init)`                     | Same API                           |
| `createContext(val)`    | `createContext(val)`               | Same API                           |
| `useId()`               | `useId()`                          | Same API                           |

---

## What You Gain / Lose

### React to AIR

**Gain:** Zero dependencies (~32KB saved), no dependency arrays, no stale
closures, automatic memoization, built-in forms/animation/virtual scroll,
signal-based context (no re-render storms).

**Lose:** React ecosystem (Material UI, react-query), React DevTools (use aio
DevTools), familiar React patterns, community support.

### AIR to React

**Gain:** Vast React ecosystem, React DevTools, community support, React Native.

**Lose:** Automatic memoization, signal-based reactivity, built-in utilities,
smaller bundle, simpler mental model.

Both renderers connect to the same server, same features, same protocol. The
difference is how they manage UI reactivity. See
[renderer architecture](air-setup.md#architecture-overview).
