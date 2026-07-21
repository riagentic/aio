# AIR Animation

CSS-first declarative transitions for enter/exit animations, imperative spring
physics for continuous values, and low-level transition hooks for full control.

---

## Transition Presets

Built-in CSS animation functions for `<Transition>` and `<TransitionGroup>`:

```tsx
import { fade, scale, slide } from "aio/air";
```

| Preset  | Enter                  | Exit                  |
| ------- | ---------------------- | --------------------- |
| `fade`  | Opacity 0 -> 1         | Opacity 1 -> 0        |
| `slide` | translateY(-20px) -> 0 | 0 -> translateY(20px) |
| `scale` | scale(0.95) -> 1       | 1 -> scale(0.95)      |

Each preset accepts `TransitionOptions`:

```ts
fade(node, { duration: 300, delay: 100, easing: "ease-out" });
```

---

## Transition

Animate a single child's enter and exit:

```tsx
import { fade, signal, Transition } from "aio/air";

const visible = signal(true);

const App = () => (
  <div>
    <button onClick={() => visible.set(!visible.peek())}>Toggle</button>
    <Transition enter={fade} exit={fade}>
      {[visible.value ? <div className="card">Hello</div> : null]}
    </Transition>
  </div>
);
```

DOM removal is **deferred** until the exit animation completes.

| Prop       | Type                | Description                       |
| ---------- | ------------------- | --------------------------------- |
| `enter`    | `TransitionFn`      | Enter animation (e.g., `fade`)    |
| `exit`     | `TransitionFn`      | Exit animation (e.g., `fade`)     |
| `options`  | `TransitionOptions` | Duration, delay, easing overrides |
| `children` | any                 | Single conditional child          |

---

## TransitionGroup

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

FLIP (First-Last-Invert-Play) smoothly animates position changes on reorder.

| Prop           | Type                | Default | Description                   |
| -------------- | ------------------- | ------- | ----------------------------- |
| `enter`        | `TransitionFn`      | --      | Enter animation               |
| `exit`         | `TransitionFn`      | --      | Exit animation                |
| `options`      | `TransitionOptions` | --      | Shared animation options      |
| `flip`         | `boolean`           | `false` | Enable FLIP reorder animation |
| `flipDuration` | `number`            | `300`   | FLIP animation duration (ms)  |

---

## useSpring()

```ts
function useSpring(config?: SpringConfig): SpringValue;
```

Spring physics animation. Call outside the component body. Uses actual
`requestAnimationFrame` timestamps for frame-rate-independent animation.

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

**SpringConfig:**

| Prop        | Type     | Default | Description           |
| ----------- | -------- | ------- | --------------------- |
| `initial`   | `number` | `0`     | Starting value        |
| `stiffness` | `number` | `170`   | Spring constant       |
| `damping`   | `number` | `26`    | Damping coefficient   |
| `mass`      | `number` | `1`     | Mass                  |
| `precision` | `number` | `0.01`  | Convergence threshold |

**SpringValue:**

| Member       | Type      | Description                                     |
| ------------ | --------- | ----------------------------------------------- |
| `value`      | `number`  | Signal-tracked current value                    |
| `animating`  | `boolean` | Whether animation is running                    |
| `to(target)` | `void`    | Animate to target                               |
| `set(value)` | `void`    | Immediately set (no animation)                  |
| `dispose()`  | `void`    | Cancel animation and clean up — call on unmount |

> **Cleanup:** Call `x.dispose()` when the spring is no longer needed (e.g., in
> `onCleanup`). This cancels any in-flight `requestAnimationFrame` loop and
> prevents memory leaks.
