# Upgrading from 1.0.24-beta to 1.0.25-beta

Nothing is removed or renamed. `mod.ts` and the `deno.json` exports are
unchanged apart from additions. An app upgrades with no edit by hand; the lines
below say what a few apps (and more tests) may notice.

```sh
am pin v1.0.25-beta
am fix
```

## Can refuse what booted before

- **SQL params**: a `Date`, `Map`, `Set`, `ArrayBuffer` or nested array as a
  param, or a string passed as the whole params list, is refused by name. On
  1.0.24 these bound NULL or were split into characters. Pass scalars or
  `Uint8Array`s (`d.toISOString()`, `[str]`).
- **`users`** must be an object map (`users: []` or a string exits at boot).
- **`trustProxyHeader`** naming no valid header (a trailing space, a colon)
  exits at boot; it used to 500 every request. `true` or another non-string
  still boots with its 1.0.24 meaning and a warning; `false`/`0` means unset,
  also warned.
- **Mounts** (`assets`/`serveDirs`): a non-string dir exits at boot. A blank dir
  is skipped with a warning (it used to serve the cwd). `"media"` now means
  `/media` (it used to match nothing).
- **Build**: a missing `entry`, a per-target `ui` that names no file, or a bad
  `build.minify` fails up front. A JDK below 17 is no longer picked for Android.
- **`blobs.put()`** refuses a `File`/`Blob`, an `ArrayBuffer` or a string by
  name, with the fix (`file.stream()`, `new Uint8Array(buf)`, `TextEncoder`);
  these never worked. A `Uint8Array`, a `ReadableStream` and any async or sync
  iterable of chunks work as before.
- **`build --targets=` / `--platforms=`** names like `toString` are refused as
  unknown (they used to crash). `build.channel` that is not a channel name (`5`,
  `""`) is refused; ship, publish and the app read it one way.
- **SQL inside a callback transaction**: `tx.query`/`tx.execute` refuse `BEGIN`,
  `COMMIT`, `END` and `ROLLBACK` by name — the callback owns the transaction,
  and one of them ended it under aio's feet. `SAVEPOINT`, `RELEASE` and
  `ROLLBACK TO` still work.
- **`aio/cli` `args()`**: `--version` on a spec that declares no `version` exits
  2 (it ran the action). A spec that declares its own `version` flag parses it
  as before.
- **Android**: an `applicationId` the title cannot make is refused with the id
  it made and the `android.applicationId` fix.

## Behaviour you may notice

- **Desktop windows never open at a screen edge** — 64 px inside the work area
  (`EDGE_MARGIN`). A saved window at x = 0 had its window-manager frame at x =
  -10; an NVIDIA X driver faulted on it and took the whole desktop down (595
  crashes Xorg). A saved window as big as the screen opens smaller and
  maximized. Window and tray icons above 256×256 px are scaled to 256.
  `window-state.json` is written atomically.

- **`.zip` desktop installs update from a patch** (`am publish --patch-from=`):
  a per-file "tree" patch, measured 27 KB instead of the 175 MB zip for a
  one-line change; any mismatch downloads the whole release, said in one log
  line. Nothing to change in an app.
- **Web target: unchanged `assets` files are not downloaded again on a deploy**
  — the new build's install copies them from the previous build's cache when
  their bytes hash to the new digest (files up to 16 MiB). An update still needs
  room for both builds while it installs; a failed install now says why in the
  worker's console.

- **`aio/cli` progress/spinner now on stderr**; stdout is the program's output
  only (`tool --json | jq` no longer gets `label...` lines). On a terminal
  nothing looks different. A test reading progress from `testIO().stdout` reads
  `.stderr` now; `progress(n, { stream: "out" })` /
  `spinner(l, { stream: "out" })` keeps stdout.
- **Async methods**: writes made before an `await` commit before the next action
  or read, in program order. `Promise.all([c.inc(), c.inc()])` is now 2. One
  await gap that dispatches is several actions.
- **`throw null` / `throw undefined`** in an async method rejects the caller (it
  used to resolve).
- **Async write-sets carry the caller's user** to `beforeReduce`/`onAction`/the
  journal. A per-user guard that let them through as `user: undefined` now
  applies to them.
- **Persist excludes like `list.*.secret`** are honoured. Those values stop
  being stored and are gone after the next restart.
- **`bind()` on a number field** (`initial: 41`) with
  `<input type=number|range>` stores a number. An empty field is `NaN`, which
  travels as `null` over JSON. Check `Number.isNaN(v)`, not `v === ""`.
- **`<select defaultValue>`** picks its option on mount, the same one SSR
  picked.
- **Re-login in the same tab**: a cell the new user may not see is cleared on
  the first state. It no longer shows the previous user's data.
- **Prod restart of the same build** no longer reloads open tabs. A rebuild, or
  a new aio version, still reloads them. Dev reloads on every restart, as
  before.
- **`aio dev` / `am start`** answer a UI-less app's pages with 503 "Headless
  build", as prod does. Probe `/__aio/health`, not `/`. `testServer`/libraryMode
  keep the 200 shell and warn once.
- **`onConnect`/`onDisconnect`** on the local socket (desktop windows): still
  not called by default. New opt-in `aio.run({ localConnectHooks: true })` runs
  them there too; `user` is then `undefined`, so don't write `u!.id`.
- **Behind a trusted TLS proxy** (`trustProxyHeader` +
  `X-Forwarded-Proto: https`): cookies are `Secure`, and the OIDC `redirect_uri`
  is `https://…/__aio/auth/oidc/callback`. Register that URI at your IdP (logged
  once), or keep the old one with the new `auth.oidc.redirectUri` (sent
  verbatim). `/__aio/pair` answers `no-store`.
- **/ws**: the browser's session cookie outranks a session token in the page
  URL. Static `users:` share links are unchanged. On an app with a login flow, a
  tab signed in only by a `?token=` session link warns once and is told whose
  account it is in.
- **Static files**: the server-only deny list (`*.server.*`, dotfiles, `.ts` in
  prod) is judged on the file actually opened, including links and Windows name
  aliases.
- **Lifecycle**: a failed main module exits 1 (it used to hang). A
  `fatalOnStart` failure runs the full shutdown (state persisted), then exits 1,
  and never confirms a pending update. Calls still running at the shutdown
  deadline are rejected with `DISPATCH_CLOSED` (they used to hang).
- **CLI client / `peer()`**: `call()` after `close()` rejects (it used to hang).
  `send()` after `close()` warns. Each stream chunk restarts the ack timer. Over
  the local socket a caller's `as` identity is proven, and a refused proof
  closes that connection, logged once.
- **A lost connection** rejects in-flight calls with `code: "CONNECTION_LOST"`.
  The message is unchanged: match on `code`.
- **Updates**: an install whose folder its user cannot write reports `error`
  ("available, but this install cannot apply it") instead of `offer`. A boot no
  longer saves the channel it resolved: only `updates.setChannel()` pins one, so
  changing `--channel`/config takes effect again. A channel an older version
  saved without a mark is still used and warned about once.
- **`am start` races**: two `am start`s at once attach to the instance that
  serves (no false "already running"). `AIO_PARENT_PID` that is not a pid warns.
  Stopping one of two instances of one data home leaves the other's
  `control.key`.
- **Desktop (Linux)**: each app window carries its own class (the app id), the
  same as `StartupWMClass` in its `.desktop` entries, so the dock groups it
  under the app (it was `electron`). A pin made against the old class may need
  re-pinning. A window left with Electron's default icon says why in the log. A
  GTK splash no longer crashes the process ~1 s after it closes.
- **Desktop (Windows)**: the Start-menu shortcut and the app now carry an
  AppUserModelID, so the taskbar button names the app (it said "Electron"). A
  taskbar pin made by 1.0.19 or older may need re-pinning once. `am stop` on a
  packaged app with no TCP port now stops it gracefully (`onStop` runs) instead
  of killing it.
- **New: `appIcon()` effect**
  (`s.$do(appIcon({ window, tray, tooltip, fps }))`): change the tray/window
  icon and tooltip at run time, frames for an animation; over-size or bad images
  are refused loudly.
- **Desktop (Linux, AppImage)**: an AppImage run without FUSE (extract-and-run)
  stops its app within about 2 s of the AppImage process being stopped (the app
  kept running, and its extracted folder stayed).
- **Android**: a change of font size or display size no longer reloads the page;
  text follows the system font scale live. A media request the WebView cannot
  grant whole (`{ video, audio }`) is denied up front, with a log line naming it
  (it showed a camera prompt, then failed silently); `{ video: true }` alone
  works as before.
- **Time travel**: undo/redo/goto/lock in the dev panel and `useTimeTravel()`
  reach the server (they sent nothing).
- **UI**: keyed moves keep focus and selection. A `Menu` focuses its first item
  on open. `<Alert role>` / `aria-required` / a controlled `Tabs` value naming
  no tab / `<svg tabIndex>` now do what they say. `useHead` refuses attribute
  names that are not names.
- **Sync / offline**: an offline edit refused only because the device clock is
  far behind is re-issued once, also after a reload while still offline. A cell
  that stopped syncing with unsent changes in the browser's storage now says so
  once (console + a server diagnostic); nothing is deleted.
- **A focused text field** with a debounced handler keeps what was typed when an
  unrelated parent render re-asserts the same value (the text was lost).
  `localFirst: true` leaves `worker: true` cells server-only (it used to refuse
  the boot).
- **Peers**: a `peer()` handle follows a callee that restarted on a new port.
  Upload/blob work against a socket-only app. A wrong token fails fast with the
  reason.
- **Snapshots**: `am snapshot load` / `app.loadSnapshot` of an older snapshot
  fills fields declared since.
- **Live queries**: `reactiveDB(app.db)` over a state-bound table refreshes on
  every committed write. Adding `unique`/`nullable` to an existing column says
  it is not applied to the stored table.
- **Big frames**: the client send pacer also limits bytes per second.
- **Metrics and `am`**: `aio_broadcast_bytes_*` count both WS and the local
  socket. Cell sizes are UTF-8 bytes. `dispatched=` excludes
  `__init`/`__destroy`.
- **`parseCli`** (aio/extras) returns `port: 0` for `--port=0` (it returned
  undefined), and `--port=0` beats config and `AIO_PORT`.
- **`aio/cli`**: a declared `short: "h"` flag gets `-h` (`--help` always helps).
  `watch()` prints its first frame once. Redraw follows the progress stream's
  own terminal (`CliIO.errTty`), so `tool 2>log` logs no redraw codes. A `cli`
  build whose deno.json declares no `client` warns that it bakes `--client=cli`
  in front of argv (`Deno.args[0]` is then not the command): declare
  `"client": "cli"`.

## Retire

Each of these was a workaround for something 1.0.25 does itself:

- Deleting `window-state.json`, or dragging a window off the screen's left edge,
  to stop an NVIDIA X driver crash on launch — aio never places a window at an
  edge (1.0.25).
- Deleting a 0-byte `window-state.json` after a crash — it is written to a temp
  file and renamed (1.0.25).
- Suppressing aiol's cell-definition error on a `peer()` handle's `.cell()` call
  — aiol tells the two apart (1.0.25).
- A second, default-scope process only so an `--instance` app can reach a
  default-scope service — `peer(id, { instance: null })` (1.0.25).

## am / aiol / install

- Words after `--` reach the app verbatim, and `am restart` keeps them.
- `am status`/`am logs --port=N` mean the app on that port. `am status` says
  `stopped — crashed`. `am help <unknown>` exits 1.
- `am upgrade`, `install.sh` and `install.ps1` pick the newest `v*` tag by
  semver.
- `am publish` refuses a bad channel before building. `aio ship` prints copy
  commands that run, names the versioned artifact when given the unversioned
  path, and notes that manifests left in `dist/` are cleared by the next build
  (use `--channel-dir`).
- New: `am prune versions [--yes] [--keep=<ref,…>] [--json]` — the version store
  finally shrinks (report first; `--yes` removes what it named). Plain
  `am prune` is unchanged.
- New: `am state`/`am expect` path filters `[?key]`, `[?key=value]`,
  `[?key!=value]` (`am state 'pool.models[?loaded]'`); old paths read as before;
  a miss prints the path syntax.
- `am start --wiat=5` says "did you mean am's --wait?". `--wait` on a verb that
  ignores it warns. Extra `am dispatch` args a method does not take warn.
  `am logs -f` keeps a character split across reads intact.
- `deno task doctor` checks a lost `deno.lock` against git HEAD.
  `deno task bench --only=a,b` works; `AIO_BENCH_RESULTS` moves the results
  file.
- amui: confirm is an inline bar (no blocking dialog); state and logs follow a
  restart.
- aiol no longer reads `p.cell<…>("x")` on a `peer()` handle as a cell
  definition.
- aiol run from a dir without `deno.json` lints the nearest project above it.
  Given a file, aiol exits 2. Hidden-field reads written as destructuring or
  brackets are errors.
- A broken pipe exits a CLI app with 141, quietly. `-h` goes to a flag that
  declares `short: "h"`. Ctrl+D ends `password()`.

## Tests that can go red

Each one was passing for the wrong reason:

- **`testUI` after a login** reads and calls as the signed-in user (it stayed
  anonymous). An assertion that saw the anonymous view now sees that user's.
- **`am migrate --tests`** lists the test shapes an upgrade turns red, for the
  version you come from.

- An un-awaited `expectCell`/`waitFor`/`settle`/`rejects` fails the test that
  made it.
- `crashWorker`: raw dispatches (schedule ticks) to the dead cell are refused,
  as in prod.
- Async write ordering: an assertion that relied on a lost or reordered write.

## New warnings (once each, never refusals)

- Typos in `security` keys, `android.*` / `build.android.*` keys or CSP words,
  Electron boolean switches given as strings, `ui.tray` shape, a non-boolean
  `auth`, an unusable `key`, `users` set beside `resolveUser`, malformed `users`
  entries.
- `dbPragmas` that do not take effect. `--instance` with an explicit `dbPath`.
  Two apps on one store.
- A direct `app.db` write to a state-mirrored table (`app.db` is now a wrapper;
  identity differs).
- A weak fixed `key` under `--expose`. A non-square `icon.png` for the web
  target (Chrome will not install it). `schedule.after()`/`own.set()` as a bare
  statement (aiol). A call refused by a dead worker cell, once.
- Dev only: a bare action nothing observed, a hydrate text mismatch, an unkeyed
  list shifting written-out siblings.
- `<Browser>` with no working `<webview>` (no `electron: { webviewTag: true }`)
  says so, once per page (it rendered nothing).
- A CLI client that cannot reach an app's local socket for 5 s says why (the
  socket path's state).
- A packaged app refused for a bad command-line argument also writes the reason
  into its existing `logs/app.log` (a double-clicked app showed nothing).

## New, all opt-in

- **`pairing: { pake: true }`** — PIN pairing by PAKE (CPace): an 8-digit code,
  and the exchange is bound to the certificate the client sees, so a relay that
  reads the code cannot pair in its place. Needs TLS (an exposed app with
  `tls: false` is refused at boot). Clients older than this release cannot pair
  with it: pair them after updating. See [Pairing by PAKE](../auth/auth.md).
- **`am state --prod [path]`** — a read-only probe of a production build's
  client view (`GET /__aio/view`), behind the same gates as the app's own
  clients; `AIO_TOKEN` for a per-user app's view.
- **`peer(id, { instance })`** (`@experimental`) — reach a service running in
  another instance scope; `null` means the default one.
- **`ZoomPan`**, with pure `zoomAt` / `fitView`, in `aio/ui`: wheel zoom at the
  cursor, drag to pan, zoom/fit buttons.
- **`errorSummary(err, max?)`** beside `errorCode`: one line — code and first
  sentence.
- **`serverFn(ns, { timeoutMs })`** (default 30 s, as before);
  **`effect(fn, { rerunOnSelfWrite: true })`** (default unchanged).
- **deno.json `"neutral": "soft"`** — near-grey neutrals under the app's colour;
  **`android.schemes`** — deep links into the Android app.
- **`.zip` desktop installs update from a patch**, and the web target reuses
  unchanged `assets` files (both above).
- **`deno task test:gpu-lab`** — for aio itself: shows aio's windows to a real
  NVIDIA X driver (`scripts/gpu-lab.sh`); `scripts/x-blackbox.sh` records what X
  saw before a crash.
