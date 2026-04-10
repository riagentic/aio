# AIR API Reference

## Mounting

| Function  | Signature                         | Description                   |
| --------- | --------------------------------- | ----------------------------- |
| `mount`   | `mount(root, App): MountHandle`   | Initialize and render         |
| `hydrate` | `hydrate(root, App): MountHandle` | Attach to server-rendered DOM |

Each `mount()` creates an independent render root with its own pending queue.

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

---

## h() -- Non-TSX Usage

```ts
import { Fragment, h, mount } from "aio/air";

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

| Function             | Signature                                 | Description                   |
| -------------------- | ----------------------------------------- | ----------------------------- |
| `onMount`            | `onMount(fn): void`                       | After first render            |
| `onCleanup`          | `onCleanup(fn): void`                     | Before re-render & on unmount |
| `afterRender`        | `afterRender(fn): void`                   | After DOM commit              |
| `useRef`             | `useRef<T>(init): { current: T }`         | Persistent mutable ref        |
| `useId`              | `useId(): string`                         | SSR-safe unique ID            |
| `useOptimistic`      | `useOptimistic<T,A>(state, fn): [T, add]` | Optimistic UI overlay         |
| `createContext`      | `createContext<T>(default): Context<T>`   | Create context                |
| `useContext`         | `useContext<T>(ctx): T`                   | Read context value            |
| `useContextSelector` | `useContextSelector<T,R>(ctx, sel): R`    | Selective context             |
| `useDimensions`      | `useDimensions(): DimensionsState`        | Element size tracking         |

## Server State Hooks

| Function        | Signature                               | Description       |
| --------------- | --------------------------------------- | ----------------- |
| `useAio`        | `useAio(): { state, send }`             | Subscribe to all  |
| `useLocal`      | `useLocal(init): { local, set, patch }` | Client-only state |
| `useConnected`  | `useConnected(): boolean`               | Connection status |
| `useProjection` | `useProjection(fn): T`                  | Derived state     |
| `useTimeTravel` | `useTimeTravel(ref): TimeTravelState`   | Debug time travel |

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
| `setDevMode`         | `setDevMode(enabled): void`                      | Enable a11y + warnings   |
| `memo`               | `memo(Component): Component`                     | No-op (auto-memo)        |

## React Compat (migration)

| Function      | Signature                        | Description            |
| ------------- | -------------------------------- | ---------------------- |
| `useState`    | `useState<T>(init): [T, setter]` | Signal-backed state    |
| `useEffect`   | `useEffect(fn, deps?): void`     | Maps to onMount/effect |
| `useCallback` | `useCallback(fn, deps?): fn`     | No-op (identity)       |
| `useMemo`     | `useMemo(fn, deps?): T`          | Calls fn() immediately |
