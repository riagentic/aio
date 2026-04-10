# Migrating from React to AIR

Step-by-step migration guide for teams moving from React to AIR.

---

## At a Glance

|                      | React                                           | AIR (`aio/air`)                          |
| -------------------- | ----------------------------------------------- | ---------------------------------------- |
| **Reactivity model** | React hooks (manual deps)                       | Signals (auto-tracked)                   |
| **Memoization**      | Manual (`React.memo`, `useCallback`, `useMemo`) | Automatic                                |
| **Dependencies**     | React 18+, ReactDOM                             | Zero                                     |
| **Bundle size**      | ~40KB+ (React + ReactDOM)                       | ~8KB                                     |
| **Events**           | React synthetic events                          | Native DOM events                        |
| **Forms**            | Bring your own                                  | Built-in `useForm`                       |
| **Animation**        | Bring your own                                  | Built-in `useSpring`, `<Transition>`     |
| **Virtual scroll**   | Bring your own                                  | Built-in `useVirtualList`                |
| **Error boundaries** | Class component (15+ LOC)                       | `<ErrorBoundary>` (one line)             |
| **SSR**              | `react-dom/server` + `react-dom/client`         | Built-in `renderToString` + `hydrate`    |
| **Server state**     | Direct cell access, `useAio`, `useLocal`        | Direct cell access, `useAio`, `useLocal` |
| **Routing**          | Built-in (same API)                             | Built-in (signal-based)                  |

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

## Migration Steps

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

## What You Gain

**Zero dependencies** (~32KB saved), no dependency arrays, no stale closures,
automatic memoization, built-in forms/animation/virtual scroll, signal-based
context (no re-render storms).

**What you lose:** React ecosystem (Material UI, react-query), React DevTools
(use aio DevTools), React Native support.

See [renderer architecture](air-setup.md#architecture-overview) for how AIR
connects to server state.
