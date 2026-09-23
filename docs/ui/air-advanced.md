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

**A routed app** renders the route in `routePath` — set it from the request
before rendering. `<Route>`, `useRoute` and `<Link>` need no runtime on the
server, and context Providers (the route context, your own) reach their children
exactly as they do in the browser:

```tsx
import { collectHead, renderToString, routePath, routeSearch } from "aio/air";
import App from "./App.tsx";

Deno.serve((req) => {
  const url = new URL(req.url);
  // Both signals, or `useRoute().search` is empty on the server and full in
  // the browser — a page that hydrates into different markup than it shipped.
  // `routePath` is the PATHNAME only: the query lives in `routeSearch`.
  routePath.set(url.pathname);
  routeSearch.set(url.searchParams);
  const body = renderToString(<App />);
  return new Response(
    `<!doctype html><head>${collectHead()}</head><body>${body}</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
});
```

### renderToStream()

Streaming SSR -- yields HTML chunks as an async generator.

**The route contract.** `routePath` / `routeSearch` are ONE pair of signals
shared by every request in the process. The only safe way to use them on a
server that handles requests concurrently: **every request sets the route and
calls `renderToStream()` / `renderToString()` in one synchronous step — no
`await` between the set and the call, on ANY request.** Then each render takes
its own request's route when it is called, and keeps it however long its body
takes and whatever else the handler awaits before sending it.

When any request breaks that — sets the route, then awaits, then renders —
another request's render can read the route it left behind: a stream re-reads
the route once, at the end of the synchronous turn it was called in (so that
code creating the stream first and setting the route right after keeps working,
as in 1.0.9), and two requests resumed by one shared promise (a config or
session cache) run in ONE turn. No timing can tell the two apart, so the one
that re-reads may render the other request's route. aio cannot prevent that; it
says so:

- `[aio] routePath changed after renderToStream() — set it BEFORE the call;
  under concurrent requests this can render another request's route (<call
  site>).`
  — whenever that end-of-turn re-read finds a different route than the call did.
  Once per call site per process.
- `[aio] renderToStream(): the route (or another request value) changed after
  renderToStream() was called, in the same turn as another render's call —
  this stream keeps the value it was CALLED with. Set routePath before
  renderToStream(), with no await in between (<call site>).`
  — the one exception to the re-read: when another top-level render set up in
  the same turn took a DIFFERENT route, the stream keeps its call-time route
  (the live one may be that render's). A live route that matches none of them is
  reported; one that matches another render's is correct concurrent code and
  says nothing. Renders that took this stream's own route do not count (two
  streams created before one `routePath.set` both re-read, as in 1.0.9). Once
  per call site per process.
- `[aio] routePath changed after renderToStream() was called and before the
  stream was first read — the stream renders the route it was CALLED with
  (1.0.9 read it at the first read). …`
  — a route set after that turn (1.0.9 code that creates the stream, awaits,
  then sets the route; or another request that set its route and is awaiting
  before its own render) is never rendered, and is reported at the stream's
  first read. Once per call site per process.

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
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      for await (const chunk of renderToStream(<App />, req)) {
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
