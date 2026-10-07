# Embedding a web page (`<Browser>`)

An aio desktop app can show somebody else's page inside its own — a reader, a
docs pane, an OAuth flow, a preview of the thing your app is editing. Electron
calls that a `<webview>`; aio wraps it as `<Browser>`, with the two traps every
author meets in hour one already closed.

## Turn it on

```ts
await aio.run({ cells, electron: { webviewTag: true } });
```

`electron.webviewTag` enables the tag and nothing else. `childWindows: true`
enables it too, together with `__aioIPC.openWindow`; use that one only if the
app opens child windows as well. Without either the tag does not render at all —
not an error, just nothing, which is worth knowing before you spend an afternoon
on your CSS.

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

| Prop         | What it does                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `src`        | The page. Changing it navigates; re-rendering with the same value does nothing                         |
| `keepAlive`  | Reopen the page the guest was on after an unmount, under this id                                       |
| `partition`  | Which session (cookies, storage) the guest uses — two with the same one share a login                  |
| `preload`    | A script run in the guest before its page — `guestPreload("…")`, see [below](#a-preload-for-the-guest) |
| `onNavigate` | Called with the URL the guest landed on, including in-page navigations                                 |
| `ref`        | The element itself, for everything Electron documents that this does not wrap                          |
| `hostKeys`   | Keys the guest hands back to the app, even from inside its iframes — `["Escape"]`                      |
| `onHostKey`  | Called with each relayed key: `{ key, code, ctrlKey, shiftKey, altKey, metaKey, repeat }`              |

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

## A preload for the guest

A guest preload is a script Electron runs inside the embedded page before the
page's own — how an app injects a provider (a wallet connector, a reader mode)
and hears back from it (`ipcRenderer.sendToHost`). It is a **file Electron opens
from disk**, so the package has to carry it and the window has to agree it is
yours. Declare it, then name it:

```jsonc
// deno.json — paths are relative to this file
"build": { "guestPreloads": ["src/guest/preload.cjs"] }
```

```tsx
import { Browser, guestPreload } from "aio/ui";

export default function App() {
  return (
    <Browser
      src="https://example.com/"
      preload={guestPreload("src/guest/preload.cjs")}
    />
  );
}
```

On a hand-written `<webview>` the same value goes in its `preload` attribute,
and `__aioIPC.openWindow(url, { preload: guestPreload("…") })` takes it for a
[child window](electron.md#child-windows-openwindow).

`guestPreload()` takes the path **exactly as declared** and returns the same
name in `deno task dev` and in every package (AppImage, Windows exe and zip,
macOS app) — the window maps it onto the file wherever that run keeps it: your
project in dev, the package's own copy when built. Never build a `file://` path
to it yourself: it points into your source tree, which a packaged app does not
have.

- **Only declared files load by name.** An undeclared `guestPreload("…")` is
  refused when the guest attaches — in dev too, so it cannot work on your
  machine and fail in the package.
- **The build checks it.** A declared file that does not exist stops the build,
  naming it. So does a literal `guestPreload("…")` in your source that is not
  declared. A `<webview>`/`<Browser>` whose `preload` is a literal path
  (`preload="file://…"`) gets a warning on an Electron build, with the
  declaration to add.
- **A refusal is loud.** The guest still loads — with no preload and no bridge —
  and the reason goes to the app's log (`am logs`, `logs/app.log`) as
  `<webview> preload REFUSED: …` with the fix, and to the page as an
  `aio:guest-preload-refused` event on `window`:

  ```ts
  addEventListener("aio:guest-preload-refused", (e) => {
    const { preload, reason } = (e as CustomEvent).detail;
    showBanner(`The embedded page has no bridge: ${reason}`);
  });
  ```
- A declared path is plain: `/`-separated segments of letters, digits, `.`, `_`
  and `-`, relative to the deno.json — no `..`, no absolute path.
- The preload runs **sandboxed**, with `contextIsolation` on and no Node
  (`require("electron")` gives it `ipcRenderer` and `contextBridge`, not `fs`).
  Write it as CommonJS (`.cjs`/`.js`) with no imports of your own — it is
  shipped as the file you wrote, not bundled.
- Guest preloads ship in **Electron packages** (`--electron` targets). A plain
  compiled binary launched with `--client=electron` has no files on disk beside
  it, so a guest preload is refused there, by name.

A preload inside the directory the window serves the app from still loads by its
path, as before; in a package that directory holds only aio's own bundle, which
is why the declared name is the form to use.

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

- **`partition`** is the guest's session. A `persist:` prefix survives restarts;
  without one, the session is new each launch. A guest with **no** `partition`
  that shows another site gets the session `persist:aio-webview`, never your
  app's own: a page in the app's session can read, and POST to, everything the
  app serves on `aio://app` (measured on Electron 44, from a worker too). This
  is logged once. So does one that starts on `about:blank` or with no `src`.
  `partition="persist:"` (nothing after the colon) is not a partition: Electron
  resolves it to the app's own session, so aio treats it as no `partition` at
  all. A guest with no `partition` whose `src` is your app's own origin (or a
  `data:` / `file:` URL) stays in the app's session, so a preview of your own
  route keeps working — and it **stays on your app**: its navigation to another
  http(s) site is cancelled, whether the page, a redirect or your own `src`
  change started it, and logged once per site
  (`[aio:electron] navigation BLOCKED in <webview> guest to …`). Give it a
  `partition` and it may go anywhere.
- **An `<iframe>` is not a `<webview>`.** A frame from another site inside your
  app's own window lives in the app's session: under the default policy it
  loads, and a page in it can read, and POST to, what the app serves on
  `aio://app` (measured on Electron 44). aio logs this once per site
  (`[aio:electron] an <iframe> from … loaded in the app's own window`). Embed
  another site with `<webview partition="persist:name">`, or refuse foreign
  frames altogether:
  `aio.run({ security: { cspDirectives: { "frame-src": "'self'" } } })`. The
  same holds, and is logged the same way, for a frame inside a `<webview>` that
  has no `partition` and shows your app's own page: that guest is in the app's
  session too.
- **Wipe a partition when the app locks:**
  `await __aioShell.clearPartition("persist:reader")` clears its cookies,
  storage, cache and HTTP auth. It resolves `{ ok: true, partition }` and
  rejects with the reason. An empty name and `"persist:"` are refused: both
  resolve to the app's own session, and clearing it would sign your app out.
  Only the app's own page can call it. Guests that named no partition are in
  `"persist:aio-webview"`.
- The guest **cannot reach your cells**. It runs in its own process with no
  `nodeIntegration` and no aio client, and with no preload unless you declare
  one ([above](#a-preload-for-the-guest)) — the only channels between you and it
  are the props above and what your own preload sends.
- A guest **cannot get Node back**, whatever its tag says. aio forces `sandbox`,
  `contextIsolation` and `nodeIntegration: false` on every guest when it
  attaches, so a hand-written
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
  event has no effect, and aio sets no navigation policy on guests. The page
  loads; `onNavigate` / `did-navigate` is where you learn of it, so an app that
  restricts where a guest may go steps back after the fact.
- **A guest opens no window.** Without `allowpopups` on the tag, Electron drops
  `window.open` and `target=_blank` (measured on Electron 44). With it, aio
  denies the window and hands an http(s) link to the system browser only after a
  real click or key press in the guest (within 5 s), at most one per 2 s.
  Everything else is refused and logged once per origin and reason:
  `[aio:electron] pop-up BLOCKED from <webview> guest …`.
- **A guest saves no file.** A download a guest starts is cancelled and logged
  once per origin (`[aio:electron] download CANCELLED from <webview> guest …`).
  `aio.run({ electron: { guestDownloads: true } })` allows downloads from guests
  and child windows. Your app's own page always downloads.
- **A guest gets no device.** A HID, USB, serial or Bluetooth request from a
  guest is cancelled and logged once per origin. (Your app's own page is left to
  Electron, which cancels a request nothing answers: aio has no device chooser.)
- **A guest gets no permissions.** Clipboard read, camera, microphone,
  geolocation, notifications — every one is denied to a `<webview>` guest and to
  a frame from another origin (or a `data:` URL) inside your window; only
  fullscreen is allowed. Each denial is said once per permission and origin
  (`[aio:electron] permission "clipboard-read" DENIED to embedded page …`). Your
  app's own page keeps what it had. A page that truly needs a permission belongs
  in its own window (`__aioIPC.openWindow`), where it keeps the ones asked for
  by its own origin. Set
  [`electron.permissions`](electron.md#permissions-electron--permissions-) to
  deny child windows and guests everything (fullscreen too) and give your own
  page only what you list.

## See also

- [Electron client](electron.md) — windows, `electron.webviewTag`,
  `childWindows`, `openWindow`
- [The default theme](../ui/theme.md) — `ui.chrome`, and the frame around it all
