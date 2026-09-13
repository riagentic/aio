# Embedding a web page (`<Browser>`)

An aio desktop app can show somebody else's page inside its own — a reader, a
docs pane, an OAuth flow, a preview of the thing your app is editing. Electron
calls that a `<webview>`; aio wraps it as `<Browser>`, with the two traps every
author meets in hour one already closed.

## Turn it on

```ts
await aio.run({ cells, childWindows: true });
```

`<webview>` rides the same opt-in as `openWindow`, because they are the same
decision: **render remote content inside the app**. Without it the tag does not
render at all — not an error, just nothing, which is worth knowing before you
spend an afternoon on your CSS.

## Use it

```tsx
import { Browser } from "aio/ui";
import { reader } from "./cell.ts"; // a cell with `url` and `setUrl`

export default function App() {
  return (
    <Browser
      src={reader.url}
      keepAlive="reader"
      partition="persist:reader"
      onNavigate={(url: string) => reader.setUrl(url)}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
```

| Prop         | What it does                                                                          |
| ------------ | ------------------------------------------------------------------------------------- |
| `src`        | The page. Changing it navigates; re-rendering with the same value does nothing        |
| `keepAlive`  | Keep the guest alive across unmounts, under this id                                   |
| `partition`  | Which session (cookies, storage) the guest uses — two with the same one share a login |
| `onNavigate` | Called with the URL the guest landed on, including in-page navigations                |
| `ref`        | The element itself, for everything Electron documents that this does not wrap         |

## The two traps

### A reactive `src` is an infinite navigation loop

Written as an ordinary attribute, `src={state.url}` is re-applied by the
renderer on every pass. Setting `src` on a `<webview>` **navigates**; navigating
fires `did-navigate`; an address bar naturally writes that back to state; state
re-renders; the render sets `src` again. The page flickers and never settles,
and nothing in the stack says why.

`<Browser>` sets the URL imperatively and only when it actually changed, so the
`onNavigate` → state → `src` cycle that looks so obviously wrong is exactly what
you are supposed to write.

### Unmounting destroys the guest — and its login

A `<webview>` removed from the document is destroyed by Electron, taking the
page's scroll position, its form state and its **session** with it. So a tab
switch, or a `{visible && <Browser/>}`, silently signs the user out of the page
they were reading.

`keepAlive="reader"` parks the element instead of dropping it, and hands the
same guest back the next time a `<Browser>` mounts with that id. Without it you
get Electron's default, which is destruction.

## What is not wrapped

Everything else. `<Browser>` renders a plain `<webview>`, so the whole Electron
API is still true and still reachable:

```tsx
let guest: HTMLElement | null = null;
<Browser src={url} ref={(el) => (guest = el)} />;
// …later
(guest as any)?.openDevTools();
```

`goBack`, `goForward`, `reload`, `stop`, `executeJavaScript`, `insertCSS` — all
of them are the guest's, documented by Electron, and unchanged.

## Security

You are rendering a page you do not control, inside your app's window. Two
things follow:

- **`partition`** is how you keep it out of your own session. A `persist:`
  prefix survives restarts; without one, the guest gets a fresh session each
  launch.
- The guest **cannot reach your cells**. It runs in its own process with no
  preload, no `nodeIntegration` and no aio client — the only channel between you
  and it is the props above.
- A guest **cannot get Node back**, whatever its tag says. Electron copies the
  app window's `sandbox`, `contextIsolation` and `nodeIntegration: false` onto
  every guest, so a hand-written
  `<webview nodeintegration
  webpreferences="sandbox=no">` still gets none of
  them, and a `preload` on it runs sandboxed, with no `fs` (measured on Electron
  44).
- **Injecting a provider into a page** (a wallet connector, say) is
  `__aioIPC.openWindow(url, { preload })`: a child window, not an inline guest,
  gated by `childWindows`. The preload must live inside the app directory
  (symlinks are resolved first), and the sandbox stays on unless you pass
  `sandbox: false`. A refused request logs which rule it broke.

## See also

- [Electron client](electron.md) — windows, `childWindows`, `openWindow`
- [The default theme](../ui/theme.md) — `ui.chrome`, and the frame around it all
