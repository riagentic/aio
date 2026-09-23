# Upgrading from 1.0.9-beta to 1.0.10-beta

Nothing is removed and nothing changes shape; the surface only grows (the
`profiles` option, `--profile`). `renderToStream` keeps its exact type (it is
now a plain function returning the same `AsyncGenerator`).

```sh
am pin --latest
```

**No app needs a code change unless it sets `routePath` AFTER its
`renderToStream()` call** — after an `await` that follows it (reported at run
time), or before a `renderToString()` in the same step (not reported); see the
first item below. What follows is what you may notice in a server that streams
pages.

## What you may notice

- **A streamed page takes its route when `renderToStream()` is called.** A
  handler that set `routePath`, created the stream, and then awaited something
  before sending the body could render the NEXT request's page — measured, every
  overlapping pair. Now it renders its own, provided every request keeps the
  route contract: **set the route and call `renderToStream()` /
  `renderToString()` in one synchronous step, no `await` in between, on every
  request** (`routePath` is one signal shared by the whole process). A request
  that sets the route and then awaits can still hand its route to another
  request's stream — a stream re-reads the route once at the end of the turn it
  was called in (so create-the-stream-then-set-the-route code keeps working, as
  in 1.0.9), and two requests resumed by one shared promise share that turn.
  1.0.9 did this silently; now
  `[aio] routePath changed after renderToStream() —
  set it BEFORE the call; …`
  names the call site, once per call site. **The one 1.0.9 pattern that renders
  differently:** a route set after the call's turn — create the stream, `await`,
  then set `routePath` — is no longer rendered (1.0.9 read it at the first pull,
  which is what let one request's route into another's page). The stream renders
  the route it was called with, and
  `[aio] routePath changed after renderToStream() was called and before the
  stream was first read …`
  names the call site; the fix is to set the route before the call. **The one
  that renders differently in silence:** create the stream, set `routePath`,
  then `renderToString()` a shell, in one synchronous step — the stream keeps
  the route it was called with (1.0.9 rendered the new one). That sequence is
  exactly what two correct requests resumed by one shared promise produce (one
  streams, the next sets its route and renders a string), so no warning can tell
  them apart without accusing correct code. Same fix: set the route before the
  call. See [the route contract](../ui/air-advanced.md#rendertostream) for all
  three warnings.
- **A closed tab's head is no longer handed to the next no-argument
  `collectHead()`** once another render has been set up (anything called
  `renderToStream()` / `renderToString()` at the top level since): the answer is
  empty instead of the head of a visitor who left. Stopping your own stream (a
  `break` out of the loop) and then asking still answers with that stream's
  head, as in 1.0.9. The next page's no-argument head still throws next to a
  closed tab, as in 1.0.9 — `collectHead(req)` is exact.
- **A page whose root is a context Provider (any Fragment) now streams.** It
  used to be computed whole before its first byte; now its first chunks go out
  as soon as they are ready — so a component that throws later in the page fails
  the stream after some HTML was sent, exactly as a page whose root is an
  element always did. Catch it with an `ErrorBoundary`, or render to a string
  when a page must be all-or-nothing.

## In the browser

- **A call that ran but was NOT SAVED says so.** When the server's ack carries
  `unsaved` (the call ran, but its write could not be persisted) or `short` (it
  ran on fewer arguments than its method declares), the tab warns once per call:
  `[aio] call <id> ran, but: NOT SAVED — <reason>; <short>`. The call still
  resolves — it did run. A sync cell's op ack carrying `unsaved` warns once per
  op: `[aio:sync] op <id> on <cell> NOT SAVED — <reason>`.
- **One `sync-err` retry loop, not one per error.** A server holding ops (time
  travel paused) answers every op with `sync-err`; each used to start its own
  2-second loop re-sending the whole queue. Now there is one, and the reason is
  logged once per episode:
  `[aio:sync] server sync failed: <reason> — retrying
  every 2s (said once until a sync lands)`.
- **`AckPayload` gains optional `unsaved` / `short`** (wire, additive): an older
  server omits them and an older client ignores them.

## Persistence and crash recovery

Nothing to change in an app. What is different on disk, and what that means if
you go back:

- **`persist: "none"` slices an older build stored are removed at boot.** A cell
  that declares `persist: "none"` is never restored from the store, and a slice
  1.0.9 (or a downgrade) left there is deleted with SQLite's `secure_delete` on.
  The database is then rebuilt (`VACUUM`, which drops the older revisions that
  earlier saves left in free pages) and the WAL is truncated, so no copy of it
  is left in the files. Boot logs one line naming the cells. The rebuild runs
  only on the boot that finds such a slice, and it takes as long as a copy of
  the database.
- **The dev checkpoint no longer holds `persist: "none"` cells**, and one an
  older build wrote has them filtered out before `onCheckpointRestore` sees it.
- **`journal: true` writes new kinds of lines.** A `listensTo` reaction that
  lands on another save clock (a sync op's listeners, a sync cell's listeners)
  and a server-side write to a sync cell are journalled as the STATE they left,
  so a crash brings them back in their live order. Every line carries a format
  stamp (`fmt`).
- **The first boot over data 1.0.9 last ran**, crashed or stopped cleanly, is
  recognised by the missing stamp. This version stamps the op-log in `state.db`
  (a `sync_meta` row named `__aio_reactions_fmt`) once its boot is settled, with
  `persist` on or off. Boot says so:
  `journal: this data was last run by an older aio build (1.0.9 or earlier) …
  none is re-derived, so nothing is counted twice`.
  1.0.9 recorded no `listensTo` reaction of a sync op on another cell: its boots
  re-derived them through every listener, and saved them or lost them in ways no
  record shows. So this version **re-derives none**. Each cell's own ops fold
  into it, as in 1.0.9. A crashed 1.0.9 journal's calls are replayed as calls,
  with their reactions. Every listener that may lack reactions gets one warning:
  `sync: "tally"'s listensTo reactions to 10 "notes" ops in the op-log
  (server_ts 1–10) are in no record this boot can read — … Nothing was
  re-applied, so nothing is counted twice; 1.0.9 may have saved these reactions
  or lost them — check "tally".`
  The warning also names the ops 1.0.9 folded out of the op-log and, for a sync
  listener, the store-persisted calls it listens to. **Check each named cell
  once**: its reactions come back only where a save of 1.0.9's holds them (a
  store-persisted listener after a clean stop, usually whole; a sync listener,
  whose reactions 1.0.9 never folded, usually only its own ops). Nothing is
  counted twice — 1.0.9 itself counted every op again on every boot (a tally of
  24 came back 45 after a crash, 10 came back 20 after a clean stop). The next
  boot says nothing.
- **An op an older build wrote after a downgrade** (this version, then 1.0.9,
  then this version again) is found the same way, op by op: it has no record in
  the journal (below). Its listeners are named, and nothing is re-applied.
- **A sync op its cell refuses no longer triggers its `listensTo` listeners.**
  This is the only change to what listeners see, and it applies to sync ops
  alone (a client write to a `sync: true` cell). 1.0.9 ran the listeners of a
  sync op whose `validate` (or machine guard, or disabled cell) refused it,
  while it answered the client `op-rejected` and deleted the op from the op-log.
  So the reaction lived only until the next restart: a counter that listens to a
  sync method counted a refused write, and a reboot took it back without a word.
  Now the reaction never happens, live or after a crash. A call (a method call,
  `am dispatch`, a trojan POST) its cell refuses still runs its listeners,
  exactly as in 1.0.9 — see
  [what a listener sees of a refused action](../state/composition.md).
- **Turning `journal: true` off moves an unreplayed journal aside.** A run with
  the journal off used to leave a journal a crash had left where it was — not
  replayed, and then replayed by the next run with the journal on, over
  everything saved in between (a sync cell's list came back as it was before the
  crash). Now the journal-off run moves it to `journal.unreplayed-<time>` and
  warns with its path and record count; its writes are not applied. To recover
  them, stop, move the file back and start once with the journal on. A sync
  cell's journalled state older than a snapshot a journal-off run wrote is never
  applied either (warned, and the snapshot is kept). A sync op the crash caught
  in flight is resolved first, as a journal-on boot resolves it. The same holds
  when 1.0.9 (journal off) ran in between: with `journal: true` the store gets
  SQL triggers (table `aio_store_gen`; plain SQL, which 1.0.9 runs too) that
  flag a save this version did not make, and the journal is moved aside instead
  of replayed.
- **Going back to 1.0.9 (`am pin`).** 1.0.9 ignores the new lines and recovers
  the way it always did: the op-log, the store, and the calls in the journal. It
  also folds every sync op still in the op-log through all of that op's
  listeners, on every boot, clean stop or not. So:
  - A **store-persisted listener of a sync cell** (a counter that `listensTo` a
    sync method) is counted again for every op still in the op-log. The saved
    slice already holds those reactions. A clean stop does not help (a tally of
    24 comes back 48 after a clean SIGTERM), and each further 1.0.9 boot adds
    them again until the log is compacted. 1.0.9 does this to such an app on its
    own restarts too. There is no safe way back for an app with such a listener.
    Stay on 1.0.10, or check and correct that listener's value after every 1.0.9
    boot.
  - A **sync listener** loses the reactions only the new lines held. After a
    clean stop there are none, because its folds hold them.
  - Everything else is recovered as 1.0.9 always recovered it. After a crash,
    boot this version first so it recovers, stop it cleanly, and then go back.

## Profiles (new)

Nothing to change in an app. A second copy of an app with its own data is now
one flag — see
[profiles](../clients/app-manager.md#profiles-several-copies-of-one-app):

- **`--profile=<name>`** runs from `~/.<appId>-<name>` (or beside `appDir` /
  `$AIO_APPS_DIR/<appId>`), keyed `<appId>@<name>`: its own lock, socket,
  Windows pipe and Electron profile. On every `am` verb, on the app itself
  (`deno task dev`, a packaged binary or AppImage, Electron), and as
  `AIO_PROFILE`. `am start myapp@dev` is the short form; `am restart` replays
  it.
- **`--profile=<path>`** is that exact folder, keyed `<appId>@<hash8(path)>`.
  `--home=<dir>` is its alias, on the app (`--home=`) and on `am`. Both, naming
  two folders, are refused. A path gets the same foreign-folder and
  reserved-name refusals as a derived home.
- **`am start --home=<dir>` starts an instance there.** 1.0.9 refused it.
- **`am instances` lists a profile as `myapp@dev`** (`--json` adds `profile`),
  and a bare `am stop` never stops one (bare `am status` names the running
  profiles: `am stop --app=myapp@dev`). `stopWith` is `--profile=<name>` for a
  profile and `--home=<dir>` for any other custom home; `myapp@1a2b3c4d`
  addresses a running instance by its hash tag. A start `am` refuses before the
  app boots (foreign folder, another owner) writes nothing into that folder; its
  log is left beside it, `.<folder>.am-start-<pid>.log`.
- **Mixed versions:** a 1.0.9 `am` sees `myapp@dev` locks as the app "running
  from 2 data homes" and refuses bare verbs — use this version's `am`.
- **An `appDir` named like a profile keys like one.** `appDir: "~/.myapp-q1"`
  (the default home plus `-<valid name>`) is now `myapp@q1` — lock, socket,
  `am instances` row — instead of `myapp@<hash8>`. Same folder, same data; a
  script that hard-coded the hashed name must use the new one.
- **`am remove --data` never removes a profile home.** It lists them (`--json`:
  `profileHomes`) and leaves them.
- **A fixed-port clash between two copies** names the aio app holding the port
  and suggests `--port=0`.
- **`data/meta.json` records the profile**, and boot refuses a home another app
  or profile owns — the `dev` profile of `myapp` and an app named `myapp-dev`
  both derive `~/.myapp-dev`. A plain boot is refused only by a `meta.json` a
  profile wrote; a folder 1.0.9 wrote is never refused.
- **`aio.run({ profiles: false })`** opts out: every form is refused at boot
  (exit 1). An app that declares its own `--profile` / `--home` flag keeps it;
  aio then reads only `AIO_PROFILE` (and warns once if the flag is on the
  command line). `am` forwards argv as is, so for such an app use
  `AIO_PROFILE=<name> am start`.
- **Going back to 1.0.9:** a 1.0.9 app refuses `--profile` as an unknown flag,
  so a copy never boots on the real data. A profile's home is a plain app home
  and stays where it is.

Fixed alongside:

- **An `appDir` app under `--instance` / `AIO_APPS_DIR` no longer opens the
  default instance's `state.db`.** 1.0.9 moved its lock into the scoped lock dir
  but kept the data home, so the two held different locks on ONE database — two
  writers. The home itself is now locked too: `<home>/.aio-instance.lock` (an OS
  lock, with `.aio-instance.json` naming the holder), so two processes in
  different lock scopes cannot open one `state.db` — the second is refused with
  `already running from …`.
- **An `--instance` Electron window has its own Chromium profile.** 1.0.9 opened
  the default one, sharing its storage and cookies with the user's window.

## `am`, locks and lifecycle

Nothing to change in an app. A script that reads `am`'s exit codes or `--json`
may see these:

- **`am status` has a new transitional state: `maintenance`** (exit 2, like
  `starting` / `stopping`). It is `am backup` or `am restore` holding the app's
  lock; `--json` reports `status: "maintenance"` with the `op` and its `pid`.
- **`am backup` and `am restore` hold the app's lock for the whole copy.** While
  they run, `am start`, the app's own boot, `am stop` and `am state` (and every
  verb that talks to the app) refuse, and each names the holder:
  `am backup is running on "<app>" (pid N)`. `am stop` no longer SIGTERMs a
  backup. A backup copies into `<dest>.partial` and renames it into place only
  when it is complete. A leftover `.partial` from a killed backup is refused by
  name and never reused. A restore copies into `data.restoring-<stamp>` and then
  swaps it in, so a failed copy leaves `data/` untouched. Ctrl-C / SIGTERM
  aborts either one the same way (at the next file; a SECOND signal abandons the
  file still copying and exits at once), and the command exits 130 / 143 instead
  of ignoring the signal and exiting 0. `am instances` lists the hold as
  `status: "maintenance"` with its `op` and no `stopWith`. `am kill` interrupts
  it (it exits 143 with `data/` as it was) and no longer removes its lock. A
  restore never reuses a `data.replaced-*` / `data.restoring-*` name (`-2`,
  `-3`, … inside one second), and names a `data.restoring-*` a killed restore
  left. A boot the lock refuses writes nothing into `data/` (`meta.json` and
  `.heap-notice` are written only once the lock is held, `meta.json` whole or
  not at all). A boot after a killed backup/restore says which op it was, rather
  than warning that the app lost writes. A backup or restore whose signal lands
  during its last file still aborts (143, no `<dest>`, `data/` not swapped). A
  wedged holder is ended with `kill -9 <pid>`; whatever finds its lock next
  (`am start`, `am status`, `am instances`, the boot) reclaims it and names the
  killed op and the partial copy it left.
- **A desktop app whose Electron window CRASHES exits 1** (it exited 0). A
  window killed by a signal other than SIGTERM / SIGINT / SIGHUP (for example
  SIGTRAP when the display refuses it, or SIGSEGV), or one that exits non-zero,
  still shuts the app down the same graceful way (drained, persisted). The app
  now logs an ERROR `electron crashed (…)` with the window's last stderr lines,
  and the process exits 1. Closing the window normally still exits 0.
- **Exit 1 where 1.0.9 exited 0 on a failure:**
  - `am check <entry>` when the entry you named does not exist;
  - `am link` / `am pin` / `am fix` with an `--aio=<path>` that is not an aio
    checkout;
  - `am installed` when the install root cannot be read;
  - `am profile` / `am shot` / `am eval` against an app that is still booting.
    Before, these asked port 0; now they say the app `is still starting`.
- **`--json` failure documents gain an `error` field** (additive) on `am kill`
  and `am fix`. A failure never prints `ok: true`.
- **`am create` refuses a file (or an unreadable path) at the target** before it
  provisions anything. A scaffold that fails half-way is undone: what it created
  is removed, and files it overwrote under `--force` are restored. A path it
  could not put back is named (`undo incomplete — not put back: …`).
- **`am pin` moves the `dep/aio` link and the recorded pin together.** When the
  pin cannot be written, the link is put back, and so is a `.aio/pin.local` the
  failed pin had just created.
- **SIGHUP stops a desktop app gracefully**, the same way as SIGTERM: through
  the shutdown path, which also ends a first-run Electron install still in
  progress — its whole process tree (`taskkill /T /F` on Windows). An app
  started under `nohup` keeps ignoring it. Headless apps still outlive their
  shell.
- **Lock files are published whole** (by link / rename, mode 0600), never
  half-written. Next to `<app>.lock` in the lock dir you may briefly see
  `<app>.lock.mx` (the per-lock mutex) and `<app>.lock.<pid>.<nonce>.tmp`. Temp
  files left by a killed process are swept at the next acquire. A scoped lock
  dir (`aio-<scope>`, one per `AIO_APPS_DIR`) is removed at exit by the process
  that created it once it is empty; before, only an app's shutdown did, and `am`
  commands and in-process tests left them behind. Its apps root is recorded
  outside it, in `<runtime dir>/.aio-roots/<dir name>` (read only by
  `check:orphans`), so a 1.0.9 app's exit prune still empties it.
- **A lock is removed only while it still names the owner that was judged
  dead.** `am stop` / `am status` / `am instances` / the boot compare before
  they delete. Before, a lock re-published in between (a restarted instance)
  could be deleted, and a second instance then opened the same `state.db`. A
  lock dir is emptied file by file, never recursively: a socket some process is
  bound to keeps it (a `singleton: false` app holds no lock). A control socket
  is bound after its lock dir is re-created if a sibling pruned it, and the dir
  is re-checked (yours, 0700, not a link) on every bind. An unreadable lock that
  names no live process is swept once it is 10 minutes old.
- **`am`'s own lock writes compare first too** (the `stopping` mark, the
  `started` repair, the `am start` placeholder): they write only while the lock
  still names the process `am` read (same pid and start). An app that finishes
  booting meanwhile is still that process and is stopped as asked. When ANOTHER
  process holds the lock by then, `am stop` stops nothing and says so; re-run
  it.
- **`am start` says when it cannot record the launch** (`launch.json` in the
  app's home — a read-only or foreign home): `am restart` then cannot replay
  `--env-file` and the other flags. It used to be silent.
- **A control socket whose path is too long** (over ~100 bytes — a long appId
  under a scoped runtime dir) moves to `/tmp/aio/<appId>-<hash>.sock` instead of
  `/tmp/aio/<appId>.sock`. The hash covers the scope and home, so two instances
  of one appId no longer share a socket. The lock records the path; `am` finds
  it there.
- **macOS: a lock records its owner's start time as UTC epoch seconds**
  (`startEpoch`, new field). The 1.0.9 `startToken` there was `ps` text in the
  reader's time zone and language, so `am` in another zone or locale took a live
  app for a recycled pid. A 1.0.9 lock's text token is ignored, and pid liveness
  decides.
- **`am` prints two kinds of text two ways.** What `am` composes (status lines,
  refusals, the instances table — lock-file text inside) has control, bidi and
  zero-width characters replaced; only aio's own colour codes pass. What you
  asked to see — `am state`, `am dispatch`'s return value, `am errors`,
  `am logs` (and `-f`), `am eval`, `am surface`, `am trigger`'s reply,
  `am timeline`, `am record` — is passed through byte-exact when piped; on a
  terminal only the escape sequences that would move the cursor, clear the
  screen or set a title/link are removed, however deep in the value they sit. A
  ZWJ emoji, an RLM and the app's own colours display as written. A lock file
  itself is read byte-for-byte.
- **A control socket at a path with runs of spaces or a tab** is recognised as
  bound when a lock dir is pruned. Before, such a path was read with its
  whitespace folded, and the live socket could be removed as unbound.
- **The version store (`~/.local/lib/aio-versions`):**
  - `git` runs with `LC_ALL=C`, so a translated git is read correctly;
  - a finished checkout gets a `<version>.provisioned` marker next to it. An
    older complete checkout without one is checked and kept;
  - a version another `am` is still provisioning is refused ("being provisioned
    right now"), never torn down;
  - a torn checkout that cannot be removed is refused by name;
  - dead registrations are removed by exact path only. There is no repo-wide
    `git worktree prune`, so your own worktrees are never forgotten.
- **Boot warns about a misplaced `diagnostics` key**, for example
  `diagnostics: { checkpoint: false }` written at the top instead of under `dev`
  / `prod`. It was a silent no-op before; it still boots.

## Retire

Workarounds this release lets an app delete:

- **A per-request lock or queue around `renderToStream()`**, or setting
  `routePath` again inside the stream's `start()`, added because a streamed page
  sometimes rendered another request's route. The stream takes its route at the
  call (1.0.10-beta).
- **Wrapping a root Provider in an extra element** so the page would stream. A
  Fragment root streams (1.0.10-beta).

Nothing else — no API was removed, so no call site has to move.
