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
count.get(); // 0 — the same tracked read, spelled as the mirror of set()
count.peek(); // 0 — reads without tracking (use in event handlers)
count.set(1); // updates and notifies subscribers
count.set(1); // no-op — same value (see equality rules below)
```

### The three reads

Two of them are the same operation:

| Call      | Tracks? | Reach for it when                                      |
| --------- | ------- | ------------------------------------------------------ |
| `.value`  | yes     | inside JSX — `{count.value}` reads as a value          |
| `.get()`  | yes     | beside a write — `count.set(count.get() + 1)`          |
| `.peek()` | **no**  | you must NOT subscribe — event handlers, effect bodies |

`.value` and `.get()` are interchangeable; pick whichever reads better at the
call site. The only real choice is tracked (`.value` / `.get()`) versus
untracked (`.peek()`) — and getting THAT wrong is what makes a UI go stale, so
see [Reactivity — what is tracked, and where](reactivity-tracking.md).

`computed()` answers all three the same way.

### Equality: when does `set()` notify?

`set()` skips the update (no notification) when the new value is "the same". The
exact rules:

| New value                  | Skipped when…                                           |
| -------------------------- | ------------------------------------------------------- |
| Primitives, same reference | `Object.is(old, next)`                                  |
| Plain object / array       | Shallow-equal: same keys/length, all values `Object.is` |
| `Date` / `RegExp`          | Same time value / same source+flags                     |
| Typed arrays               | Same bytes                                              |
| `Set` / `Map`              | **Never skipped** — always notifies (AIO-364)           |
| Class instances            | **Never skipped** — always notifies (AIO-378)           |

Set/Map and class instances hold state where shallow comparison can't see it
(entries, private fields, getters), so a fresh instance always counts as a
change. Shallow equality only applies to _plain_ objects — `{...state}` spreads
and array literals — where it prevents infinite re-render loops from
`set({ ...sameValues })` in effect/rAF callbacks.

Escape hatch: `set(next, { force: true })` always notifies, regardless of
equality. In dev mode, named signals `console.warn` whenever an update is
skipped, telling you which rule matched.

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

**Module-level signals survive component unmount/remount:**

```tsx
// Module-level UI state (survives unmount)
const ui = signal({ collapsed: [] as string[] }, "sidebar");

function Sidebar() {
  return <TreeRow collapsed={ui.value.collapsed} />;
}
// Each component independently re-renders when signals IT reads change —
// no parent subscription needed (AIO-7.5).
```

**Signal\<T\> interface:**

| Member                        | Description                                                     |
| ----------------------------- | --------------------------------------------------------------- |
| `.value`                      | Read with automatic dependency tracking                         |
| `.get()`                      | The same tracked read, as a method — mirrors `.set()`           |
| `.peek()`                     | Read without tracking (use in event handlers)                   |
| `.set(next)`                  | Write and notify. No-op for equal values — see "Equality" above |
| `.set(next, { force: true })` | Bypass equality checks and always notify                        |
| `.set(prev => v)`             | Updater form — receives current value                           |
| `.subscribe(fn)`              | Manual subscriber, returns unsubscribe fn                       |

> **Legacy idiom — delete on sight:** older code reads `void sig.value` in a
> parent component "so children re-render". Child subscriptions have been
> independent of parents since AIO-7.5 — the read is dead weight (and an extra
> parent re-render). Components subscribe by reading `.value` in their own
> render; nothing else is needed. | `._name` | Optional debug name (pass as 2nd
> arg to signal) |

**Dev mode** (`localStorage.AIO_DEV = '1'` or `aio.config.dev = true`):

- Named signals log `console.warn` when updates are skipped (identical reference
  or shallow-equal).
- Missing parent subscriptions are warned when a child reads a signal the parent
  does not touch.

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

### Re-deriving when inputs change (`afterRender` + `useRef`)

The pattern every non-trivial UI eventually needs: _when these inputs change,
recompute this derived state_ — without an effect system, and without looping.
One field report called it "the most load-bearing hook in my app" and found it
by reading AIR's source, which is a docs failure, not a discovery.

```tsx
import { afterRender, useRef } from "aio/air";
import { cell } from "aio";

const cfg = cell("cfg", {
  state: { modelId: "7b", ctxSize: 4096, summary: "" },
  methods: {
    // The derived output — written by the reaction, never read by the key.
    retune(s: { modelId: string; ctxSize: number; summary: string }) {
      s.summary = `${s.modelId} @ ${s.ctxSize}`;
    },
  },
});

function Settings() {
  // Everything the derivation depends on, in one key.
  const key = `${cfg.modelId}|${cfg.ctxSize}`;
  const last = useRef("");

  afterRender(() => {
    if (last.current === key) return; // inputs unchanged — nothing to do
    last.current = key;
    cfg.retune();
  });

  return <div>{cfg.summary}</div>;
}
```

**Why it settles in one extra pass, and doesn't loop:** the reaction writes
state that the component reads, so it renders again — but the second pass
computes the _same_ key, the guard returns early, and it stops. The rule is
therefore:

> the reaction must not change anything the key is derived from.

If it does, you get an infinite render loop, and it is your key that's wrong,
not the hook. Keep the key from _inputs_ (ids, sizes, settings) and let the
reaction write only _outputs_ (the derived summary).

`useRef` is the right store for `last` because a ref survives re-renders without
being reactive — reading it never subscribes the component, so the guard itself
can't trigger the render it is trying to prevent.
