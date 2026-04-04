# AIR Signals

Signals are the reactive primitive. A signal holds a value and notifies
subscribers when it changes. Reads inside a tracking scope (component render,
`computed`, `effect`) are automatically tracked.

---

## signal()

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
handlers (no tracking needed).

**Signal\<T\> interface:**

| Member            | Description                                       |
| ----------------- | ------------------------------------------------- |
| `.value`          | Read with automatic dependency tracking           |
| `.peek()`         | Read without tracking (use in event handlers)     |
| `.set(next)`      | Write and notify. No-op if `Object.is(old, next)` |
| `.set(prev => v)` | Updater form — receives current value             |
| `.subscribe(fn)`  | Manual subscriber, returns unsubscribe fn         |
| `._name`          | Optional debug name (pass as 2nd arg to signal)   |

Pass an optional name as 2nd arg: `signal(0, "count")` for devtools output.

---

## computed()

```ts
function computed<T>(fn: () => T): Computed<T>;
```

Derived value that recomputes lazily when dependencies change.

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
- **Diamond-safe**: computed at the bottom of a diamond only runs once.

---

## effect()

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

---

## batch()

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

---

## untrack()

```ts
function untrack<T>(fn: () => T): T;
```

Execute a function without tracking signal reads.

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

---

## watch()

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
  console.log(`Theme changed: ${prev} -> ${next}`);
  document.body.className = next;
});

theme.set("dark"); // logs: "Theme changed: light -> dark"
stop(); // stops watching
```

With `immediate: true`, the callback fires once with current value on creation:

```ts
watch(theme, (val) => applyTheme(val), { immediate: true });
```

---

## on()

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

---

## afterRender()

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
    const el = document.getElementById("content");
    if (el) height.set(el.offsetHeight);
  });

  return <div id="content">Height: {height.value}px</div>;
};
```

Useful for DOM measurements, scroll positioning, or third-party library
initialization that needs the real DOM.
