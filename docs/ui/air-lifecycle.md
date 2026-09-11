# AIR Lifecycle, Context & Error Handling

All lifecycle hooks must be called **inside a component function body** during
render.

`onMount` and `onCleanup` are collected as a **list**, so — unlike React — you
_can_ call those conditionally or in loops.

`useRef`, `useSignal` and `useId` are **not** in that group: they are matched
across renders **by call order**, so index 0 is index 0 forever. A hook behind
an `if` (or in a loop whose length changes) shifts every later hook onto a
different slot, and the component silently starts reading another ref's value.
Call those three unconditionally at the top of the body and put the condition
inside the value. Dev mode reports it when the count changes between renders.

---

## onMount()

```ts
function onMount(fn: () => void): void;
```

Runs **once** after the component's first render — and **after the component's
DOM subtree and refs are committed to the document**. Inside `onMount`,
`ref.current` is the real node and `ref.current.isConnected` is `true`, so
imperative setup (`getContext`, `focus()`, `getBoundingClientRect()`,
third-party widgets) works directly. Children mount before their parents
(bottom-up, like React).

```tsx
import { onCleanup, onMount, signal, useRef } from "aio/air";
import { draw } from "./draw.ts";

const Chart = () => {
  const ref = useRef<HTMLCanvasElement>(null!);

  onMount(() => {
    const ctx = ref.current.getContext("2d"); // ref.current is committed here
    draw(ctx);
  });

  return <canvas ref={ref} />;
};
```

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
  if (typeof document === "undefined") return; // SSR/testUI: no DOM here
  const handler = (e: KeyboardEvent) => console.log(e.key);
  document.addEventListener("keydown", handler);
  onCleanup(() => document.removeEventListener("keydown", handler));
});
```

> **`onMount` also runs without a DOM** — under SSR and in `testUI`'s
> server-side pass there is no global `document`, so guard DOM access (the
> unguarded version throws `document is not defined` in exactly the harness you
> test with). And register listeners on `document` (or
> `el.ownerDocument.defaultView`), never on the Deno global — a listener on
> `globalThis` never fires under `testUI`, and the harness warns when it sees
> one.

Throwing inside a cleanup callback does not break subsequent cleanups.

---

## useRef()

```ts
function useRef<T>(initial: T): { current: T };
```

Persist a mutable value across re-renders. Mutations do **not** trigger
re-render. Multiple `useRef` calls maintain independent identity.

---

## useRaf()

```ts
function useRaf(
  cb: (time: number, delta: number) => void,
  active?: boolean,
): void;
```

A managed `requestAnimationFrame` loop with automatic cleanup — no manual
`cancelAnimationFrame` bookkeeping. `cb` receives the frame timestamp (ms) and
the delta since the previous frame (0 on the first frame). The **latest** `cb`
is always used, so a closure reading live cell state stays current across
re-renders. The loop cancels on unmount. Pass `active: false` to not start it.

```tsx
import { useRaf, useRef } from "aio/air";
import { draw } from "./draw.ts";
import { cycle } from "./cell/cycle.ts";

const Canvas = () => {
  const ref = useRef<HTMLCanvasElement>(null!);
  useRaf((_t, dt) => {
    const ctx = ref.current?.getContext("2d");
    if (ctx) draw(ctx, cycle.phase, dt); // live cell read, every frame
  });
  return <canvas ref={ref} />;
};
```

> Reading cell state inside a raw rAF callback (or any imperative code) is a
> **live read** — it returns the current value at call time, no `effect()`
> needed. Reads inside an `effect`/render are additionally _tracked_ for
> reactivity; imperative reads are not tracked, which is exactly what you want
> in a frame loop.

For element size, see [`useDimensions`](air-reference.md)
(`ResizeObserver`-backed width/height signals).

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
  const [items, addOptimistic] = useOptimistic(
    todoCell.items,
    (current, newItem: { id: number; text: string }) => [...current, newItem],
  );

  function handleAdd(text: string) {
    addOptimistic({ id: Date.now(), text });
    todoCell.addTodo(text);
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
import { ErrorBoundary, h } from "aio/air";
import { RiskyComponent } from "./RiskyComponent.tsx";

const App = () =>
  h(
    ErrorBoundary,
    {
      fallback: (error: Error) => (
        <div className="error">Oops: {error.message}</div>
      ),
    },
    <RiskyComponent />,
  );
```

| Prop       | Type                      | Description                                  |
| ---------- | ------------------------- | -------------------------------------------- |
| `fallback` | `(error: Error) => VNode` | Render function called with the caught error |
| `children` | any                       | The subtree to protect                       |

Catches errors during initial render, signal-triggered re-render, and lazy
component rejection. Event handler errors are **not** caught (same as React).

**Recovery is automatic.** The failing component stays subscribed to the signals
its failed render read, so when one of them changes the component is rendered
again — the boundary is not a one-way door, and you need no reset callback or
key change.

**With no boundary above it**, a component whose own re-render throws keeps its
last good output and logs the error; everything beside it keeps updating. A
`fallback` that itself throws degrades to that same behaviour rather than
looping.

---

## Redux DevTools Integration

Connect to the Redux DevTools browser extension for state inspection. Two
bridges, named for what they drive — both from `aio/air`:

- `connectReduxDevTools()` / `disconnectReduxDevTools()` — the **Redux
  DevTools** browser extension: every state change, paired with the action that
  caused it. A no-op when the extension is absent.
- `connectAioDevTools()` — **aio's own** component-tree devtools (the AIR
  inspector), unrelated to Redux.

```tsx
import { connectReduxDevTools, useAio } from "aio/air";

export default function App() {
  const { state, send } = useAio<AppState>();

  onMount(() => {
    if (import.meta.env.DEV) connectReduxDevTools();
  });
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
import { useAio, useTimeTravel } from "aio/air";

type AppState = { counter: number };

export default function App() {
  const { state } = useAio<AppState>();
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

## Window events: `onWindowEvent`

`globalThis.addEventListener("mousemove", fn)` looks right — in a single browser
page `globalThis` **is** the window. In aio it often is not: a component can be
mounted in an Electron child window or a `<webview>`, where the bare global
belongs to a different window and the handler never hears the event. Under
`testUI` the mount lives in a happy-dom window while `globalThis` is Deno's, so
the registration is refused outright rather than silently doing nothing.

The correct-everywhere spelling is
`el.ownerDocument.defaultView.addEventListener(...)`. `onWindowEvent` resolves
that same window for you and removes the listener on unmount:

```tsx
import { onWindowEvent, useLocal } from "aio/air";

function Dragger() {
  const [pos, setPos] = useLocal({ x: 0, y: 0 });
  const [resizes, setResizes] = useLocal(0);
  onWindowEvent("mousemove", (e) => setPos({ x: e.clientX, y: e.clientY }));
  onWindowEvent("resize", () => setResizes(resizes + 1));
  return (
    <div class="stage">
      {pos.x},{pos.y} · {resizes} resizes
    </div>
  );
}
```

The handler is read at event time, so it always sees the latest render's closure
— the same discipline as `onGlobalKey`, `useRaf` and `useInterval`. For a
keyboard shortcut specifically, prefer `onGlobalKey`, which also handles chords
and ignores keys typed into a field.
