# AIR Evolution — Best of Every Framework, First-Class AIO Integration

**Date:** 2026-03-29
**Type:** Architecture + API Design
**Priority:** P1
**Status:** Approved

## Guiding Principles

1. **AIR is the primary renderer** — all innovation happens here
2. **React is a first-class consumer** — super-thin adapter, minimal maintenance,
   bridges `useFeature`/`useAio`/`useLocal` to React, nothing more
3. **TSX function components** — the universal component shape
4. **Zero boilerplate, then go further** — features are direct imports, no hooks
   needed for the common case. If the developer writes ceremony, we failed.
5. **Shrink API surface** — fewer functions, same power
6. **DevTools: AIR-native first** — signal-aware "why did this render" + Redux
   DevTools. React DevTools compat only if real demand appears.
7. **"Feels like cheating"** — the north star. Better than Solid's signals,
   better than Vue's DX, better than Svelte's transitions, and nobody else has
   server-pushed reactive state.

## Mission

Make AIR the best renderer for Deno/TS apps by learning from React, Vue, Solid,
Svelte, Qwik, and Angular — stealing what's proven, rejecting what's broken, and
building what only AIO can build (server-pushed signals + delta protocol).

**Priority axis:** C (full-stack integration, our moat) > A (DX, React devs
productive fast) > B (performance, adopt where free or near-free).

## Feature Access — Unified Namespace (Option 6)

The primary API for accessing server features in AIR components is direct import
with a unified namespace. State fields and methods live on one object:

```tsx
import { dashboard, alerts } from "./features";

function Overview() {
  return <div>
    <p>{dashboard.activeUsers} online</p>
    <p>{alerts.unread} alerts</p>
    <button onClick={() => dashboard.refresh()}>Refresh</button>
    <button onClick={() => alerts.markAllRead()}>Clear</button>
  </div>;
}
```

**How it works:**
- Feature ref is a Proxy built once at connection time (not per-render)
- State field reads (`dashboard.activeUsers`) return signal `.value`, entering
  AIR's tracking scope — component auto-subscribes
- Method calls (`dashboard.refresh()`) dispatch to server via send proxy
- Name collisions between state fields and methods are already prevented by
  AIO's feature definition validation (existing behavior)

**`useFeature` stays for:**
- React adapter (React needs hooks for `useSyncExternalStore`)
- SSR with concurrent requests (request-scoped context)
- Dynamic feature refs passed as props
- Destructuring convenience when heavily using both state and methods

```tsx
// React adapter — hook required
const { state, send } = useFeature(dashboard);

// AIR dynamic ref — hook required
function GenericPanel({ featureRef }) {
  const { state, send } = useFeature(featureRef);
}

// AIR static feature — direct import, zero ceremony
function Panel() {
  return <div>{dashboard.activeUsers}</div>;
}
```

## React Adapter Scope

Hard boundary. The React adapter provides ONLY:
- `useFeature` — subscribe to feature state, get typed send
- `useAio` — subscribe to full app state
- `useLocal` — client-only signal-backed state
- `useConnected` — connection status boolean
- Routing hooks — `useRoute`, `useNavigate`
- Routing components — `Route`, `Outlet`, `Link`, `NavLink`, `Redirect`

Nothing else. No compat layer, no transitions, no actions, no resource(). React
users bring their own React ecosystem. We don't replicate AIR features in React.

---

## Part 1: Signal Primitives

### 1.1 Updater function on `signal.set()`

**Source:** Solid, React, Angular
**Priority:** P0 | **Effort:** Tiny (3 lines)

```ts
// Current: count.set(count.peek() + 1)
// Proposed: count.set(prev => prev + 1)
```

In `SignalImpl.set()`, detect `typeof next === 'function'` and call it with
current value. Angular calls this `.update()` — we keep it on `.set()` to avoid
API bloat.

### 1.2 Auto-batch event handlers

**Source:** React 18, Solid, Svelte
**Priority:** P0 | **Effort:** Small

Wrap all DOM event handler callbacks in implicit `batch()`. In `vdom.ts` event
patching:

```ts
// When patching events on DOM elements:
el[`__${name}`] = (e: Event) => batch(() => handler(e));
```

Two `signal.set()` calls in one click handler = one render, not two. Every
modern framework does this. Eliminates an entire class of "why 3 renders" bugs.

### 1.3 Auto-dispose effects in components

**Source:** Vue's `watchEffect` auto-cleanup
**Priority:** P0 | **Effort:** Small

Effects created during component render must auto-dispose on unmount, same as
computeds. Currently `_computedCollectStart/End` tracks computeds but raw
`effect()` calls are NOT auto-tracked. This is a composability bug — custom hooks
that call `effect()` leak.

Fix: extend the computed collector to also track `effect()` disposals created
during component render.

### 1.4 `untrack()` global function

**Source:** Solid
**Priority:** P1 | **Effort:** Tiny (5 lines)

```ts
export function untrack<T>(fn: () => T): T {
  const prev = _trackStack.pop();
  try { return fn(); }
  finally { if (prev) _trackStack.push(prev); }
}
```

`peek()` works per-signal. `untrack()` works for any expression. Both needed.

### 1.5 `watch(source, callback)` with old/new values

**Source:** Vue's `watch()`, Solid's `on()`
**Priority:** P1 | **Effort:** Small

```ts
watch(count, (next, prev) => {
  analytics.log(`count changed: ${prev} -> ${next}`);
}, { immediate?: boolean });
```

Thin wrapper: effect that stores previous value and only fires callback when
source changes. Useful for analytics, delta logging, conditional side effects.

### 1.6 `on()` explicit dependency helper

**Source:** Solid
**Priority:** P1 | **Effort:** Small

```ts
effect(on(count, (value, prev) => {
  // Only runs when count changes, not other signals read inside
  console.log(otherSignal.peek()); // accessed but not tracked
}));
```

Sugar over `effect` + `peek()`. Prevents the common footgun of effects tracking
too many signals.

### 1.7 `linkedSignal` — writable computed

**Source:** Angular
**Priority:** P2 | **Effort:** Small (~50 lines)

```ts
const options = signal(['A', 'B', 'C']);
const selected = linkedSignal(() => options.value[0]);
// selected.value === 'A'
selected.set('B');        // manually overridden
options.set(['X', 'Y']);  // selected auto-resets to 'X'
```

Solves: state with a derived default that can be manually overridden. Common in
form fields, tab selection, filter defaults.

---

## Part 2: Effect Timing

### 2.1 `afterRender()` / `effect.post()` — post-DOM-update effect

**Source:** Vue's `flush: 'post'`, React's `useLayoutEffect`, AIO-71 #2
**Priority:** P1 | **Effort:** Small

```ts
afterRender(() => {
  el.scrollTo(0, target); // DOM is guaranteed updated
});
```

AIR has no "after DOM update" primitive. This blocks: scroll restoration, DOM
measurement, chart library integration. Implementation: queue callbacks during
render, flush after VDOM commit to real DOM.

### 2.2 `effect.pre()` — pre-DOM-update effect

**Source:** Svelte's `$effect.pre`
**Priority:** P3 | **Effort:** Small

```ts
effect.pre(() => {
  savedScroll = container.scrollTop; // measure before DOM changes
});
```

Runs before VDOM commit. Use case: save positions before list re-renders.

---

## Part 3: Animation System

### 3.1 Deferred DOM removal for exit animations

**Source:** Svelte, Vue
**Priority:** P1 | **Effort:** Medium

When VDOM reconciliation removes a node, the DOM node vanishes immediately. Exit
animations require holding the node alive. The reconciler needs a "leaving"
state:

1. Mark node as leaving (don't remove from DOM)
2. Run exit transition
3. Remove from DOM when transition completes
4. Safety timeout as fallback

This is a prerequisite for items 3.2-3.4.

### 3.2 CSS-first transition API

**Source:** Svelte's `css: (t) => string`
**Priority:** P1 | **Effort:** Medium

```ts
function fade(node: HTMLElement, { duration = 300 }) {
  return {
    duration,
    css: (t: number) => `opacity: ${t}`,
    // OR: tick: (t: number) => { /* JS per frame */ }
  };
}
```

Framework generates `@keyframes` dynamically, applies via CSS animation, cleans
up. Animations run on compositor thread = zero jank. The `t` parameter goes 0->1
on enter, 1->0 on exit.

Also: auto-duration detection via `transitionend`/`animationend` events instead
of hardcoded `setTimeout`.

### 3.3 Declarative `<Transition>` component

**Source:** Vue, Svelte
**Priority:** P1 | **Effort:** Medium

```tsx
<Transition enter={fade} exit={fade} mode="out-in">
  {show.value && <Modal />}
</Transition>
```

- Detects child enter/exit via VDOM diff
- Applies transition functions from 3.2
- `mode="out-in"` sequences old exit before new enter
- Works with any transition function (CSS or JS)

### 3.4 `<TransitionGroup>` with FLIP

**Source:** Vue, Svelte
**Priority:** P2 | **Effort:** Large

FLIP (First-Last-Invert-Play) for keyed list reorder animation:

1. Record positions before DOM update (First)
2. Apply DOM update (Last)
3. Calculate delta, apply inverse transform (Invert)
4. Remove inverse, let CSS transition play (Play)

```tsx
<TransitionGroup enter={fade} exit={fade} move={{ duration: 300 }}>
  {items.map(item => <Card key={item.id} item={item} />)}
</TransitionGroup>
```

Crossfade/shared-element transitions via `[send, receive]` pair pattern (from
Svelte) is a stretch goal.

---

## Part 4: Resource & Async

### 4.1 `resource()` — async data as signals

**Source:** Solid's `createResource`, Angular's `resource()`
**Priority:** P1 | **Effort:** Medium

```ts
const user = resource(
  () => userId.value,  // reactive source (re-fetches when this changes)
  async (id, { signal: abortSignal }) => {
    const res = await fetch(`/api/users/${id}`, { signal: abortSignal });
    return res.json();
  }
);

user.value      // data (or undefined while loading)
user.loading    // boolean signal
user.error      // error signal
user.latest     // last successful value (persists through refetch)
user.refetch()  // manual re-trigger
user.mutate(v)  // optimistic update (local only)
```

Critical distinction from `useFeature`:
- `useFeature` = live server-pushed state via delta protocol (AIR's killer feature)
- `resource()` = client-initiated one-shot async (fetches, uploads, API calls)

Integrates with `Suspense` (throws promise when pending).

### 4.2 `<Await>` component — inline async rendering

**Source:** Svelte's `{#await}`
**Priority:** P2 | **Effort:** Small

```tsx
<Await value={resource}>
  {{
    pending: () => <Spinner />,
    then: (data) => <Profile user={data} />,
    catch: (err) => <Error error={err} />,
  }}
</Await>
```

Simpler than Suspense for one-off async. Suspense is for tree-level boundaries;
`<Await>` is for inline use.

### 4.3 `<Defer>` — trigger-based lazy loading

**Source:** Angular's `@defer`, Qwik's lazy loading
**Priority:** P2 | **Effort:** Medium

```tsx
<Defer
  trigger="viewport"
  prefetch="idle"
  placeholder={<Skeleton />}
  loading={<Spinner />}
  loadingMinMs={500}
  error={<p>Failed</p>}
>
  <HeavyChart data={data} />
</Defer>
```

Triggers: `viewport` (IntersectionObserver), `idle` (requestIdleCallback),
`hover`, `interaction` (click/keydown), `timer(ms)`, `immediate`.

Prefetch is separate from render trigger — code loads during idle, renders when
user scrolls to viewport. Major UX win over bare `lazy()`.

---

## Part 5: Component Utilities

### 5.1 `<Show>` with TypeScript narrowing

**Source:** Solid
**Priority:** P1 | **Effort:** Tiny (10 lines)

```tsx
<Show when={user} fallback={<Login />}>
  {(u) => <Profile user={u} />}  {/* u: User, not User | null */}
</Show>
```

Solves: TypeScript can't narrow types in JSX conditional expressions.

### 5.2 `<Key value={x}>` — force subtree remount

**Source:** Svelte's `{#key}`
**Priority:** P3 | **Effort:** Tiny

```tsx
<Key value={userId}>
  <UserProfile id={userId} />  {/* fully re-mounts on userId change */}
</Key>
```

### 5.3 `<Show keepAlive>` — preserve DOM on hide

**Source:** Vue's `<KeepAlive>` (simplified)
**Priority:** P3 | **Effort:** Small

```tsx
<Show when={activeTab.value === 'settings'} keepAlive>
  <SettingsPanel />
</Show>
```

Toggles `display: none` instead of unmounting. Preserves scroll position, canvas
state, video playback. No LRU cache — simpler than Vue's approach. AIR's feature
system already handles data persistence.

### 5.4 Action/directive system for DOM behaviors

**Source:** Svelte's `use:` actions
**Priority:** P1 | **Effort:** Medium

```tsx
// Define an action — receives DOM node, returns cleanup
function tooltip(node: HTMLElement, text: () => string) {
  const tip = document.createElement('div');
  const show = () => { tip.textContent = text(); node.appendChild(tip); };
  const hide = () => tip.remove();
  node.addEventListener('mouseenter', show);
  node.addEventListener('mouseleave', hide);
  return { cleanup() { node.removeEventListener('mouseenter', show); } };
}

// Use via `use` prop (array of actions)
<div use={[tooltip(() => helpText.value), clickOutside(close), draggable()]}>
```

Each action: gets real DOM node after mount, auto-cleans on unmount, can react
to signal changes. 10x cleaner than useRef+useEffect per behavior.

Implementation: process `use` prop in VDOM commit phase. After element is
mounted, call each action function with the DOM node. Store cleanup handles in
element metadata. Run cleanups on unmount.

### 5.5 Portal string selector + disabled prop

**Source:** Vue's `<Teleport>`
**Priority:** P3 | **Effort:** Tiny

```tsx
<Portal to="#modal-root" disabled={inline}>
  <Modal />
</Portal>
```

### 5.6 Reactive element dimensions

**Source:** Svelte's `bind:clientWidth/clientHeight`
**Priority:** P2 | **Effort:** Small

```tsx
const dims = useDimensions();
<div ref={dims.ref}>Width: {dims.width.value}px</div>
```

ResizeObserver under the hood, returns signals. Everyone needs this, nobody
wants to write it manually.

---

## Part 6: Context & DevTools

### 6.1 `useContextSelector`

**Source:** React community demand (React lacks this)
**Priority:** P2 | **Effort:** Small

```ts
const theme = useContextSelector(ThemeCtx, v => v.theme);
// Only re-renders when theme changes, not entire context object
```

Creates a computed from the selector function. Solves the "context re-render
storm" that React Context suffers from and that AIR's current implementation
also has (reads entire context signal).

### 6.2 DevTools

**Priority:** P2 | **Effort:** TBD

Two paths under consideration:
- **Option A (preferred):** Reuse React DevTools — find a clean way to make AIR
  components visible in React DevTools (Preact-style compat or other approach).
  Lower effort if feasible, instant familiarity for React developers.
- **Option B (fallback):** Build AIR-native DevTools — signal-aware "why did this
  render" with exact signal names, component tree, dependency graph. Better than
  React DevTools for signal-based code but requires building from scratch.

**Decision deferred.** Investigate Option A first. If no clean path exists, build
Option B. Either way, Redux DevTools integration already works today.

**Phased approach if building AIR-native:**
1. Embedded panel (1-2 days) — `<div>` overlay, keyboard shortcut, reads
   existing `_recordRender` / `ComponentTreeNode` data
2. "Why did this render" + signal graph (3-5 days) — tag triggering signal in
   `_scheduleComponentRender`, show dependency graph
3. Chrome extension (2-3 weeks) — proper DevTools panel, publish to Chrome Web
   Store. Only when AIR has real adoption.

---

## Part 7: VDOM Optimizations

### 7.1 Frozen/static VNode optimization

**Source:** Vue's static hoisting (runtime equivalent)
**Priority:** P2 | **Effort:** Medium

When all props and children of a VNode are literals, mark it `_static = true`.
During diff, skip it entirely — reuse the DOM node.

```ts
// In h():
if (typeof tag === 'string' && isStaticProps(props) && isStaticChildren(children)) {
  vnode._static = true;
}
// In _diff():
if (nv._static && ov._static && nv.tag === ov.tag) {
  nv._dom = ov._dom; return; // skip entirely
}
```

No compiler needed. Runtime detection. Works with any JSX.

### 7.2 Hybrid signal-bound attributes

**Source:** Solid concept, adapted for VDOM
**Priority:** P3 | **Effort:** Large

When a prop value is a signal, bypass VDOM diff and create a direct DOM binding:

```tsx
<div class={theme.value}>...</div>
// Instead of re-rendering whole component, create micro-effect:
// effect(() => el.className = theme.value)
```

VDOM for structure, direct bindings for leaf updates. Vue 3's Block Tree does
something similar at the template level.

---

## Part 8: Form Enhancements

### 8.1 Async validators

**Source:** Angular reactive forms
**Priority:** P2 | **Effort:** Small

```ts
const form = useForm({
  username: {
    initial: "",
    rules: [(v) => v.length >= 3 ? null : "Too short"],
    asyncRules: [async (v) => {
      const taken = await checkUsername(v);
      return taken ? "Already taken" : null;
    }],
    debounceMs: 300,
  },
});
```

Field shows `validating` state while async rules run. Debounce prevents rapid
server hits.

### 8.2 Cross-field validation

**Source:** Angular form-level validators
**Priority:** P2 | **Effort:** Small

```ts
const form = useForm({
  password: { initial: "" },
  confirm: { initial: "" },
}, {
  validators: [
    (fields) => fields.password === fields.confirm ? null : {
      confirm: "Passwords don't match"
    }
  ]
});
```

---

## Part 9: Ecosystem Bridge — Islands Pattern

### 9.1 `island()` — mount external framework components

**Priority:** P1 | **Effort:** Medium

AIR owns the page. React/Vue/Solid components mount into specific DOM nodes
when needed (chart libraries, rich text editors, etc.).

```tsx
// In an AIR component:
import { island } from "aio";

const ReactChart = island({
  load: () => import("recharts"),
  component: (mod) => mod.LineChart,
  // Reads AIO signals, passes as props
  props: () => ({ data: chartData.value, width: 600 }),
});

// In JSX:
<ReactChart />
```

Implementation per framework (~20 lines each):
- **React:** `createRoot()` + `useSyncExternalStore()` for signal reads
- **Vue:** `createApp()` + `watch()` on signal subscriptions
- **Solid:** `render()` + signal read via `createEffect`

The island helper handles: lazy loading, mounting/unmounting lifecycle,
signal-to-props bridging, cleanup on AIR component unmount.

### 9.2 Signal subscription API for external consumers

```ts
import { subscribe } from "aio/signals";

// Any framework can consume AIO signals:
const unsub = subscribe(mySignal, (value) => {
  externalChart.update(value);
});
```

Already exists as `signal.subscribe()`. Document it prominently for ecosystem
integration.

---

## Part 10: SSR Enhancements

### 10.1 Streaming SSR

**Source:** Solid, React
**Priority:** P3 | **Effort:** Large

```ts
const stream = renderToStream(() => h(App, null));
// Sends HTML chunks as Suspense boundaries resolve
```

Better TTFB. Implementation: walk VDOM, flush HTML when hitting a pending
Suspense boundary, continue when promise resolves.

### 10.2 Dev-mode enhancements

**Source:** React StrictMode, Svelte a11y warnings
**Priority:** P2 | **Effort:** Small

- Double-invoke `onMount` in dev mode to catch missing cleanup
- Warn on auto-memo defeat (new-reference value-equal props)
- Warn on signal reads outside tracking context
- A11y warnings: missing `alt`, `onClick` without `onKeyDown`, missing labels

---

## Explicitly Rejected

| Idea | Source | Why NOT |
|------|--------|---------|
| `reactive()` deep proxy | Vue | Destructuring kills reactivity, debugging nightmare |
| Template DSL / custom files | Svelte, Angular | Locks out TypeScript, standard tooling |
| `<For>`, `<Index>`, `<Switch>`, `<Match>` | Solid | Unnecessary with VDOM keyed reconciliation |
| Directives (v-model, v-show) | Vue | Framework smell. Actions pattern is superior |
| Full concurrent rendering | React | 4+ years of complexity. Per-component signals cover 95% |
| RSC architecture | React | Delta protocol IS our server component model |
| React Compiler / auto-memo | React | AIR doesn't have the problem it solves |
| Synthetic events | React | IE-era legacy. Native DOM events correct. |
| Deep proxy stores | Solid | Fights delta protocol architecture |
| Full resumability | Qwik | Massive complexity. Delta protocol handles state transfer differently |
| Dollar sign conventions | Qwik | DX tax. Serialization boundaries should be implicit |
| Angular DI | Angular | Over-engineering. Context + features suffice |
| Options API / dual modes | Vue | ONE way to do things. No legacy compat |
| Class components | React | Dead API. Functions only. |
| Dependency arrays | React | Auto-tracking makes them unnecessary |

---

## Implementation Order

**Phase 1 — Signal Foundation** (items 1.1-1.6, 2.1, 1.3)
- Updater fn, auto-batch, auto-dispose, untrack, watch, on, afterRender
- Foundation for everything else. All small/tiny effort.

**Phase 2 — Animation System** (items 3.1-3.3, 3.2 CSS API)
- Deferred DOM removal, CSS-first transitions, `<Transition>` component
- Biggest visible DX gap. Medium effort.

**Phase 3 — Component Utilities** (items 5.1, 5.4, 4.1, 9.1)
- `<Show>`, actions/directives, `resource()`, islands bridge
- Full-stack integration story. Mixed effort.

**Phase 4 — DX Polish** (items 6.1-6.2, 5.6, 8.1-8.2, 4.3, 10.2)
- Context selector, devtools, dimensions, form enhancements, defer, dev warnings
- Quality of life. Mixed effort.

**Phase 5 — Performance** (items 7.1-7.2, 3.4, 10.1)
- Frozen VNodes, hybrid bindings, TransitionGroup FLIP, streaming SSR
- Optimization layer. Large effort.

---

## Success Criteria

1. A React developer can be productive in AIR in <10 minutes using compat hooks
2. An AIR developer never needs to think about memoization, dep arrays, or manual batching
3. Server-pushed state via `useFeature` + client async via `resource()` cover 100% of data needs
4. Animation system matches Svelte's ergonomics with CSS-first performance
5. External framework components (React charts, etc.) mount via `island()` with zero config
6. DevTools show "why did this render" with exact signal names — better than any other framework
