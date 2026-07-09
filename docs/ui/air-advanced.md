# AIR Advanced Patterns

SSR, portals, islands, code splitting, virtual scrolling, dimensions, deferred
loading, accessibility, custom adapters, and framework integration.

---

## Code Splitting

```tsx
import { lazy, Suspense } from "aio/air";

const HeavyChart = lazy(() => import("./heavy-chart.ts"));

const App = () => (
  <Suspense fallback={<span>Loading chart...</span>}>
    <HeavyChart data={chartData} />
  </Suspense>
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
import { Portal } from "aio/air";

const Modal = () => (
  <Portal target={document.getElementById("modal-root")!}>
    <div className="modal">I'm rendered in #modal-root!</div>
  </Portal>
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

### renderToStream()

Streaming SSR -- yields HTML chunks as an async generator:

```tsx
import { renderToStream } from "aio/air";

Deno.serve(async () => {
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      for await (const chunk of renderToStream(<App />)) {
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

<Defer trigger="viewport" load={() => import("./heavy-chart.ts")}
  placeholder={<div>Chart placeholder</div>} loading={<div>Loading...</div>} />
<Defer trigger={2000} load={() => import("./analytics.ts")} />
<Defer trigger="hover" load={() => import("./preview.ts")}
  placeholder={<div>Hover to preview</div>} />
```

Triggers: `"viewport"` (IntersectionObserver), `"idle"` (requestIdleCallback),
`"hover"` (mouseenter), `"interaction"` (click/keydown), `"immediate"`, `number`
(setTimeout ms).

---

## Accessibility (Dev Mode)

```tsx
import { setDevMode } from "aio/air";
setDevMode(true);
```

Warns about: `<img>` without `alt`, `onClick` without keyboard handler,
`<input>` without label. Dev mode only -- zero overhead in production.

---

## Custom Adapters

Build adapters for any framework using `aio/state-core`:

```ts
import {
  createSendProxy,
  getCellSignal,
  getConnectedSignal,
  getStateSignal,
  send,
  setTransport,
  trackPath,
} from "aio/state-core";
```

**Minimal contract:** `getCellSignal()` for cell state, `getStateSignal()` for
full state, `useLocal(initial)` as framework-local state, `useConnected()` via
`getConnectedSignal()`.

### Svelte 5 (Runes)

```svelte
<script>
  import { getStateSignal } from '@riagentic/aio/state-core'
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
import { onCleanup, onMount, useRef } from "aio/air";

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

  return (
    <Portal target={document.body}>
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
      </div>
    </Portal>
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
