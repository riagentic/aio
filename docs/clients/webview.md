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

| Prop         | What it does                                                                              |
| ------------ | ----------------------------------------------------------------------------------------- |
| `src`        | The page. Changing it navigates; re-rendering with the same value does nothing            |
| `keepAlive`  | Reopen the page the guest was on after an unmount, under this id                          |
| `partition`  | Which session (cookies, storage) the guest uses — two with the same one share a login     |
| `onNavigate` | Called with the URL the guest landed on, including in-page navigations                    |
| `ref`        | The element itself, for everything Electron documents that this does not wrap             |
| `hostKeys`   | Keys the guest hands back to the app, even from inside its iframes — `["Escape"]`         |
| `onHostKey`  | Called with each relayed key: `{ key, code, ctrlKey, shiftKey, altKey, metaKey, repeat }` |

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

### Unmounting destroys the guest

A `<webview>` that leaves the document is destroyed by Electron, and so is one
that is only MOVED within it (measured on Electron 44) — the page's scroll
position, its form state and its JS state go with it. So a tab switch, or a
`{visible && <Browser/>}`, brings the user back to `src`, not to the page they
had browsed to.

`keepAlive="reader"` remembers where the guest was, and the next `<Browser>`
that mounts with that id opens there — unless the app changed `src` in the
meantime, which wins. It cannot keep the scroll, the forms or the JS state: no
guest survives an unmount. Cookies, and so a cookie-based login, are the
`partition` session's, not the guest's, and survive either way.

## Keys the guest gives back (`hostKeys`)

While focus is inside a guest, its keys go to the guest — and while it is inside
an **iframe within** the guest (a video embed, a captcha), nothing of yours can
see them at all, preload included. So "Escape always gives the keyboard back"
fails exactly when the user needs it. Declare the keys the app must always get:

```tsx
<Browser
  src={reader.url}
  hostKeys={["Escape"]}
  onHostKey={(k) => k.key === "Escape" && closeReader()}
/>;
```

- Each declared **keydown** arrives as `onHostKey`, and as a bubbling
  `aio:hostkey` event (a `CustomEvent` whose `detail` is that object) on the
  `<webview>` element — so a plain `<webview data-aio-host-keys='["Escape"]'>`
  works too.
- Matched on `KeyboardEvent.key`, exactly (`"Escape"`, `"F1"`, `"a"` ≠ `"A"`),
  whatever modifiers are held; the modifiers are in the event.
- The guest **still receives** the key: this relays, it does not steal.
- 1–16 keys: `<Browser>` throws on anything else, and a malformed hand-written
  attribute is ignored with a warning naming it. The list is read once, when the
  guest attaches.
- Secure by construction: the main process reads the guest's real input
  (`before-input-event` — a page cannot synthesize it) and filters it there, so
  an undeclared key never leaves the main process, and the guest page gets
  nothing — no preload, no API, no sign that it is being listened to.

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
  `sandbox: false`. A refused request logs which rule it broke. A child window's
  preload has no channel back to the app; one that must answer the app (a
  signing request) belongs in a `<webview>` guest, whose preload reaches the
  host with `ipcRenderer.sendToHost`.
- **A guest's navigation cannot be refused from the renderer.** Electron
  documents that `event.preventDefault()` on a `<webview>`'s `will-navigate`
  event has no effect, and aio sets no navigation policy on guests (only their
  popup policy: `target=_blank` opens http(s) in the system browser). The page
  loads; `onNavigate` / `did-navigate` is where you learn of it, so an app that
  restricts where a guest may go steps back after the fact.
- **A guest gets no permissions.** Clipboard read, camera, microphone,
  geolocation, notifications — every one is denied to a `<webview>` guest and to
  a frame from another origin (or a `data:` URL) inside your window; only
  fullscreen is allowed. Each denial is said once per permission and origin
  (`[aio:electron] permission "clipboard-read" DENIED to embedded page …`). Your
  app's own page keeps what it had. A page that truly needs a permission belongs
  in its own window (`__aioIPC.openWindow`), where it keeps the ones asked for
  by its own origin.

## See also

- [Electron client](electron.md) — windows, `childWindows`, `openWindow`
- [The default theme](../ui/theme.md) — `ui.chrome`, and the frame around it all
