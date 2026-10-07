# Upgrading from 1.0.18-beta to 1.0.19-beta

Nothing is removed or renamed. The surface gains a few names — see
[What is new](#what-is-new). Most apps change nothing. An app with a desktop
(Electron) build that embeds other sites, an app whose `<webview>` uses a
`preload`, and an app with UI tests each have one thing to check — see
[What to do](#what-to-do).

```sh
am pin --latest
am fix
```

This release is about two things. The first: aio's own test suite now runs
natively on Windows 11 and on an Apple-silicon Mac, not only on Linux, and what
that found is fixed. The second: failures that showed only in `deno task dev`
and were silent in a packaged app are now said in the package too, or stopped at
build time.

## What to do

- **Your `<webview>` (or `openWindow`) uses a `preload`:** it worked in
  `deno task dev` and was dropped in every packaged build. Declare the file and
  name it with `guestPreload()`:

  ```json
  { "build": { "guestPreloads": ["src/guest/preload.cjs"] } }
  ```

  ```tsx
  import { guestPreload } from "aio/ui";

  <webview src={url} preload={guestPreload("src/guest/preload.cjs")} />;
  ```

  A build now warns about a `preload` written as a file path, and fails on a
  `guestPreload("…")` that is not declared. Details:
  [webview](../clients/webview.md).
- **Your desktop app shows other sites** in a `<webview>` or an `openWindow`
  child window: read [Embedded and child pages](#embedded-and-child-pages).
  Cookies of such pages start empty once after the upgrade.
- **You have UI tests (`testUI`):** a call from a component, a handler or the
  test body now reaches the method the way a real server receives it. A test
  that passed a `Date`, a `Map`, a `Set` or a class instance to a method now
  fails and names the argument — see [Testing](#testing).
- **Your app pins its own `esbuild`, `happy-dom` or `electron`:**
  `am pin
  --latest` moves the first two; `am fix` aligns Electron. An app that
  keeps the old pins still builds and tests — see [Packages](#packages).
- **Your server code reads a file beside itself**
  (`Deno.readTextFile(new URL("../style.css", import.meta.url))`): a compiled
  build now stops when that file is not in the binary, and prints the
  `compile.include` line to add. The read used to fail at run time, in the
  binary only.
- **You script `am discover`:** it exits 1 when the probe could not be sent (it
  used to print "no aio apps found" and exit 0).

Everything else needs nothing.

## What is new

| Name                                      | What it is                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `build.guestPreloads` (deno.json)         | The guest preload files an Electron package ships                                |
| `guestPreload(path)` (`aio/ui`)           | The name of a declared guest preload, the same in dev and in a package           |
| `electron: { webviewTag: true }`          | `<webview>` without `openWindow` (`childWindows: true` still turns on both)      |
| `electron: { guestDownloads: true }`      | Lets guests and child windows download                                           |
| `openWindow(url, { partition, origins })` | The child window's session, and (opt-in) the only origins it may navigate to     |
| `__aioShell.clearPartition(name)`         | Clears a guest session's cookies, storage and cache (for "lock" in an app)       |
| `workerRespawn: true` (cell)              | A crashed `worker: true` cell is started again                                   |
| `crashWorker(cell)` (`aio/testing`)       | Crashes a worker cell in a test                                                  |
| `deno task build --smoke` / `build.smoke` | Starts each built artifact and fails the build when it does not come up clean    |
| `// aio-ok(read): <why>`                  | Marks a file read the build check should not judge                               |
| aiol: hook order                          | A state hook after an early `return`, behind a condition or in a loop is flagged |

## Embedded and child pages

A field report audited what a third-party page can do inside a desktop app. The
window now treats such pages as outsiders. What an existing app can notice:

- **A child window (`openWindow`) has its own session, `persist:aio-child`.** It
  shared the app's session, where a page can reach the app's own `aio://` pages.
  Its cookies and logins start empty once and are kept from then on.
  `openWindow(url, { partition: "persist:name" })` chooses another session; a
  name without `persist:` is kept in memory only. A name that resolves to the
  app's own session (`"persist:"` alone) is refused.
- **A child window navigates as before** — to any site, so a login flow that
  crosses origins keeps working. Only the app's own scheme (`aio:`) and `file:`
  are refused there. `openWindow(url, { origins: ["https://id.example"] })` is
  the opt-in that keeps a window on the listed origins and the one it was opened
  on.
- **A `<webview>` with no `partition` that shows another site lives in
  `persist:aio-webview`**, for the same reason. Its cookies start empty once. A
  `<webview>` that sets `partition` is unchanged.
- **A `<webview>` with no `partition` that shows the app's own pages** cannot
  navigate to another site; the attempt is logged with the fix (give it a
  `partition`).
- **Downloads started by a guest or a child window are cancelled** and logged.
  `electron: { guestDownloads: true }` allows them. The app's own page is
  unchanged.
- **A link a guest or a child window opens in the system browser** needs a real
  click or key press in that page, and at most one opens every 2 s.
- **A child window that calls `window.open`** gets no new window; an http(s)
  target goes to the system browser under the rule above.
- **Only the app's own window is "the app".** Another window showing the app's
  origin no longer gets the app's permissions.
- **Device pickers** (HID, USB, serial, Bluetooth) asked for by a guest or a
  child window are refused and logged. The app's own page is unchanged: Electron
  answers its request as it did (no device, aio has no chooser).
- **Not changed, and now said:** a foreign `<iframe>` placed directly in the
  app's own window shares the app's session. The window logs one line per site
  naming the two ways out — a `<webview>` with a `partition`, or
  `security: { cspDirectives: { "frame-src": "'self'" } }`.

Every refusal above reaches `app.log` by name. Details:
[electron](../clients/electron.md), [webview](../clients/webview.md).

## Said in a release build too

Each of these was a line in the dev console and nothing at all in a packaged
app:

- **A component whose hook count changes between renders** (a hook after an
  early `return`) read another hook's state. A production page now logs one
  error per component. The new aiol rule finds these before they run: `am lint`.
- **`onMount`, `onCleanup`, `onUnmount` or `useHead` called outside a render**
  was dropped. Logged once.
- **A call whose arguments JSON cannot carry intact** (a `Date`, a `Map`) is
  logged once per method by a production client. What is sent is unchanged.
- **A refused guest preload** carries the fix in its log line, and the page
  receives an `aio:guest-preload-refused` event.

## Testing

- **`testUI` calls cross the wire.** A cell method called from a component, a
  handler or the test body receives its arguments as a real server does:
  JSON-decoded. A call whose arguments JSON changes (`Date`, `Map`/`Set`, a
  class instance, `NaN`, a function, or an `undefined` argument or array slot,
  which arrives as `null`) fails the test and names `cell.method()`, the
  argument path (`args[1].when: Date → string`) and what to send instead. Such a
  test was green over a call the app sends changed. An optional field left
  `undefined` (`add({ text, due })`) is fine: the key arrives absent, as in the
  app. Awaited return values are JSON too. `testCell`, `bootCells` and calls
  between cells are unchanged.
- **happy-dom is 20.** `testUI` makes its window with the framework's own
  happy-dom, whatever the app pins. Two things differ from 17: a `<script>` in
  rendered HTML is not run, and the parser closes a `<p>` at a nested `<div>` as
  a browser does — server HTML of that shape is a hydration mismatch, in the
  test as in the browser.
- **Contrast and selector audits run on every mount.** They ran only for an app
  with cells, so a second cell-less mount in the same file was not checked.
- **`history.back()` after a `#hash` change** lands where a browser lands.
- **`afterRender` does not run for a component that was discarded** — by an
  error boundary, a failed hydration, or a removal in the same pass.

## Packages

| Package   | Was    | Is      |
| --------- | ------ | ------- |
| esbuild   | 0.24.2 | 0.25.12 |
| Electron  | 44.4.1 | 44.5.1  |
| happy-dom | 17.6.3 | 20.14.5 |

- An app whose deno.json still says `esbuild@0.24.2` or `happy-dom@^17` builds
  and tests as before: the framework loads its own.
- An app whose deno.json says `electron@44.4.1` builds with 44.5.1 and says so
  in one line that names `am fix`. `am doctor` has the same line.

## Windows and macOS

- **Windows: an app installed by an older one-click `.exe`** gets its Start-menu
  shortcut at its next start, once, so the download can be deleted.
  `"build": { "windows": { "shortcut": false } }` is honoured.
- **A process number reused by another program** no longer reads as the running
  app: a lock records when its process started, on Windows and for local
  connections on macOS as on Linux. Lock files written by an older aio are
  judged as before.
- **Windows: `am kill --stale`** checks what the process is before ending it.
- **macOS: a database snapshot through a symlinked folder** works; **Windows: a
  file that failed to open as a database** is released.
- **macOS: a root certificate whose key cannot be loaded** (made by aio 1.0.6 or
  older on a Mac) is replaced, with a warning that names `am trust`.
- **macOS: the "Move to Applications?" question** closes when the app stops.
- **Android builds started on a Windows host** start `gradlew.bat`.

## Running an app

- `am restart` no longer reports "started" for a launch that lost to another
  one; it names the launch that holds the app.
- A client that floods a WebSocket, or speaks an old protocol, is told why it
  was closed even while it is still sending.
- `am discover`, and the desktop client's own search, say when the probe could
  not be sent (on macOS: the Local Network permission).
- Steady memory pressure is logged once, and again when it gets worse.
  `onMemoryPressure` still runs every interval.
- The boot report's row for the `am` port is labelled `control` (was `trojan`).
- A journal tail replayed by start after start with no save in between is
  counted against the replay ceiling; at the ceiling one start is refused, by
  name, and the next one replays.
- A build that was interrupted while it had packages set aside is repaired at
  the next start from source.
- **A sync app killed in the instant it refused a change** no longer refuses to
  boot: that change is removed at the next start, with one warning. The database
  gains one nullable column (`sync_ops.settled`); an older aio still opens it. A
  row left this way by an older aio still stops the start, and the message gives
  the one-line repair. An app that sets `PRAGMA synchronous = FULL` pays a
  second sync per accepted change; the default setting pays nothing measurable.
  See [CRDT](../persistence/crdt.md).
- Several copies of an app started at once no longer fail on the lock folder (a
  macOS race), and an app can no longer end up with its lock where `am` does not
  look.
- The record of the installed version is written whole, so a reader never sees
  it empty.

## Retire

- **A script that copies a guest preload into a built package**, or a `preload`
  path computed from the working directory: `build.guestPreloads` and
  `guestPreload()` replace both.
- **A source scan for hooks after an early return**: the aiol hook-order rule
  does it.
- **A UI test that checks call arguments by hand for `Date` or `Map`**: `testUI`
  fails on them.
- **A release step that starts the built app to see whether it comes up**:
  `deno task build --smoke`.

The full list is in [the changelog](../../CHANGELOG.md).
