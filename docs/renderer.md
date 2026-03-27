# AIO Renderer

React syntax. No React baggage.

AIO's renderer uses the same TSX you already know — `<div>`, `<button>`,
components, props, children — but eliminates the boilerplate React forces on
you: no `useState`, no `useCallback`, no `useMemo`, no `React.memo`, no
dependency arrays, no stale closures. Signals handle reactivity automatically.

```tsx
// This is AIO. Looks like React. Runs without React.
import { mount, signal } from "aio";

const count = signal(0);

const App = () => (
  <button onClick={() => count.set(count.peek() + 1)}>
    Count: {count.value}
  </button>
);

mount(document.getElementById("root")!, App);
```

Zero dependencies. ~8KB total. Same developer experience.

---

## Table of Contents

- [Setup](#setup)
- [Connecting to AIO Server State](#connecting-to-aio-server-state)
  - [useFeature](#usefeature--subscribe-to-a-feature)
  - [useAio](#useaio--subscribe-to-all-state)
  - [useLocal](#uselocal--client-only-state)
  - [useConnected](#useconnected--connection-status)
- [What AIO Does Automatically](#what-aio-does-automatically)
- [Side-by-Side: React vs AIO](#side-by-side-react-vs-aio)
- [Signals](#signals)
  - [signal()](#signal)
  - [computed()](#computed)
  - [effect()](#effect)
  - [batch()](#batch)
- [Components](#components)
  - [Props & Children](#props--children)
  - [Conditional Rendering](#conditional-rendering)
  - [Lists & Keys](#lists--keys)
  - [Fragments](#fragments)
  - [Refs](#refs)
  - [Style & Class](#style--class)
  - [Events](#events)
  - [SVG](#svg)
  - [dangerouslySetInnerHTML](#dangerouslysetinnerhtml)
- [Lifecycle](#lifecycle)
  - [onMount()](#onmount)
  - [onCleanup()](#oncleanup)
  - [useRef()](#useref)
- [Context](#context)
  - [createContext()](#createcontext)
  - [useContext()](#usecontext)
  - [Context.Provider](#contextprovider)
- [Error Handling](#error-handling)
  - [ErrorBoundary](#errorboundary)
- [Code Splitting](#code-splitting)
  - [lazy()](#lazy)
  - [Suspense](#suspense)
- [Portals](#portals)
- [Server-Side Rendering](#server-side-rendering)
  - [renderToString()](#rendertostring)
  - [Hydration](#hydration)
- [Forms](#forms)
  - [useForm()](#useform)
  - [useFieldArray()](#usefieldarray)
- [Animation](#animation)
  - [useTransition()](#usetransition)
  - [useSpring()](#usespring)
- [Virtual Scrolling](#virtual-scrolling)
  - [useVirtualList()](#usevirtuallist)
- [DevTools](#devtools)
- [Mounting & Rendering](#mounting--rendering)
  - [mount()](#mount)
  - [hydrate()](#hydrate)
  - [unmount](#unmount)
- [Architecture](#architecture)
  - [Rendering Pipeline](#rendering-pipeline)
  - [Per-Component Reactivity](#per-component-reactivity)
  - [Auto-Memo](#auto-memo)
  - [Per-Mount Isolation](#per-mount-isolation)
- [h() — Non-TSX Usage](#h--non-tsx-usage)
- [API Reference (Cheat Sheet)](#api-reference-cheat-sheet)

---

## Setup

Add to your `deno.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "aio"
  }
}
```

That's it. Write `.tsx` files. The JSX compiler maps `<div>` to AIO's virtual
DOM — no React import needed.

> **Types:** AIO uses `@types/react` for HTML intrinsic element types
> (`HTMLAttributes`, `CSSProperties`, etc.), so you get full autocomplete and
> type checking on all HTML/SVG elements.

---

## Connecting to AIO Server State

AIO's renderer connects to the server's state pipeline with the same hooks React
apps use. Same `{ state, send }` pattern, same feature refs.

### useFeature — Subscribe to a feature

```tsx
import { mount, useFeature } from "aio";
import { counter } from "./features/counter.ts";

const App = () => {
  const { state, send } = useFeature(counter);
  return (
    <div>
      <span>Count: {state.count}</span>
      <button onClick={() => send.increment()}>+</button>
    </div>
  );
};

mount(document.getElementById("root")!, App);
```

`state` is reactive — reading `state.count` in JSX auto-tracks the dependency.
When the server updates the counter feature, **only this component** re-renders.

`send` has typed methods matching the feature's actions. `send.increment()`
dispatches to the server via WebSocket/IPC.

### useAio — Subscribe to all state

```tsx
import { useAio } from "aio";

const Dashboard = () => {
  const { state, send } = useAio();
  return (
    <div>
      <span>Counter: {state.counter?.count}</span>
      <span>Todos: {state.todo?.items.length}</span>
    </div>
  );
};
```

Re-renders on **any** state change. Prefer `useFeature` for scoped updates.

### useLocal — Client-only state

```tsx
import { useLocal } from "aio";

const editing = useLocal(false);

const EditToggle = () => (
  <button onClick={() => editing.set(!editing.local)}>
    {editing.local ? "Cancel" : "Edit"}
  </button>
);
```

Not synced to server. For UI-only state like modals, tabs, form visibility.

### useConnected — Connection status

```tsx
import { useConnected } from "aio";

const StatusBar = () => {
  const connected = useConnected();
  return (
    <div className={connected ? "online" : "offline"}>
      {connected ? "Connected" : "Reconnecting..."}
    </div>
  );
};
```

---

## Adapter Architecture

AIO supports multiple renderers through a layered adapter pattern:

```
state-core.ts (framework-agnostic)
  ├── adapters/react.ts  — React hooks (useSyncExternalStore)
  ├── adapters/air.ts    — AIR native hooks (signal-based)
  └── browser.ts         — full-featured client (WS lifecycle + AIR hooks)
```

**state-core** owns all shared state logic: signals, tracking proxy, send proxy,
fallback merge, subscription tracking. It has zero framework dependencies.

**Adapters** are thin wrappers that bridge state-core to a specific UI
framework. Each adapter exports the same API: `useFeature`, `useAio`,
`useLocal`, `useConnected`.

| Adapter                  | Import                                                       | Reactivity             | Transport                 |
| ------------------------ | ------------------------------------------------------------ | ---------------------- | ------------------------- |
| **browser.ts** (default) | `import { useFeature } from "aio"`                           | AIR signals            | Built-in WS/IPC           |
| **React**                | `import { useFeature } from "@riagentic/aio/adapters/react"` | `useSyncExternalStore` | External (`setTransport`) |
| **AIR**                  | `import { useFeature } from "@riagentic/aio/adapters/air"`   | AIR signals            | External (`setTransport`) |

**browser.ts** is a superset — it includes AIR hooks plus WebSocket/IPC
connection management, DevTools, offline queue, vitals, and time-travel. This is
what you get when you `import { useFeature } from "aio"` in the browser.

**Standalone adapters** (React, AIR) work without browser.ts when transport is
connected externally via `setTransport()`. Useful for:

- React Native apps with custom transport
- Embedding AIO state in an existing React app
- Testing adapters in isolation

### Building a Custom Adapter

Use state-core directly to build adapters for any framework:

```ts
import {
  _resolveWithFallback,
  _trackingProxy,
  createSendProxy,
  type FeatureRef,
  getConnectedSignal,
  getFeatureSignal,
  getStateSignal,
  send,
  setTransport,
  trackPath,
} from "@riagentic/aio/state-core";
```

**Minimal adapter contract:**

1. **`useFeature(ref)`** — subscribe to a feature signal via
   `getFeatureSignal()`, return `{ state, send }` where send is from
   `createSendProxy()`
2. **`useAio()`** — subscribe to the full state signal via `getStateSignal()`,
   return `{ state, send }`
3. **`useLocal(initial)`** — framework-local state (no server sync)
4. **`useConnected()`** — subscribe to `getConnectedSignal()`

**Key utilities from state-core:**

| Export                                  | Purpose                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `getFeatureSignal(name, defaults?)`     | Per-feature signal — `.peek()` for snapshot, `.subscribe()` for changes |
| `getStateSignal()`                      | Full app state signal                                                   |
| `getConnectedSignal()`                  | Connection status signal                                                |
| `trackPath(path)`                       | Register a state path for subscription filtering                        |
| `createSendProxy(name, ref, sendFn?)`   | Typed send methods — uses action creators when available                |
| `_trackingProxy(obj, parentPath?)`      | Deep Proxy for automatic path tracking                                  |
| `_resolveWithFallback(state, defaults)` | Merge incomplete state with defaults                                    |
| `setTransport({ send, close })`         | Connect a custom transport                                              |
| `flushOfflineQueue()`                   | Flush queued actions after transport connects                           |

### Example: Vue 3 Adapter

```ts
import { onUnmounted, ref } from "vue";
import {
  _resolveWithFallback,
  createSendProxy,
  type FeatureRef,
  getFeatureSignal,
  trackPath,
} from "@riagentic/aio/state-core";

export function useFeature<S>(
  featureRef: FeatureRef,
  options?: { fallback?: S },
) {
  const name = featureRef.__aio.id;
  trackPath(name);

  const sig = getFeatureSignal(name, featureRef.__aio.state);
  const state = ref(sig.peek());
  const unsub = sig.subscribe(() => {
    state.value = sig.peek();
  });
  onUnmounted(unsub);

  const defaults = options?.fallback ?? featureRef.__aio.state;
  const resolved = _resolveWithFallback(state.value, defaults);

  return {
    state: resolved as S,
    send: createSendProxy(name, featureRef),
  };
}
```

### deno.json Exports

Third-party adapters import from these paths:

```json
{
  "exports": {
    "./state-core": "./src/state-core.ts",
    "./adapters/react": "./src/adapters/react.ts",
    "./adapters/air": "./src/adapters/air.ts"
  }
}
```

---

## What AIO Does Automatically

Things you do manually in React that AIO handles for you:

| React boilerplate              | AIO equivalent                 | Why it's automatic                                    |
| ------------------------------ | ------------------------------ | ----------------------------------------------------- |
| `useState` + setter            | `signal` — read/write anywhere | State lives outside components, no re-render cascade  |
| `useMemo(() => ..., [deps])`   | `computed(() => ...)`          | Auto-tracks which signals are read, no dep array      |
| `useEffect(() => ..., [deps])` | `effect(() => ...)`            | Auto-tracks dependencies, no stale closures           |
| `useCallback(fn, [deps])`      | Plain function                 | Signals read `.peek()` in handlers — always fresh     |
| `React.memo(Component)`        | Automatic                      | Props shallow-compared on every parent re-render      |
| Dependency arrays              | Nothing                        | Signals track reads automatically                     |
| Stale closure bugs             | Impossible                     | No closures over stale state — signals always current |
| Context re-render storms       | Doesn't happen                 | Context values are signals — only readers re-render   |
| `react-hook-form`              | Built-in `useForm`             | Signal-based, field-level reactivity                  |
| `react-spring`                 | Built-in `useSpring`           | Signal-tracked spring physics                         |
| `react-transition-group`       | Built-in `useTransition`       | CSS transition orchestration                          |
| `react-window`                 | Built-in `useVirtualList`      | Windowed scrolling                                    |
| ErrorBoundary class (37 LOC)   | `<ErrorBoundary>`              | Built-in, one line                                    |

---

## Side-by-Side: React vs AIO

Every example below: React on the left, AIO on the right. Same TSX. Less code.

### 1. Counter

**React:**

```tsx
import { useState } from "react";
import { createRoot } from "react-dom/client";

function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount((c) => c + 1)}>Count: {count}</button>;
}

createRoot(document.getElementById("root")!).render(<Counter />);
```

**AIO:**

```tsx
import { mount, signal } from "aio";

const count = signal(0);

const Counter = () => (
  <button onClick={() => count.set(count.peek() + 1)}>
    Count: {count.value}
  </button>
);

mount(document.getElementById("root")!, Counter);
```

**What's different:** `useState` → `signal`. State lives outside the component.
No setter function, no closure — `count.value` is always current.

---

### 2. Todo List

**React:**

```tsx
import { useCallback, useMemo, useState } from "react";

interface Todo {
  id: number;
  text: string;
  done: boolean;
}
let nextId = 0;

function TodoApp() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [input, setInput] = useState("");
  const remaining = useMemo(() => todos.filter((t) => !t.done).length, [todos]);

  const add = useCallback(() => {
    if (!input.trim()) return;
    setTodos((prev) => [...prev, { id: nextId++, text: input, done: false }]);
    setInput("");
  }, [input]);

  const toggle = useCallback((id: number) => {
    setTodos((prev) =>
      prev.map((t) => t.id === id ? { ...t, done: !t.done } : t)
    );
  }, []);

  const remove = useCallback((id: number) => {
    setTodos((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <div>
      <h1>Todos ({remaining} left)</h1>
      <div>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button onClick={add}>Add</button>
      </div>
      <ul>
        {todos.map((t) => (
          <li
            key={t.id}
            style={{ textDecoration: t.done ? "line-through" : "none" }}
          >
            <input
              type="checkbox"
              checked={t.done}
              onChange={() => toggle(t.id)}
            />
            {t.text}
            <button onClick={() => remove(t.id)}>x</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

**AIO:**

```tsx
import { computed, mount, signal } from "aio";

interface Todo {
  id: number;
  text: string;
  done: boolean;
}
let nextId = 0;

const todos = signal<Todo[]>([]);
const input = signal("");
const remaining = computed(() => todos.value.filter((t) => !t.done).length);

const add = () => {
  if (!input.peek().trim()) return;
  todos.set([...todos.peek(), {
    id: nextId++,
    text: input.peek(),
    done: false,
  }]);
  input.set("");
};
const toggle = (id: number) =>
  todos.set(todos.peek().map((t) => t.id === id ? { ...t, done: !t.done } : t));
const remove = (id: number) =>
  todos.set(todos.peek().filter((t) => t.id !== id));

const TodoApp = () => (
  <div>
    <h1>Todos ({remaining.value} left)</h1>
    <div>
      <input
        value={input.value}
        onInput={(e: Event) => input.set((e.target as HTMLInputElement).value)}
        onKeydown={(e: KeyboardEvent) => {
          if (e.key === "Enter") add();
        }}
      />
      <button onClick={add}>Add</button>
    </div>
    <ul>
      {todos.value.map((t) => (
        <li
          key={t.id}
          style={{ textDecoration: t.done ? "line-through" : "none" }}
        >
          <input
            type="checkbox"
            checked={t.done}
            onChange={() => toggle(t.id)}
          />
          {t.text}
          <button onClick={() => remove(t.id)}>x</button>
        </li>
      ))}
    </ul>
  </div>
);

mount(document.getElementById("root")!, TodoApp);
```

**What's different:**

- `useState` → `signal` (outside the component)
- `useMemo` → `computed` (no dep array)
- `useCallback` → plain functions (no stale closures — signals read `.peek()`)
- `onChange` → `onInput` (native DOM event, not React synthetic)
- Same JSX structure, same logic, less ceremony

---

### 3. Data Fetching with Loading/Error

**React:**

```tsx
import { useEffect, useState } from "react";

interface User {
  id: number;
  name: string;
  email: string;
}

function UserProfile({ userId }: { userId: number }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/users/${userId}`)
      .then((r) => {
        if (!r.ok) throw new Error("Not found");
        return r.json();
      })
      .then((data) => {
        if (!cancelled) {
          setUser(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (loading) return <div>Loading...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  return (
    <div>
      <h2>{user!.name}</h2>
      <p>{user!.email}</p>
    </div>
  );
}
```

**AIO:**

```tsx
import { effect, mount, signal } from "aio";

interface User {
  id: number;
  name: string;
  email: string;
}

const userId = signal(1);
const user = signal<User | null>(null);
const loading = signal(true);
const error = signal<string | null>(null);

effect(() => {
  const id = userId.value; // auto-tracked — effect re-runs when userId changes
  const controller = new AbortController();
  loading.set(true);
  error.set(null);

  fetch(`/api/users/${id}`, { signal: controller.signal })
    .then((r) => {
      if (!r.ok) throw new Error("Not found");
      return r.json();
    })
    .then((data) => {
      user.set(data);
      loading.set(false);
    })
    .catch((err) => {
      if (err.name !== "AbortError") {
        error.set(err.message);
        loading.set(false);
      }
    });

  return () => controller.abort();
});

const UserProfile = () => {
  if (loading.value) return <div>Loading...</div>;
  if (error.value) return <div className="error">Error: {error.value}</div>;
  return (
    <div>
      <h2>{user.value!.name}</h2>
      <p>{user.value!.email}</p>
    </div>
  );
};

mount(document.getElementById("root")!, UserProfile);
```

**What's different:**

- Three `useState` → three `signal` calls
- `useEffect` with `[userId]` dep array → `effect` auto-tracks `userId.value`
- No `cancelled` flag pattern — `AbortController` handles cleanup
- No risk of stale closure — `effect` always reads current signal values

---

### 4. Theme Context

**React:**

```tsx
import { createContext, useCallback, useContext, useState } from "react";

type Theme = "light" | "dark";
const ThemeCtx = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "light",
  toggle: () => {},
});

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light");
  const toggle = useCallback(
    () => setTheme((t) => t === "light" ? "dark" : "light"),
    [],
  );
  // Every consumer re-renders on toggle — even those that only read `theme`
  return (
    <ThemeCtx.Provider value={{ theme, toggle }}>{children}</ThemeCtx.Provider>
  );
}

function ThemeToggle() {
  const { toggle } = useContext(ThemeCtx);
  return <button onClick={toggle}>Toggle Theme</button>;
}

function ThemedCard({ title }: { title: string }) {
  const { theme } = useContext(ThemeCtx);
  return <div className={`card card-${theme}`}>{title}</div>;
}

function App() {
  return (
    <ThemeProvider>
      <ThemeToggle />
      <ThemedCard title="Hello" />
      <ThemedCard title="World" />
    </ThemeProvider>
  );
}
```

**AIO:**

```tsx
import { createContext, mount, signal, useContext } from "aio";

type Theme = "light" | "dark";
const ThemeCtx = createContext<Theme>("light");

const theme = signal<Theme>("light");
const toggle = () => theme.set(theme.peek() === "light" ? "dark" : "light");

const ThemeToggle = () => <button onClick={toggle}>Toggle Theme</button>;

const ThemedCard = (props: { title: string }) => {
  const t = useContext(ThemeCtx);
  return <div className={`card card-${t}`}>{props.title}</div>;
};

const App = () => (
  <ThemeCtx.Provider value={theme.value}>
    <ThemeToggle />
    <ThemedCard title="Hello" />
    <ThemedCard title="World" />
  </ThemeCtx.Provider>
);

mount(document.getElementById("root")!, App);
```

**What's different:**

- No `ThemeProvider` wrapper component needed
- No `useCallback` — plain function, no closure issues
- Context is a signal internally: only `ThemedCard` re-renders on toggle.
  `ThemeToggle` doesn't read the theme → auto-skipped, no `React.memo`
- React re-renders ALL context consumers when the value object changes. AIO only
  re-renders consumers whose signal value actually changed.

---

### 5. Form with Validation

**React (react-hook-form):**

```tsx
import { useFieldArray, useForm } from "react-hook-form";

interface FormData {
  teamName: string;
  members: { name: string; role: string }[];
}

function TeamForm() {
  const { register, control, handleSubmit, formState: { errors } } = useForm<
    FormData
  >({
    defaultValues: { teamName: "", members: [{ name: "", role: "" }] },
  });
  const { fields, append, remove } = useFieldArray({
    control,
    name: "members",
  });

  return (
    <form onSubmit={handleSubmit(console.log)}>
      <input {...register("teamName", { required: "Team name required" })} />
      {errors.teamName && <span>{errors.teamName.message}</span>}

      {fields.map((field, i) => (
        <div key={field.id}>
          <input
            {...register(`members.${i}.name`, { required: "Name required" })}
          />
          <input {...register(`members.${i}.role`)} />
          <button type="button" onClick={() => remove(i)}>Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => append({ name: "", role: "" })}>
        Add Member
      </button>
      <button type="submit">Submit</button>
    </form>
  );
}
```

**AIO:**

```tsx
import { mount, useFieldArray, useForm } from "aio";

const form = useForm({
  teamName: {
    initial: "",
    rules: [(v: string) => v ? null : "Team name required"],
  },
});
const members = useFieldArray([{ name: "", role: "" }]);

const TeamForm = () => (
  <form
    onSubmit={(e: Event) => {
      e.preventDefault();
      if (form.validate()) {
        console.log({
          ...form.values(),
          members: members.items,
        });
      }
    }}
  >
    <input {...form.bind("teamName")} />
    {form.fields.teamName.error && <span>{form.fields.teamName.error}</span>}

    {members.items.map((member, i) => (
      <div key={i}>
        <input
          value={member.name}
          onInput={(e: Event) =>
            members.set(i, {
              ...member,
              name: (e.target as HTMLInputElement).value,
            })}
        />
        <input
          value={member.role}
          onInput={(e: Event) =>
            members.set(i, {
              ...member,
              role: (e.target as HTMLInputElement).value,
            })}
        />
        <button type="button" onClick={() => members.remove(i)}>Remove</button>
      </div>
    ))}
    <button type="button" onClick={() => members.push({ name: "", role: "" })}>
      Add Member
    </button>
    <button type="submit">Submit</button>
  </form>
);

mount(document.getElementById("root")!, TeamForm);
```

**What's different:**

- No `react-hook-form` dependency
- `register()` → `form.bind()` (returns `{ value, onInput, onBlur }`)
- Signal-based: typing in one field doesn't re-render the whole form

---

### 6. Animated List with Transitions

**React (react-transition-group):**

```tsx
import { useState } from "react";
import { CSSTransition, TransitionGroup } from "react-transition-group";

let nextId = 0;

function AnimatedList() {
  const [items, setItems] = useState([{ id: nextId++, text: "First" }]);

  return (
    <div>
      <button
        onClick={() =>
          setItems(
            (prev) => [...prev, { id: nextId++, text: `Item ${nextId}` }],
          )}
      >
        Add
      </button>
      <TransitionGroup component="ul">
        {items.map((item) => (
          <CSSTransition key={item.id} timeout={300} classNames="fade">
            <li>
              {item.text}
              <button
                onClick={() =>
                  setItems((prev) =>
                    prev.filter((i) =>
                      i.id !== item.id
                    )
                  )}
              >
                x
              </button>
            </li>
          </CSSTransition>
        ))}
      </TransitionGroup>
    </div>
  );
}
```

**AIO:**

```tsx
import { mount, signal, useTransition } from "aio";

let nextId = 0;
const items = signal([{ id: nextId++, text: "First" }]);
const transitions = new Map<number, ReturnType<typeof useTransition>>();

const getTransition = (id: number) => {
  if (!transitions.has(id)) {
    const t = useTransition({ name: "fade", duration: 300 });
    transitions.set(id, t);
    t.enter();
  }
  return transitions.get(id)!;
};

const addItem = () =>
  items.set([...items.peek(), { id: nextId++, text: `Item ${nextId}` }]);

const removeItem = (id: number) => {
  const t = transitions.get(id);
  if (t) {
    t.exit();
    setTimeout(() => {
      items.set(items.peek().filter((i) => i.id !== id));
      transitions.delete(id);
    }, 300);
  }
};

const AnimatedList = () => (
  <div>
    <button onClick={addItem}>Add</button>
    <ul>
      {items.value.map((item) => {
        const t = getTransition(item.id);
        return t.mounted
          ? (
            <li key={item.id} className={t.className}>
              {item.text}
              <button onClick={() => removeItem(item.id)}>x</button>
            </li>
          )
          : null;
      })}
    </ul>
  </div>
);

mount(document.getElementById("root")!, AnimatedList);
```

CSS (same for both):

```css
.fade-enter {
  opacity: 0;
}
.fade-active {
  opacity: 1;
  transition: opacity 300ms;
}
.fade-exit {
  opacity: 0;
  transition: opacity 300ms;
}
```

**What's different:**

- No `react-transition-group` dependency (~8KB saved)
- Built-in `useTransition` handles CSS class staging
- Same CSS classes, same visual result

---

### 7. Spring Animation

**React (react-spring):**

```tsx
import { animated, useSpring } from "@react-spring/web";
import { useState } from "react";

function DismissCard() {
  const [gone, setGone] = useState(false);
  const styles = useSpring({
    opacity: gone ? 0 : 1,
    transform: gone ? "translateX(300px)" : "translateX(0px)",
    config: { tension: 200, friction: 20 },
  });

  return (
    <animated.div style={styles} onClick={() => setGone(true)}>
      Click to dismiss
    </animated.div>
  );
}
```

**AIO:**

```tsx
import { mount, useSpring } from "aio";

const opacity = useSpring({ initial: 1, stiffness: 200, damping: 20 });
const x = useSpring({ initial: 0, stiffness: 200, damping: 20 });

const dismiss = () => {
  opacity.to(0);
  x.to(300);
};

const DismissCard = () => (
  <div
    onClick={dismiss}
    style={{
      opacity: `${opacity.value}`,
      transform: `translateX(${x.value}px)`,
    }}
  >
    Click to dismiss
  </div>
);

mount(document.getElementById("root")!, DismissCard);
```

**What's different:**

- No `react-spring` dependency (~25KB saved)
- No `animated.div` wrapper — plain `<div>` with inline style
- `useSpring` returns signal-tracked `.value` — component auto-updates each
  frame

---

### 8. Virtual Scrolling — 10K Items

**React (react-window):**

```tsx
import { FixedSizeList } from "react-window";

const data = Array.from(
  { length: 10000 },
  (_, i) => ({ id: i, name: `User ${i}` }),
);

function BigList() {
  return (
    <FixedSizeList
      height={400}
      width="100%"
      itemCount={data.length}
      itemSize={40}
    >
      {({ index, style }) => (
        <div style={style} className="row">{data[index].name}</div>
      )}
    </FixedSizeList>
  );
}
```

**AIO:**

```tsx
import { mount, useVirtualList } from "aio";

const data = Array.from(
  { length: 10000 },
  (_, i) => ({ id: i, name: `User ${i}` }),
);
const vlist = useVirtualList({
  items: data,
  itemHeight: 40,
  containerHeight: 400,
});

const BigList = () => (
  <div style={vlist.containerStyle} onScroll={vlist.onScroll}>
    <div style={vlist.innerStyle}>
      {vlist.visible.map(({ item, index, offset }) => (
        <div
          key={index}
          className="row"
          style={{
            position: "absolute",
            top: `${offset}px`,
            height: "40px",
            width: "100%",
          }}
        >
          {item.name}
        </div>
      ))}
    </div>
  </div>
);

mount(document.getElementById("root")!, BigList);
```

**What's different:**

- No `react-window` dependency
- Works with `Signal<T[]>` too — items can be reactive

---

### 9. Error Boundaries

**React:**

```tsx
import { Component } from "react";

// React REQUIRES a class component for error boundaries (no hook API)
class ErrorBoundary extends Component<
  { fallback: (e: Error) => React.ReactNode; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error
      ? this.props.fallback(this.state.error)
      : this.props.children;
  }
}

function App() {
  return (
    <ErrorBoundary fallback={(e) => <h1>App crashed: {e.message}</h1>}>
      <Header />
      <ErrorBoundary fallback={(e) => <div>Widget failed: {e.message}</div>}>
        <RiskyWidget />
      </ErrorBoundary>
      <Footer />
    </ErrorBoundary>
  );
}
```

**AIO:**

```tsx
import { ErrorBoundary, mount } from "aio";

const App = () => (
  <ErrorBoundary fallback={(e: Error) => <h1>App crashed: {e.message}</h1>}>
    <Header />
    <ErrorBoundary
      fallback={(e: Error) => <div>Widget failed: {e.message}</div>}
    >
      <RiskyWidget />
    </ErrorBoundary>
    <Footer />
  </ErrorBoundary>
);

mount(document.getElementById("root")!, App);
```

**What's different:**

- React requires a 15-line class component — no hook API for error boundaries
- AIO: `<ErrorBoundary>` is built-in, one line
- Same nesting behavior

---

### 10. SSR + Hydration

**React:**

```tsx
// server.ts
import { renderToString } from "react-dom/server";
const html = renderToString(<App />);

// client.ts
import { hydrateRoot } from "react-dom/client";
hydrateRoot(document.getElementById("root")!, <App />);
```

**AIO:**

```tsx
// server.ts
import { renderToString } from "aio";
const html = renderToString(<App />);

// client.ts
import { hydrate } from "aio";
hydrate(document.getElementById("root")!, App);
```

**What's different:**

- Same API names, same pattern
- No separate `react-dom/server` and `react-dom/client` imports
- AIO hydration walks DOM once, attaches refs and listeners. Falls back to full
  render on mismatch (no confusing partial hydration errors).

---

### 11. Code Splitting

**React:**

```tsx
import { lazy, Suspense, useState } from "react";

const Dashboard = lazy(() => import("./Dashboard"));
const Settings = lazy(() => import("./Settings"));

function App() {
  const [page, setPage] = useState("dashboard");
  return (
    <div>
      <nav>
        <button onClick={() => setPage("dashboard")}>Dashboard</button>
        <button onClick={() => setPage("settings")}>Settings</button>
      </nav>
      <Suspense fallback={<div>Loading...</div>}>
        {page === "dashboard" ? <Dashboard /> : <Settings />}
      </Suspense>
    </div>
  );
}
```

**AIO:**

```tsx
import { lazy, mount, signal, Suspense } from "aio";

const Dashboard = lazy(() => import("./Dashboard.ts"));
const Settings = lazy(() => import("./Settings.ts"));
const page = signal("dashboard");

const App = () => (
  <div>
    <nav>
      <button onClick={() => page.set("dashboard")}>Dashboard</button>
      <button onClick={() => page.set("settings")}>Settings</button>
    </nav>
    <Suspense fallback={<div>Loading...</div>}>
      {page.value === "dashboard" ? <Dashboard /> : <Settings />}
    </Suspense>
  </div>
);

mount(document.getElementById("root")!, App);
```

**What's different:** Same `lazy()` + `<Suspense>` pattern. `useState` →
`signal`.

---

## Signals

Signals are the reactive primitive. A signal holds a value and notifies
subscribers when it changes. Reads inside a tracking scope (component render,
`computed`, `effect`) are automatically tracked.

### signal()

```ts
function signal<T>(initial: T): Signal<T>;
```

Create a writable reactive value.

```tsx
const count = signal(0);

count.value; // 0 — reads with tracking (use in JSX)
count.peek(); // 0 — reads without tracking (use in event handlers)
count.set(1); // updates and notifies subscribers
count.set(1); // no-op — same value (Object.is check)
```

**In TSX:**

```tsx
const count = signal(0);

const Counter = () => (
  <div>
    <span>Count: {count.value}</span>
    <button onClick={() => count.set(count.peek() + 1)}>+</button>
  </div>
);
```

Use `.value` in JSX expressions (creates tracking). Use `.peek()` in event
handlers (no tracking needed — you don't want the handler to be a dependency).

**Signal\<T\> interface:**

| Member       | Description                                       |
| ------------ | ------------------------------------------------- |
| `.value`     | Read with automatic dependency tracking           |
| `.peek()`    | Read without tracking (use in event handlers)     |
| `.set(next)` | Write and notify. No-op if `Object.is(old, next)` |

### computed()

```ts
function computed<T>(fn: () => T): Computed<T>;
```

Create a derived value that recomputes lazily when dependencies change.

```tsx
const items = signal([1, 2, 3]);
const total = computed(() => items.value.reduce((a, b) => a + b, 0));

const Summary = () => <span>Total: {total.value}</span>;
// total recomputes only when items changes. No useMemo, no dep array.
```

- **Lazy**: doesn't compute until `.value` is read.
- **Cached**: returns cached value if deps unchanged.
- **Composable**: computeds can depend on other computeds.
- **Diamond-safe**: computed at the bottom of a diamond dependency only runs
  once.

### effect()

```ts
function effect(fn: () => void | (() => void)): () => void;
```

Run a function when its tracked signals change. Returns a dispose function.

```tsx
const count = signal(0);

const dispose = effect(() => {
  console.log("Count is:", count.value);
  return () => console.log("Cleaning up");
});
// Logs: "Count is: 0" (runs immediately)

count.set(1);
// Logs: "Cleaning up", then "Count is: 1"

dispose(); // stops tracking, runs cleanup
```

- Runs immediately on creation.
- Cleanup function (if returned) runs before each re-run and on dispose.
- Auto-tracks: no dependency array.

### batch()

```ts
function batch(fn: () => void): void;
```

Batch multiple signal updates — subscribers notified once at the end.

```tsx
const firstName = signal("John");
const lastName = signal("Doe");

batch(() => {
  firstName.set("Jane");
  lastName.set("Smith");
});
// Components that track both are notified once, not twice.
```

---

## Components

A component is a plain function returning TSX (or `null`).

### Props & Children

```tsx
interface GreetingProps {
  name: string;
  children?: any;
}

const Greeting = (props: GreetingProps) => (
  <div>
    Hello, {props.name}!
    {props.children}
  </div>
);

// Usage:
<Greeting name="Alice">
  <span>(friend)</span>
</Greeting>;
```

Components can return `null` to render nothing.

### Conditional Rendering

Same as React — use ternary or `&&`:

```tsx
const loggedIn = signal(false);

const App = () => (
  <div>
    {loggedIn.value ? <Dashboard /> : <LoginForm />}
    {loggedIn.value && <UserMenu />}
  </div>
);
```

### Lists & Keys

Same as React — `.map()` with `key`:

```tsx
const users = signal([
  { id: 1, name: "Alice" },
  { id: 2, name: "Bob" },
]);

const UserList = () => (
  <ul>
    {users.value.map((user) => <li key={user.id}>{user.name}</li>)}
  </ul>
);
```

Without keys, the diffing algorithm uses positional comparison. With keys,
elements are matched by identity — DOM nodes are moved instead of recreated.

### Fragments

Group children without a wrapper element. Use `<>...</>`:

```tsx
const Pair = () => (
  <>
    <li>One</li>
    <li>Two</li>
  </>
);
```

Or import `Fragment` explicitly:

```tsx
import { Fragment } from "aio";

const Pair = () => (
  <Fragment>
    <li>One</li>
    <li>Two</li>
  </Fragment>
);
```

### Refs

Direct access to DOM nodes. Two forms:

```tsx
// Callback ref
<input
  ref={(el) => {
    if (el) el.focus();
  }}
/>;

// Object ref (from useRef)
const inputRef = useRef<HTMLInputElement>(null!);

const App = () => (
  <div>
    <input ref={inputRef} />
    <button onClick={() => inputRef.current.focus()}>Focus</button>
  </div>
);
```

Callback refs receive `null` when the element is removed.

### Style & Class

```tsx
// Style object (camelCase → CSS)
<div style={{ backgroundColor: "red", fontSize: "16px" }} />

// className — string
<div className="foo bar" />

// className — array (truthy values joined)
<div className={["foo", isActive && "active"]} />

// className — object (keys with truthy values)
<div className={{ foo: true, bar: false, active: isActive }} />
```

Style diffing is incremental — only changed properties are updated.

### Events

Event handlers use `on` + event name (camelCase), same as React:

```tsx
<button
  onClick={() => console.log("clicked")}
  onMouseEnter={() => hover.set(true)}
  onMouseLeave={() => hover.set(false)}
>
  Hover me
</button>

<input onInput={(e: Event) => name.set((e.target as HTMLInputElement).value)} />
```

> **Note:** AIO uses native DOM events, not React synthetic events. Use
> `onInput` instead of `onChange` for text inputs (React's `onChange` is
> actually `onInput` under the hood).

### SVG

SVG elements are automatically detected and created with the correct namespace:

```tsx
<svg viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="40" fill="red" />
</svg>;
```

All standard SVG tags are recognized: `svg`, `circle`, `path`, `g`, `text`,
`defs`, `linearGradient`, `filter`, `clipPath`, etc.

### dangerouslySetInnerHTML

Inject raw HTML (use carefully — no XSS sanitization):

```tsx
<div dangerouslySetInnerHTML={{ __html: "<b>bold</b>" }} />;
```

---

## Lifecycle

All lifecycle hooks must be called **inside a component function body** during
render. Unlike React, you _can_ call them conditionally or in loops (though
rarely needed).

### onMount()

```ts
function onMount(fn: () => void): void;
```

Runs **once** after the component's first render.

```tsx
const Timer = () => {
  const elapsed = signal(0);

  onMount(() => {
    const id = setInterval(() => elapsed.set(elapsed.peek() + 1), 1000);
    onCleanup(() => clearInterval(id));
  });

  return <span>{elapsed.value}s</span>;
};
```

### onCleanup()

```ts
function onCleanup(fn: () => void): void;
```

Runs before each re-render (previous render's cleanup) and on unmount.

```tsx
const Fetcher = (props: { url: string }) => {
  const data = signal(null);
  const controller = new AbortController();
  onCleanup(() => controller.abort());

  fetch(props.url, { signal: controller.signal })
    .then((r) => r.json())
    .then((d) => data.set(d));

  return data.value
    ? <pre>{JSON.stringify(data.value)}</pre>
    : <span>Loading...</span>;
};
```

Throwing inside a cleanup callback does not break subsequent cleanups.

### useRef()

```ts
function useRef<T>(initial: T): { current: T };
```

Persist a mutable value across re-renders. Mutations do **not** trigger
re-render.

```tsx
const Counter = () => {
  const renderCount = useRef(0);
  renderCount.current++;
  const count = signal(0);

  return (
    <div>
      <span>Count: {count.value}</span>
      <span>Renders: {renderCount.current}</span>
    </div>
  );
};
```

Multiple `useRef` calls maintain independent identity across re-renders.

---

## Context

Pass values down the component tree without prop drilling. Same concept as
React.

### createContext()

```ts
function createContext<T>(defaultValue: T): Context<T>;
```

```tsx
const ThemeCtx = createContext<"light" | "dark">("light");
```

### useContext()

```ts
function useContext<T>(ctx: Context<T>): T;
```

Read the current context value inside a component.

```tsx
const ThemedBox = () => {
  const theme = useContext(ThemeCtx);
  return <div className={theme}>themed</div>;
};
```

If no Provider is found, returns the default value.

### Context.Provider

Set a context value for a subtree:

```tsx
const App = () => (
  <ThemeCtx.Provider value="dark">
    <ThemedBox /> {/* reads "dark" */}
  </ThemeCtx.Provider>
);
```

**Key difference from React:** Context values are stored as signals internally.
When a Provider's value changes, **only components that called `useContext`**
re-render. No "context re-render storm" — only actual consumers update.

**Nesting:** Inner Providers override outer ones:

```tsx
<ThemeCtx.Provider value="dark">
  <ThemedBox /> {/* "dark" */}
  <ThemeCtx.Provider value="light">
    <ThemedBox /> {/* "light" */}
  </ThemeCtx.Provider>
</ThemeCtx.Provider>;
```

---

## Error Handling

### ErrorBoundary

Catches render errors in children. One line — no class component needed.

```tsx
import { ErrorBoundary } from "aio";

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

## Code Splitting

### lazy()

```ts
function lazy(loader: () => Promise<{ default: ComponentFn }>): ComponentFn;
```

```tsx
const HeavyChart = lazy(() => import("./heavy-chart.ts"));

const App = () => (
  <Suspense fallback={<span>Loading chart...</span>}>
    <HeavyChart data={chartData} />
  </Suspense>
);
```

If the import rejects, the error propagates to the nearest `ErrorBoundary`.

### Suspense

```tsx
import { Suspense } from "aio";

<Suspense fallback={<div>Loading...</div>}>
  <LazyComponent />
</Suspense>;
```

| Prop       | Type    | Description                               |
| ---------- | ------- | ----------------------------------------- |
| `fallback` | `VNode` | Shown while any lazy child is unresolved  |
| `children` | any     | The subtree (may contain lazy components) |

Multiple lazy components under one `Suspense`: fallback shows until **all**
resolve.

---

## Portals

Render children into a DOM node outside the component hierarchy:

```tsx
import { Portal } from "aio";

const Modal = () => (
  <Portal target={document.getElementById("modal-root")!}>
    <div className="modal">I'm rendered in #modal-root!</div>
  </Portal>
);
```

| Prop       | Type   | Description                 |
| ---------- | ------ | --------------------------- |
| `target`   | `Node` | The DOM node to render into |
| `children` | any    | Content to render           |

Portal content is cleaned up on unmount. Portals are skipped during SSR.

---

## Server-Side Rendering

### renderToString()

```ts
function renderToString(vnode: VNode | string | number | null): string;
```

Render a component tree to HTML string. No DOM required.

```tsx
import { renderToString } from "aio";

const html = renderToString(
  <div className="app">
    <h1>Hello SSR</h1>
    <MyComponent name="World" />
  </div>,
);
```

Features:

- Components are executed and serialized
- Void elements self-close correctly
- HTML entities are escaped
- Style objects converted to CSS strings
- Event handlers, refs, and keys are omitted
- ErrorBoundary catches errors and renders fallback
- Suspense renders fallback for unresolved lazy components

### Hydration

1. Server renders HTML with `renderToString(<App />)`
2. HTML is sent to browser
3. Browser calls `hydrate(root, App)`
4. Hydration walks existing DOM in parallel with VNode tree:
   - Attaches references
   - Binds event listeners
   - Registers signal subscriptions
   - Does **not** recreate DOM nodes
5. If structure doesn't match, falls back to full `mount`

```tsx
// Server
const html = renderToString(<App />);

// Browser
hydrate(document.getElementById("root")!, App);
// DOM is now interactive — same nodes, events attached
```

---

## Forms

### useForm()

```ts
function useForm<T extends Record<string, unknown>>(
  config: { [K in keyof T]: { initial: T[K]; rules?: ValidationRule<T[K]>[] } },
): FormState<T>;
```

Signal-based form state. Call outside the component body (like `signal`).

```tsx
const form = useForm({
  email: {
    initial: "",
    rules: [
      (v) => v ? null : "Required",
      (v) => v.includes("@") ? null : "Must be an email",
    ],
  },
  password: {
    initial: "",
    rules: [(v) => v.length >= 8 ? null : "Min 8 characters"],
  },
});

const LoginForm = () => (
  <form
    onSubmit={(e: Event) => {
      e.preventDefault();
      if (form.validate()) console.log(form.values());
    }}
  >
    <input type="email" {...form.bind("email")} />
    {form.fields.email.error && (
      <span className="err">{form.fields.email.error}</span>
    )}

    <input type="password" {...form.bind("password")} />
    {form.fields.password.error && (
      <span className="err">{form.fields.password.error}</span>
    )}

    <button type="submit" disabled={!form.valid}>Login</button>
  </form>
);
```

**ValidationRule**: `(value: T) => string | null` — return error message or
`null`.

**Validation timing**: errors computed on `.touch()` (blur) and on `.set()` if
already touched. `form.validate()` touches all fields.

**FormState\<T\>:**

| Member       | Type                         | Description                            |
| ------------ | ---------------------------- | -------------------------------------- |
| `fields`     | `{ [K]: FieldState<T[K]> }`  | Per-field state objects                |
| `valid`      | `boolean`                    | All fields have no error               |
| `dirty`      | `boolean`                    | Any field modified from initial        |
| `values()`   | `T`                          | Get all current values as plain object |
| `validate()` | `boolean`                    | Touch all, return valid                |
| `reset()`    | `void`                       | Reset all fields to initial            |
| `bind(name)` | `{ value, onInput, onBlur }` | Bind props for `<input>`               |

**FieldState\<T\>:**

| Member      | Type             | Description                                  |
| ----------- | ---------------- | -------------------------------------------- |
| `value`     | `T`              | Signal-tracked current value                 |
| `error`     | `string \| null` | Current validation error                     |
| `dirty`     | `boolean`        | Modified from initial                        |
| `touched`   | `boolean`        | Has been blurred                             |
| `set(next)` | `void`           | Set value, update dirty, validate if touched |
| `touch()`   | `void`           | Mark touched, run validation                 |
| `reset()`   | `void`           | Reset to initial                             |

### useFieldArray()

```ts
function useFieldArray<T>(initial?: T[]): FieldArrayState<T>;
```

Dynamic array field. Call outside the component body.

```tsx
const tags = useFieldArray<string>(["default"]);

const TagEditor = () => (
  <div>
    {tags.items.map((tag, i) => (
      <div key={i}>
        <span>{tag}</span>
        <button onClick={() => tags.remove(i)}>x</button>
      </div>
    ))}
    <button onClick={() => tags.push("new")}>Add Tag</button>
  </div>
);
```

**FieldArrayState\<T\>:**

| Member             | Type   | Description            |
| ------------------ | ------ | ---------------------- |
| `items`            | `T[]`  | Signal-tracked array   |
| `push(item)`       | `void` | Append                 |
| `remove(index)`    | `void` | Remove at index        |
| `move(from, to)`   | `void` | Reorder                |
| `set(index, item)` | `void` | Replace at index       |
| `reset()`          | `void` | Reset to initial array |

---

## Animation

### useTransition()

```ts
function useTransition(config: TransitionConfig): TransitionState;
```

CSS transition orchestration. Call outside the component body.

```tsx
const fade = useTransition({ name: "fade", duration: 200 });

const App = () => (
  <div>
    <button onClick={() => fade.toggle()}>Toggle</button>
    {fade.mounted && <div className={fade.className}>I fade in and out</div>}
  </div>
);
```

CSS classes applied: `fade-enter` → `fade-active` → `fade-exit` → idle.

```css
.fade-enter {
  opacity: 0;
}
.fade-active {
  opacity: 1;
  transition: opacity 200ms;
}
.fade-exit {
  opacity: 0;
  transition: opacity 200ms;
}
```

**TransitionConfig:**

| Prop       | Type      | Default | Description           |
| ---------- | --------- | ------- | --------------------- |
| `name`     | `string`  | —       | Base class name       |
| `duration` | `number`  | `300`   | Exit duration in ms   |
| `initial`  | `boolean` | `false` | Start in active state |

**TransitionState:**

| Member      | Type                                      | Description                 |
| ----------- | ----------------------------------------- | --------------------------- |
| `stage`     | `"enter" \| "active" \| "exit" \| "idle"` | Current stage               |
| `mounted`   | `boolean`                                 | Whether to render in DOM    |
| `className` | `string`                                  | CSS class for current stage |
| `enter()`   | `void`                                    | Start enter                 |
| `exit()`    | `void`                                    | Start exit                  |
| `toggle()`  | `void`                                    | Flip between enter/exit     |

### useSpring()

```ts
function useSpring(config?: SpringConfig): SpringValue;
```

Spring physics animation. Call outside the component body.

```tsx
const x = useSpring({ initial: 0, stiffness: 200, damping: 20 });

const Box = () => (
  <div
    style={{ transform: `translateX(${x.value}px)` }}
    onClick={() => x.to(x.value === 0 ? 200 : 0)}
  >
    Click me
  </div>
);
```

Uses actual `requestAnimationFrame` timestamps for frame-rate-independent
animation. Delta time clamped at 64ms to prevent spiral on tab switch.

**SpringConfig:**

| Prop        | Type     | Default | Description           |
| ----------- | -------- | ------- | --------------------- |
| `initial`   | `number` | `0`     | Starting value        |
| `stiffness` | `number` | `170`   | Spring constant       |
| `damping`   | `number` | `26`    | Damping coefficient   |
| `mass`      | `number` | `1`     | Mass                  |
| `precision` | `number` | `0.01`  | Convergence threshold |

**SpringValue:**

| Member       | Type      | Description                    |
| ------------ | --------- | ------------------------------ |
| `value`      | `number`  | Signal-tracked current value   |
| `animating`  | `boolean` | Whether animation is running   |
| `to(target)` | `void`    | Animate to target              |
| `set(value)` | `void`    | Immediately set (no animation) |

---

## Virtual Scrolling

### useVirtualList()

```ts
function useVirtualList<T>(config: VirtualListConfig<T>): VirtualListState<T>;
```

Renders only visible items. Call outside the component body.

```tsx
const items = signal(
  Array.from({ length: 10000 }, (_, i) => ({ id: i, name: `Item ${i}` })),
);
const vlist = useVirtualList({ items, itemHeight: 40, containerHeight: 400 });

const BigList = () => (
  <div style={vlist.containerStyle} onScroll={vlist.onScroll}>
    <div style={vlist.innerStyle}>
      {vlist.visible.map(({ item, index, offset }) => (
        <div
          key={index}
          style={{
            position: "absolute",
            top: `${offset}px`,
            height: "40px",
            width: "100%",
          }}
        >
          {item.name}
        </div>
      ))}
    </div>
  </div>
);
```

**VirtualListConfig\<T\>:**

| Prop              | Type                 | Default | Description                      |
| ----------------- | -------------------- | ------- | -------------------------------- |
| `items`           | `T[] \| Signal<T[]>` | —       | Items (plain or reactive)        |
| `itemHeight`      | `number`             | —       | Fixed height per item (px)       |
| `containerHeight` | `number`             | —       | Container height (px)            |
| `overscan`        | `number`             | `3`     | Extra items above/below viewport |

**VirtualListState\<T\>:**

| Member             | Type                                           | Description                    |
| ------------------ | ---------------------------------------------- | ------------------------------ |
| `visible`          | `{ item: T; index: number; offset: number }[]` | Visible items                  |
| `totalHeight`      | `number`                                       | Total scrollable height        |
| `scrollTop`        | `number`                                       | Current scroll position        |
| `onScroll(e)`      | `void`                                         | Pass to container's `onScroll` |
| `scrollToIndex(i)` | `void`                                         | Jump to item                   |
| `containerStyle`   | `Record<string, string>`                       | Apply to scroll container      |
| `innerStyle`       | `Record<string, string>`                       | Apply to inner wrapper         |

Items can be a `Signal<T[]>` — the visible window recomputes automatically.

---

## DevTools

Connect to the AIO DevTools inspector and Redux DevTools Extension.

```tsx
import { connectAioDevTools } from "aio";

const devtools = connectAioDevTools();
// devtools.tree — component tree (signal-tracked)
// devtools.renders — recent render events (ring buffer, max 200)
// devtools.totalRenders — total render count
// devtools.connected — connection status
// devtools.disconnect() — clean up
```

Automatically bridges to Redux DevTools browser extension. Render events appear
as `RENDER/ComponentName` actions.

**DevToolsHandle:**

| Member         | Type                  | Description              |
| -------------- | --------------------- | ------------------------ |
| `tree`         | `ComponentTreeNode[]` | Component hierarchy      |
| `renders`      | `RenderEvent[]`       | Recent renders (max 200) |
| `totalRenders` | `number`              | Total since connect      |
| `connected`    | `boolean`             | Connection status        |
| `disconnect()` | `void`                | Clean up                 |

---

## Mounting & Rendering

### mount()

```ts
function mount(root: HTMLElement, App: ComponentFn): MountHandle;
```

Initialize the renderer. Clears `root.innerHTML`, executes `App`, renders to
DOM.

```tsx
const App = () => <div>Hello world</div>;
const handle = mount(document.getElementById("root")!, App);
```

### hydrate()

```ts
function hydrate(root: HTMLElement, App: ComponentFn): MountHandle;
```

Attach to existing server-rendered DOM without recreating elements.

```tsx
const handle = hydrate(document.getElementById("root")!, App);
```

### unmount

```ts
function _unmount(handle: MountHandle): void;
```

Dispose all instances, run cleanups, clear DOM.

---

## Architecture

### Rendering Pipeline

```
mount(root, App)
  │
  ├─ <App />                    Create root VNode
  ├─ _render(root, vnode)       Walk tree, create DOM, attach hooks
  │   │
  │   ├─ beforeComponent()      Start signal tracking scope
  │   ├─ App(props)             Execute component function
  │   ├─ afterComponent()       End tracking, create instance, subscribe
  │   ├─ [recurse children]
  │   └─ afterSubtree()         Pop instance stack
  │
  └─ return MountHandle

Signal changes:
  signal.set(newValue)
    → notify subscribers
    → queueMicrotask(_flushPending)
    → _rerenderComponent(instance)
      → cleanup old deps/tracking/computeds
      → re-execute component with new tracking scope
      → _diff(parentDom, newRendered, oldRendered)
      → subscribe to new deps
```

### Per-Component Reactivity

Each component runs in its own tracking scope. Only signals **read during
render** become dependencies.

```tsx
const a = signal(1);
const b = signal(2);

const CompA = () => <span>A: {a.value}</span>; // tracks only 'a'
const CompB = () => <span>B: {b.value}</span>; // tracks only 'b'

a.set(10); // only CompA re-renders
b.set(20); // only CompB re-renders
```

Fundamentally different from React, where a parent re-render re-renders all
children unless they opt out with `React.memo`.

### Auto-Memo

When a parent re-renders, child components are checked before re-execution:

1. Is the child's own signal triggered? → Re-render.
2. Are props shallowly equal to previous? → **Skip**.
3. Are children references identical? → **Skip**.

Automatic. No `React.memo`, no `useMemo`, no `useCallback`.

```tsx
const parentSignal = signal("parent");
const childSignal = signal("child");

const Child = (props: { label: string }) => (
  <span>{props.label}: {childSignal.value}</span>
);

const Parent = () => (
  <div>
    Parent: {parentSignal.value}
    <Child label="static" /> {/* auto-skipped when parentSignal changes */}
  </div>
);

parentSignal.set("updated"); // Parent re-renders, Child is skipped (same props)
childSignal.set("updated"); // Only Child re-renders
```

### Per-Mount Isolation

Each `mount()` creates an independent render root with its own pending queue.
Multiple mounts on the same page don't interfere:

```tsx
const handle1 = mount(root1, App1);
const handle2 = mount(root2, App2);
// Signal changes in App1's tree queue re-renders only in handle1
```

---

## h() — Non-TSX Usage

For environments without a TSX compiler (tests, scripts), use `h()` directly:

```ts
import { Fragment, h, mount } from "aio";

// Element
h("div", { className: "card" }, "Hello");

// Component
h(MyComponent, { name: "Alice" });

// Fragment
h(Fragment, null, h("span", null, "A"), h("span", null, "B"));

// Nested children
h("ul", null, items.map((i) => h("li", { key: i.id }, i.name)));
```

`h()` is what TSX compiles to. The JSX runtime in `src/jsx-runtime.ts` maps
`<div className="card">Hello</div>` →
`h("div", { className: "card" }, "Hello")`.

---

## API Reference (Cheat Sheet)

### Signals

| Function   | Signature                      | Description                    |
| ---------- | ------------------------------ | ------------------------------ |
| `signal`   | `signal<T>(init): Signal<T>`   | Writable reactive value        |
| `computed` | `computed<T>(fn): Computed<T>` | Lazy derived value             |
| `effect`   | `effect(fn): dispose`          | Side effect with auto-tracking |
| `batch`    | `batch(fn): void`              | Coalesce updates               |

### Components & VDOM

| Function         | Signature                           | Description                                |
| ---------------- | ----------------------------------- | ------------------------------------------ |
| `h`              | `h(tag, props, ...children): VNode` | Create virtual node (TSX compiles to this) |
| `Fragment`       | `<>...</>`                          | Wrapper-less children group                |
| `ErrorBoundary`  | `<ErrorBoundary fallback={fn}>`     | Error catcher with fallback                |
| `Portal`         | `<Portal target={node}>`            | Render into external DOM node              |
| `Suspense`       | `<Suspense fallback={node}>`        | Loading fallback for lazy                  |
| `lazy`           | `lazy(loader): ComponentFn`         | Code-split component                       |
| `renderToString` | `renderToString(vnode): string`     | SSR                                        |

### Renderer

| Function   | Signature                         | Description                   |
| ---------- | --------------------------------- | ----------------------------- |
| `mount`    | `mount(root, App): MountHandle`   | Initialize and render         |
| `hydrate`  | `hydrate(root, App): MountHandle` | Attach to server-rendered DOM |
| `_unmount` | `_unmount(handle): void`          | Tear down                     |

### Hooks (inside component body)

| Function        | Signature                               | Description                   |
| --------------- | --------------------------------------- | ----------------------------- |
| `onMount`       | `onMount(fn): void`                     | After first render            |
| `onCleanup`     | `onCleanup(fn): void`                   | Before re-render & on unmount |
| `useRef`        | `useRef<T>(init): { current: T }`       | Persistent mutable ref        |
| `createContext` | `createContext<T>(default): Context<T>` | Create context                |
| `useContext`    | `useContext<T>(ctx): T`                 | Read context value            |

### Utilities

| Function             | Signature                                        | Description                  |
| -------------------- | ------------------------------------------------ | ---------------------------- |
| `useForm`            | `useForm<T>(config): FormState<T>`               | Form state + validation      |
| `useFieldArray`      | `useFieldArray<T>(init?): FieldArrayState<T>`    | Dynamic array field          |
| `useTransition`      | `useTransition(config): TransitionState`         | CSS transition orchestration |
| `useSpring`          | `useSpring(config?): SpringValue`                | Spring physics animation     |
| `useVirtualList`     | `useVirtualList<T>(config): VirtualListState<T>` | Windowed list                |
| `connectAioDevTools` | `connectAioDevTools(): DevToolsHandle`           | Inspector + Redux DevTools   |
| `setDevMode`         | `setDevMode(enabled): void`                      | Dev warnings                 |

---

## Summary — React vs AIO

| Pattern        | React                               | AIO                             |
| -------------- | ----------------------------------- | ------------------------------- |
| State          | `useState` inside component         | `signal` outside component      |
| Derived        | `useMemo` + dep array               | `computed` (auto-tracked)       |
| Side effects   | `useEffect` + dep array             | `effect` (auto-tracked)         |
| Memoization    | `React.memo` + `useCallback`        | Automatic (auto-memo)           |
| Context        | Re-renders all consumers            | Signal — only readers re-render |
| Error boundary | Class component (15+ LOC)           | Built-in `<ErrorBoundary>`      |
| Forms          | `react-hook-form` (external)        | Built-in `useForm`              |
| Animation      | `react-spring` (external)           | Built-in `useSpring`            |
| Transitions    | `react-transition-group` (external) | Built-in `useTransition`        |
| Virtual scroll | `react-window` (external)           | Built-in `useVirtualList`       |
| SSR            | `react-dom/server`                  | Built-in `renderToString`       |
| Code splitting | `React.lazy` + `Suspense`           | `lazy` + `Suspense` (same API)  |
| Syntax         | TSX                                 | TSX (same)                      |
| Bundle         | React + ReactDOM ~40KB gzip         | ~8KB total, 0 deps              |
