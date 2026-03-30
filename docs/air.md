# AIR — AIO Internal Renderer

React syntax. No React baggage.

AIR uses the same TSX you already know — `<div>`, `<button>`, components, props,
children — but eliminates the boilerplate React forces on you: no `useState`, no
`useCallback`, no `useMemo`, no `React.memo`, no dependency arrays, no stale
closures. Signals handle reactivity automatically.

```tsx
import { mount, signal } from "aio/air";

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
- [What AIR Does Automatically](#what-air-does-automatically)
- [Signals](#signals)
  - [signal()](#signal)
  - [computed()](#computed)
  - [effect()](#effect)
  - [batch()](#batch)
  - [untrack()](#untrack)
  - [watch()](#watch)
  - [on()](#on)
  - [afterRender()](#afterrender)
- [Components](#components)
  - [Props & Children](#props--children)
  - [Conditional Rendering (+ Show)](#conditional-rendering)
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
  - [useId()](#useid)
  - [useOptimistic()](#useoptimistic)
- [Context](#context)
  - [createContext()](#createcontext)
  - [useContext()](#usecontext)
  - [useContextSelector()](#usecontextselector)
  - [Context.Provider](#contextprovider)
- [Error Handling](#error-handling)
- [Code Splitting](#code-splitting)
  - [lazy()](#lazy)
  - [Suspense](#suspense)
- [Async Data](#async-data)
  - [resource()](#resource)
- [Directives — use Prop](#directives--use-prop)
- [Islands](#islands)
  - [island()](#island)
- [Portals](#portals)
- [Server-Side Rendering](#server-side-rendering)
  - [renderToString()](#rendertostring)
  - [renderToStream()](#rendertostream)
  - [Hydration](#hydration)
- [Routing](#routing)
  - [useRoute()](#useroute)
  - [useNavigate()](#usenavigate)
  - [Route, Outlet, Link, NavLink, Redirect](#route-outlet-link-navlink-redirect)
- [Forms](#forms)
  - [useForm()](#useform)
  - [useFieldArray()](#usefieldarray)
- [Animation](#animation)
  - [Transition Presets](#transition-presets--fade-slide-scale)
  - [\<Transition\>](#transition)
  - [\<TransitionGroup\>](#transitiongroup)
  - [useTransition()](#usetransition)
  - [useSpring()](#usespring)
- [Virtual Scrolling](#virtual-scrolling)
  - [useVirtualList()](#usevirtuallist)
- [Element Dimensions](#element-dimensions)
  - [useDimensions()](#usedimensions)
- [Deferred Loading](#deferred-loading)
  - [\<Defer\>](#defer)
- [Accessibility (Dev Mode)](#accessibility-dev-mode)
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
  - [Frozen VNodes](#frozen-vnodes-static-optimization)
  - [Signal-Bound Attributes](#signal-bound-attributes)
- [React Compat Hooks](#react-compat-hooks)
- [Custom Adapters](#custom-adapters)
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

That's it. Write `.tsx` files. The JSX compiler maps `<div>` to AIR's virtual
DOM — no React import needed.

> **Types:** AIO uses `@types/react` for HTML intrinsic element types
> (`HTMLAttributes`, `CSSProperties`, etc.), so you get full autocomplete and
> type checking on all HTML/SVG elements.

All component imports come from `aio/air`:

```ts
import { computed, effect, mount, signal, useFeature } from "aio/air";
```

---

## Connecting to AIO Server State

AIR connects to the server's state pipeline with the same hooks the React
renderer uses. Same `{ state, send }` pattern, same feature refs.

### useFeature — Subscribe to a feature

```tsx
import { mount, useFeature } from "aio/air";
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
import { useAio } from "aio/air";

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
import { useLocal } from "aio/air";

const EditToggle = () => {
  const { local, set } = useLocal(false);
  return (
    <button onClick={() => set(!local)}>
      {local ? "Cancel" : "Edit"}
    </button>
  );
};
```

Not synced to server. For UI-only state like modals, tabs, form visibility.
`set()` accepts a value or updater function. For objects, `patch()` merges
partial updates.

### useConnected — Connection status

```tsx
import { useConnected } from "aio/air";

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

## What AIR Does Automatically

Things you do manually in React that AIR handles for you:

| React boilerplate              | AIR equivalent                       | Why it's automatic                                    |
| ------------------------------ | ------------------------------------ | ----------------------------------------------------- |
| `useState` + setter            | `signal` — read/write anywhere       | State lives outside components, no re-render cascade  |
| `useMemo(() => ..., [deps])`   | `computed(() => ...)`                | Auto-tracks which signals are read, no dep array      |
| `useEffect(() => ..., [deps])` | `effect(() => ...)`                  | Auto-tracks dependencies, no stale closures           |
| `useCallback(fn, [deps])`      | Plain function                       | Signals read `.peek()` in handlers — always fresh     |
| `React.memo(Component)`        | Automatic                            | Props shallow-compared on every parent re-render      |
| Dependency arrays              | Nothing                              | Signals track reads automatically                     |
| Stale closure bugs             | Impossible                           | No closures over stale state — signals always current |
| Context re-render storms       | Doesn't happen                       | Context values are signals — only readers re-render   |
| `react-hook-form`              | Built-in `useForm`                   | Signal-based, field-level reactivity                  |
| `react-spring`                 | Built-in `useSpring`                 | Signal-tracked spring physics                         |
| `react-transition-group`       | `<Transition>` / `<TransitionGroup>` | Declarative CSS enter/exit + FLIP reorder             |
| `react-window`                 | Built-in `useVirtualList`            | Windowed scrolling                                    |
| ErrorBoundary class (37 LOC)   | `<ErrorBoundary>`                    | Built-in, one line                                    |
| Conditional render + types     | `<Show when={v}>`                    | TypeScript narrows the truthy value                   |
| `React.lazy` + Suspense        | `<Defer trigger="viewport">`         | Viewport/idle/hover/timer triggers                    |
| `useSWR` / `react-query`       | `resource()`                         | Signal-based async data with auto-refetch             |
| Custom ResizeObserver hook     | `useDimensions()`                    | Reactive width/height signals                         |
| `eslint-plugin-jsx-a11y`       | Built-in dev-mode a11y               | Runtime warnings for img/alt, keyboard, labels        |

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
import { signal } from "aio/air";

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

| Member            | Description                                       |
| ----------------- | ------------------------------------------------- |
| `.value`          | Read with automatic dependency tracking           |
| `.peek()`         | Read without tracking (use in event handlers)     |
| `.set(next)`      | Write and notify. No-op if `Object.is(old, next)` |
| `.set(prev => v)` | Updater form — receives current value             |
| `.subscribe(fn)`  | Manual subscriber, returns unsubscribe fn         |
| `._name`          | Optional debug name (pass as 2nd arg to signal)   |

**Updater form:**

```tsx
count.set((prev) => prev + 1); // safe — no stale closures
```

**Named signals (for devtools and diagnostics):**

```ts
const count = signal(0, "count"); // _name appears in devtools + flush warnings
```

### computed()

```ts
function computed<T>(fn: () => T): Computed<T>;
```

Create a derived value that recomputes lazily when dependencies change.

```tsx
import { computed, signal } from "aio/air";

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
import { effect, signal } from "aio/air";

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
import { batch, signal } from "aio/air";

const firstName = signal("John");
const lastName = signal("Doe");

batch(() => {
  firstName.set("Jane");
  lastName.set("Smith");
});
// Components that track both are notified once, not twice.
```

### untrack()

```ts
function untrack<T>(fn: () => T): T;
```

Execute a function without tracking signal reads. Useful inside effects or
components when you need to read a signal without creating a dependency.

```tsx
import { effect, signal, untrack } from "aio/air";

const a = signal(1);
const b = signal(2);

effect(() => {
  // Tracks 'a', but reads 'b' without tracking
  console.log(a.value, untrack(() => b.value));
});

b.set(10); // effect does NOT re-run (b is untracked)
a.set(2); // effect re-runs (a is tracked)
```

### watch()

```ts
function watch<T>(
  source: Signal<T> | Computed<T>,
  fn: (next: T, prev: T | undefined) => void,
  opts?: { immediate?: boolean },
): () => void;
```

Watch a single signal or computed for changes. Returns a dispose function.

```tsx
import { signal, watch } from "aio/air";

const theme = signal("light");

const stop = watch(theme, (next, prev) => {
  console.log(`Theme changed: ${prev} → ${next}`);
  document.body.className = next;
});

theme.set("dark"); // logs: "Theme changed: light → dark"
stop(); // stops watching
```

With `immediate: true`, the callback fires once with current value on creation:

```ts
watch(theme, (val) => applyTheme(val), { immediate: true });
```

### on()

```ts
function on<T>(
  source: Signal<T> | Computed<T>,
  fn: (next: T, prev: T) => void,
): () => void;
```

Like `watch()` but skips the initial value — only fires on **changes**. Both
`next` and `prev` are guaranteed defined.

```tsx
import { on, signal } from "aio/air";

const count = signal(0);

const stop = on(count, (next, prev) => {
  console.log(`Changed from ${prev} to ${next}`);
});

count.set(1); // logs: "Changed from 0 to 1"
```

### afterRender()

```ts
function afterRender(fn: () => void): void;
```

Register a callback to run after the current render pass commits to the DOM.
Must be called inside a component body.

```tsx
import { afterRender, signal } from "aio/air";

const App = () => {
  const height = signal(0);

  afterRender(() => {
    // DOM is committed — safe to measure
    const el = document.getElementById("content");
    if (el) height.set(el.offsetHeight);
  });

  return <div id="content">Height: {height.value}px</div>;
};
```

Useful for DOM measurements, scroll positioning, or third-party library
initialization that needs the real DOM.

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

Ternary or `&&` (same as React):

```tsx
const loggedIn = signal(false);

const App = () => (
  <div>
    {loggedIn.value ? <Dashboard /> : <LoginForm />}
    {loggedIn.value && <UserMenu />}
  </div>
);
```

**`<Show>` component** — conditional rendering with TypeScript narrowing:

```tsx
import { Show, signal } from "aio/air";

const user = signal<{ name: string } | null>(null);

const App = () => (
  <Show when={user.value} fallback={<span>Loading...</span>}>
    {(u) => <div>Hello, {u.name}!</div>}
  </Show>
);
```

`Show` narrows the type — `u` is `{ name: string }`, not `null`. The render
function only runs when `when` is truthy.

| Prop       | Type                   | Description                       |
| ---------- | ---------------------- | --------------------------------- |
| `when`     | `T \| falsy`           | Condition — truthy enables render |
| `fallback` | `VChild`               | Shown when `when` is falsy        |
| `children` | `(value: T) => VChild` | Render function with narrowed T   |

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
import { Fragment } from "aio/air";

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
import { useRef } from "aio/air";

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
// Style object (camelCase -> CSS)
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

> **Note:** AIR uses native DOM events, not React synthetic events. Use
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

### onCleanup()

```ts
function onCleanup(fn: () => void): void;
```

Behavior depends on **where** it's called:

| Context                     | Runs on re-render | Runs on unmount |
| --------------------------- | ----------------- | --------------- |
| Component body              | Yes               | Yes             |
| Inside `onMount()` callback | No                | Yes             |

**Body-level** — cleanup before each re-render and on unmount:

```tsx
import { onCleanup, signal } from "aio/air";

const Fetcher = (props: { url: string }) => {
  const data = signal(null);
  const controller = new AbortController();
  onCleanup(() => controller.abort()); // aborts on re-render AND unmount

  fetch(props.url, { signal: controller.signal })
    .then((r) => r.json())
    .then((d) => data.set(d));

  return data.value
    ? <pre>{JSON.stringify(data.value)}</pre>
    : <span>Loading...</span>;
};
```

**Inside onMount()** — cleanup only on unmount (like React's
`useEffect(fn, [])`):

```tsx
import { onCleanup, onMount } from "aio/air";

const KeyboardListener = () => {
  onMount(() => {
    const handler = (e: KeyboardEvent) => console.log(e.key);
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
    // ^ runs ONLY on unmount — listener survives re-renders
  });

  return <div>Press any key</div>;
};
```

This is the recommended pattern for persistent listeners, subscriptions, and
third-party integrations that must survive re-renders.

Throwing inside a cleanup callback does not break subsequent cleanups.

### useRef()

```ts
function useRef<T>(initial: T): { current: T };
```

Persist a mutable value across re-renders. Mutations do **not** trigger
re-render.

```tsx
import { signal, useRef } from "aio/air";

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

### useId()

```ts
function useId(): string;
```

Generate a unique, SSR-stable ID. Persists across re-renders. Format: `:r{N}:`.

```tsx
import { useId } from "aio/air";

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

IDs are deterministic — the same component tree produces the same IDs on server
and client, making `useId()` safe for SSR + hydration. Each `mount()` root has
its own counter, so multiple roots don't collide.

**React equivalent:** `useId()` (React 18+). Same API, same behavior.

### useOptimistic()

```ts
function useOptimistic<T, A = T>(
  passthrough: T,
  updateFn: (current: T, optimistic: A) => T,
): [T, (action: A) => void];
```

Show an immediate UI update while an async action (e.g., server round-trip) is
in flight. When `passthrough` changes (server confirms), the optimistic overlay
clears automatically.

```tsx
import { useFeature, useOptimistic } from "aio/air";
import { todoFeature } from "./app.ts";

const TodoList = () => {
  const { state, send } = useFeature(todoFeature);

  const [items, addOptimistic] = useOptimistic(
    state.items,
    (current, newItem: { id: number; text: string }) => [...current, newItem],
  );

  function handleAdd(text: string) {
    // Show immediately in UI
    addOptimistic({ id: Date.now(), text });
    // Send to server — when server confirms, state.items updates
    // and the optimistic overlay clears
    send.addTodo(text);
  }

  return (
    <ul>
      {items.map((item) => <li key={item.id}>{item.text}</li>)}
    </ul>
  );
};
```

- `passthrough` — the confirmed state (usually from `useFeature`).
- `updateFn` — pure function that applies optimistic values on top of current
  state.
- Multiple `addOptimistic()` calls stack — all pending overlays apply in order.
- When `passthrough` reference changes, all pending overlays clear.

**React equivalent:** `useOptimistic()` (React 19). Same API shape.

---

## Context

Pass values down the component tree without prop drilling. Same concept as
React.

### createContext()

```ts
function createContext<T>(defaultValue: T): Context<T>;
```

```tsx
import { createContext } from "aio/air";

const ThemeCtx = createContext<"light" | "dark">("light");
```

### useContext()

```ts
function useContext<T>(ctx: Context<T>): T;
```

Read the current context value inside a component.

```tsx
import { useContext } from "aio/air";

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

### useContextSelector()

```ts
function useContextSelector<T, R>(
  ctx: Context<T>,
  selector: (value: T) => R,
): R;
```

Select a subset of context — re-renders only when the selected value changes
(shallow equality check). Prevents re-rendering when unrelated context fields
update.

```tsx
import { createContext, useContextSelector } from "aio/air";

const AppCtx = createContext({ theme: "light", locale: "en", count: 0 });

// Only re-renders when theme changes, ignores count/locale changes
const ThemedBox = () => {
  const theme = useContextSelector(AppCtx, (ctx) => ctx.theme);
  return <div className={theme}>themed</div>;
};
```

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

## Code Splitting

### lazy()

```ts
function lazy(loader: () => Promise<{ default: ComponentFn }>): ComponentFn;
```

```tsx
import { lazy, Suspense } from "aio/air";

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
import { Suspense } from "aio/air";

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

## Async Data

### resource()

```ts
function resource<S, T>(
  source: () => S,
  fetcher: (source: S, opts: { signal: AbortSignal }) => Promise<T>,
): Resource<T>;
```

Fetch async data as reactive signals. Automatically refetches when the source
signal changes. Aborts in-flight requests on source change or dispose.

```tsx
import { resource, signal } from "aio/air";

const userId = signal(1);

const user = resource(
  () => userId.value,
  async (id, { signal }) => {
    const res = await fetch(`/api/users/${id}`, { signal });
    return res.json();
  },
);

const UserCard = () => {
  if (user.loading.value) return <span>Loading...</span>;
  if (user.error.value) return <span>Error!</span>;
  return <div>{user.value?.name}</div>;
};
```

**Resource\<T\>:**

| Member          | Type                     | Description                                     |
| --------------- | ------------------------ | ----------------------------------------------- |
| `value`         | `T \| undefined`         | Current data (undefined during fetch)           |
| `latest`        | `Signal<T \| undefined>` | Last successful data (preserved during refetch) |
| `loading`       | `Signal<boolean>`        | True while fetching                             |
| `error`         | `Signal<unknown>`        | Error from last failed fetch                    |
| `refetch()`     | `void`                   | Manually trigger refetch                        |
| `mutate(value)` | `void`                   | Optimistically set value (clears error)         |
| `dispose()`     | `void`                   | Stop tracking, abort in-flight                  |

---

## Directives — `use` Prop

Attach reusable behaviors to DOM elements via the `use` prop:

```tsx
import { signal } from "aio/air";

// Define an action (receives element + optional value)
function autoFocus(el: HTMLElement) {
  el.focus();
  return () => {}; // optional cleanup
}

function tooltip(el: HTMLElement, text: string) {
  el.title = text;
  return () => {
    el.title = "";
  };
}

// Use on elements
const App = () => (
  <div>
    <input use={autoFocus} />
    <button use={[tooltip, "Click me!"]}>Hover</button>
  </div>
);
```

**Action signature:**

```ts
type Action = (el: HTMLElement, value?: unknown) => void | (() => void);
```

- `use={fn}` — calls `fn(element)`
- `use={[fn, value]}` — calls `fn(element, value)`
- Return a cleanup function for teardown on unmount or when `use` changes

Actions are cleaned up and re-applied when the `use` prop identity changes
during diffing. Skipped in SSR.

---

## Islands

Mount external framework components (React, Vue, Solid, etc.) into AIR pages.
AIR owns the page layout; islands manage their own subtree.

### island()

```ts
function island<M>(config: IslandConfig<M>): ComponentFn;
```

```tsx
import { island, signal } from "aio/air";

const ReactChart = island({
  load: () => import("./react-chart.tsx"),
  mount: (container, Chart, props) => {
    const root = ReactDOM.createRoot(container);
    root.render(<Chart {...props} />);
    return {
      update: (p) => root.render(<Chart {...p} />),
      unmount: () => root.unmount(),
    };
  },
  props: () => ({ data: chartData.value }),
});

// Use like a normal AIR component
const Dashboard = () => (
  <div>
    <h1>Dashboard</h1>
    <ReactChart />
  </div>
);
```

**IslandConfig\<M\>:**

| Prop      | Type                                            | Description                           |
| --------- | ----------------------------------------------- | ------------------------------------- |
| `load`    | `() => Promise<M>`                              | Lazy module loader                    |
| `mount`   | `(container, component, props) => IslandHandle` | Mount into container, return handle   |
| `props`   | `() => Record<string, unknown>`                 | Reactive props (signal reads tracked) |
| `loading` | `() => VChild`                                  | Optional loading placeholder          |

**IslandHandle:**

| Method      | Description                        |
| ----------- | ---------------------------------- |
| `update(p)` | Update props in external component |
| `unmount()` | Clean up external component        |

**How it works:**

1. `load()` lazy-imports the external module
2. `mount()` creates the external component in a container `<div>`
3. Signal changes in `props()` automatically call `handle.update()`
4. On AIR unmount, `handle.unmount()` cleans up the external component
5. Failed loads allow retry (module promise clears on error)

---

## Portals

Render children into a DOM node outside the component hierarchy:

```tsx
import { Portal } from "aio/air";

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
import { renderToString } from "aio/air";

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
- HTML entities escaped (including backticks in attributes)
- Style objects converted to CSS strings
- Event handlers, refs, keys, and `use` directives are omitted
- ErrorBoundary catches errors and renders fallback
- Suspense renders fallback for unresolved lazy components

### renderToStream()

```ts
async function* renderToStream(
  vnode: VNode | string | number | null,
): AsyncGenerator<string, void, unknown>;
```

Streaming SSR — yields HTML chunks as an async generator. Elements yield opening
tag, then children (recursively), then closing tag. Ideal for HTTP streaming.

```tsx
import { renderToStream } from "aio/air";

// Deno HTTP server with streaming
Deno.serve(async () => {
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      for await (const chunk of renderToStream(<App />)) {
        controller.enqueue(enc.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
```

Suspense boundaries with unresolved lazy children yield fallback content
synchronously. Content outside Suspense boundaries streams immediately.

| Method           | Use case                              |
| ---------------- | ------------------------------------- |
| `renderToString` | Simple SSR, small pages, tests        |
| `renderToStream` | Large pages, HTTP streaming, low TTFB |

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
import { hydrate, renderToString } from "aio/air";

// Server
const html = renderToString(<App />);

// Browser
hydrate(document.getElementById("root")!, App);
// DOM is now interactive — same nodes, events attached
```

---

## Routing

AIR's router is signal-based — route changes auto-track like any other signal.

### useRoute()

```ts
function useRoute(pattern?: string): RouteState;
```

Read the current route. If `pattern` is provided, matches against it.

```tsx
import { useRoute } from "aio/air";

const UserPage = () => {
  const { path, params, search, matched } = useRoute("/users/:id");
  if (!matched) return null;
  return <div>User: {params.id}</div>;
};
```

**RouteState:**

| Member    | Type                     | Description              |
| --------- | ------------------------ | ------------------------ |
| `path`    | `string`                 | Current path             |
| `params`  | `Record<string, string>` | Matched route parameters |
| `search`  | `string`                 | Query string             |
| `matched` | `boolean`                | Whether pattern matched  |

### useNavigate()

```ts
function useNavigate(): (
  to: string | number,
  opts?: { replace?: boolean },
) => void;
```

Returns the `navigate` function for programmatic navigation.

```tsx
import { useNavigate } from "aio/air";

const GoHome = () => {
  const nav = useNavigate();
  return <button onClick={() => nav("/")}>Home</button>;
};
```

### Route, Outlet, Link, NavLink, Redirect

```tsx
import { Link, NavLink, Outlet, Redirect, Route } from "aio/air";

const App = () => (
  <div>
    <nav>
      <NavLink to="/" exact>Home</NavLink>
      <NavLink to="/about">About</NavLink>
    </nav>
    <Route path="about" element={<About />} />
    <Route path="users" element={<UsersLayout />}>
      <Route index element={<UserList />} />
      <Route path=":id" element={<UserDetail />} />
    </Route>
    <Route path="old" element={<Redirect to="/about" />} />
  </div>
);

const UsersLayout = () => (
  <div>
    <h1>Users</h1>
    <Outlet />
  </div>
);
```

**Route** renders its element when the path matches. Nested Routes support
layouts with `Outlet`.

**Link** navigates without page reload. **NavLink** adds `activeClass` (default
`"active"`) when the path matches. **Redirect** navigates on mount.

---

## Forms

### useForm()

```ts
function useForm<T>(config): FormState<T>;
```

Signal-based form state. Call outside the component body (like `signal`).

```tsx
import { useForm } from "aio/air";

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
import { useFieldArray } from "aio/air";

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

AIR provides a layered animation system: CSS-first declarative transitions for
enter/exit animations, imperative spring physics for continuous values, and
low-level transition hooks for full control.

### Transition Presets — fade, slide, scale

Built-in CSS animation functions. Pass to `<Transition>` or `<TransitionGroup>`:

```tsx
import { fade, scale, slide } from "aio/air";
```

| Preset  | Enter                 | Exit                 |
| ------- | --------------------- | -------------------- |
| `fade`  | Opacity 0 → 1         | Opacity 1 → 0        |
| `slide` | translateY(-20px) → 0 | 0 → translateY(20px) |
| `scale` | scale(0.95) → 1       | 1 → scale(0.95)      |

Each preset accepts `TransitionOptions`:

```ts
fade(node, { duration: 300, delay: 100, easing: "ease-out" });
```

### \<Transition\>

Animate a single child's enter and exit:

```tsx
import { fade, signal, Transition } from "aio/air";

const visible = signal(true);

const App = () => (
  <div>
    <button onClick={() => visible.set(!visible.peek())}>Toggle</button>
    <Transition enter={fade} exit={fade}>
      {visible.value && <div className="card">Hello</div>}
    </Transition>
  </div>
);
```

When the child appears, the `enter` transition plays. When removed, the `exit`
transition plays and DOM removal is **deferred** until the animation completes.

**TransitionProps:**

| Prop       | Type                | Description                       |
| ---------- | ------------------- | --------------------------------- |
| `enter`    | `TransitionFn`      | Enter animation (e.g., `fade`)    |
| `exit`     | `TransitionFn`      | Exit animation (e.g., `fade`)     |
| `options`  | `TransitionOptions` | Duration, delay, easing overrides |
| `children` | any                 | Single conditional child          |

### \<TransitionGroup\>

Animate lists with enter, exit, and FLIP reorder animations:

```tsx
import { fade, signal, TransitionGroup } from "aio/air";

const items = signal(["a", "b", "c"]);

const List = () => (
  <TransitionGroup enter={fade} exit={fade} flip flipDuration={200}>
    {items.value.map((item) => <div key={item}>{item}</div>)}
  </TransitionGroup>
);
```

When items are added, `enter` plays. Removed items animate with `exit` before
DOM removal. When items reorder, FLIP (First-Last-Invert-Play) smoothly animates
position changes.

**TransitionGroupProps:**

| Prop           | Type                | Default | Description                   |
| -------------- | ------------------- | ------- | ----------------------------- |
| `enter`        | `TransitionFn`      | —       | Enter animation               |
| `exit`         | `TransitionFn`      | —       | Exit animation                |
| `options`      | `TransitionOptions` | —       | Shared animation options      |
| `flip`         | `boolean`           | `false` | Enable FLIP reorder animation |
| `flipDuration` | `number`            | `300`   | FLIP animation duration (ms)  |

### Deferred DOM Removal

When a `<Transition>` or `<TransitionGroup>` exit animation is active, AIR holds
the DOM node until the animation completes. This is handled via the
`onBeforeRemove` VDOM hook with a 5-second safety timeout.

### useTransition()

```ts
function useTransition(config: TransitionConfig): TransitionState;
```

Imperative CSS transition orchestration. Call outside the component body.

```tsx
import { useTransition } from "aio/air";

const fade = useTransition({ name: "fade", duration: 200 });

const App = () => (
  <div>
    <button onClick={() => fade.toggle()}>Toggle</button>
    {fade.mounted && <div className={fade.className}>I fade in and out</div>}
  </div>
);
```

CSS classes applied: `fade-enter` -> `fade-active` -> `fade-exit` -> idle.

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
import { mount, useSpring } from "aio/air";

const x = useSpring({ initial: 0, stiffness: 200, damping: 20 });

const Box = () => (
  <div
    style={{ transform: `translateX(${x.value}px)` }}
    onClick={() => x.to(x.value === 0 ? 200 : 0)}
  >
    Click me
  </div>
);

mount(document.getElementById("root")!, Box);
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
import { mount, signal, useVirtualList } from "aio/air";

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

mount(document.getElementById("root")!, BigList);
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

## Element Dimensions

### useDimensions()

```ts
function useDimensions(): DimensionsState;
```

Track an element's content dimensions reactively via `ResizeObserver`. Call
inside a component body.

```tsx
import { useDimensions } from "aio/air";

const ResizablePanel = () => {
  const dims = useDimensions();

  return (
    <div ref={dims.ref} style={{ resize: "both", overflow: "auto" }}>
      Width: {dims.width.value}px, Height: {dims.height.value}px
    </div>
  );
};
```

**DimensionsState:**

| Member   | Type                               | Description                    |
| -------- | ---------------------------------- | ------------------------------ |
| `ref`    | `{ current: HTMLElement \| null }` | Attach to the measured element |
| `width`  | `Signal<number>`                   | Content width in px            |
| `height` | `Signal<number>`                   | Content height in px           |

The observer disconnects automatically on component unmount.

---

## Deferred Loading

### \<Defer\>

Trigger-based lazy loading — load components when they enter the viewport,
become idle, on hover, on interaction, after a timer, or immediately.

```tsx
import { Defer } from "aio/air";

const App = () => (
  <div>
    {/* Load when scrolled into view */}
    <Defer
      trigger="viewport"
      load={() => import("./heavy-chart.ts")}
      placeholder={<div>Chart placeholder</div>}
      loading={<div>Loading chart...</div>}
    />

    {/* Load after 2 seconds */}
    <Defer
      trigger={2000}
      load={() => import("./analytics.ts")}
    />

    {/* Load on hover */}
    <Defer
      trigger="hover"
      load={() => import("./preview.ts")}
      placeholder={<div>Hover to preview</div>}
    />
  </div>
);
```

**DeferProps:**

| Prop             | Type                                      | Description                             |
| ---------------- | ----------------------------------------- | --------------------------------------- |
| `trigger`        | `DeferTrigger`                            | When to start loading                   |
| `load`           | `() => Promise<{ default: ComponentFn }>` | Lazy loader                             |
| `placeholder`    | `VChild`                                  | Shown before trigger fires              |
| `loading`        | `VChild`                                  | Shown while loading (after trigger)     |
| `error`          | `VChild`                                  | Shown on load error                     |
| `loadingMinMs`   | `number`                                  | Minimum time to show loading state (ms) |
| `componentProps` | `Record<string, unknown>`                 | Props passed to loaded component        |

**DeferTrigger:**

| Value           | Behavior                                       |
| --------------- | ---------------------------------------------- |
| `"viewport"`    | IntersectionObserver — loads when visible      |
| `"idle"`        | requestIdleCallback (or 200ms fallback)        |
| `"hover"`       | mouseenter on container                        |
| `"interaction"` | click or keydown on container                  |
| `"immediate"`   | Loads right away (like `lazy` but with states) |
| `number`        | setTimeout with given ms                       |

---

## Accessibility (Dev Mode)

When dev mode is enabled via `setDevMode(true)`, AIR warns about common
accessibility issues during element creation:

| Check                      | Warning                                        |
| -------------------------- | ---------------------------------------------- |
| `<img>` without `alt`      | Missing alt attribute                          |
| `onClick` without keyboard | Non-interactive element needs `onKeyDown`      |
| `<input>` without label    | Needs `id`, `aria-label`, or `aria-labelledby` |

These are `console.warn` messages in dev mode only — zero overhead in
production.

```tsx
import { setDevMode } from "aio/air";

setDevMode(true); // enable a11y warnings + excessive re-render detection
```

---

## DevTools

Connect to the AIO DevTools inspector and Redux DevTools Extension.

```tsx
import { connectAioDevTools } from "aio/air";

const devtools = connectAioDevTools();
// devtools.tree — component tree (signal-tracked)
// devtools.renders — recent render events (ring buffer, max 200)
// devtools.totalRenders — total render count
// devtools.connected — connection status
// devtools.disconnect() — clean up
```

Automatically bridges to Redux DevTools browser extension. Render events appear
as `RENDER/ComponentName` actions with signal trigger names when available.

In dev mode, each re-render records which signal(s) triggered it. Use named
signals (`signal(0, "count")`) for clear devtools output.

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
import { mount } from "aio/air";

const App = () => <div>Hello world</div>;
const handle = mount(document.getElementById("root")!, App);
```

### hydrate()

```ts
function hydrate(root: HTMLElement, App: ComponentFn): MountHandle;
```

Attach to existing server-rendered DOM without recreating elements.

```tsx
import { hydrate } from "aio/air";

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
  |
  +- <App />                    Create root VNode
  +- _render(root, vnode)       Walk tree, create DOM, attach hooks
  |   |
  |   +- beforeComponent()      Start signal tracking scope
  |   +- App(props)             Execute component function
  |   +- afterComponent()       End tracking, create instance, subscribe
  |   +- [recurse children]
  |   +- afterSubtree()         Pop instance stack
  |
  +- return MountHandle

Signal changes:
  signal.set(newValue)
    -> notify subscribers
    -> queueMicrotask(_flushPending)
    -> _rerenderComponent(instance)
      -> cleanup old deps/tracking/computeds
      -> re-execute component with new tracking scope
      -> _diff(parentDom, newRendered, oldRendered)
      -> subscribe to new deps
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

1. Is the child's own signal triggered? -> Re-render.
2. Are props shallowly equal to previous? -> **Skip**.
3. Are children references identical? -> **Skip**.

Automatic. No `React.memo`, no `useMemo`, no `useCallback`.

### Per-Mount Isolation

Each `mount()` creates an independent render root with its own pending queue.
Multiple mounts on the same page don't interfere:

```tsx
const handle1 = mount(root1, App1);
const handle2 = mount(root2, App2);
// Signal changes in App1's tree queue re-renders only in handle1
```

### Frozen VNodes (Static Optimization)

`h()` automatically detects static subtrees — elements with string tags, no
key/ref/use, all primitive props, and all static children. These VNodes get a
`_static = true` flag at creation time.

During diffing, when both old and new VNodes are static with the same tag, a
`_staticEqual()` deep comparison runs (depth-limited to 6 levels). If identical,
the entire subtree is skipped — no DOM operations at all.

```tsx
// This entire subtree is frozen — zero diff cost on re-render
const Header = () => (
  <header>
    <h1>My App</h1>
    <nav>
      <a href="/">Home</a>
      <a href="/about">About</a>
    </nav>
  </header>
);
```

This is fully automatic — no API surface, no opt-in needed.

### Signal-Bound Attributes

When a Signal is passed directly as an element prop, AIR creates a direct
`effect()` that updates the DOM attribute without going through the VDOM diff:

```tsx
const color = signal("red");

// Signal value binds directly to the DOM attribute
const App = () => <div className={color} />;
// When color.set("blue") fires, the class attribute updates via effect
// — no component re-render, no VDOM diff
```

This works for any prop (className, title, disabled, etc.) and for style object
properties:

```tsx
const bg = signal("red");
const App = () => <div style={{ backgroundColor: bg }} />;
```

Signal bindings are automatically cleaned up on unmount. When a different signal
is passed on re-render, old bindings are disposed and new ones created.

---

## React Compat Hooks

AIR exports React-compatible hooks for gradual migration. These allow existing
React component code to compile and run under AIR by changing only the import
path from `react` to `aio/air`.

```tsx
// Before (React)
import { useCallback, useEffect, useMemo, useState } from "react";

// After (AIR — works immediately, optimize later)
import { useCallback, useEffect, useMemo, useState } from "aio/air";
```

**How they work:**

| Hook                                       | AIR behavior                                              | Dev hint                       |
| ------------------------------------------ | --------------------------------------------------------- | ------------------------------ |
| `useState(init)`                           | Signal-backed. Returns `[value, setter]`.                 | Use `useLocal()` or `signal()` |
| `useEffect(fn, [])`                        | Delegates to `onMount()` + `onCleanup()`                  | Use `onMount()` for setup      |
| `useEffect(fn)` or `useEffect(fn, [deps])` | Creates a single `effect()`. Deps ignored (auto-tracked). | Use `effect()` for reactive    |
| `useCallback(fn, deps)`                    | Returns `fn` as-is. No-op.                                | Unnecessary in AIR — remove    |
| `useMemo(fn, deps)`                        | Calls `fn()` and returns result. No caching.              | Use `computed()` for caching   |
| `memo(Component)`                          | Returns Component as-is. No-op.                           | Unnecessary in AIR — remove    |

**Dev hints** fire once per function name per session as `console.info` messages
in dev mode only (gated behind `__aioDev`). They guide you toward AIR-native
alternatives but never affect behavior.

See [AIR vs React](air-vs-react.md) for the full migration guide.

---

## Custom Adapters

Use `aio/state-core` to build adapters for any framework:

```ts
import {
  _resolveWithFallback,
  _trackingProxy,
  createSendProxy,
  getConnectedSignal,
  getFeatureSignal,
  getStateSignal,
  send,
  setTransport,
  trackPath,
} from "aio/state-core";
```

**Minimal adapter contract:**

1. **`useFeature(ref)`** — subscribe to a feature signal via
   `getFeatureSignal()`, return `{ state, send }`
2. **`useAio()`** — subscribe to the full state signal via `getStateSignal()`,
   return `{ state, send }`
3. **`useLocal(initial)`** — framework-local state (no server sync)
4. **`useConnected()`** — subscribe to `getConnectedSignal()`

**Key utilities from state-core:**

| Export                                  | Purpose                                        |
| --------------------------------------- | ---------------------------------------------- |
| `getFeatureSignal(name, defaults?)`     | Per-feature signal                             |
| `getStateSignal()`                      | Full app state signal                          |
| `getConnectedSignal()`                  | Connection status signal                       |
| `trackPath(path)`                       | Register state path for subscription filtering |
| `createSendProxy(name, ref, sendFn?)`   | Typed send methods                             |
| `_trackingProxy(obj, parentPath?)`      | Deep Proxy for automatic path tracking         |
| `_resolveWithFallback(state, defaults)` | Merge incomplete state with defaults           |
| `setTransport({ send, close })`         | Connect a custom transport                     |
| `flushOfflineQueue()`                   | Flush queued actions after transport connects  |

---

## h() — Non-TSX Usage

For environments without a TSX compiler (tests, scripts), use `h()` directly:

```ts
import { Fragment, h, mount } from "aio/air";

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
`<div className="card">Hello</div>` ->
`h("div", { className: "card" }, "Hello")`.

---

## API Reference (Cheat Sheet)

### Signals

| Function   | Signature                           | Description                    |
| ---------- | ----------------------------------- | ------------------------------ |
| `signal`   | `signal<T>(init, name?): Signal<T>` | Writable reactive value        |
| `computed` | `computed<T>(fn): Computed<T>`      | Lazy derived value             |
| `effect`   | `effect(fn): dispose`               | Side effect with auto-tracking |
| `batch`    | `batch(fn): void`                   | Coalesce updates               |
| `untrack`  | `untrack<T>(fn): T`                 | Read without tracking          |
| `watch`    | `watch(source, fn, opts?): dispose` | Watch signal for changes       |
| `on`       | `on(source, fn): dispose`           | Like watch, skips initial      |

### Components & VDOM

| Function         | Signature                              | Description                                |
| ---------------- | -------------------------------------- | ------------------------------------------ |
| `h`              | `h(tag, props, ...children): VNode`    | Create virtual node (TSX compiles to this) |
| `Fragment`       | `<>...</>`                             | Wrapper-less children group                |
| `ErrorBoundary`  | `<ErrorBoundary fallback={fn}>`        | Error catcher with fallback                |
| `Portal`         | `<Portal target={node}>`               | Render into external DOM node              |
| `Suspense`       | `<Suspense fallback={node}>`           | Loading fallback for lazy                  |
| `Show`           | `<Show when={val} fallback={...}>`     | Conditional render with narrowing          |
| `lazy`           | `lazy(loader): ComponentFn`            | Code-split component                       |
| `Defer`          | `<Defer trigger="viewport" load={fn}>` | Trigger-based lazy loading                 |
| `renderToString` | `renderToString(vnode): string`        | Sync SSR                                   |
| `renderToStream` | `renderToStream(vnode): AsyncGen`      | Streaming SSR                              |

### Renderer

| Function  | Signature                         | Description                   |
| --------- | --------------------------------- | ----------------------------- |
| `mount`   | `mount(root, App): MountHandle`   | Initialize and render         |
| `hydrate` | `hydrate(root, App): MountHandle` | Attach to server-rendered DOM |

### Hooks (inside component body)

| Function             | Signature                                 | Description                       |
| -------------------- | ----------------------------------------- | --------------------------------- |
| `onMount`            | `onMount(fn): void`                       | After first render                |
| `onCleanup`          | `onCleanup(fn): void`                     | Before re-render & on unmount     |
| `afterRender`        | `afterRender(fn): void`                   | After DOM commit                  |
| `useRef`             | `useRef<T>(init): { current: T }`         | Persistent mutable ref            |
| `useSignal`          | `useSignal<T>(init, opts?): Signal<T>`    | Component-scoped signal           |
| `useId`              | `useId(): string`                         | SSR-safe unique ID                |
| `useOptimistic`      | `useOptimistic<T,A>(state, fn): [T, add]` | Optimistic UI overlay             |
| `createContext`      | `createContext<T>(default): Context<T>`   | Create context                    |
| `useContext`         | `useContext<T>(ctx): T`                   | Read context value                |
| `useContextSelector` | `useContextSelector<T,R>(ctx, sel): R`    | Selective context (re-render opt) |
| `useDimensions`      | `useDimensions(): DimensionsState`        | Element size tracking             |

### Server State Hooks

| Function        | Signature                                  | Description                      |
| --------------- | ------------------------------------------ | -------------------------------- |
| `useFeature`    | `useFeature(ref): { state, send, status }` | Subscribe to a feature           |
| `useAio`        | `useAio(): { state, send }`                | Subscribe to all state           |
| `useLocal`      | `useLocal(init): { local, set, patch }`    | Client-only state                |
| `useConnected`  | `useConnected(): boolean`                  | Connection status                |
| `useProjection` | `useProjection(fn): T`                     | Derived state with ref stability |
| `useTimeTravel` | `useTimeTravel(ref): TimeTravelState`      | Debug time travel                |

### Async Data

| Function   | Signature                                | Description                    |
| ---------- | ---------------------------------------- | ------------------------------ |
| `resource` | `resource(source, fetcher): Resource<T>` | Reactive async data as signals |

### Routing

| Function      | Signature                          | Description              |
| ------------- | ---------------------------------- | ------------------------ |
| `useRoute`    | `useRoute(pattern?): RouteState`   | Current route state      |
| `useNavigate` | `useNavigate(): NavigateFn`        | Programmatic navigation  |
| `Route`       | `<Route path="..." element={...}>` | Conditional route render |
| `Outlet`      | `<Outlet />`                       | Nested route content     |
| `Link`        | `<Link to="...">`                  | Navigation link          |
| `NavLink`     | `<NavLink to="...">`               | Link with active class   |
| `Redirect`    | `<Redirect to="...">`              | Navigate on mount        |

### Animation

| Function          | Signature                                     | Description                    |
| ----------------- | --------------------------------------------- | ------------------------------ |
| `fade`            | `TransitionFn`                                | Opacity enter/exit preset      |
| `slide`           | `TransitionFn`                                | Vertical slide preset          |
| `scale`           | `TransitionFn`                                | Scale enter/exit preset        |
| `Transition`      | `<Transition enter={fn} exit={fn}>`           | Single child enter/exit        |
| `TransitionGroup` | `<TransitionGroup enter={fn} exit={fn} flip>` | List enter/exit + FLIP reorder |
| `useTransition`   | `useTransition(config): TransitionState`      | Imperative CSS transitions     |
| `useSpring`       | `useSpring(config?): SpringValue`             | Spring physics animation       |

### Utilities

| Function             | Signature                                        | Description                   |
| -------------------- | ------------------------------------------------ | ----------------------------- |
| `useForm`            | `useForm<T>(config): FormState<T>`               | Form state + validation       |
| `useFieldArray`      | `useFieldArray<T>(init?): FieldArrayState<T>`    | Dynamic array field           |
| `useVirtualList`     | `useVirtualList<T>(config): VirtualListState<T>` | Windowed list                 |
| `island`             | `island<M>(config): ComponentFn`                 | External framework mounting   |
| `connectAioDevTools` | `connectAioDevTools(): DevToolsHandle`           | Inspector + Redux DevTools    |
| `setDevMode`         | `setDevMode(enabled): void`                      | Enable a11y + render warnings |
| `memo`               | `memo(Component): Component`                     | No-op (auto-memo built-in)    |

### React Compat (migration)

| Function      | Signature                        | Description            |
| ------------- | -------------------------------- | ---------------------- |
| `useState`    | `useState<T>(init): [T, setter]` | Signal-backed state    |
| `useEffect`   | `useEffect(fn, deps?): void`     | Maps to onMount/effect |
| `useCallback` | `useCallback(fn, deps?): fn`     | No-op (identity)       |
| `useMemo`     | `useMemo(fn, deps?): T`          | Calls fn() immediately |
