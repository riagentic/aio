# AIR Animation

CSS-first declarative transitions for enter/exit animations, imperative spring
physics for continuous values, and low-level transition hooks for full control.

---

## Transition Presets

Built-in CSS animation functions for `<Transition>` and `<TransitionGroup>`:

```tsx
import { fade, scale, slide } from "aio/air";
```

Every preset is one `css(t)` function keyframed from `t = 0` to `t = 1` on
enter, and replayed backwards on exit — so the Exit column is always the Enter
column read right to left. Each fades opacity alongside its transform:

| Preset  | `css(t)`                                        | Enter (`t` 0 → 1)                                                   |
| ------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| `fade`  | `opacity: t`                                    | `opacity: 0` → `opacity: 1`                                         |
| `slide` | `transform: translateY((1-t)*100%); opacity: t` | `translateY(100%)` + `opacity: 0` → `translateY(0%)` + `opacity: 1` |
| `scale` | `transform: scale(t); opacity: t`               | `scale(0)` + `opacity: 0` → `scale(1)` + `opacity: 1`               |

`slide` travels a full **element height** (`100%`), not a fixed pixel offset,
and `scale` grows from **zero**, not from a near-1 value — both are deliberate:
a preset that moves a fixed 20px looks wrong on anything but one row height. For
a subtler entrance, write your own `TransitionFn` rather than expecting the
preset to be gentle.

Each preset accepts `TransitionOptions` — `duration` (default `300`), `delay`
(default none) and `easing` (default CSS `ease`):

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
