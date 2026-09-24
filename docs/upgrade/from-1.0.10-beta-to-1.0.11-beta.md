# Upgrading from 1.0.10-beta to 1.0.11-beta

Nothing is removed and nothing changes shape. An app needs a code change only
for the items marked **Action** below.

```sh
am pin --latest
```

1.0.11 closes what 1.0.10 left open. It adds one optional argument and new
warnings, fixes a `trackedMemo` that threw stranding its readers, and makes the
release gate prove its own claims.

## New, optional

- **Route on render.** `renderToString(<App />, { route, search })` and
  `renderToStream(<App />, key, { route, search })` give a server render its own
  route: everything in it routes by that route, never by the global `routePath`
  / `routeSearch`, which it never writes (a read inside it still subscribes to
  them, so effects over the route keep their links — the value it gets is the
  render's own) — so no await, anywhere, in any number of concurrent requests,
  can make it render another request's page, and no route warning applies to it.
  Omitted, a render routes by the globals as before. It is the recommended form
  now; see [the route contract](../ui/air-advanced.md).

## What you may notice

- **Options in `renderToStream`'s key slot are refused.**
  `renderToStream(<App />, { route })` — the `renderToString` shape, options
  second — used to take the options object as the head KEY and render by the
  global route, silently. It now throws a `TypeError` naming the fix, at the
  stream's first read (like any set-up error of a stream): pass the options
  third, `renderToStream(<App />, key, { route })`, with `undefined` as the key
  if you have none.
- **A page downloads 79 KB gzipped, from 77** (renderer plus client runtime):
  the route scope that route-on-render needs costs about 1–2 KB gz, measured by
  `check:bundle-size`.
- **Upgrade `am` before you run a profile, if an older `am` is still around.**
  An `am` from 1.0.9 or earlier does not know profiles: with ONLY `myapp@dev`
  running, its `am stop myapp` stops the dev profile and `am state` reads the
  profile's data, without a word (with the default instance also up it targets
  that instance; with two profiles and no default it refuses). `am upgrade`
  first — `am version` says which one you have.
- **A server render that reads a route another request set says so.** A request
  that sets `routePath`, awaits a promise another request also awaits, then
  renders, served the other request's page in 1.0.10 without a word. The render
  is unchanged (aio cannot know which route you meant), but the first route read
  now logs `[aio] … set outside this render's synchronous step` naming the call
  site. The fix is to pass the route to the render (`{ route, search }`, above),
  or, keeping the globals, to set the route and call `renderToStream()` /
  `renderToString()` in one synchronous step. Pages that never read the route
  are never told, and it is best-effort (the gaps are listed in
  [the route contract](../ui/air-advanced.md)).
- **An effect or `watch` created in a route render that reads the route
  (directly or through a `computed`) is named.** It runs on the GLOBAL route
  (never the render's), so a value it writes for the page is the global route's.
  The line names the call site; to fix it, derive the value with `computed()` or
  `useRoute()` in the render.
- **An effect or component whose `trackedMemo` threw now recovers.** In 1.0.10 a
  memo that threw once (through a computed that threw, or on a guarded value)
  left its reader subscribed to nothing: it never ran or re-rendered again. It
  now re-runs when what the memo read changes.
- **Route warnings repeat, with a count.** They used to be said once per call
  site per process, so a busy handler went silent after its first mistake. Now
  each is said at the 1st, 2nd, 4th, 8th … hit and ends with
  `[N times at this call site; M more since the last warning]`.
- **A `listensTo` pair across the sync line is named at boot.** When one cell
  has `sync: true` and a cell it listens to (or that listens to it) does not,
  boot logs one line naming both and what differs — a sync listener's reaction
  is a server write folded into its snapshot, a plain listener of a sync cell
  reacts only once the op reaches the server. Mixed pairs keep working; the line
  only says what they do. The test harnesses say the same line.
- **No log line carries the app key.** The "Electron not installed" error, the
  Electron shell's own log lines, `--server-url`'s "connecting to" line and the
  CLI client's "a DIFFERENT app" refusal printed the URL with `?token=`. They
  now print `?token=…`. The two `share:` lines at boot still print the full link
  on purpose — that is the URL you copy.

## Action — check these first

- **An exposed HTTPS app reached by a name NOT in its certificate now answers
  403.** Over HTTP/2 — every browser on TLS — the DNS-rebinding Host gate never
  saw the name in 1.0.10, so any name passed. It now checks it like HTTP/1.1
  always did. Names in the certificate the app serves pass with no config (a
  `*.example.com` wildcard covers one label), as do localhost, IPs and this
  machine's hostname. Any other name — a reverse proxy's, a LAN alias — must be
  listed: `aio.run({ allowedOrigins: ["myapp.example.com"] })`. The 403 body
  names the exact line.
- **A binary embeds only the `*.server.ts` its entry can load**: its module
  graph, its own folder (minus another target's entry folder), and siblings of a
  module the graph reaches. A module your entry loads through an opaque
  `import(url)` from somewhere else must be listed in deno.json
  `"compile": { "include": [...] }` — dev keeps working either way, so check the
  build's `⚠ not embedding N *.server.ts …` warning.
- **A test can now go red where it passed.** A call from a disposed
  `bootCells`/`testUI` boot — an `onInit` that started a method nobody awaited,
  directly or through another cell's handle — used to write into the NEXT test's
  state; it is refused and fails loudly. An error thrown from `onInit` under
  `bootCells`/`testUI` (e.g. calling a method while the app is still booting)
  used to be only logged; it now fails the test at `settle()` / dispose, as the
  docs always said. Fix the leak or the `onInit` it names.

## What else you may notice

- **`s.$do(...)` after its method returned is refused by name.** Captured by a
  `setTimeout`/listener, stashed for a later method, or called after a
  `transaction: true` method settled, it used to run nothing, silently. Now it
  logs `[cell] method(): s.$do(...) called after the method returned` (dev and
  prod) and still runs nothing; called inside another method, it throws there.
  Fix: call `s.$do` inside the method (await the work first), or have the
  callback dispatch a method and `$do` there.
- **`concurrency: "queue"` / `serialize` start in call order.** With nothing
  queued, a queued call used to start a microtask late, so a sync call made
  right after it ran first. Code that relied on that reordering (rare, and
  unintended) now sees calls run in the order they were made.
- **`budgets.cellState` now governs persist too.** It moves the 1 MB persist
  warning, lifts the 16 MB persist error when declared above it, and a breach
  shows on `/health`. A small value declared only for the broadcast warning now
  also warns on persist.
- **Size warnings end with a `Fix:` line and a link** to
  [Legitimately large state](../persistence/big-data.md#legitimately-large-state).
  The whole-state frame each WebSocket client gets on connect (and on `resync`,
  `subs`, a user change) is now size-checked and counts toward `payload`, so an
  app with persist off can see a new warning.
- **`persist: "none"` cells are scrubbed from existing copies** on the first
  boot: `<db>.snapshot`, the update's pre-migration backup, `am backup` copies
  and `logs/actions.jsonl` (payloads). Rolling back to an older build restores
  that backup without the scrubbed slice — the point of `persist: "none"`.
- **A `worker: true` cell refuses new calls with `DISPATCH_DRAINING` during
  shutdown**, like the main dispatch; running methods still finish.
- **Standalone / Android:** an unreadable saved state is left untouched and
  nothing is saved that run (said at boot); corrupt state is copied to
  `<key>.corrupt-<ms>` before anything is written. A `MainActivity.kt` overlay
  without `AioNativeStore` or the insets frame warns at build time; a
  third-party `<iframe>` in a standalone APK is reported once per origin.
- **`testCell` says once that it does not run `onInit`** — use
  `bootCells`/`testUI` to run it.
- **`am`:**
  - `am stop` waits until the process is gone (`--no-wait` for the old return);
  - `am start --app=<component>` starts that component's own entry (it ran the
    project's default entry under the component's id);
  - `am restart` replays `--entry`, and never stops an app it cannot start;
  - `am start`/`restart` follow a socket-only app, and name its socket;
  - a multi-component project accepts `help`, `--version`, `start`, `stop`,
    `restart`, `status`; a component's app id is the one it runs under, so two
    components without an `appId` are refused up front;
  - `am upgrade` refuses an aio copy nested inside another repo, `am` never runs
    git in a repo that is not its own (hooks included), and `am fix` leaves a
    nested app's parent `dep/aio` alone;
  - `am pin --json` adds `offMain`/`latestNote`;
  - a failure prints exactly one error document.
- **An old dev checkpoint is INFO, not WARN, when the app has no
  `onCheckpointRestore`.** A "zero warnings" check stops tripping after a break.
- **`am trigger` finds a handle by name** when exactly one live element has it
  (as `testUI` does); `am create` takes `--client=` (`--target=` still works);
  `deno task doctor` warns when `deno.lock` lacks entries for aio's own tools —
  run `am fix` and commit the lock.
- **A budget warning is logged at WARN** in the log files too (it was an ERROR
  there), and a headless server no longer prints the theme line.

## Retire

If you wrapped a `trackedMemo`'s body in `try`/`catch` only so its readers would
keep updating, that wrapper is no longer needed. If you filtered `?token=` out
of your own log shipping for the lines above, that filter is no longer needed
for them (the `share:` lines still carry the key).
