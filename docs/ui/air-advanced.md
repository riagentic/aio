# AIR Advanced Patterns

SSR, portals, islands, code splitting, virtual scrolling, dimensions, deferred
loading, accessibility, custom adapters, and framework integration.

---

## Code Splitting

```tsx
import { h, lazy, Suspense } from "aio/air";
import { chartData } from "./chart-data.ts";

const HeavyChart = lazy(() => import("./heavy-chart.ts"));

const App = () =>
  h(
    Suspense,
    { fallback: <span>Loading chart...</span> },
    <HeavyChart data={chartData.value} />,
  );
```

If the import rejects, the error propagates to the nearest `ErrorBoundary`.
Multiple lazy components under one `Suspense`: fallback shows until all resolve.

---

## Async Data -- resource()

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

**Resource\<T\>:** `value`, `latest` (preserved during refetch), `loading`,
`error`, `refetch()`, `mutate(value)`, `dispose()`.

---

## Something you HOLD -- useResource()

`resource()` fetches. `useResource()` is for something you hold open — a camera,
a socket, a GPU pipeline, a file handle — where the **close** matters and a key
decides which one you have:

```tsx
import { useResource } from "aio/air";
import { settings } from "./cell.ts"; // a cell with a `cameraId`
declare function openCamera(id: string | number, s: AbortSignal): MediaStream;

const cam = useResource({
  key: () => settings.cameraId, // reactive
  open: (id, { signal }) => openCamera(id, signal),
  close: (stream: MediaStream) => stream.getTracks().forEach((t) => t.stop()),
});
```

Three guarantees, each of which is a bug in every hand-rolled version:

- **One open per key, reference-counted.** Three components holding the same key
  open it once and close it when the last one lets go — not three opens, and not
  a close while somebody is still using it. `scope` keeps two unrelated
  resources that happen to share an id apart.
- **A stale open cannot win.** An `open` that resolves after the key has moved
  on closes what it made and does not install it. No `alive(s)` guard at twenty
  call sites, nineteen of which are right.
- **The close is attached to the open.** Changing the key closes the old
  resource _before_ opening the new one, so two pipelines never fight over one
  device.

`key: null` holds nothing and releases whatever it held. The handle carries
`value`, `loading`, `error`, `key` and `dispose()`.

---

## Reacting to state -- onChange()

The rule "when the camera id changes, reopen the camera" is not a render and not
an event handler. Put it in neither:

```ts
import { onChange } from "aio/air";
import { settings } from "./cell.ts";
declare function openCamera(id: string | number): { close(): void };

const stop = onChange(
  () => settings.cameraId,
  (id) => {
    const cam = openCamera(id);
    return () => cam.close(); // runs before the next change, and on stop()
  },
);
```

It differs from a bare `effect` in three ways that all matter:

- **Only the selector is tracked.** The body runs untracked, so a reaction that
  reads other state while working does not subscribe to it and re-run itself
  forever. That is the loop everyone hits first.
- **It waits for a change.** An `effect` runs immediately, so the rule above
  written as one opens a camera on boot that nobody asked for. Pass
  `{ immediate: true }` when you do want that.
- **The returned cleanup is the close**, run before the next change and on
  dispose — so "close the old, open the new" is one function instead of two
  rules that have to agree.

Because it is not tied to a component, a state change from anywhere reaches it —
including `am dispatch`, which is exactly the case where a rule living in a JSX
handler quietly does not run.

---

## Directives -- `use` Prop

```tsx
function autoFocus(el: HTMLElement) { el.focus(); }
function tooltip(el: HTMLElement, text: string) {
  el.title = text;
  return () => { el.title = ""; };
}

<input use={autoFocus} />
<button use={[tooltip, "Click me!"]}>Hover</button>
```

- `use={fn}` -- calls `fn(element)`. `use={[fn, value]}` -- calls
  `fn(element, value)`.
- Return a cleanup function for teardown on unmount.

---

## Islands

Mount external framework components (React, Vue, Solid) into AIR pages:

```tsx
import { island } from "aio/air";
import ReactDOM from "react-dom/client"; // islands need the host framework
import { chartData } from "./chart-data.ts";

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
```

Signal changes in `props()` automatically call `handle.update()`.

---

## Portals

Render children into a DOM node outside the component hierarchy:

```tsx
import { h, Portal } from "aio/air";

const Modal = () =>
  h(
    Portal,
    { target: document.getElementById("modal-root")! },
    <div className="modal">I'm rendered in #modal-root!</div>,
  );
```

Portals are skipped during SSR.

---

## Server-Side Rendering

### renderToString()

```tsx
import { renderToString } from "aio/air";

const html = renderToString(
  <div className="app">
    <h1>Hello SSR</h1>
  </div>,
);
```

**A routed app** passes the request's route to the render. `<Route>`, `useRoute`
and `<Link>` need no runtime on the server, and context Providers (the route
context, your own) reach their children exactly as they do in the browser:

```tsx
import { collectHead, renderToString } from "aio/air";
import App from "./App.tsx";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // …await a session, a database read — anywhere: the route is the render's.
  // The path AND the query, or `useRoute().search` is empty on the server and
  // full in the browser — a page that hydrates into different markup than it
  // shipped. `route` is the PATHNAME only: the query goes in `search`.
  const body = renderToString(<App />, {
    route: url.pathname,
    search: url.searchParams,
  });
  return new Response(
    `<!doctype html><head>${collectHead()}</head><body>${body}</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
});
```

Omit the options and the render routes by the global `routePath` / `routeSearch`
signals instead — the 1.x form
(`routePath.set(url.pathname);
routeSearch.set(url.searchParams); renderToString(<App />)`),
which is safe only under the route contract below.

### renderToStream()

Streaming SSR -- yields HTML chunks as an async generator.

**The route contract.** Give every render its route:

```tsx
renderToStream(<App />, req, { route: url.pathname, search: url.searchParams });
renderToString(<App />, { route: url.pathname, search: url.searchParams });
```

A render given its route routes by it alone — every read the render makes:
`useRoute`, `<Route>`, `<Link>`/`<NavLink>` active state, the route signals read
in a component (`routePath.value`, `routePath()`, `.peek()`) or placed in the
markup as a child or an attribute (`<a href={routePath}>`), and any `computed` /
`trackedMemo` over them evaluated while it renders — in nested renders and in
every later pull of a stream included. It never renders from the global
`routePath` / `routeSearch` and never writes them (a read inside it still
subscribes to them — tracking only; the value is the render's). A module-level
`computed` over the route is recomputed for each such render and never carries
one render's route into another render or into the global, and never disturbs
the global's own cache or subscriptions (a computed read inside a render is
evaluated once per render, however often it is read). Effects are not part of a
render: one that runs because a component wrote a signal sees the global and
keeps its subscription, and an effect or `watch` CREATED during a render runs
every pass on the global route, its first included — so it subscribes to what
the global route reads, never to the branch the render took. One that reads
`routePath` / `routeSearch` on that first pass (directly, or through a
`computed` or `trackedMemo` over them) is named in a warning (once per call
site, then with a count): whatever it writes for the page is the global route's
— derive render values with `computed` or `useRoute` instead. An effect or
`computed` that itself CALLS a render given a route re-runs whenever anything
that render read changes. Nothing can race it: await anything, anywhere, in any
number of concurrent requests, and say nothing. What it cannot cover is work a
component starts and finishes LATER (after an `await` inside a `useResource`
fetcher, a timer): that runs outside the render and reads the globals.

`route` is a pathname like `url.pathname` — `/` first, not `//`, no scheme, no
`?` or `#` (the query goes in `search`); anything else is refused with a
`TypeError`, as is `search` without `route`. The options are the THIRD argument
of `renderToStream` (the second is the key `collectHead(key)` answers for):
`renderToStream(<App />, { route })` is refused rather than silently routing by
the global.

Without options a render reads the globals — the 1.x form, kept for
compatibility. `routePath` / `routeSearch` are ONE pair of signals shared by
every request in the process. The only safe way to use them on a server that
handles requests concurrently: **every request sets the route and calls
`renderToStream()` / `renderToString()` in one synchronous step — no `await`
between the set and the call, on ANY request.** Then each render takes its own
request's route when it is called, and keeps it however long its body takes and
whatever else the handler awaits before sending it.

When any request breaks that — sets the route, then awaits, then renders —
another request's render can read the route it left behind, or it can read
another request's. aio cannot prevent that (the signals are shared, and a stream
re-reads the route once, at the end of the synchronous turn it was called in, so
that code creating the stream first and setting the route right after keeps
working as in 1.0.9 — and two requests resumed by one shared promise run in ONE
turn). What it does is say so. Every server-side write to `routePath` /
`routeSearch` stamps the writing async context; these are the cases it reports,
each naming the render's call site:

- `[aio] this server render read the route, and the route was set outside
  this render's synchronous step (another request, or this one after an await)
  — it can be another request's page. …`
  — the render's own async context wrote the route earlier, but the LAST write
  came from a different one: another request (the classic case — a request sets
  its route, awaits a shared config or session promise, and renders after
  another request resumed from the same promise and set its own), or a helper of
  this request that wrote it after an `await`. Said at the render's first route
  READ (`useRoute`, `<Route>`, `<Link>`/`<NavLink>`'s active state) — a page
  that never reads the route cannot render the wrong one and is never told.
- `[aio] routePath changed after renderToStream() — set it BEFORE the call;
  under concurrent requests this can render another request's route (<call
  site>).`
  — whenever that end-of-turn re-read finds a different route than the call did.
- `[aio] renderToStream(): the route (or another request value) changed after
  renderToStream() was called, in the same turn as another render's call —
  this stream keeps the value it was CALLED with. Set routePath before
  renderToStream(), with no await in between (<call site>).`
  — the one exception to the re-read: when another top-level render set up in
  the same turn took a DIFFERENT route, the stream keeps its call-time route
  (the live one may be that render's). A live route that matches none of them is
  reported; one that matches another render's is correct concurrent code and
  says nothing. Renders that took this stream's own route do not count (two
  streams created before one `routePath.set` both re-read, as in 1.0.9).
- `[aio] routePath changed after renderToStream() was called and before the
  stream was first read — the stream renders the route it was CALLED with
  (1.0.9 read it at the first read). …`
  — a route set after that turn (1.0.9 code that creates the stream, awaits,
  then sets the route; or another request that set its route and is awaiting
  before its own render) is never rendered, and is reported at the stream's
  first read.

Each is said the 1st, 2nd, 4th, 8th … time its call site hits it, and every
repeat carries the count
(`[N times at this call site; M more since the last
warning]`) — quiet under
load, never silent for good. Observe-only, the same in dev and prod; what is
rendered does not change.

A write made in the render's own synchronous step is never reported, even inside
another library's `AsyncLocalStorage.run()` (a tracer's active span), which
drops the write's stamp when it returns: a write made in the same microtask from
the render's own stamp counts as the render's.

What is NOT caught reliably (best-effort):

- the classic case above when the OTHER request started after this one's route
  write and inherited its stamp — on `Deno.serve`, a write in a handler's
  synchronous prefix is inherited by every request accepted after it — and
  resumed in the same microtask this render is called in: its write then looks
  like this render's own step;
- a render in a request that never writes the route: its async context carries
  no stamp (nothing to compare) or one another request left on the accept loop,
  so it is told only sometimes;
- a component that reads `routePath.value` directly instead of through the
  router.

The contract above is the whole defence there. On runtimes without
`node:async_hooks` (a browser) the write stamp is off; the three route-change
warnings still apply.

A stream created inside a server component is settled at its first read, as in
1.0.9: read during that component call, it is part of the enclosing page; read
after the page ended, it is a render of its own (its own `useId` sequence and
keyed head) that takes the route at that first read.

Its `useId` sequence, its `<head>` and its `<select>` scopes are its own. Pass
any object that identifies the response -- the `Request` -- and
`collectHead(req)` gives you that render's head back, whatever else was
streaming at the time:

```tsx
import { renderToStream } from "aio/air";
import App from "./App.tsx";

Deno.serve((req) => {
  const url = new URL(req.url);
  const route = { route: url.pathname, search: url.searchParams };
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      for await (const chunk of renderToStream(<App />, req, route)) {
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

### Hydration

```tsx
import { hydrate } from "aio/air";
import App from "./App.tsx";

hydrate(document.getElementById("root")!, App);
```

Walks existing DOM, attaches listeners, binds signals. Falls back to full render
on mismatch.

---

## Virtual Scrolling

```tsx
import { signal, useVirtualList } from "aio/air";

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
```

Config: `items` (plain or `Signal<T[]>`), `itemHeight`, `containerHeight`,
`overscan` (default `3`).

---

## Element Dimensions

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

Returns `ref`, `width` (Signal), `height` (Signal). Observer disconnects on
unmount.

---

## Deferred Loading

```tsx
import { Defer } from "aio/air";

export const demos = (
  <>
    <Defer
      trigger="viewport"
      load={() => import("./heavy-chart.ts")}
      placeholder={<div>Chart placeholder</div>}
      loading={<div>Loading...</div>}
    />
    <Defer trigger={2000} load={() => import("./analytics.ts")} />
    <Defer
      trigger="hover"
      load={() => import("./preview.ts")}
      placeholder={<div>Hover to preview</div>}
    />
  </>
);
```

Triggers: `"viewport"` (IntersectionObserver), `"idle"` (requestIdleCallback),
`"hover"` (mouseenter), `"interaction"` (click/keydown), `"immediate"`, `number`
(setTimeout ms).

---

## Accessibility (Dev Mode)

**On by default in dev.** The renderer's warnings follow the same `__aioDev`
flag every other aio diagnostic does -- the dev server sets it, `deno task dev`
sets it, and the test harness sets it -- so you get them without asking, and
production is silent. (They used to sit behind `setDevMode()`, which nothing in
the framework called: a warning behind a flag nobody sets is a warning that does
not exist.)

Warns about: `<img>` without `alt`, `onClick` without keyboard handler,
`<input>` without label, `<button>` with no `type` inside a form, `<a onClick>`
with no `href`, a positive `tabIndex`, `aria-hidden` on something focusable,
`aria-disabled` used as if it disabled -- plus missing and duplicate keys, hooks
called in a different order than last render, a component re-rendering in a
loop, `onMount` outside a render, and server/client markup divergence during
hydration. Zero overhead in production.

Override it when you need to:

```tsx
import { setDevMode } from "aio/air";
setDevMode(true); // force on, e.g. in a production debugging session
setDevMode(false); // force off
setDevMode("auto"); // back to following __aioDev (the default)
```

`setDevMode(true)` additionally stamps `data-component="Name"` on each
component's root element. That one is opt-in rather than ambient because it
CHANGES the DOM, and SSR does not write it -- armed by default, every hydrated
component would look like a server/client divergence.

---

## Custom Adapters

Build adapters for any framework using `aio/state-core`:

```ts
import {
  getCellSignal,
  getStateSignal,
  handleMessage,
  ready,
  send,
  setTransport,
} from "aio/state-core";
```

**Minimal contract:** `getCellSignal()` for cell state, `getStateSignal()` for
full state, `send()` to dispatch, `setTransport()`/`handleMessage()` to wire a
custom transport, `ready()` for the first-state gate. (This IS the supported
`aio/state-core` surface — everything else on the entry is framework wiring,
`@internal` since alpha52.)

### Svelte 5 (Runes)

```svelte
<script>
  import { getStateSignal } from 'aio/state-core'
  const sig = getStateSignal()
  let state = $state(sig.peek())
  $effect(() => { return sig.subscribe(() => { state = sig.peek() }) })
</script>
<button onclick={() => send({ type: 'counter:increment', payload: {} })}>
  Count: {state?.counter?.count ?? '...'}
</button>
```

### Vue 3 (Composable)

```ts
import { onUnmounted, ref } from "vue";
import { getStateSignal, send } from "@riagentic/aio/state-core";

export function useAio() {
  const sig = getStateSignal();
  const state = ref(sig.peek());
  const unsub = sig.subscribe(() => {
    state.value = sig.peek();
  });
  onUnmounted(unsub);
  return { state, send };
}
```

AIR is the built-in adapter. Other framework adapters are community-maintained.

---

## Offline and Reconnection

Actions dispatched while offline are queued. Auto-reconnect with exponential
backoff (1s -> 30s max). On reconnect, server sends full state. Use
`useConnected()` for UI feedback. `send()` works online and offline.

## Electron / Desktop

Same code runs in Electron. AIO uses IPC instead of WebSocket -- transparent to
components.

## Modal / Dialog with focus trap (recipe)

AIR ships `Portal` but no `<Dialog>` primitive — modal focus management is a
recipe so you keep full control of markup and styling. This one handles the
whole keyboard/a11y class that's easy to get wrong: focus moves into the dialog
on open, `Tab`/`Shift+Tab` cycle **within** it, `Escape` closes, and focus
returns to the trigger on close. The parent mounts it conditionally
(`{open && <Modal…>}`) so hooks run in a stable order.

```tsx
import { h, onCleanup, onMount, Portal, useRef } from "aio/air";

export function Modal(
  { onClose, children }: { onClose: () => void; children: unknown },
) {
  const dialog = useRef<HTMLDivElement | null>(null);

  onMount(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const root = dialog.current;
    if (!root) return;

    const focusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          "a[href],button:not([disabled]),textarea,input,select," +
            '[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);

    (focusables()[0] ?? root).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab") {
        const els = focusables();
        if (els.length === 0) return;
        const first = els[0], last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);

    onCleanup(() => {
      document.removeEventListener("keydown", onKey, true);
      trigger?.focus?.(); // restore focus to whatever opened the dialog
    });
  });

  return h(
    Portal,
    { target: document.body },
    <div
      onClick={onClose} // backdrop click closes
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.5)",
        display: "grid",
        placeItems: "center",
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()} // clicks inside don't close
        style={{ background: "#fff", padding: "1.5rem", borderRadius: 8 }}
      >
        {children}
      </div>
    </div>,
  );
}
```

Usage — mount only while open, and wrap inputs in a `<form>` so **Enter
submits**:

```tsx
{
  open && (
    <Modal onClose={() => ui.closeModal()}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save(name);
          ui.closeModal();
        }}
      >
        <h2>Rename</h2>
        <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
        <button type="submit">Save</button>
        <button type="button" onClick={() => ui.closeModal()}>Cancel</button>
      </form>
    </Modal>
  );
}
```

Notes: the capture-phase `keydown` listener means the trap works even when focus
is on the backdrop; `role="dialog"` + `aria-modal="true"` announce it to screen
readers; and returning focus to the trigger on close keeps keyboard navigation
coherent.
