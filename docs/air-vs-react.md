# AIR vs React — Comparison & Migration

Side-by-side comparison of aio's two renderers and step-by-step migration guides
in both directions.

---

## Table of Contents

- [At a Glance](#at-a-glance)
- [API Comparison](#api-comparison)
  - [Identical API (same name, same behavior)](#identical-api)
  - [Same Name, Different Engine](#same-name-different-engine)
  - [AIR-Only API](#air-only-api)
  - [React-Only Patterns](#react-only-patterns)
- [Side-by-Side Examples](#side-by-side-examples)
  - [Counter](#1-counter)
  - [Todo List](#2-todo-list)
  - [Data Fetching](#3-data-fetching)
  - [Theme Context](#4-theme-context)
  - [Form with Validation](#5-form-with-validation)
  - [Animation](#6-animation)
  - [Virtual Scrolling](#7-virtual-scrolling)
  - [Error Boundary](#8-error-boundary)
  - [SSR + Hydration](#9-ssr--hydration)
  - [Code Splitting](#10-code-splitting)
- [Migration: React to AIR](#migration-react-to-air)
  - [Step 1: Change Import](#step-1-change-import)
  - [Step 2: Compat Hooks (automatic)](#step-2-compat-hooks-automatic)
  - [Step 3: Optimize (optional)](#step-3-optimize-optional)
  - [Event Differences](#event-differences)
- [Migration: AIR to React](#migration-air-to-react)
  - [Step 1: Change Import](#step-1-change-import-1)
  - [Step 2: Replace Signal Patterns](#step-2-replace-signal-patterns)
  - [Step 3: Replace AIR Utilities](#step-3-replace-air-utilities)
- [Hook Migration Table](#hook-migration-table)
- [What You Gain / Lose](#what-you-gain--lose)

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

These work the same in both renderers. Same name, same behavior, same types.

| API                                                              | Import                   |
| ---------------------------------------------------------------- | ------------------------ |
| `useFeature(ref)`                                                | `aio/air` or `aio/react` |
| `useAio()`                                                       | `aio/air` or `aio/react` |
| `useLocal(init)`                                                 | `aio/air` or `aio/react` |
| `useConnected()`                                                 | `aio/air` or `aio/react` |
| `useProjection(fn)`                                              | `aio/air` or `aio/react` |
| `useTimeTravel(ref)`                                             | `aio/air` or `aio/react` |
| `useRoute(pattern?)`                                             | `aio/air` or `aio/react` |
| `useNavigate()`                                                  | `aio/air` or `aio/react` |
| `Route`, `Outlet`, `Link`, `NavLink`, `Redirect`                 | `aio/air` or `aio/react` |
| `useRef(init)`                                                   | `aio/air` or `react`     |
| `createContext(default)`                                         | `aio/air` or `react`     |
| `useContext(ctx)`                                                | `aio/air` or `react`     |
| `page(key, routes)`                                              | `aio/air` or `aio/react` |
| `feature`, `aio`, `log`, `msg`, `actions`, `effects`, `schedule` | all three                |
| All types and server symbols                                     | all three                |

### Same Name, Different Engine

These exist in both but use different underlying mechanisms.

| API                                      | AIR behavior               | React behavior          |
| ---------------------------------------- | -------------------------- | ----------------------- |
| `memo(Component)`                        | No-op (auto-memo built-in) | `React.memo` wrapper    |
| `connectDevTools` / `disconnectDevTools` | AIR renderer devtools      | React renderer devtools |

### AIR-Only API

These are only available in `aio/air`. No React equivalent.

| API                                                       | Purpose                           |
| --------------------------------------------------------- | --------------------------------- |
| `signal(init)`                                            | Reactive value                    |
| `computed(fn)`                                            | Lazy derived value                |
| `effect(fn)`                                              | Reactive side effect              |
| `batch(fn)`                                               | Coalesce signal updates           |
| `onMount(fn)`                                             | Run after first render            |
| `onCleanup(fn)`                                           | Run before re-render / on unmount |
| `mount(root, App)`                                        | Mount AIR app to DOM              |
| `hydrate(root, App)`                                      | Hydrate SSR'd AIR app             |
| `h(tag, props, children)`                                 | JSX factory                       |
| `Fragment`, `ErrorBoundary`, `Portal`, `Suspense`, `lazy` | VDOM components                   |
| `renderToString(vnode)`                                   | Server-side rendering             |
| `useForm(config)`                                         | Signal-based form state           |
| `useFieldArray(init?)`                                    | Dynamic array field               |
| `useSpring(config)`                                       | Spring physics animation          |
| `useTransition(config)`                                   | CSS transition orchestration      |
| `useVirtualList(config)`                                  | Windowed scrolling                |
| `connectAioDevTools()`                                    | Component tree inspector          |

### React-Only Patterns

These are standard React — not available in AIR.

| Pattern                      | AIR alternative                |
| ---------------------------- | ------------------------------ |
| `useState`                   | `signal()` or `useLocal()`     |
| `useEffect`                  | `effect()` or `onMount()`      |
| `useCallback`                | Not needed (no stale closures) |
| `useMemo`                    | `computed()`                   |
| `useReducer`                 | `useFeature()` or `useLocal()` |
| `useLayoutEffect`            | `onMount()` (runs post-render) |
| `forwardRef`                 | Use `ref` prop directly        |
| `useImperativeHandle`        | Not provided                   |
| `React.memo`                 | Not needed (auto-memo)         |
| `useSyncExternalStore`       | Signals handle this natively   |
| `createRoot` / `hydrateRoot` | `mount()` / `hydrate()`        |

---

## Side-by-Side Examples

### 1. Counter

**React:**

```tsx
import { useFeature } from "aio/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";

function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount((c) => c + 1)}>Count: {count}</button>;
}

createRoot(document.getElementById("root")!).render(<Counter />);
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

mount(document.getElementById("root")!, Counter);
```

**What's different:** `useState` -> `signal`. State lives outside the component.
No setter function, no closure — `count.value` is always current.

### 2. Todo List

**React:**

```tsx
import { useCallback, useMemo, useState } from "react";

function TodoApp() {
  const [todos, setTodos] = useState<
    { id: number; text: string; done: boolean }[]
  >([]);
  const [input, setInput] = useState("");
  const remaining = useMemo(() => todos.filter((t) => !t.done).length, [todos]);

  const add = useCallback(() => {
    if (!input.trim()) return;
    setTodos((prev) => [...prev, { id: Date.now(), text: input, done: false }]);
    setInput("");
  }, [input]);

  return (
    <div>
      <h1>Todos ({remaining} left)</h1>
      <input value={input} onChange={(e) => setInput(e.target.value)} />
      <button onClick={add}>Add</button>
    </div>
  );
}
```

**AIR:**

```tsx
import { computed, mount, signal } from "aio/air";

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

const TodoApp = () => (
  <div>
    <h1>Todos ({remaining.value} left)</h1>
    <input
      value={input.value}
      onInput={(e: Event) => input.set((e.target as HTMLInputElement).value)}
    />
    <button onClick={add}>Add</button>
  </div>
);

mount(document.getElementById("root")!, TodoApp);
```

**What's different:**

- `useState` -> `signal` (outside the component)
- `useMemo` -> `computed` (no dep array)
- `useCallback` -> plain function (no stale closures)
- `onChange` -> `onInput` (native DOM event)

### 3. Data Fetching

**React:**

```tsx
import { useEffect, useState } from "react";

function UserProfile({ userId }: { userId: number }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/users/${userId}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setUser(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (loading) return <div>Loading...</div>;
  return <div>{user?.name}</div>;
}
```

**AIR:**

```tsx
import { effect, mount, signal } from "aio/air";

const userId = signal(1);
const user = signal(null);
const loading = signal(true);

effect(() => {
  const id = userId.value; // auto-tracked
  const controller = new AbortController();
  loading.set(true);

  fetch(`/api/users/${id}`, { signal: controller.signal })
    .then((r) => r.json())
    .then((data) => {
      user.set(data);
      loading.set(false);
    })
    .catch((err) => {
      if (err.name !== "AbortError") loading.set(false);
    });

  return () => controller.abort();
});

const UserProfile = () => {
  if (loading.value) return <div>Loading...</div>;
  return <div>{user.value?.name}</div>;
};

mount(document.getElementById("root")!, UserProfile);
```

**What's different:** No `cancelled` flag — `AbortController` handles cleanup.
No dep array — `effect` auto-tracks `userId.value`.

### 4. Theme Context

**React:**

```tsx
import { createContext, useCallback, useContext, useState } from "react";

const ThemeCtx = createContext({ theme: "light", toggle: () => {} });

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState("light");
  const toggle = useCallback(
    () => setTheme((t) => t === "light" ? "dark" : "light"),
    [],
  );
  // Every consumer re-renders when toggle is called
  return (
    <ThemeCtx.Provider value={{ theme, toggle }}>{children}</ThemeCtx.Provider>
  );
}
```

**AIR:**

```tsx
import { createContext, mount, signal, useContext } from "aio/air";

const ThemeCtx = createContext<"light" | "dark">("light");
const theme = signal<"light" | "dark">("light");
const toggle = () => theme.set(theme.peek() === "light" ? "dark" : "light");

const App = () => (
  <ThemeCtx.Provider value={theme.value}>
    <ThemedCard />
  </ThemeCtx.Provider>
);
```

**What's different:** AIR context is signal-backed — only components that read
the value re-render. No context re-render storm.

### 5. Form with Validation

**React:** Requires `react-hook-form` or manual state management.

**AIR:** Built-in `useForm` with signal-based field-level reactivity:

```tsx
import { useForm } from "aio/air";

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

### 6. Animation

**React:** Requires `react-spring` (~25KB) or `framer-motion` (~50KB).

**AIR:** Built-in spring physics:

```tsx
import { mount, useSpring } from "aio/air";

const x = useSpring({ initial: 0, stiffness: 200, damping: 20 });

const Box = () => (
  <div
    style={{ transform: `translateX(${x.value}px)` }}
    onClick={() => x.to(200)}
  >
    Click me
  </div>
);
```

### 7. Virtual Scrolling

**React:** Requires `react-window` or `react-virtualized`.

**AIR:** Built-in:

```tsx
import { useVirtualList } from "aio/air";

const data = Array.from(
  { length: 10000 },
  (_, i) => ({ id: i, name: `Item ${i}` }),
);
const vlist = useVirtualList({
  items: data,
  itemHeight: 40,
  containerHeight: 400,
});
```

### 8. Error Boundary

**React:** Class component required (no hook API):

```tsx
class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    return this.state.error
      ? this.props.fallback(this.state.error)
      : this.props.children;
  }
}
```

**AIR:** One line:

```tsx
import { ErrorBoundary } from "aio/air";

<ErrorBoundary fallback={(e) => <div>Error: {e.message}</div>}>
  <RiskyComponent />
</ErrorBoundary>;
```

### 9. SSR + Hydration

**React:**

```tsx
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
```

**AIR:**

```tsx
import { hydrate, renderToString } from "aio/air";
```

Same pattern, fewer imports.

### 10. Code Splitting

Both use the same pattern: `lazy()` + `<Suspense>`. Just different imports.

---

## Migration: React to AIR

### Step 1: Change Import

```diff
- import { useState, useEffect, useCallback, useMemo } from "react";
+ import { useState, useEffect, useCallback, useMemo } from "aio/air";
```

That's it for the first pass. AIR provides compat versions of all four hooks.
Your code compiles and runs immediately.

### Step 2: Compat Hooks (automatic)

The compat hooks work but aren't optimal. In dev mode, they emit one-time
`console.info` hints suggesting AIR-native alternatives:

```
[aio] useState() is signal-backed in AIR. Recommended: useLocal() or signal().
[aio] useEffect() mapped to AIR primitives. Recommended: onMount() or effect().
[aio] useCallback() is unnecessary in AIR — components are auto-optimized.
[aio] useMemo() is unnecessary in AIR — use computed() for cached derivations.
```

### Step 3: Optimize (optional)

Replace compat hooks with AIR-native equivalents at your own pace:

```diff
- const [count, setCount] = useState(0);
+ const count = signal(0);
  // JSX: count.value instead of count
  // handlers: count.set() or count.set(prev => prev + 1)

- useEffect(() => { ... }, []);
+ onMount(() => { ... });

- useEffect(() => { ... }, [dep1, dep2]);
+ effect(() => { ... });
  // deps are auto-tracked — no array needed

- const memoized = useMemo(() => expensive(), [dep]);
+ const memoized = computed(() => expensive());

- const handler = useCallback(() => doStuff(), [dep]);
+ const handler = () => doStuff();
  // just a plain function — no stale closures with signals
```

### Event Differences

AIR uses native DOM events. Key differences from React synthetic events:

| React                   | AIR                                    | Notes                                    |
| ----------------------- | -------------------------------------- | ---------------------------------------- |
| `onChange` on `<input>` | `onInput`                              | React's `onChange` is actually `onInput` |
| `SyntheticEvent`        | `Event` / `MouseEvent` / etc.          | Native DOM event types                   |
| `e.target.value`        | `(e.target as HTMLInputElement).value` | Cast needed in TS                        |
| `onKeyDown`             | `onKeydown`                            | Lowercase 'd'                            |
| Event pooling           | N/A                                    | Native events are not pooled             |

---

## Migration: AIR to React

Less common but fully supported.

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
- // count.value, count.peek(), count.set()
+ // Inside component:
+ const [count, setCount] = useState(0);

- const derived = computed(() => items.value.length);
+ const derived = useMemo(() => items.length, [items]);

- effect(() => { console.log(count.value); });
+ useEffect(() => { console.log(count); }, [count]);

- onMount(() => { ... });
+ useEffect(() => { ... }, []);

- onCleanup(() => { ... });
+ useEffect(() => { return () => { ... }; }, []);
```

### Step 3: Replace AIR Utilities

| AIR                      | React replacement                        |
| ------------------------ | ---------------------------------------- |
| `mount(root, App)`       | `createRoot(root).render(<App />)`       |
| `hydrate(root, App)`     | `hydrateRoot(root, <App />)`             |
| `useForm(config)`        | `react-hook-form` or manual state        |
| `useSpring(config)`      | `react-spring` or `framer-motion`        |
| `useTransition(config)`  | `react-transition-group`                 |
| `useVirtualList(config)` | `react-window` or `react-virtualized`    |
| `<ErrorBoundary>`        | Class component error boundary           |
| `renderToString(vnode)`  | `renderToString` from `react-dom/server` |

---

## Hook Migration Table

Complete mapping between React, AIR native, and AIR compat:

| React                   | AIR (recommended)                     | AIR (compat — works, migrate later)                       |
| ----------------------- | ------------------------------------- | --------------------------------------------------------- |
| `useState(init)`        | `useLocal(init)` or `signal(init)`    | `useState(init)` from `aio/air`                           |
| `useEffect(fn, [])`     | `onMount(fn)`                         | `useEffect(fn, [])` from `aio/air`                        |
| `useEffect(fn)`         | `effect(fn)`                          | `useEffect(fn)` from `aio/air`                            |
| `useEffect(fn, [a, b])` | `effect(fn)` (auto-tracked)           | `useEffect(fn, [a, b])` from `aio/air` (deps ignored)     |
| `useRef(init)`          | `useRef(init)`                        | Same (identical API)                                      |
| `useMemo(fn, deps)`     | `computed(fn)` or inline              | `useMemo(fn, deps)` from `aio/air` (calls fn immediately) |
| `useCallback(fn, deps)` | Just use `fn` directly                | `useCallback(fn, deps)` from `aio/air` (identity)         |
| `React.memo(Comp)`      | Not needed (auto-memo)                | `memo(Comp)` from `aio/air` (identity)                    |
| `createContext(val)`    | `createContext(val)`                  | Same (identical API)                                      |
| `useContext(ctx)`       | `useContext(ctx)`                     | Same (identical API)                                      |
| `useReducer(r, init)`   | `useFeature(ref)` or `useLocal(init)` | Not provided                                              |
| `useLayoutEffect`       | `onMount()` (runs post-render)        | Not provided                                              |
| `forwardRef`            | Use `ref` prop directly               | Not provided                                              |
| `useImperativeHandle`   | Not provided                          | Not provided                                              |

---

## What You Gain / Lose

### Moving from React to AIR

**Gain:**

- Zero dependencies (~32KB saved)
- No dependency arrays, no stale closures
- Automatic memoization (no `React.memo`, `useCallback`, `useMemo`)
- Built-in forms, animation, virtual scrolling, error boundaries
- Signal-based context (no re-render storms)
- Smaller, simpler component code

**Lose:**

- React ecosystem (Material UI, react-query, etc.)
- React DevTools (use aio DevTools instead)
- React synthetic events (use native DOM events)
- Familiar React patterns (useState, useEffect with dep arrays)
- Community support / Stack Overflow answers for React-specific issues

### Moving from AIR to React

**Gain:**

- Vast React ecosystem
- React DevTools
- Community support
- Familiar patterns for React developers
- React Native (if needed)

**Lose:**

- Automatic memoization
- Signal-based reactivity (back to dep arrays)
- Built-in utilities (need external packages)
- Smaller bundle size
- Simpler mental model (signals vs hooks + closures)
