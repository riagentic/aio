# Upgrading from 1.0.16-beta to 1.0.17-beta

Nothing is removed or renamed; the public surface gains optional keys only:
`electron: { allowLocalPeers }`, and `host` and `handoff` on the lock record
(`LockData`, `aio/extras`). Most apps change nothing. A few kinds of app have
something to do — see [What to do](#what-to-do); a few smaller steps are marked
**To do** below.

```sh
am pin --latest
```

This release is two things. The **size repair**: 1.0.16-beta meant to drop the
TypeScript compiler from a compiled binary, but on a real host it was still
embedded, and the audit meant to catch that could not see it. And the **repair
of what 1.0.15-beta and 1.0.16-beta shipped broken**, found by an audit of both:
minified desktop builds, the Windows one-click `.exe`, the local-peer lockdown,
the version read, and three environment variables.

## What to do

- **You run `--prod --client=electron` from source** (`deno run … main.ts`): add
  `--allow-ffi` (`-A` includes it). Without it the app now refuses to start and
  names the flag; in 1.0.16 it started with a blank window. A compiled build
  needs nothing.
- **Your desktop app has a companion process** (a helper, a CLI) that connects
  to the app's local socket in production: set

  ```ts
  await aio.run({ electron: { allowLocalPeers: true } });
  ```

  That turns the lockdown off — the socket is then open to every process of the
  user, as in dev — and the boot log says so. Only the boolean `true` does it;
  another value leaves the socket gated, with a warning.
- **You point `$ELECTRON_PATH` at a wrapper script**: the wrapper must `exec`
  Electron. The window has to be the process the server launched; a wrapper that
  starts Electron as a child is refused, with an ERROR that names both pids.
- **Something of yours opens a WebSocket on `<app>.http.sock`**: that socket no
  longer upgrades (`Upgrade: websocket` is answered 501). A session is opened on
  the state socket (`<app>.sock`, NDJSON). An HTTP client may keep its
  connection for the next request, as before.
- **A library you ship loads a build-only package at runtime and lists it only
  as a peer** (`typescript`, usually): add it to `keepPackages`. It was embedded
  in 1.0.16 by mistake and is now left out; the build warns with
  `! typescript is a required peer of <library>, and aio leaves it out …` when
  this may apply.

  ```jsonc
  // deno.json
  "build": { "keepPackages": ["typescript"] }
  ```

- **You keep a package by name that itself needs a build-only package** (`tsx`
  needs `esbuild`): name both. A kept package now ships with the ordinary
  packages it needs; a build-only one on the way stays out until it is named,
  and the build prints the line to add.
- **Your staged desktop app holds a symlink that leads outside the app, at
  nothing, or at a folder it is inside**: the Windows one-click `.exe` build now
  stops and names the path. Replace the link with the file. A link that stays
  inside the app is packed as a copy — nothing to do.
- **You script against the macOS bundle's layout, or sign or notarize it
  yourself**: `Contents/MacOS/` now holds `app_window`, a relative symlink to
  the nested runtime, and the window process runs under that path (`ps`,
  `pgrep`). Keep it a link when you copy or re-pack the bundle. `Info.plist`
  gains the runtime's `NS…`/`Electron…` keys and `Contents/Resources/` its
  `.lproj` stubs.
- **Your page calls `window.close()` in a `closeToTray` app to end it**: the
  call now hides the window, like the close button. Quit through the tray's
  Quit, Cmd+Q, `am stop` or a signal. Without `closeToTray` the call ends the
  app as before.
- **You parse `perf.log`**: `duration` may now be fractional (`5.4`); read it as
  a number, not an integer.
- **Something of yours relies on the working directory of a program your Windows
  app opens** (`openExternal`, an external link): for an installed app it is now
  the Windows directory, not the install folder. A relative path given to
  `openExternal` still resolves against the app's directory.
- **Your page uses `beforeunload` to keep a desktop window open when the app
  stops**: it no longer can. An exit the app decides (`am stop`, a signal, the
  server dying, a crash of the window's main process) ignores the page's veto; a
  close or quit by the user still asks it.
- **A script of yours looks for the window's main script or preload in the temp
  directory**: they are in the app's profile directory now
  (`<profile>/aio-main/`, `<profile>/aio-preload/`).
- **You script `am start` to replace an instance that hangs**: `am start` onto
  an instance that listens but does not answer is now refused
  (`not answering: … is running and listening, but does not answer`); it used to
  end it. Run `am stop` or `am kill` first. `am status` reports it the same way,
  with exit 2.
- **You keep a file or folder beside the install whose name looks like an update
  leftover** (`<install>.staged-…`, `.old-…`, `.zip-…`): it is no longer removed
  — except at the first start on 1.0.17 (or one that finds
  `update-artifacts.json` gone), which takes onto the record what 1.0.16 and
  older left: a hand copy of the app named exactly like an updater copy
  (`<install>.old-1.2.3`) is taken for the updater's then and pruned like an old
  version. Rename such a copy before you upgrade. If it has a name an update
  needs, the update is refused with `<path> is in the way of the update…` until
  you move it.
- **You ship updates to directory installs (Electron `.zip`, macOS `.app`)**: if
  an app built with aio 1.0.17 or later updates such an install to a release
  that was built with an older aio, that install records no digest of what it
  runs: a re-published build of the SAME version is not offered to it until the
  next version arrives. Nothing wrong is accepted — only that one detection is
  lost. Build the release with 1.0.17 or later to avoid it.
- **You run `am publish --dir=<dir>` with a directory that is the project,
  `src/`, an app dir, `.git`, `.aio`, inside or around one of them, or inside
  `dist/`**: it now stops with exit 1 before the build. Publish into a directory
  of its own (`release`, the default) or one outside the project. A project
  whose `.aio/outputs.json` named such a directory sees its version change once,
  to the true one.
- **A supervisor of yours waits exactly 8 s before it kills an aio app**: wait
  at least 8.2 s. A teardown whose phase overran now runs up to 200 ms longer,
  so the databases can close.
- **You ship a macOS desktop app to macOS 12**: the bundle's
  `LSMinimumSystemVersion` is now the bundled runtime's (13.0 with the Electron
  aio carries now), where it said 12.0. How macOS 12 treats it was not tested;
  keep users on macOS 12 on your previous release.
- **You see `! build.minify: <file> ships UN-minified (…) — <why>` in a build**:
  the module is shipped as written, comments included. Rewrite the expression
  the warning names, or accept it; the reasons are listed in
  [targets](../build/targets.md#hide-the-server-source-buildminify-on-by-default).

## What you may notice

### Desktop apps

- **Another local process learns less.** In production, a process that is not
  the app's window may ask `GET /__aio/health` over `ctl` and is told
  `{ status, appId }`; `am stop`'s `POST /__aio/trojan/shutdown` passes on to
  the app's credential check; everything else is 404, and the HTTP socket
  answers it 403 within 2 s. 1.0.16 answered the app's `routes`, `/__aio/vitals`
  and `/__aio/metrics` there. `am health` keeps working.
- **The HTTP socket is gated like the state socket.** 1.0.16 left
  `<app>.http.sock` open to any process of the user.
- **`--prod` from source shows its window again**, because aio starts the
  Electron binary itself instead of the `node_modules/.bin/electron` shim (in
  dev too).
- **The boot log says what is covered.** With `--port` or `--cdp` the socket is
  still gated, and a warning says what the port leaves open.
- **A window told nothing for 5 s** says why once, appends
  `— no answer from its server yet (reconnecting)` to its title until the server
  answers, and reconnects with a backoff.
- **Under `--keep-server`**, a production app closes the window's sessions and
  HTTP connections when the window exits.
- **An app started from a directory that is not a project** (a login item starts
  in the home directory) no longer runs `deno install` there, which left a
  `deno.json` behind on each launch. It uses the cached Electron runtime. To do,
  once: delete a stray `deno.json`/`deno.lock` an earlier version left in such a
  directory.
- **macOS: an app that was opened twice can be quit by its bundle id**, and
  opening a running app again shows a window hidden to the tray.
- **A killed desktop app** no longer leaves its generated Electron main script
  or its preload in the temp directory; the boot line `launching Electron (…)`
  says `packaged` for a macOS bundle and a double-clicked Windows exe.
- **A packaged desktop app whose window cannot be started** stops with exit 1
  and the reason in its log; it ran on with no window. `--keep-server` keeps the
  server.
- **The dev launcher installs Electron only into an app project**, and the
  WebSocket desktop shell logs `ui mounted`.
- **macOS: the app has an application menu** (the app's Hide and Quit, Edit,
  Window), so Cmd+Q, Cmd+H, Cmd+C/V/X/A/Z, Cmd+W and Cmd+M have a menu item;
  Cmd+W closes the window the way the close button does. Linux and Windows have
  no menu, as before.
- **Starting an app that is already running** writes no lockdown warning into
  the running app's log; `window.__aioWindow` also exists in the WebSocket
  shell.
- **A minified build reconnects after a dropped socket**, and a `blocking()`
  function may declare helpers, arrows and classes and reads its written
  `.name`. These failed in 1.0.16 with `build.minify` on (its default).
- Minified code calls one global, `__aioName`. If your app sends a function's
  source somewhere aio does not run and sees `__aioName is not defined`, define
  it there first — the line is in
  [targets](../build/targets.md#hide-the-server-source-buildminify-on-by-default).

### The local HTTP socket

- **`<app>.http.sock` is served by aio's own HTTP server, in dev and in
  production** (1.0.16: `Deno.serve`). A route sees the same `req.url`
  (`http+unix://<Host>/…`), headers, `req.signal` and bodies. What differs on
  purpose: no WebSocket upgrade; a connection is closed after a request whose
  body is still on the connection when the answer is written (an unread chunked
  body, a body on a `GET`), and for an HTTP/1.0 client (the answer then says
  `Connection: close`) — otherwise it is kept for the next request, as under
  `Deno.serve`; the HTTP/2 preface and a head line ended by a bare LF are
  answered 400; response header names are lowercase, the route's sorted and then
  the server's own; a request head that has begun and is not complete within 30
  s is answered 408; a shutdown waits 2 s for requests in flight. The full list
  is in [transports](../clients/transports.md).
- **Under the lockdown, a connection a client ended is released**; since 1.0.16
  each stayed in memory for the life of the process (about 4 KB).
- **A request on that socket costs more:** compared with 1.0.16, which used
  `Deno.serve` there, a request takes about 1.4–1.5× the time (on the order of
  50–60 µs instead of 30 µs of server CPU per request in a real app), and the
  process's RSS grows about 40 MB more over the first 5000 requests (about 16–21
  MB more at 20,000; flat over 400,000 — no leak). A JavaScript server pays for
  a `Request` and its abort signal per request through public API.
- **In production, the window process no longer holds the server's listening
  sockets** (they are close-on-exec).
- **On Windows**, the `-http` pipe (which that server already served) now reads
  header bytes as latin1, aborts `req.signal` and cancels a response stream when
  the client leaves, sends `Content-Length` for a body that is already whole,
  and keeps a connection for the next request.

### The Windows one-click `.exe`

- **A second double-click during the first extraction** waits for it, then
  starts the app. Opening a **different version's `.exe` while the app runs**
  changes nothing and says to close the app first. In 1.0.16 either could
  destroy the install.
- **After a self-update, the `.exe` you kept starts the updated app.** An app
  built with 1.0.16 swaps without the stamp that makes this work; from 1.0.17
  on, each start and each update takes it back from the newest kept copy that
  has one, and when none has one a warning says that opening the `.exe`
  reinstalls the version it carries. Publish the `.zip` with every release — an
  `.exe` install updates from the zip's manifest.
- **A signed `.exe` starts.** Sign after the build and before `deno task ship`
  ([targets](../build/targets.md)).
- **The build no longer stops when the extractor stub cannot be used** (a
  checkout path with a space, a Windows host, aio imported remotely): the path
  cases work, and anything else — a registry that does not answer within 60 s
  included — gives the legacy fat exe with a warning.
- **A symlink inside the staged app** ships as a copy of its target; the build
  says so, with the size.
- **A file of the app that changes while the `.exe` is being packed** is named
  by the build, which then uses the zip payload.
- The same staged package now packs to the same payload, so a rebuild of an
  unchanged app does not re-extract.

### Builds

- **Smaller binaries.** A build-only package reached as a peer is really left
  out; source maps, docs and test-fixture directories inside embedded packages
  are held aside for the compile and put back afterwards; a cross build no
  longer embeds the target platform's `esbuild` binary — the second and later
  builds of a project included (about 10 MB each); a cross build embeds the
  target's native packages only, not the host's as well; and a compiled app no
  longer carries aio's builder.
- **A cross build installs the target's packages first** — one `deno install`
  against a temporary copy of the lock, so your `deno.lock` and tracked files
  are not written. They stay in `node_modules/.deno`. Offline, with the target's
  packages not cached, the build stops and names the package.
- **The version of a project that builds to `--out` dirs stops moving**: the
  same string for the same sources, where a project without git got a new one
  per build. It changes once, to that stable value. `am publish` twice from
  unchanged sources gives the same version; a build records its output
  directories in `.aio/outputs.json`. To do, in a project made by an older
  `am create`: add `release/` to `.gitignore`.
- **`deno task publish` works for an app that prints to stdout while loading**;
  a binary asked for `--aio-data-contract` prints one more line on stderr.
- **Files inside a package no longer depend on the builder's umask**: 0755 for
  directories and executables, 0644 for other files, in the `.dmg`, the
  `.app.tar.gz`, the zips, the Windows exe payload, the AppImage, the web folder
  and the iOS project. The files in `dist/` themselves still follow your umask.
- **New build-time warnings.** When your code, a dependency's `dependencies`, or
  a dependency's required peer needs a package aio leaves out; when a
  `keepPackages` name matches no installed package; when a module ships
  un-minified; when the build-tool audit cannot read an artifact. Each names
  what to do.
- **`build.keepPackages` wins over every rule that leaves a package out**, and a
  kept package brings the packages it needs. A binary that names a package the
  module graph does not reach grows by those. `keepPackages` also exempts the
  named package from the source-map/docs/fixture trim.
- **`build.keepPackages` and `build.chromiumExtras`** are no longer called
  unknown keys by the build and `aiol`.
- **A module with a decorator ships un-minified**, as does one whose minified
  text TypeScript or deno would read differently. In 1.0.16 a decorated class
  got the minifier's name, a legacy parameter decorator stopped the build, and
  `[(a < b), c > (d ?? 0)]` crashed the compiled build.
- **An invalid `build.chromiumExtras`** is now named on a macOS build and on a
  build run with `AIO_STRIP_CHROMIUM=1` — a warning, and the build goes on, as
  on 1.0.16. A Windows or Linux build without the env form refuses it, as
  before. `"strip"` removes all of Vulkan (the loader too) and the DXIL
  compiler.
- **Ctrl-C during a compile** restores `node_modules` and exits 130 (`SIGTERM`:
  143). A build killed outright is repaired by the next `deno task build`.
- `AIO_SKIP_TRIM=1` turns the trim off for a build you are debugging.

### Versions, memory and updates

- **A large project keeps a version.** Past 20,000 files or 128 MB the
  `-dirty`/`-nogit` hash comes from path, size and mtime — it differs per
  checkout and moves on `touch`. 1.0.16 reported `unknown (…)` there. Past
  50,000 files, 50,000 directories or 64 levels it is still `unknown (…)`: pin a
  `"version"`, or give the app its own `deno.json`. Hashes of smaller trees are
  unchanged.
- **A pinned `"version"` reads no tree**; 1.0.16 could report `unknown (…)` and
  fail `deno task build` for a pinned app with one large asset.
- **`unknown (…)` is one line with no path**; the reason is in the log.
- **Memory reports are quieter and truer.** A native leak is reported from its
  second climbing window (its third, when the first two are more than ten
  windows apart) — the windows need not touch while RSS keeps what it gained, so
  a leak that grows in bursts is reported and a one-off step is not. It is said
  again only when RSS stands 256 MB (or a quarter of where the climb began)
  above where it was last said — memory that climbs and is given back is no
  longer reported every window. A `machine` report prints RSS, is said once,
  then again per further tenth of RAM, and does not set `nativeLeak`. A budget
  error's message contains `MEMORY_UNBOUNDED`.
- **`AIO_MAX_HEAP_MB` says what it did.** `0x2000`, `1e4`, `4096.0` and `+4096`
  cap the heap as in 1.0.16 and now warn that the spelling is not plain digits;
  `4g`, `0` and `-5` are no cap, as in 1.0.16, and now warn. To do: write
  `8192`.
- **A directory install's `installed.json` follows in-app updates**, so
  `am installed` and `am upgrade` report the running version. The record is
  written when the update is confirmed healthy. An install that updated itself
  under an older aio logs one
  `WARN updates … named X while Y is running — corrected` at its first boot.
- **A rollback that failed once and worked on the next boot** is reported as
  rolled back.
- **After a failed update on a Windows directory install**, if the update helper
  could not put the old version back and you restore it by hand, the next start
  reports `was rolled back by hand`. On other install kinds the
  `ROLLBACK FAILED … Put … back at … by hand` message is unchanged.
- **A release whose install could not be put in place is offered again** (up to
  three times) instead of being dismissed; `update-trust.json` gains
  `failedSwaps` while that is counted. On Windows the swap waits up to 30 s for
  the install folder, so after a failed one the old version comes back later
  than before.
- **A start with no update in flight** removes what an unfinished update or a
  cut-off download left beside the install — only what the updater itself made,
  by its record in a new file, `update-artifacts.json` in the data directory —
  and logs the names. A look-alike it did not make is left and named. On a file
  system that gives no creation time nothing is removed or pruned, and each
  start warns with the path and size. A tree an older updater left half-made
  under a different version (`<install>.staged-<v>` from a failed 1.0.16 update,
  say) cannot be proven the updater's, so it is left and named at each start —
  delete it by hand.
- **Windows: an installed app's window runs from the Windows directory**; the
  launcher hands it the app's directory in `AIO_APP_CWD`
  ([environment](../build/environment.md)).

### Everything else

- **`am stop` stops a production app gracefully on Windows** — `onStop` and the
  final save run — once the app is built with 1.0.17; an app built with an older
  aio is still ended by a signal (`TerminateProcess`). The app writes
  `<data>/control.key` in production too; on Windows it needs `--allow-ffi` (a
  compiled build has it) to write it owner-only, else it warns and `am stop`
  falls back to the signal. `--takeover` stops the previous instance the same
  way. When the app refuses the credential, `am stop` says so; `am stop --json`
  reports `how` (`graceful`, `signal`, `killed`).
- **`am start` sets `AIO_LOCK_HANDOFF`** in the app's environment, a one-time
  secret the app uses to take its lock over from `am` and then removes.
- **`am start --headless` and `--service` work**: `am` passes them to the app as
  `--client=server-only`.
- **`AIO_CDP`, `AIO_PORT`, `AIO_DEFAULT_PORT`** no longer refuse a boot that
  1.0.14 allowed — see
  [1.0.14-beta → 1.0.15-beta](from-1.0.14-beta-to-1.0.15-beta.md).
- **A refused boot leaves its reason in `app.log`**: one
  `ERROR boot refused — the app did not start: …` line. A command line that does
  not parse and a refused data folder are still on stderr only.
- **A second launch onto an instance that is still starting** waits for its
  window (up to 13 s) and exits 0 once that window has mounted its page; it
  exited 1 at once. If that instance dies during the wait, the second starts.
- **A stuck instance is ended before its lock is taken.** A launch (or
  `am start`, `am backup`, `am restore`) that finds a process alive with nothing
  listening for 2.5 s at the address its record names, and its record unchanged
  for 10 s, ends it first; it used to start beside it. If it cannot be ended,
  the start exits 1 and names the pid. The lock record gains `host`; an app
  started by 1.0.16 or older is never judged stuck — the launch is refused
  `Already running`.
- While you upgrade, the previous release and this one can meet on one machine:
  if an app of this release is stuck (running but not answering), stop it with
  `am stop --app=<id>` before you start the previous release — the previous
  release does not see such an app as running and would start beside it.
- **A start onto a live process that holds the data folder is refused even when
  its lock file is gone**; a running app whose lock file was removed files it
  again within 5 s. The lock file of a running app ends in a line of spaces and
  tabs, which `JSON.parse` ignores.
- **`logs/.rotate`** is a new file in the log folder; two starts within 3 s
  rotate the logs once.
- **New warnings:** `… was not updated` (`meta.json`), `… was not archived` (a
  log), a lock file that could not be removed at quit. On Windows a state-file
  replace waits up to 1.3 s for a file another process holds.
- **A stop says why.** One INFO line stands above `stopped uptime=…`:
  `SIGTERM received — stopping` (or `SIGINT`, `SIGHUP`), or
  `stop requested over the control API (am stop) — stopping` (or
  `(takeover by a new launch)` when a `--takeover` launch asked).
- **A server-rendered `<script>` or `<style>` is judged as a whole.** Children
  that join into the element's closing tag, or a `<script>` that leaves `<!--`
  and a later `<script` open, throw in dev and are escaped in production; both
  broke out of the element, or swallowed the page, before. To do, if dev throws:
  write `<\/script` and `<\!--` inside the string. `renderToStream` sends such
  an element's content as one chunk.
- **`"x" in s` in an async method** answers for the prototype chain again, like
  a sync method.
- **A user record that is a class instance or a `Proxy`** has no per-user cache
  key: its `forUser` view is recomputed per client and `ttl`/`"first"` do not
  cache for it. Plain-data records, `bigint` and `Date` fields included, are
  keyed.
- **`testUI({ persist: true })`** writes about 100 ms after a change, as
  production does, not only at dispose.
- **Standalone/Android: `persistDebounceMs`** may shorten the local store's 100
  ms write window; a larger value is 100 ms (1.0.15 and 1.0.16 applied it as
  written).
- **The aio client** honours `AIO_DISCOVERY_PORT` again and warns when a pinned
  certificate changed (it still connects).
- **Tooling that exited 0 now exits 1:** `deno task test` with a process that
  outlived its test, or a test file that ran no test; `AIO_TEST_FREE_CORES` that
  is not a whole number; `am prune --days=`, `am timetravel goto ""`,
  `am eval --window=`, `am shot --threshold 3`; `check:mutations --jobs=0`.
- **`aiol --safe-fix` fixes fewer things by itself than in 1.0.16**, and gives
  more `[manual]` hints. It rewrites a name only when the file proves it is
  aio's: one static import of it from aio (by specifier, by the import map, or
  through your own barrel that passes it on from aio and nowhere else), with
  every other mention of the name reading as a use. No longer rewritten: a name
  taken by `await import("aio")`; a name used without an import; a name through
  a barrel that also exports its own; `schedule.blocking` when `schedule` came
  from a sub-entry of aio; a file where one mention of a renamed word
  (`connectDevTools`, `CellAccess`, …) cannot be renamed. Your own `call`,
  `useCell`, `schedule` are left alone. To do: where the linter says `[manual]`,
  make the change by hand; the hint names the line.
- **`aiol --safe-fix` in files that hold JSX**: a name that is also written
  inside a comment, a string or element text is not rewritten, and a file that
  writes an identifier with a `\u` escape, or a closing tag that closes no
  element aiol read (`"</p>"` in a string, `// … </b>` in a comment — a `.ts`
  file too), gets no fix at all. Each finding there is `[manual]` and names the
  line.
- **`aiol` reports more.** `call({ timeout })`, `schedule.blocking(` and
  `schedule.poll({ backoff })` are found under an import alias, with type
  arguments and in more spellings; a use no rule reads gets a hint. In a `.tsx`
  file, a use that follows prose in an element (an apostrophe, a URL, a
  backtick) is now reported or fixed, and your own callback parameter after such
  prose is no longer rewritten. With no `deno.json` in the linted directory,
  uses of a bare `aio` import are `[manual]`, where they were fixed. Import-map
  `scopes` are read.
- **`deno task test`** writes `.aio/test-shards/<n>.log` while a shard runs and
  names a shard silent for 5 minutes; `--quiet-ms=<n>` takes digits only, 1 to
  2147483647, and the last occurrence counts. `--shards` and `AIO_TEST_SHARDS`
  take digits only, 1 to 256.
- **`install.sh`** puts `am` back in `~/.deno/bin` when only `DENO_INSTALL` is
  set.
- **Android:** whitespace inside a template placeholder (`{{ APP_NAME }}`, as a
  formatter may write it) is accepted.

## Retire

- Nothing. No workaround in this guide's scope is retired by 1.0.17-beta.
