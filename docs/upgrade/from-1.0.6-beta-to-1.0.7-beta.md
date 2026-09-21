# Upgrading from 1.0.6-beta to 1.0.7-beta

**The public surface is additive only** — nothing was removed and no signature
changed.

```sh
am pin --latest
```

This release is a security audit of the packaged desktop app — done against a
wallet, where a leaked key is money — plus the field reports that came in after
1.0.6-beta, and a verify round that attacked every one of those fixes and found
fourteen more bugs inside them.

**Almost every app needs no code change.** There is exactly one shape that now
refuses to boot — a `visible`/`persist` filter written as a string instead of a
list — and an app in that position was silently broadcasting the field it meant
to hide.
[Jump to it](#a-boot-that-now-refuses-a-filter-list-that-is-not-a-list); the fix
is a pair of brackets.

Everything else here closes a door that should never have been open. The full
account is `CHANGELOG.md`.

## A packaged Electron app: three doors are now shut

| what used to happen                                                                                                     | now                                                                                                   | what to do                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the state-snapshot route answered in a PACKAGED build, not only in dev                                                  | it is dev-only                                                                                        | nothing, unless you were fetching it from a shipped app — expose a METHOD that returns what you need, screened by `visible`. (`am state` is not the answer: the trojan route it reads is dev-only too) |
| the Content-Security-Policy never reached the packaged renderer (it was sent as a header the `file:`-like load ignored) | it is a `<meta>` in the shell, so it applies                                                          | if your UI loaded a script or style from somewhere else, name that origin in your CSP                                                                                                                  |
| `openWindow({ sandbox: false })` from the renderer opened an UNSANDBOXED child window                                   | the renderer cannot ask for that. The APP decides, with `electron: { unsandboxedChildWindows: true }` | add the key if you genuinely need one — the refusal names it                                                                                                                                           |
| `AIO_ELECTRON_ARGS` forwarded any switch Chromium would parse, `--no-sandbox` included                                  | it is an ALLOW-LIST; anything not on it is refused by name                                            | if you passed a switch for a real reason, say which — an allow-list entry is a one-line change                                                                                                         |
| the preload script was written 0644 at a predictable path                                                               | it is written mode 0600 into a private `mkdtemp` directory                                            | nothing, unless something of yours read that path — it moves per run by design                                                                                                                         |

Two new keys, both optional and both defaulting to today's behaviour:

```ts
aio.run({
  cells: [wallet],
  electron: {
    requireSandbox: true, // refuse to open rather than open unsandboxed
    unsandboxedChildWindows: false, // the default: the renderer may not ask
  },
});
```

`requireSandbox` is worth knowing about. On a kernel that restricts unprivileged
user namespaces — Ubuntu 24.04+, and every container — Chromium aborts unless
`chrome-sandbox` is setuid-root, so aio adds `--no-sandbox` and warns. That
stays the default, because the alternative is an app that does not start.
`requireSandbox: true` says your app would rather not open at all; the refusal
names the two commands that make the sandbox usable.

## Four smaller Electron changes you may notice

| what changes                                                                                                                                                  | what to do                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `electron: { requireSandbox: true }` on a host where the sandbox is unusable now EXITS the process (code 1) instead of leaving the server running window-less | nothing — that is what the key asks for. Drop the key to keep serving                      |
| `AIO_ELECTRON_ARGS` refuses a token containing a control character, naming it                                                                                 | nothing; such a token could never be spawned at all                                        |
| a lock/socket directory that is a SYMLINK owned by another user is refused (it falls back to `<base>/aio-u<uid>`, loudly)                                     | nothing. A symlink you own still works                                                     |
| `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` are removed from the window's environment, each named in the log                                                    | nothing, unless you set one on purpose — for an aio app neither has a working use          |
| the packaged window's `<meta>` CSP no longer prints `frame-ancestors` / `report-uri` / `sandbox`                                                              | nothing. They were ignored there and logged a Chromium error; the HTTP header is unchanged |

## `eval` no longer runs in your pages (`script-src`)

The default policy (`security.csp: "basic"`) now carries one more directive:

```
script-src * data: blob: 'unsafe-inline' 'wasm-unsafe-eval'
```

It names every source a page could already reach — every http(s) URL, the
document's own scheme (`aio://app/app.js` in a packaged window), `data:`,
`blob:`, inline scripts and `on…=` handlers, and WebAssembly — and withholds
exactly one capability: `'unsafe-eval'`. So `eval("…")`, `new Function("…")` and
`setTimeout("…")` stop working, in the browser and in the packaged app
identically.

**What to do:** nothing, unless your app or a library it loads evaluates
strings. If it does, you will see it under `deno task dev` — the policy is the
same in dev and in a build, on purpose. Give the capability back by name:

```ts
aio.run({
  cells: [app],
  security: {
    cspDirectives: {
      // either drop the directive entirely…
      "script-src": false,
      // …or keep it and re-add just the one thing:
      // "script-src": "* data: blob: 'unsafe-inline' 'unsafe-eval'",
    },
  },
});
```

**Why:** Electron's renderer check is literally "does `eval` still run", so
every packaged aio app printed
`Electron Security Warning (Insecure Content-Security-Policy)` at every launch —
including in production, because the promise in that message ("will not show up
once the app is packaged") is not true for an app that runs the stock `electron`
binary. The `<meta>` CSP this release added did not silence it; this does, by
removing the cause rather than the message.

## The `Invalid guestInstanceId` line after a `<webview>` close is annotated

Electron throws `Uncaught Error: Invalid guestInstanceId: N` from its own
isolated-world bundle every time a `<webview>` is detached
([electron#53989](https://github.com/electron/electron/issues/53989)). It was
reaching `errors=N` and lighting the dev overlay's error badge, permanently, for
something no app did and no page can prevent.

It is now recognised — by message **and** by source file, both anchored — and
logged at **info** with the issue number and one sentence of explanation. It no
longer counts as a problem with your app; the dev overlay lists it as a muted
notice instead.

**What to do:** nothing. If you were filtering that line yourself, you can stop.
An error with the same wording thrown from your OWN bundle is untouched and
stays loud. Details in
[the Electron client docs](../clients/electron.md#the-invalid-guestinstanceid-line-after-closing-a-).

## A macOS `.app` now refuses updates instead of breaking itself

An installed macOS bundle used to report itself as an `"binary"` install, which
meant it would ACCEPT a plain-binary release and rename it over
`Contents/MacOS/<exe>` — a file inside a signed bundle. The result is an app
macOS will not open.

It now reports `"macos-app"`, installs nothing, and answers a newer release with
the download link and the manual step (drag the new app into `/Applications`;
your data lives in `~/Library/Application Support` and is kept) — the same shape
Android already had. `aio ship` still refuses a `.dmg`, and a real in-place
strategy for a signed bundle is tracked in `todo.md`.

**What to do:** nothing in code. If you ship a macOS app, tell your users the
update is a download, not a button.

## Reclaiming the Electron runtime cache: `am prune`

`~/.cache/aio/tools/electron/` keeps one 250–370 MB directory per Electron
version and platform and never removed one — 7.7 GB across 32 entries on the
machine this was found on.

```sh
am prune          # REPORT ONLY: every entry, its size, and why it stays or goes
am prune --yes    # delete exactly what that report named
```

Nothing is automatic and nothing is deleted without having been printed first:
the cache is shared by every aio app on the machine. A launch now stamps the
runtime it used, so age is measured from USE; the version this aio ships is
never offered; `--keep=43.4.1` protects a version an app of yours is pinned to.

**What to do:** nothing. Run it when you want the disk back.

## `access:` no longer stops one cell calling another

A cell whose method calls another cell's method is the SERVER calling itself,
and the server trusts itself — the same as an effect, a schedule or `onInit`.
That origin is marked by the call path, never inferred from the transport and
never carried on an action, so no client frame can forge it.

If you have a test asserting that a cell-to-cell call is DENIED by `access`, it
will now see the call succeed. That test was pinning a bug: `access` gates calls
**over the network**, and a server-side caller was being treated as a client
because server and client share one isolate in the harness.

While you are there, two more facts worth re-reading, now stated beside both
keys: `access` gates CALLS, `visible` gates READS, and **neither implies the
other**. An "admin-only" cell with no `visible` still broadcasts its whole state
to every socket. A `visible: "none"` cell still answers every method any client
dispatches. Boot now prints a notice when a cell hides secret-shaped state and
nothing gates the call side.

### Two `access` changes that show up only in TESTS

Production is unaffected — the origin scope is installed by the `testUI`
harness, and everywhere else the check is a null test and a direct call. Under
`testUI`:

- **A component that calls a gated cell's method during its RENDER is now
  denied.** It was intermittently allowed: an async method's write commits
  synchronously, the signal flush queued the re-render from inside that commit,
  and the queued work inherited the server marker — so the component body ran as
  the server. A sync method never leaked, so the same app code could pass or
  fail depending on which it used. The boundary is the method BODY, not the turn
  it started: a call from a render, or from anything a render schedules, is
  client origin and is refused exactly as a click is.
- **An `own.set` factory or disposer calling a gated cell is now allowed.** It
  is your own server code; it was being refused because the effect manager calls
  it outside the body that emitted it.

## A boot that now REFUSES: a filter list that is not a list

The one change here that can stop an app starting, and it is deliberate.

```ts
cell("acct", { state, visible: { exclude: "secret" } }); // a string, not a list
```

That used to be **silently dropped**. The cell resolved to `visible: "all"`,
every named field went to every client, the startup report said `visible=all`,
and nothing warned. An app in this position was already leaking; it simply had
no way to find out.

`cell()` throws now, and the same shape under `cellDefaults` is a config error.
The message names the cell, what was broadcast, and the fix in your own field
name. **Wrap the value in an array** — `exclude: ["secret"]` — and the app boots
with the filter it always meant to have.

## Bug reports and time-travel carry less

A bug report or timeline export is screened through the cell's real `visible`
filter now, dot paths included — so a value your clients cannot see does not
travel in a support ticket either. If you relied on a report containing an
excluded field, read it with `am state` on the server instead.

Three more, from the verify round that attacked that fix:

- **A cell with `visible: { forUser }` is withheld from reports WHOLE**, named
  in `truncated` with a note. Such a cell is screened twice on the wire — the
  structural filter, then the per-client decision — and a `forUser`-only cell
  has no structural filter at all, so the report was carrying every user's rows.
  If you need those values, read them on the server.
- **A time-travel journal line carries the shaped slice for `onPersist` cells**,
  so replaying a jump restores what a clean restart gives. Undo used to write
  values the store has never held into the durable journal.
- **`exclude: ["a.b"]` now also hides a top-level key literally named `"a.b"`**
  — from the wire, the deltas and the store, and its boot value is restored on
  replay. The client read seam, `am surface` and the `fields` badge already
  called that field hidden and refused the read; the frame and the delta path
  shipped it anyway, so the value sat in the client's own state unreadable by
  its own component. All five seams agree now.

## `install:android` refuses a stale APK

`deno task install:android` installs; it does not build. It used to take the
newest `.apk` by timestamp without asking whether your sources had moved since,
so editing the app and running install put the PREVIOUS build on the phone —
under the same version number — and printed `✓`.

It now refuses, naming the file that changed and how long after the build:

```sh
deno task install:android --build        # build first, then install
deno task install:android --apk=app.apk  # install this exact artifact anyway
```

## If your Android app scans QR codes, add `android: { camera: true }`

Every APK used to declare `android.permission.CAMERA` and a camera
`uses-feature`, whether or not the app ever opened one. So a todo list told its
user, on the install screen and on its Play listing, that it could use the
camera — and Play flags an unused camera permission.

The declaration is now **opt-in**, default off:

```json
{
  "android": { "camera": true }
}
```

**Most apps do nothing.** Add the key only if a page of yours calls
`getUserMedia` — a QR scanner, a document capture, a photo field. Rebuild the
APK afterwards.

Nothing fails silently if you forget. The WebView denies the request and says
why, in logcat:

```
E aio: camera DENIED: this page asked for the camera, but the APK does not
  declare android.permission.CAMERA. It is opt-in: add "android": { "camera":
  true } to your deno.json and rebuild.
```

A value that is neither `true` nor `false` is refused by name at build time.
Details: [targets.md](../build/targets.md#the-camera-is-opt-in).

## A version may now say how finished it is

`deno.json`'s `version` accepts a release stage — `"1.2-alpha"`, `"1.2-beta"`,
`"1.2-rc"` — and it rides the derived build number into one string,
`1.2.345-beta`, which every reader already shared: `--version`, the boot line,
the status bar, `/__aio/health`, artifact names, the ship manifest and the
update check. Stages rank `alpha < beta < rc < release`.

Your own updates keep working: a release channel does not offer prereleases, and
every build of a staged app is one, so an install whose version carries a stage
follows its own line by default (`prerelease: false` still means no).

Nothing to do unless you want it. `"1.2-rc1"` is still refused — the build count
already numbers the build — and so is any other word. On Android, note that
`versionCode` comes from `major.minor.build` alone, so promote an rc to a
release on a later commit.

## `dist/` keeps its identity across a rebuild

The build used to rename `dist/` aside and create a fresh one. Anything holding
that directory — a `docker run -v` bind mount, a file watcher, an editor's tree,
an open `cd dist` — was silently left pointing at the old, orphaned one. The
loudest case was `am lab`: the guest's share went empty on the first rebuild and
stayed empty for the life of the lab, 404ing on a file the hand-off named.

`dist/` is emptied in place now. Nothing to do — but if you worked around this
with a `--stop`-and-restart habit after every build, you can drop it.

## An Android app's state moved to durable storage (and moves itself)

A standalone APK persisted through the WebView's `localStorage`, which commits
to disk on the WebView's own lazy schedule. Measured on an API 35 emulator: a
kill 122 ms after a change brought the app back without it, silently. At 933 ms
the same change survived, which is why every earlier test — all of which waited
— called it fine. A swipe-away, an OOM kill and a crash are all that kill.

Standalone APKs now write through a native file store: temp file → `fsync` →
atomic rename, so a change is on disk before the write returns, and the write
debounce is REMOVED rather than shortened. Re-measured: killed 52 ms after the
change, restored with it.

**Nothing to do, including for an app already installed on someone's phone.** On
the first launch after the upgrade the runtime finds the previous build's state
in `localStorage`, copies it into the durable store and says so:

```
[aio] persistence: adopted "aio:myapp" from localStorage into the native store
```

The old copy is left alone. If the copy ever fails, the app still runs on the
value it found and says that loudly instead of starting empty.

Two things to know. The bridge is installed **only** for a standalone APK — the
one shape whose WebView can never show anything but its own bundled assets — so
a `--remote` client APK and a `dev:android` build are unchanged, and the bridge
is revoked at runtime if a foreign page ever loads. And the remaining window is
named rather than implied: a committed change cannot be lost, but a kill still
loses text typed and not yet sent to a method, and an async method's work before
its next commit.

## Android builds now target SDK 35

Play wants 35+. Android 15 makes every activity edge-to-edge by default at that
target, and without a fix the page drew **under the status bar** — the app title
and the system clock on the same pixels. The WebView now sits in a frame that
carries the system bars and display cutout as padding, so the page keeps the
area it had on every API level. Nothing to do; rebuild and it is there.

## SSR: two pages rendering at once no longer share a scope

`renderToString` was always safe — it returns before anything else can start a
render. Two concurrent `renderToStream`s were not: they shared one `useId`
counter, one `useHead` collection and one open-`<select>` stack. One visitor's
title, description and canonical URL could be served inside another visitor's
page, every id after the first was a hydration mismatch, and an interleaved
stream could mark the other render's `<option>` selected.

Each render now carries its own state. Two additive, optional parameters name a
render when you need to ask about it later:

```ts
const html = renderToStream(<App />, req); // `req` — any object identifying this response
const head = collectHead(req); // …this response's head, never another's
```

Unkeyed `collectHead()` still answers for the current render and is still
correct for the documented synchronous `renderToString` pattern. What changed:
when two streams overlapped and it cannot tell which page you mean, it now
**throws** and names the fix, instead of handing you the wrong page's head.

**If you serve concurrent streams, pass the key.** If you do not, nothing
changes.

## An illegal attribute NAME is now refused on the server too

The client already threw on one; the server wrote it out. So a prop name built
from untrusted input — `{"x onload=alert(1)": 1}` — became raw HTML in the
document, where escaping the value does nothing. Both writers now enforce the
same rule (XML `Name`, exactly what `setAttribute` enforces) and throw naming
the attribute and the element, in dev and in prod alike.

Only a name a browser would have refused anyway is affected. If you spread
arbitrary keys into props, validate them before the spread.

## A hung desktop peer can no longer wedge the transport

`socketFetch` — the Electron client's request path — had no timeout, so six
never-answered requests filled the socket pool and everything after them waited
forever. It is now bounded to the **first byte** (30 s; `AIO_SOCKET_TIMEOUT_MS`
to change it), which leaves SSE, long polls and slow downloads alone: once
headers arrive the renderer owns the stream. A timeout answers 504 naming the
method, the path, the elapsed ms and the knob.

## Smaller, and nothing to do about them

- **An embedded app (`libraryMode`) survives `ulimit -f`.** The SIGXFSZ guard
  rode on the single-instance lock, which an embedded app deliberately does not
  take — so a write past the file-size limit killed the process outright, with
  no error and no final save. The guard belongs to the process, so it is held by
  every boot now, lock or no lock.
- **`onUnmount()` is new on `aio/air`** — a cleanup that runs once, when the
  component goes away, for anything a re-render must not touch. `onCleanup` in a
  component body runs on unmount AND before every re-render, which is right for
  what the body re-creates each render and wrong for a place in a queue or an
  armed timer. `aiol` flags the mistake and names this. Nothing existing
  changes.
- **`am surface` lists `submit` on a form's submit button.** It reported
  `events: []` for `<button>` inside a `<form onSubmit>` while
  `am trigger …
  click` genuinely ran the handler, so anything choosing a
  target from the surface alone read the one working button as inert.

- **`am lab` says when the guest's share is stale** instead of printing a fetch
  command that will 404 — for the cases the build cannot fix, such as a
  `rm -rf dist` or a `git clean` while the lab runs. `--json` gains
  `shareStale`.
- **`am help` is one screen.** Bare `am help` lists the 16 everyday verbs;
  `am help --commands` is the old one-line-per-command list of all 71, and
  `am help --all` is still the full text. `am help --json` gains an `everyday`
  field beside the unchanged, complete `commands`.
- **`serverUser` / `serverRequest` / `serverAuth` / `blocking` no longer break
  an Android build.** A cell module importing one of them — the shape
  `docs/auth/auth.md` itself uses — refused the APK bundle with
  `No matching export in "src/standalone-air.ts"`, an esbuild error naming an
  aio internal. The android runtime now carries the same facades the browser
  does: the import resolves, and a CALL throws, naming the runtime it landed on
  and pointing at `--android --remote`. It never answers `undefined`, which
  would read as "anonymous" in an authorization check.
- **Every hook on `aio/air` declares `@tier Core | Kit | Advanced`** in its
  JSDoc, so your editor's tooltip says whether a first app needs it.
- **The physical-proof matrix says what its gates prove.** `windows (real)` is
  `windows (lab-vm)`, because that gate checks the lab, not an app; the
  app-level rows are separate and honestly marked NO GATE. `cli (binary)` and
  `web (real-browser)` are new rows, written by gates that already ran.

## Retire

Workarounds this release lets an app delete:

- **A shim around `access` for cell-to-cell calls** — a flag on the action, an
  `as-server` hop, or a second unguarded copy of a method written so one cell
  could call another without tripping its own `access` rule. The server calling
  itself is server origin now, so call the method (1.0.7-beta).
- **Hand-stripping secrets out of a bug report or a timeline export** before
  attaching it to a ticket. The report is screened through the cell's real
  `visible` filter, dot paths included (1.0.7-beta).
- **A `stat`-the-APK step in your own install script**, or the habit of always
  passing `--build`. `deno task install:android` refuses an artifact older than
  your sources and names the file that changed (1.0.7-beta).
- **A belt-and-braces `sandbox: true` on every `openWindow` call.** The renderer
  can no longer ask for an unsandboxed child window at all; the app decides,
  with `electron.unsandboxedChildWindows` (1.0.7-beta).
- **A hand-declared copy of the `electron` config shape.** `ElectronConfig` is
  exported from `aio`, so a value lifted out of `aio.run({ … })` can be named
  instead of re-typed (1.0.7-beta).
- **A display-only version suffix.** An app appending `-alpha` to what
  `appVersion()` returns, so its UI could say how finished it was while the
  artifact names and the update check said something else, can put the stage in
  `deno.json` and delete the shim (1.0.7-beta).
- **`redactActions` entries added only to keep a `forUser` cell's rows out of a
  bug report** — that cell is withheld whole now. Keep the ones that redact an
  action for its own sake (1.0.7-beta).

Nothing else — no API was removed, so no call site has to move.
