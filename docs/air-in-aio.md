# AIR in AIO — Integration Guide

How to build AIO applications with the AIR renderer. This guide covers the
architecture, data flow, optimal patterns, and the benefits you get from the
AIO + AIR combination.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Two Files, Full App](#two-files-full-app)
- [Data Flow](#data-flow)
- [Connecting UI to Server State](#connecting-ui-to-server-state)
  - [useFeature — Feature-Scoped State](#usefeature--feature-scoped-state)
  - [useAio — Full State Tree](#useaio--full-state-tree)
  - [useLocal — Client-Only State](#uselocal--client-only-state)
  - [useConnected — Connection Status](#useconnected--connection-status)
- [Local UI State with Signals](#local-ui-state-with-signals)
- [Optimal Patterns](#optimal-patterns)
  - [Feature Per Domain](#feature-per-domain)
  - [useFeature Over useAio](#usefeature-over-useaio)
  - [Signals for UI, Features for Business](#signals-for-ui-features-for-business)
  - [Derived State with computed()](#derived-state-with-computed)
  - [Side Effects at the Right Level](#side-effects-at-the-right-level)
- [Multi-Feature Applications](#multi-feature-applications)
- [Forms](#forms)
- [Routing](#routing)
- [SSR and Hydration](#ssr-and-hydration)
- [Offline and Reconnection](#offline-and-reconnection)
- [Electron / Desktop](#electron--desktop)
- [What AIO + AIR Gives You](#what-aio--air-gives-you)

---

## Architecture Overview

AIO is a full-stack framework. AIR is its native renderer. Together they form a
clean split:

```
┌──────────────────────────────────────────────────────────────────┐
│                          Server (Deno)                           │
│                                                                  │
│   feature("counter", { state, methods })                         │
│   feature("todo",    { state, methods, persist })                │
│   feature("auth",    { state, methods, machine })                │
│                                                                  │
│   aio.run({ features: [...], baseDir })                          │
│   ─── dispatch loop ── reduce ── effects ── persist ── broadcast │
└──────────────────────┬───────────────────────────────────────────┘
                       │ WebSocket / IPC
                       │ State deltas + action acknowledgments
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Client (AIR Renderer)                          │
│                                                                  │
│   state-core: signals per feature ← server broadcasts            │
│   adapters/air: useFeature() → { state, send }                   │
│   aio-renderer: mount() → per-component signal tracking          │
│                                                                  │
│   signal() / computed() / effect() — local reactivity            │
│   useForm() / useVirtualList() / <Transition> — built-in UI      │
└──────────────────────────────────────────────────────────────────┘
```

**The server owns business logic and state.** Features define what the app can
do — their methods, state shape, persistence rules, and inter-feature
communication.

**The client owns rendering and local interaction.** AIR reads server state via
signals, sends actions back, and handles everything visual — animations, forms,
scroll, routing.

No state duplication. No manual sync. The server is the source of truth.

---

## Two Files, Full App

Every AIO + AIR app starts with two files:

**`app.ts` — Server entry point (feature + runtime)**

```ts
import { aio, feature } from "aio";

export const counter = feature("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
    decrement(s, by = 1) {
      s.count -= by;
    },
    reset(s) {
      s.count = 0;
    },
  },
});

await aio.run({
  features: [counter],
  baseDir: import.meta.dirname!,
});
```

**`App.tsx` — UI component (AIR renders it)**

```tsx
import { useFeature } from "aio/air";
import { counter } from "./app.ts";

export default function App() {
  const { state, send } = useFeature(counter);
  return (
    <div>
      <h1>{state.count}</h1>
      <button onClick={() => send.increment()}>+</button>
      <button onClick={() => send.decrement()}>−</button>
      <button onClick={() => send.reset()}>Reset</button>
    </div>
  );
}
```

Run with `deno run -A app.ts`. AIO starts the server, compiles the UI, opens a
browser (or Electron window), connects WebSocket, and streams state. The counter
works across tabs — open two and click in one, both update.

**Import rule:**

- `"aio"` — server code: `feature`, `aio`, `log`, types
- `"aio/air"` — client code: `useFeature`, `signal`, `mount`, UI utilities

---

## Data Flow

The round-trip for a user action:

```
1. User clicks button
   └─ onClick={() => send.increment()}

2. AIR batches the handler
   └─ batch(() => handler(event))

3. send.increment() creates action
   └─ { type: "counter:increment", payload: { args: [] }, _source: "UI" }

4. Action sent via WebSocket (or IPC in Electron)
   └─ ws.send(JSON.stringify(action))

5. Server dispatches through reduce()
   └─ counter's increment method mutates state: s.count += 1

6. Server broadcasts delta to all connected clients
   └─ { counter: { count: 1 } }

7. state-core receives delta, updates feature signal
   └─ batch(() => featureSignal.set({ count: 1 }))

8. AIR re-renders only components that read counter.count
   └─ Per-component tracking → surgical DOM update
```

The round-trip is fast — WebSocket, not HTTP. Delta compression means only
changed fields are sent. Signal batching means one DOM update even if multiple
fields change.

---

## Connecting UI to Server State

### useFeature — Feature-Scoped State

```tsx
import { useFeature } from "aio/air";
import { counter } from "./app.ts";

const Counter = () => {
  const { state, send } = useFeature(counter);
  return <span>{state.count}</span>;
};
```

- `state` is a reactive proxy. Reading `state.count` in JSX auto-tracks it.
- `send` is typed. `send.increment(5)` dispatches to the server with args.
- **Only this component re-renders** when `counter.count` changes. Other
  features' updates are ignored.

This is the primary hook. Use it for every feature your component needs.

### useAio — Full State Tree

```tsx
const Dashboard = () => {
  const { state } = useAio();
  return <span>{state.counter?.count} / {state.todo?.items.length}</span>;
};
```

Re-renders on **any** state change. Use sparingly — dashboards, debug panels.
Prefer `useFeature` for scoped updates.

### useLocal — Client-Only State

```tsx
const Tabs = () => {
  const { local: tab, set: setTab } = useLocal("overview");
  return (
    <div>
      <button onClick={() => setTab("overview")}>Overview</button>
      <button onClick={() => setTab("details")}>Details</button>
      <div>{tab === "overview" ? <Overview /> : <Details />}</div>
    </div>
  );
};
```

Signal-backed, not synced to server. For UI-only state: modals, tabs, form
visibility, hover states. Supports `set(value)`, `set(prev => next)`, and
`patch(partial)` for object state.

### useConnected — Connection Status

```tsx
const StatusBadge = () => {
  const connected = useConnected();
  return <span className={connected ? "online" : "offline"} />;
};
```

Boolean signal. Reactive — component re-renders when connection drops or
restores.

---

## Local UI State with Signals

Not everything needs server state. Use signals for transient UI concerns:

```tsx
import { computed, signal } from "aio/air";

// Module-level signals — shared across components, persist across re-renders
const searchQuery = signal("");
const showFilters = signal(false);

// Derived state — auto-tracked, auto-cached
const queryLength = computed(() => searchQuery.value.length);

const SearchBar = () => (
  <div>
    <input
      value={searchQuery.value}
      onInput={(e) => searchQuery.set(e.target.value)}
    />
    <span>{queryLength.value} characters</span>
    <button onClick={() => showFilters.set(!showFilters.peek())}>
      {showFilters.value ? "Hide" : "Show"} Filters
    </button>
  </div>
);
```

**When to use which:**

| State type                        | Use                        | Why                             |
| --------------------------------- | -------------------------- | ------------------------------- |
| Business data (persisted, shared) | `useFeature`               | Server is source of truth       |
| Component-local UI toggle         | `useLocal`                 | Signal-backed, component-scoped |
| Cross-component UI state          | `signal()` at module level | Shared without prop drilling    |
| Cached derivation                 | `computed()`               | Auto-tracked, no dep arrays     |

---

## Optimal Patterns

### Feature Per Domain

One feature per business domain. Not per screen, not per component.

```ts
// Good — domain boundaries
feature("auth",    { state: { user, token, role }, methods: { login, logout } });
feature("orders",  { state: { items, status },     methods: { place, cancel } });
feature("chat",    { state: { messages, typing },   methods: { send, markRead } });

// Bad — screen-based (mixes concerns, can't reuse)
feature("orderPage", { state: { orders, user, chatMessages, ... } });
```

Features are the unit of reuse. They work the same in browser, Electron, CLI,
and headless testing.

### useFeature Over useAio

Always prefer `useFeature(specificFeature)` over `useAio()`.

```tsx
// Good — re-renders only when orders change
const OrderList = () => {
  const { state } = useFeature(orders);
  return <ul>{state.items.map((o) => <li key={o.id}>{o.name}</li>)}</ul>;
};

// Bad — re-renders on ANY state change in any feature
const OrderList = () => {
  const { state } = useAio();
  return <ul>{state.orders?.items.map((o) => <li key={o.id}>{o.name}</li>)}
  </ul>;
};
```

`useFeature` subscribes to one feature's signal. `useAio` subscribes to the
global signal. The performance difference is real in apps with many features.

### Signals for UI, Features for Business

Keep the separation clean:

```tsx
const OrderDashboard = () => {
  // Server state — business data
  const { state, send } = useFeature(orders);

  // Client state — UI concern
  const { local: sortBy, set: setSortBy } = useLocal<"date" | "amount">("date");
  const { local: expanded, set: setExpanded } = useLocal<Set<number>>(
    new Set(),
  );

  const sorted = [...state.items].sort((a, b) =>
    sortBy === "date" ? b.date - a.date : b.amount - a.amount
  );

  return (
    <div>
      <button onClick={() => setSortBy(sortBy === "date" ? "amount" : "date")}>
        Sort by {sortBy}
      </button>
      {sorted.map((order) => (
        <OrderRow
          key={order.id}
          order={order}
          expanded={expanded.has(order.id)}
          onToggle={() =>
            setExpanded((prev) => {
              const next = new Set(prev);
              next.has(order.id) ? next.delete(order.id) : next.add(order.id);
              return next;
            })}
          onCancel={() => send.cancel(order.id)}
        />
      ))}
    </div>
  );
};
```

Sort order and expanded rows are UI state — no reason to send them to the
server. Order data and cancellation are business logic — they belong in the
feature.

### Derived State with computed()

Use `computed()` for expensive derivations that depend on server state:

```tsx
import { computed } from "aio/air";

const OrderStats = () => {
  const { state } = useFeature(orders);

  // Computed from server state — only recalculates when state.items changes
  const stats = computed(() => ({
    total: state.items.length,
    pending: state.items.filter((o) => o.status === "pending").length,
    revenue: state.items.reduce((sum, o) => sum + o.amount, 0),
  }));

  return (
    <div>
      <span>{stats.value.total} orders</span>
      <span>{stats.value.pending} pending</span>
      <span>${stats.value.revenue} revenue</span>
    </div>
  );
};
```

### Side Effects at the Right Level

**Server effects** — in the feature (execute/effects):

- API calls, database writes, external service calls
- Anything that should happen exactly once regardless of how many clients

**Client effects** — in the component (effect/onMount):

- DOM measurement, scroll position, focus management
- Analytics tracking, local storage, browser APIs

```tsx
// Server side — feature handles the API call
export const orders = feature("orders", {
  state: { items: [], loading: false },
  methods: {
    fetchOrders(s) {
      s.loading = true;
    },
    setOrders(s, items: Order[]) {
      s.items = items;
      s.loading = false;
    },
  },
  execute: {
    async fetchOrders(app) {
      const items = await fetch("/api/orders").then((r) => r.json());
      app.dispatch(orders.setOrders(items));
    },
  },
});

// Client side — component handles scroll restoration
const OrderList = () => {
  const { state, send } = useFeature(orders);

  onMount(() => {
    send.fetchOrders(); // Trigger server-side fetch
    window.scrollTo(0, 0); // Client-side DOM effect
  });

  return (
    <Show when={!state.loading} fallback={<Spinner />}>
      {() => (
        <ul>{state.items.map((o) => <OrderRow key={o.id} order={o} />)}</ul>
      )}
    </Show>
  );
};
```

---

## Multi-Feature Applications

Real apps have multiple features. Components can use several:

```tsx
const Header = () => {
  const { state: auth } = useFeature(authFeature);
  const { state: cart } = useFeature(cartFeature);
  const { state: notifications } = useFeature(notifFeature);

  return (
    <header>
      <span>Welcome, {auth.user?.name}</span>
      <CartIcon count={cart.items.length} />
      <BellIcon count={notifications.unread} />
    </header>
  );
};
```

Each `useFeature` tracks its own feature signal independently. The Header
re-renders when auth, cart, OR notifications change — but NOT when unrelated
features update.

Features communicate on the server via `listensTo` (observe actions), `call()`
(async coordination), or shared machine transitions. The UI doesn't need to wire
this — it just reads the resulting state.

---

## Forms

AIR's built-in form system is signal-based — field-level reactivity with no
wrappers:

```tsx
import { useForm } from "aio/air";

const CheckoutForm = () => {
  const { state: cart, send } = useFeature(cartFeature);

  const form = useForm({
    initialValues: { name: "", email: "", address: "" },
    validate: {
      name: (v) => v.length < 2 ? "Too short" : undefined,
      email: (v) => !v.includes("@") ? "Invalid email" : undefined,
    },
    onSubmit: (values) => send.checkout(values),
  });

  return (
    <form onSubmit={form.handleSubmit}>
      <input {...form.field("name")} />
      <Show when={form.errors.name?.value}>
        {(err) => <span className="error">{err}</span>}
      </Show>

      <input {...form.field("email")} />
      <input {...form.field("address")} />

      <button type="submit" disabled={!form.valid.value}>
        Pay ${cart.total}
      </button>
    </form>
  );
};
```

The form validates locally. On submit, it calls `send.checkout()` which
dispatches to the server feature. Server handles payment logic, updates state,
broadcasts result.

---

## Routing

AIR uses signal-based routing — the URL is a reactive signal:

```tsx
import { navigate, routePath } from "aio/air";

const Nav = () => (
  <nav>
    <a
      href="/orders"
      onClick={(e) => {
        e.preventDefault();
        navigate("/orders");
      }}
    >
      Orders
    </a>
    <a
      href="/settings"
      onClick={(e) => {
        e.preventDefault();
        navigate("/settings");
      }}
    >
      Settings
    </a>
  </nav>
);

const App = () => {
  const path = routePath.value;
  return (
    <div>
      <Nav />
      <Show when={path === "/orders"} fallback={<Settings />}>
        {() => <OrderList />}
      </Show>
    </div>
  );
};
```

`routePath` is a signal — components that read it re-render on navigation.
`navigate()` updates the URL and the signal. No router library needed.

---

## SSR and Hydration

AIR supports both sync and streaming SSR:

```ts
import { renderToString } from "aio/air";
import { renderToStream } from "aio/air";
import { h } from "aio/air";

// Sync — full HTML string
const html = renderToString(h(App, null));

// Streaming — async generator for chunked responses
const handler = async (req: Request) => {
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        new TextEncoder().encode("<!DOCTYPE html><html><body>"),
      );
      for await (const chunk of renderToStream(h(App, null))) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.enqueue(new TextEncoder().encode("</body></html>"));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/html" } });
};
```

Hydrate on the client to attach event handlers and signal bindings without
re-creating DOM:

```tsx
import { hydrate } from "aio/air";

hydrate(document.getElementById("root")!, App);
```

Hydration walks existing DOM, attaches listeners, binds signals. Falls back to
full render on mismatch.

---

## Offline and Reconnection

AIO handles connection drops automatically:

- **Offline queue** — actions dispatched while offline are queued in memory
- **Auto-reconnect** — exponential backoff (1s → 2s → 4s → ... → 30s max)
- **State resync** — on reconnect, server sends full state, client signals
  update
- **`useConnected()`** — reactive boolean for UI feedback

```tsx
const App = () => {
  const connected = useConnected();
  const { state, send } = useFeature(myFeature);

  return (
    <div>
      {!connected && <Banner>Working offline — changes will sync</Banner>}
      {/* UI works normally — send() queues if offline */}
      <button onClick={() => send.doThing()}>Do Thing</button>
    </div>
  );
};
```

No special handling needed. `send()` works online and offline. The queue drains
when connection restores.

---

## Electron / Desktop

Same code runs in Electron. AIO detects the environment and uses IPC instead of
WebSocket:

```ts
// app.ts — no changes needed
await aio.run({
  features: [counter],
  baseDir: import.meta.dirname!,
  // Electron window opens automatically when electron is detected
});
```

The UI code is identical. `useFeature`, `send`, signals — all work the same. The
transport layer (WebSocket vs IPC) is invisible to components.

Build targets:

```sh
deno task am compile --target electron    # Desktop app
deno task am compile --target android     # Android APK
deno task am compile --target browser     # Static web build
deno task am compile --target cli         # Headless CLI
```

---

## What AIO + AIR Gives You

Benefits of using AIR as AIO's renderer instead of React:

### Zero External Dependencies

AIR is built into AIO. No `react`, `react-dom`, `@types/react`. Your
`node_modules` stays empty. Total renderer footprint: ~8KB.

### Automatic Optimization

| What                 | React                                  | AIR                                 |
| -------------------- | -------------------------------------- | ----------------------------------- |
| Re-render prevention | `React.memo`, `useMemo`, `useCallback` | Automatic — signals track reads     |
| Dependency tracking  | Manual `[deps]` arrays                 | Auto-tracked by signal reads        |
| Stale closures       | Common bug source                      | Impossible — signals always current |
| Context performance  | All consumers re-render                | Only consumers of changed slice     |

### Native Integration

AIR hooks read from the same signals that `state-core` updates. There's no
bridge, no adapter translation, no `useSyncExternalStore` shim. When the server
broadcasts a state delta:

1. `state-core` updates the feature signal
2. AIR's per-component tracking sees the signal changed
3. Only affected components re-render
4. DOM patches are surgical (per-attribute, not per-subtree)

With React, the same path goes: signal → `useSyncExternalStore` → `setState` →
reconciler → virtual DOM diff → DOM patch. AIR cuts out the middlemen.

### Built-In UI Toolkit

Everything ships with AIO — no additional packages:

- **Forms** — `useForm()`, `useFieldArray()`, async validation
- **Animation** — `<Transition>`, `<TransitionGroup>`, FLIP reorder,
  `fade`/`slide`/`scale`
- **Virtual scroll** — `useVirtualList()` for large lists
- **Async data** — `resource()` with abort, refetch, optimistic mutate
- **Deferred loading** — `<Defer trigger="viewport">` for lazy components
- **Unique IDs** — `useId()` SSR-safe, deterministic across server/client
- **Optimistic UI** — `useOptimistic()` instant feedback during server
  round-trips
- **Dimensions** — `useDimensions()` reactive ResizeObserver
- **Accessibility** — dev-mode runtime a11y warnings
- **Routing** — signal-based, no library needed
- **SSR** — sync `renderToString()` and streaming `renderToStream()`
- **Islands** — `island()` to mount React/Vue/Solid inside AIR pages
- **DevTools** — signal tracking, render timing, component tree

### Same Code, Every Target

Features defined with `feature()` run identically across all targets. The UI
layer adapts per platform, but business logic is shared:

```
feature("orders", { state, methods, machine, persist })
  │
  ├── Browser  → AIR renderer + WebSocket
  ├── Electron → AIR renderer + IPC
  ├── Android  → AIR renderer + WebView
  ├── CLI      → headless (no renderer)
  └── Service  → headless (no renderer)
```

For CLI and service targets, features run without any renderer. For all UI
targets, AIR handles the presentation.

---

## Summary

The optimal AIO + AIR application follows these principles:

1. **Features own business logic** — state, methods, persistence, inter-feature
   communication
2. **AIR owns presentation** — rendering, local UI state, forms, animation,
   routing
3. **`useFeature` is the bridge** — typed `{ state, send }` per feature
4. **Signals for local, features for shared** — don't send UI toggles to the
   server
5. **Let the framework work** — auto-memo, auto-tracking, auto-batching,
   auto-reconnect

Two files to start. Zero configuration for reactivity. One import path per
concern (`"aio"` for server, `"aio/air"` for client). Ship it.
