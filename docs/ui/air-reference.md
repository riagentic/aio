# AIR API Reference

## Mounting

| Function  | Signature                         | Description                   |
| --------- | --------------------------------- | ----------------------------- |
| `mount`   | `mount(root, App): MountHandle`   | Initialize and render         |
| `hydrate` | `hydrate(root, App): MountHandle` | Attach to server-rendered DOM |

Each `mount()` creates an independent render root with its own pending queue.

### Testing components

`testComponent` is the public harness for testing AIR components — symmetric
with `testCell` for cells. Bring your own DOM (happy-dom / jsdom) so the
framework stays free of test-only deps; `setDocument` points the renderer at it.

| Function        | Signature                                                      | Description                                     |
| --------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| `testComponent` | `testComponent(App, { document, root? }): TestComponentHandle` | Mount for tests → `{ root, html(), unmount() }` |
| `setDocument`   | `setDocument(doc): void`                                       | Point the renderer at a DOM document            |

```ts
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { testComponent } from "aio/air";
import App from "./App.tsx";

const win = new Window();
const t = testComponent(App, { document: win.document });
assertEquals(t.html(), "<div>hi</div>");
t.unmount();
```

To drive `requestAnimationFrame` / `useRaf` in a test, stub
`globalThis.requestAnimationFrame` before mounting and flush frames manually.

---

## Architecture

### Rendering Pipeline

```
mount(root, App)
  +- <App />                    Create root VNode
  +- _render(root, vnode)       Walk tree, create DOM, attach hooks
  |   +- beforeComponent()      Start signal tracking scope
  |   +- App(props)             Execute component function
  |   +- afterComponent()       End tracking, create instance, subscribe
  |   +- [recurse children]
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

Each component runs in its own tracking scope. Only signals read during render
become dependencies.

### Auto-Memo

When a parent re-renders, child components are checked:

1. Is the child's own signal triggered? -> Re-render.
2. Are props shallowly equal? -> **Skip**.
3. Are children references identical? -> **Skip**.

No `React.memo`, no `useMemo`, no `useCallback`.

### Frozen VNodes (Static Optimization)

Static subtrees (string tags, no key/ref/use, all primitive props) get
`_static = true`. During diffing, static VNodes with same tag skip via
`_staticEqual()` — zero DOM operations.

### Signal-Bound Attributes

When a Signal is passed directly as a prop, AIR creates a direct `effect()` that
updates the DOM attribute without VDOM diff:

```tsx
const color = signal("red");
const App = () => <div className={color} />;
// color.set("blue") updates class directly — no component re-render
```

### Node Identity & Stateful-Node Preservation

When a parent re-renders, AIR **diffs** rather than recreates — a DOM node is
**reused** (not rebuilt) as long as its position resolves to the same VNode.
This matters for stateful nodes (`<canvas>`, `<video>`, `<iframe>`, map/editor
widgets) whose internal state (canvas bitmap, playback position, a running
`useRaf` loop) must survive re-renders.

Reuse rules:

- **Same tag at the same position → reused.** The existing DOM element is kept
  and only changed props/children are patched (`<canvas>` stays the same
  element). A **different tag** at that position → the old node is destroyed and
  a new one created.
- **Unkeyed children** are matched **by index** (position). Reordering an
  unkeyed list re-patches nodes in place — fine for stateless content, but it
  will move a stateful node's _contents_ to a different item.
- **Keyed children** (`key={id}`) are matched **by key identity** across
  reorders, so the right DOM node follows its data. **Always `key` lists that
  contain stateful nodes or that reorder.**

```tsx
// ✅ canvas DOM node (and its bitmap / useRaf loop) survives parent re-renders
const Scene = () => <canvas ref={ref} />;

// ✅ key stateful items so reorders move the correct node
<ul>
  {videos.map((v) => (
    <li key={v.id}>
      <video src={v.src} />
    </li>
  ))}
</ul>;
```

To force a stateful node to be **recreated** intentionally (e.g. reset a
canvas), change its `key`.

---

## h() -- Non-TSX Usage

```ts
import { Fragment, h } from "aio/air";
import { MyComponent } from "./MyComponent.tsx";

const items = [{ id: "1", name: "Ada" }, { id: "2", name: "Grace" }];

h("div", { className: "card" }, "Hello");
h(MyComponent, { name: "Alice" });
h(Fragment, null, h("span", null, "A"), h("span", null, "B"));
h("ul", null, items.map((i) => h("li", { key: i.id }, i.name)));
```

---

## Signals

| Function   | Signature                           | Description                    |
| ---------- | ----------------------------------- | ------------------------------ |
| `signal`   | `signal<T>(init, name?): Signal<T>` | Writable reactive value        |
| `computed` | `computed<T>(fn): Computed<T>`      | Lazy derived value             |
| `effect`   | `effect(fn): dispose`               | Side effect with auto-tracking |
| `batch`    | `batch(fn): void`                   | Coalesce updates               |
| `untrack`  | `untrack<T>(fn): T`                 | Read without tracking          |
| `watch`    | `watch(source, fn, opts?): dispose` | Watch signal for changes       |
| `on`       | `on(source, fn): dispose`           | Like watch, skips initial      |

## Components & VDOM

| Function         | Signature                              | Description                |
| ---------------- | -------------------------------------- | -------------------------- |
| `h`              | `h(tag, props, ...children): VNode`    | Create virtual node        |
| `Fragment`       | `<>...</>`                             | Wrapper-less children      |
| `ErrorBoundary`  | `<ErrorBoundary fallback={fn}>`        | Error catcher              |
| `Portal`         | `<Portal target={node}>`               | External DOM node          |
| `Suspense`       | `<Suspense fallback={node}>`           | Loading fallback for lazy  |
| `Show`           | `<Show when={val} fallback={...}>`     | Conditional render         |
| `lazy`           | `lazy(loader): ComponentFn`            | Code-split component       |
| `Defer`          | `<Defer trigger="viewport" load={fn}>` | Trigger-based lazy loading |
| `renderToString` | `renderToString(vnode): string`        | Sync SSR                   |
| `renderToStream` | `renderToStream(vnode): AsyncGen`      | Streaming SSR              |

## Hooks (inside component body)

| Function             | Signature                                 | Description                    |
| -------------------- | ----------------------------------------- | ------------------------------ |
| `onMount`            | `onMount(fn): void`                       | After first render             |
| `onCleanup`          | `onCleanup(fn): void`                     | Before re-render & on unmount  |
| `afterRender`        | `afterRender(fn): void`                   | After DOM commit               |
| `useRef`             | `useRef<T>(init): { current: T }`         | Persistent mutable ref         |
| `useId`              | `useId(): string`                         | SSR-safe unique ID             |
| `useOptimistic`      | `useOptimistic<T,A>(state, fn): [T, add]` | Optimistic UI overlay          |
| `createContext`      | `createContext<T>(default): Context<T>`   | Create context                 |
| `useContext`         | `useContext<T>(ctx): T`                   | Read context value             |
| `useContextSelector` | `useContextSelector<T,R>(ctx, sel): R`    | Selective context              |
| `useDimensions`      | `useDimensions(): DimensionsState`        | Element size tracking          |
| `useRaf`             | `useRaf(cb, active?): void`               | Managed rAF loop, auto-cleanup |

## Server State Hooks

| Function        | Signature                                                          | Description       |
| --------------- | ------------------------------------------------------------------ | ----------------- |
| `useAio`        | `useAio(): { state, send }`                                        | Subscribe to all  |
| `useLocal`      | `useLocal(init)` → `{ local, set, patch }` or tuple `[value, set]` | Client-only state |
| `useConnected`  | `useConnected(): boolean`                                          | Connection status |
| `useProjection` | `useProjection(fn): T`                                             | Derived state     |
| `useTimeTravel` | `useTimeTravel(): TimeTravelState`                                 | Debug time travel |

## Routing

| Function      | Signature                          | Description             |
| ------------- | ---------------------------------- | ----------------------- |
| `useRoute`    | `useRoute(pattern?): RouteState`   | Current route state     |
| `useNavigate` | `useNavigate(): NavigateFn`        | Programmatic navigation |
| `Route`       | `<Route path="..." element={...}>` | Route render            |
| `Outlet`      | `<Outlet />`                       | Nested route content    |
| `Link`        | `<Link to="...">`                  | Navigation link         |
| `NavLink`     | `<NavLink to="...">`               | Link with active class  |
| `Redirect`    | `<Redirect to="...">`              | Navigate on mount       |

## Animation

| Function          | Signature                                     | Description            |
| ----------------- | --------------------------------------------- | ---------------------- |
| `fade`            | `TransitionFn`                                | Opacity preset         |
| `slide`           | `TransitionFn`                                | Vertical slide preset  |
| `scale`           | `TransitionFn`                                | Scale preset           |
| `Transition`      | `<Transition enter={fn} exit={fn}>`           | Single child animation |
| `TransitionGroup` | `<TransitionGroup enter={fn} exit={fn} flip>` | List animation + FLIP  |
| `useSpring`       | `useSpring(config?): SpringValue`             | Spring physics         |

## Utilities

| Function             | Signature                                        | Description              |
| -------------------- | ------------------------------------------------ | ------------------------ |
| `useForm`            | `useForm<T>(config): FormState<T>`               | Form state + validation  |
| `useFieldArray`      | `useFieldArray<T>(init?): FieldArrayState<T>`    | Dynamic array field      |
| `useVirtualList`     | `useVirtualList<T>(config): VirtualListState<T>` | Windowed list            |
| `island`             | `island<M>(config): ComponentFn`                 | External framework mount |
| `connectAioDevTools` | `connectAioDevTools(): DevToolsHandle`           | Inspector + DevTools     |
| `memo`               | `memo(Component): Component`                     | No-op (auto-memo)        |

## React Compat (migration)

| Function      | Signature                        | Description            |
| ------------- | -------------------------------- | ---------------------- |
| `useState`    | `useState<T>(init): [T, setter]` | Signal-backed state    |
| `useEffect`   | `useEffect(fn, deps?): void`     | Maps to onMount/effect |
| `useCallback` | `useCallback(fn, deps?): fn`     | No-op (identity)       |
| `useMemo`     | `useMemo(fn, deps?): T`          | Calls fn() immediately |
