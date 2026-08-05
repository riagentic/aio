# App Manager

Manage your aio app without `ps`, `kill`, or `curl`. Works for humans and AI
agents alike.

```sh
deno task am <command> [args] [--flags]
```

> Prefer a GUI? **amui** (Aio Manager UI) is the visual app manager — discover,
> inspect (cells, merged state with persist/UI flags, metrics, files), and
> start/stop every aio app on your machine. See [amui](amui.md).

Output auto-detects: terminal -> pretty text, piped -> JSON. Override with
`--json` or `--quiet`.

## Building a cloned aio app (`am fix`)

A freshly cloned aio app usually **won't build yet** — the framework link,
`.env`, electron runtime and `node_modules` are all gitignored, so they're not
in the clone. `am fix` analyzes the repo and repairs the common breakages in one
go:

```sh
# 1 — install am + the framework (once per machine)
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh
# 2 — in the cloned app
cd my-app
am fix             # repair everything it can; then run: deno task dev
am fix --dry-run   # (alias --check) show what it WOULD do, change nothing
# 3 — build/run
deno task dev
```

`am fix` **only auto-applies safe, reversible, machine-specific repairs** — the
gitignored/uncommitted bits a fresh clone lacks — with exactly one exception,
the version pin below. Anything else that touches your committed source or
config it **advises** rather than changes.

Auto-fixed (safe):

| Fix                        | When                                                   |
| -------------------------- | ------------------------------------------------------ |
| `dep/aio` framework link   | source-layout app; symlink missing/broken (gitignored) |
| **`aioVersion` pin**       | **app is unpinned — records the version it links**     |
| `.env` from `.env.example` | example present, `.env` missing                        |
| electron runtime           | app imports electron; `node_modules/electron` missing  |
| git submodules             | `.gitmodules` present but not initialized              |
| shell scripts executable   | a task runs a `.sh` that lost its `+x` bit             |
| missing standard tasks     | add-only, and only for the targets the app declares    |
| dependency cache           | warms `deno cache` — surfaces any resolution error     |

Task repair is **add-only and scoped to the fleet**: `am fix` adds the
universally useful tasks (`dev`, `build`, `compile`, `test`, `am`, `doctor`,
`lint`) plus the ones the app's declared targets need — read from `target` and
`build.targets` (either spelling: the array `["browser"]` or the object form
with per-target overrides). A browser-only app never gets `dev:android`,
`dev:cli` or `dev:service`. A task the app already has is never rewritten or
removed, so a curated task list survives every repair.

### The seal: an unpinned app gets pinned

`am create` records `"aioVersion"` in the app's `deno.json`; `am fix` is the
safety net for an app that arrives without one. It writes down the version it is
about to link, and reports it:

```
✓ aio version pin — was unpinned — recorded "aioVersion": "v1.0.0-alpha41" in
  deno.json so every future clone rebuilds against this exact framework
```

This is the one committed-source edit `am fix` makes, and it is what makes "an
aio app keeps running" a fact rather than a hope: an unpinned app links to
whatever aio happens to be installed, so a framework release it never asked for
can break it. A pinned app builds against its own worktree forever.

It never overrides a pin you chose — an app held at an older release stays
there. `--dry-run` reports the seal and writes nothing. Change it any time with
`am pin <version>` (or `am pin --latest`, which stays within your major).

`am fix` also reports how far behind the pin is — an advisory, never a change. A
pin is a promise, not a prison: the app keeps building exactly as pinned, and
its author can still see that the world moved.

### Moving forward: `am pin` checks before it moves

Changing a pin reads the app's own source first, through the framework's removal
registry, and refuses a move that would break it:

```
✗ v1.0.0-alpha42 would break this app — 1 removed API(s) still in use:
  src/cell/a field report.ts:61
    cell config key 'machine:' was removed in alpha27 — guards are a guard line
    — `if (s.status !== "idle") return;`. Migrate: docs/upgrade/restructure.md
    — or run it unchanged on the version it was written for:
    `am pin v1.0.0-alpha26 && am fix`.
  Migrate them, pin a version that still runs them, or re-run with --force to
  pin anyway.
```

The pin does not change; nothing is written. `--force` pins anyway — the check
informs, it does not forbid. Moving **backward** to a version that still accepts
the old spelling is silent, and `main` (or a path pin) counts as the tip, so it
is checked like the newest release.

Advised, never changed for you: `deno.json` config (`jsx`/`jsxImportSource`/
`nodeModulesDir`), a missing `appId` in `aio.run()`, a Deno version below the
floor. For code-level issues (deprecated APIs, older-version patterns) `am fix`
points you at the linter — `deno task lint:aio` (aiol) — it won't rewrite
source.

It recognizes **how the app consumes aio** and acts accordingly: a `dep/aio`
symlink is created/repaired; a **JSR/npm pin** needs no link (skipped); a **real
vendored `dep/aio` copy** (a committed directory, not a symlink) is **never
touched** — `am fix` only ever creates or repairs a symlink, it will not delete
deliberately-vendored framework code.

**Related:** `am doctor` diagnoses deno.json config only (read-only, PASS/FAIL);
`am link` is the narrow primitive that only (re)creates the `dep/aio` symlink
(`--aio=<path>` / `$AIO_HOME` to point it elsewhere). `am fix` includes both.

## App identity

Every aio app requires `appId` in the `aio.run()` call:

```ts
await aio.run({
  appId: 'my-app',
  cells: [...]
})
```

This is the single source of truth for app identity — used for lock files, UDS
sockets, the `state.db` path, and `am` commands. The value is slugified
(lowercase alphanumeric + hyphens). **`appId` is mandatory** — the app will not
start without it.

For `am` commands, use `--app=X` to specify which app to manage, or add `appId`
to `deno.json` as a dev convenience.

## Global flags

| Flag         | Effect                                                                               |
| ------------ | ------------------------------------------------------------------------------------ |
| `--app=X`    | Target a specific app by ID (default: from `deno.json` `appId`)                      |
| `--port=N`   | Target a specific port (default: from lock file or 8000)                             |
| `--wait[=N]` | start/stop: block until complete (default 10s/5s). state: poll every Ns (default 2s) |
| `--json`     | Force JSON output                                                                    |
| `--quiet`    | Suppress output (exit code only)                                                     |

## Reaching an app that has auth (`control.key`)

`am` and amui talk to the app's control plane (`/__aio/trojan/*`) — raw state,
dispatch, SQL, whole-state replace. That endpoint is same-machine-only and
dev-only, and on an app running `auth: true` / `users:` / `resolveUser` it also
requires authority, because it is `/__aio/snapshot`'s power and more.

The authority is **owning the machine**, not membership in the app. At boot a
dev app mints `<data>/control.key` — 256 bits, mode `0600` inside the `0700`
data dir, fresh every boot and deleted at shutdown. `am` reads it and presents
it as a header on control-plane calls only; it never travels to `/ws`, to your
app's routes, or to `/__aio/snapshot`.

Nothing to configure. If `am` cannot read it you get a refusal that names the
file and distinguishes "no credential" from "a stale one", instead of a bare
401.

Deliberately **not** the app key: the app key is shareable on purpose
(`am profile`, `/__aio/pair`, `.aioapp`), so whoever paired a phone over the LAN
would hold your whole database; and it does not exist at all in the auth modes
where this problem occurs. A per-boot file that dies with the process has no
rotation story and a stolen copy is worthless.

> Two apps on one machine mean two `am` targets. `am instances` disambiguates
> them, and running `deno task am` from each app's own directory does the right
> thing — the failure mode (`app not running on port 8000`) otherwise reads like
> the app is down when you are simply pointed at the other one.

## Pairing a client (`am pair`)

```sh
am pair            # a fresh single-use PIN, without restarting the app
```

A keyed app prints a pairing PIN at boot, single-use and short-lived. Once it is
used or expires, `am pair` issues another — previously the only way to get a new
one was to restart the app, which the docs told you to do with a command that
did not exist.

## Process management

```sh
deno task am start                # start app (kills zombies, refuses if running)
deno task am start --wait         # start and block until healthy (default 10s timeout)
deno task am start --wait=30      # start with 30s timeout
deno task am start --port=9000    # start on specific port
deno task am stop                 # graceful shutdown
deno task am stop --wait          # stop and block until dead (default 5s timeout)
deno task am restart              # stop + start
deno task am status               # stopped|starting|started|stopping
```

Exit codes: `started` -> 0, `stopped` -> 1, `starting`/`stopping` -> 2.

`start` and `stop` return immediately by default — use `--wait[=N]` to block
until the action completes. `restart` always waits for stop internally, then
spawns and returns immediately. `stop` tries graceful shutdown via trojan API,
falls back to SIGTERM, escalates to SIGKILL after timeout. Kill sequence:
SIGTERM -> wait 2s -> SIGKILL.

### Singleton behavior

Controlled by `singleton` in `aio.run()`:

| Value            | Behavior                              |
| ---------------- | ------------------------------------- |
| `true` (default) | Refuse if another instance is running |
| `'takeover'`     | Kill existing instance, start new one |
| `false`          | Allow multiple instances              |

Lock files at `/tmp/aio/` (or `$XDG_RUNTIME_DIR/aio/`) as `{appId}.lock`. Stale
locks (dead PID) are auto-cleaned. Zombies (alive but not responding) are killed
automatically on `start`.

## Instance discovery

```sh
deno task am instances            # list all running aio apps on this machine
deno task am ls                   # alias
deno task am instances --json     # JSON output
```

Scans lock files, validates each PID is alive, returns active instances with
appId, port, PID, uptime, and cwd.

**Two apps on one machine mean two `am` targets.** Every `am` command resolves
ONE app — from `--app=<id>`, else the `deno.json`/entry in the current directory
— so running `deno task am` from each app's own directory does the right thing,
and `am instances` disambiguates when you are unsure which is up and on which
port. Read `app not running on port 8000` as "am aimed at the wrong app" at
least as often as "the app is down": it is what you get when `am` is run from
outside an app directory, or against a second app that took a different port.
`am` refuses to touch a port that answers as a different appId, so a wrong
target is a loud error, never a silent write to the other app.

**Programmatic:**

```ts
import { instances, resolveAppId } from "aio/extras";

const running = await instances(); // all running apps
const mine = await instances("my-app"); // specific app
const id = resolveAppId("My Cool App!"); // canonical slug: 'my-cool-app'
```

## State inspection

```sh
deno task am state                          # full state (raw, unfiltered)
deno task am state counter                  # single cell slice
deno task am state counter.count            # nested path
deno task am state fleet[0].stats           # array index traversal
deno task am state fleet[0].{name,active}   # pick specific fields
deno task am state fleet[*].{pair,status}   # wildcard: pluck from every element
deno task am state {counter,page}           # pick from root
deno task am state counter --wait=5         # poll every 5s
deno task am ui                             # UI state (cell-level ui filtered)
deno task am ui alice                       # UI state for specific user
```

Path syntax: `fleet[0].stats.pnl` for traversal, `{id,name}` for field picking,
`[*]` for wildcard over arrays. `am state` = raw server state. `am ui` = what
the browser sees.

## Action dispatch

```sh
# Cell methods — POSITIONAL args (no =): increment(5), setHost("10.0.0.1")
deno task am dispatch counter:increment 5                    # increment(5)
deno task am dispatch conn:setHost 10.0.0.1                  # setHost("10.0.0.1")
deno task am dispatch counter:reset                          # reset()

# …the same, JSON-exact. Use it when a value contains '=' (a URL, a base64
# blob), or when the exact type matters.
deno task am dispatch conn:setHost --args='["192.168.1.9"]'  # setHost("192.168.1.9")
deno task am dispatch conn:configure --args='[{"host":"h","port":8000}]'

# One object argument, spelled as named pairs: configure({host, port})
deno task am dispatch conn:configure host=h port=8000

# Plain (non-cell) actions — named payload
deno task am dispatch BulkUpdate items='[1,2]'               # payload { items: [1,2] }

# Raw envelope
deno task am dispatch --body='{"type":"conn:setHost","payload":{"args":["192.168.1.9"]}}'

deno task am actions                       # last 20 actions from history
deno task am actions 50                    # last 50 actions
```

A cell method is called with POSITIONAL arguments. Bare values (no `=`) become
those arguments, and `--args='[…]'` is the same list written as JSON — the
spelling to reach for when a value contains `=` or must keep its exact type.
Values without `--args` are auto-parsed: numbers, booleans, `null`, JSON
arrays/objects, else strings.

`key=value` pairs are collected into ONE object: after a `cell:method` type they
become the method's single object argument (`configure({host, port})`), and for
a plain action type they are the payload itself. A method taking one string
therefore has no `key=value` spelling — that is what `--args` is for.

`--body` is the whole envelope (`{type, payload}`) when it stands alone, and the
PAYLOAD of the action when a type is given positionally.

## Time-travel

In browser (dev mode): press **Ctrl+.** to toggle the time-travel panel. Shows
action history with timestamps and performance metrics (`reduce:ms effects:ms`).

From the CLI, three commands expose the DISPATCH history — what ran, what
triggered it, and what it changed:

```sh
deno task am timeline                       # recent dispatches + payload + state diff (live)
deno task am timeline --lines=50            # last 50
deno task am timeline --from=<data>/journal  # offline, from a durable journal file
deno task am replay 5..12                   # re-dispatch journal seq 5..12 for repro
deno task am replay 5..12 --dry             # show what would replay, dispatch nothing
deno task am record flow.test.ts --from=J   # turn a journal into a bootCells test
```

- **`am timeline`** reads a live, always-on in-memory ring on the running app —
  each entry carries the compact state diff the dispatch produced
  (`counter.n: 0 → 1`). With `--from=<journal>` it reads a durable journal file
  instead (payloads only — the on-disk journal, `journal: true`, stores actions,
  not diffs). It prints **payloads**, so an action called with a secret shows
  that secret here: list it in `redactActions`
  ([where files live](../persistence/where-files-live.md#secrets-in-recorded-actions)).
- **`am replay <range>`** re-dispatches a journal range against the running app,
  in order, stopping at the first failure — deterministic repro for the "froze
  in the client but the test passed" class. Point it at a fresh instance to
  reproduce a captured session. `--dry` lists the range without dispatching.

Range forms: `N` (one seq), `N..M` (inclusive), or omit for all. Both read
`<data>/journal` by default; override with `--from=<path>`.

**`sync: true` cells are not in this history.** Their changes are durable in the
CRDT op-log rather than the dispatch journal, so the timeline and replay do not
carry them — read current values with `am state`, and see
[CRDT Protocol](../persistence/crdt-protocol.md) for how those writes are stored
and replayed. (This section previously said the commands show "every state
change", which was not true of sync cells.)

## Persistence and snapshots

```sh
deno task am persist                        # force flush to SQLite
deno task am snapshot                       # dump state to stdout
deno task am snapshot save backup.json      # save to file
deno task am snapshot load backup.json      # restore from file
deno task am migrations                     # cell versions + shape drift
```

**`am migrations`** shows each cell's declared vs stored `version`, what the
last boot's migration pass did, and any **shape drift** — a field still in
storage that the cell's current `initialState` no longer declares (a
rename/removal without a `version` bump, which `deepMerge` would silently keep).
Boot also warns about drift; this is the on-demand view. A cell shape change is
covered by bumping `version` + adding an `onMigrate(state, from)` hook.

## Which aio version an app builds against

An app scaffolded by `am create` imports the framework through a gitignored
`dep/aio` symlink. That keeps `deno.json` portable, but on its own it says
nothing about WHICH aio the app was written for — so a clone a month later would
build against whatever version happened to be installed. The pin fixes that:

```jsonc
// deno.json — committed with your code
{ "aioVersion": "v1.0.0-alpha38", … }
```

```sh
am pin                    # what this app asks for, what it's linked to, what's available
am pin v1.0.0-alpha38     # switch: provision that version, relink, record it
am pin main               # follow the branch tip (a moving target, re-synced on every `am fix`)
am pin --latest           # newest release
am pin /path/to/aio       # LOCAL-DEV pin: follow a framework checkout on this machine
```

A **path pin** records `aioVersion: "path:/abs/checkout"` — every later `am fix`
keeps linking that checkout, which is the workflow for developing an app against
a work-in-progress framework. It is machine-specific by design: on a machine
without that path, `am fix` fails loudly with the fix instead of silently
linking something else. Return to a reproducible release with `am pin --latest`.

Inside a path-pinned app, the installed `am` **delegates** to the pinned
checkout's own am (announced on stderr; `AIO_AM_NO_DELEGATE=1` opts out) — so am
behavior always matches the framework the app is built against, unpushed
commands included. To use a checkout's am **everywhere** (even before any app
exists), switch the global install: `am update /path/to/aio` — a dev am on live
files, so your edits apply immediately. Plain `am update` returns to the
released am; it never git-mutates a dev checkout it happens to be running from.
First switch, when the installed am is a release that predates this verb: run
the checkout's own am once — `cd <checkout> && deno task am update .`.

`am create` pins the **newest release** by default;
`am create app --aio-version=main` opts into the tip. The clone → build path is
then:

```sh
git clone <your-app> && cd <your-app>
am fix          # reads aioVersion, provisions that exact version, links it
deno task dev
```

**How versions are provided.** `install.sh` clones aio with full history, so any
tag is available as a **git worktree** under `~/.local/lib/aio-versions/<tag>/`
— about 8 MB of source per version, with the git objects shared, not
re-downloaded. Several apps on one machine can pin several versions at once.
`AIO_VERSIONS_DIR` moves the store (containers, CI).

**Drift is a failure, not a note.** If `dep/aio` points somewhere other than the
pin, `am pin` says so and exits non-zero (usable as a CI check), and
`aio doctor` fails the `framework pin matches dep/aio` line. `am fix` corrects
it.

Two escape hatches, both deliberate: `--aio=<path>` (and `am create --mirror`)
link a live checkout for framework development, and a real directory at
`dep/aio` is treated as a vendored copy and never touched.

## What aio costs you (`am cost`)

```sh
am cost                # bytes/s per cell, which keys, reduce p95, per client
am cost --keys         # every key, not just the top three
am cost --cell=hw --window=5m
am cost --json
```

The one command that makes `aiol`'s state-size hints triageable: it reports the
exact bytes crossing sockets, attributed to the cell and key they came from. See
[performance](../debugging/performance.md#am-cost--what-aio-moves-on-your-behalf)
for how to read each column.

## Files, backup, restore

`am snapshot` is cell **state**, as JSON, from the running app. These are the
**files** — including `auth.db`, the app key and the TLS material, which are not
cell state and which a state snapshot therefore doesn't contain.

```sh
am data                      # every path this app uses + sizes, by tier
am data --json               # machine-readable

am stop wallet               # a live SQLite file can copy mid-write
am backup                    # → ./wallet-backup-<stamp>/  (a copy of data/)
am backup /mnt/usb/w1        # …or anywhere
am restore /mnt/usb/w1       # put it back
```

Everything durable lives in `~/.<appId>/data/`, so backup is a directory copy —
see [Where Files Live](../persistence/where-files-live.md) for the layout. What
the commands add over `cp -r` is two refusals:

- **`am backup` refuses while the app is running.** A SQLite `-wal` file holds
  committed pages the `.db` doesn't have yet, so a copy taken mid-write can be
  internally inconsistent. `--force` overrides and marks the result
  `tornRisk: true`.
- **`am restore` refuses another app's archive** (`meta.json` records the appId)
  and refuses outright while the app runs — a running app would write its
  in-memory pages back over what you restored. There is no `--force` for that.

A restore **moves** the data it replaces to `data.replaced-<stamp>` rather than
deleting it, so restoring the wrong archive is recoverable.

## UI inspection and interaction (dev mode)

Inspect and drive the live UI from the CLI through the **semantic UI surface** —
the same facility `testUI` uses, so what you do here and what a test does behave
identically. Elements are addressed by component/name, not CSS selectors.

```sh
deno task am ui                              # server-side UI state
deno task am surface                         # semantic surface (client 0): every component + triggerable element
deno task am surface 1                       # surface for a specific client
deno task am trigger 0 App:SubmitButton click        # click by component:name path
deno task am trigger 0 App:Email type "a@b"          # type into an input — APPENDS
deno task am trigger 0 App:Email setValue "a@b"      # REPLACE the field's value
deno task am trigger 0 App:Search focus               # focus / blur / hover / scroll / press
deno task am trigger 0 App:Stage keyDown ArrowLeft    # HOLD a key (games, drag) …
deno task am trigger 0 App:Stage keyUp ArrowLeft      # … then release it — press is a tap
```

`type` APPENDS to the field's current value (a user typing into a field that
already has one); `setValue` clears first, then types — use it to drive a form,
where replacing is the usual intent. Same two words, same two meanings as
`testUI`'s `ui.X.type()` / `ui.X.setValue()`, because both drive the same UI.

Run `am surface` first to see the addressable `Component:name` paths, then
`am trigger` them. This is the one unified UI facility — the old CSS-selector
`am interact`/`am click` and raw `am dom` snapshot were removed in favour of it.

Scope a big surface instead of piping it into a script:

```sh
am surface --component=CtxControls   # every instance, with its subtree
am surface --path=App/Main           # one subtree by path prefix
am surface --depth=1                 # top level only
am surface --full                    # untruncated element text
```

A filter that matches nothing exits non-zero and lists the components that ARE
in the surface — an empty result is nearly always a typo.

## Monitoring

```sh
deno task am clients              # connected clients (type, transport)
deno task am schedules            # active timers/cron
deno task am metrics              # uptime, connections, schedule count
deno task am health               # health check (exit 0 = ok)
deno task am config               # server config
deno task am sql "SELECT ..."     # read-only SQL query
deno task am tables               # list SQLite tables
deno task am log                  # tail last 50 lines
deno task am log --filter=ERROR   # filter log lines
deno task am log --follow         # stream (like tail -f), also: -f
deno task am log --client         # tail client log (~/.<appId>/logs/client.log)
deno task am errors               # last transpile error (dev mode)
deno task am watch                # hot-restart on file change in src/
deno task am new cell payments # scaffold cell
deno task am new page settings    # scaffold page
```

## Trojan — Control REST API

REST API at `/__aio/trojan/*` for inspection and control. Available in dev and
prod.

### Inspect (GET)

| Endpoint                      | Returns                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| `/__aio/trojan/state`         | Raw full state (unfiltered)                                     |
| `/__aio/trojan/ui`            | UI state (cell-level ui filtered)                               |
| `/__aio/trojan/ui?user=alice` | UI state for specific user                                      |
| `/__aio/trojan/clients`       | Connected clients (type, transport, index)                      |
| `/__aio/trojan/surface/<n>`   | Semantic UI surface from client n (dev)                         |
| `/__aio/trojan/trigger/<n>`   | POST: drive the UI ({path, action, text?})                      |
| `/__aio/trojan/history`       | Time-travel entries                                             |
| `/__aio/trojan/timeline`      | Recent dispatches + payload + state diff (`?after=`, `?limit=`) |
| `/__aio/trojan/migrations`    | Cell versions (declared vs stored) + shape drift                |
| `/__aio/trojan/schedules`     | Active timer/cron IDs                                           |
| `/__aio/trojan/metrics`       | Uptime, connections, schedule count                             |
| `/__aio/trojan/config`        | Port, title, expose, authMode, prod                             |
| `/__aio/trojan/health`        | Cell health: status, enabled, errors                            |

### Control (POST)

All POST endpoints require the `X-AIO: 1` header (CSRF protection). All return
JSON. Auth is inherited — tokens required when `--expose` is active.

```sh
# Dispatch action
curl -X POST localhost:8000/__aio/trojan/dispatch \
  -H 'X-AIO: 1' -H 'Content-Type: application/json' \
  -d '{"type":"INCREMENT","payload":{"by":1}}'

# Force persist
curl -X POST localhost:8000/__aio/trojan/persist -H 'X-AIO: 1'

# Time-travel (dev only)
curl -X POST localhost:8000/__aio/trojan/tt -H 'X-AIO: 1' -d '{"cmd":"undo"}'
curl -X POST localhost:8000/__aio/trojan/tt -H 'X-AIO: 1' -d '{"cmd":"goto","arg":3}'

# SQL query (read-only)
curl -X POST localhost:8000/__aio/trojan/sql -H 'X-AIO: 1' \
  -d '{"query":"SELECT * FROM users LIMIT 10"}'

# Interact with client UI
curl -X POST localhost:8000/__aio/trojan/interact/0 \
  -H 'X-AIO: 1' -H 'Content-Type: application/json' \
  -d '{"action":"click","selector":"#submit"}'
```

## HTTP endpoints

| Endpoint               | Availability | Purpose                                    |
| ---------------------- | ------------ | ------------------------------------------ |
| `/`                    | always       | HTML shell — entry point                   |
| `/ws`                  | always       | WebSocket — state sync, actions, deltas    |
| `/__aio/ui.js`         | dev only     | Live-transpiled browser code               |
| `/__aio/error`         | dev only     | Error overlay                              |
| `/__aio/snapshot` GET  | always       | Full raw state dump                        |
| `/__aio/snapshot` POST | always       | Load state from JSON                       |
| `/app.js` `/style.css` | prod only    | Pre-bundled dist assets                    |
| `/__aio/trojan/*`      | always       | Control REST API (dev-only -> 403 in prod) |

## For AI agents

`am` is designed for programmatic use. Output is JSON when piped:

```sh
deno task am health && echo "up" || echo "down"
deno task am state | jq '.fleet[0].stats'
deno task am dispatch portfolio:buy symbol=AAPL qty=10
deno task am surface --json | jq '.[].elements[] | select(.text == "Login")'
deno task am trigger 0 App:LoginButton click
deno task am log --client --json | jq -r '.lines[]' | grep ERROR
```

## Troubleshooting

| Problem                          | Fix                                                     |
| -------------------------------- | ------------------------------------------------------- |
| `am status` says "stopped"       | No running process. Check `.aio.log` for errors         |
| `am start` says "port in use"    | Non-aio process on port. Use `--port=N`                 |
| `am` targets wrong app           | Check `appId` in `aio.run()` — use `--app=X`            |
| Actions do nothing               | Check browser console + `--verbose` log for WS messages |
| State resets on restart          | Ensure `persist` isn't `false`/`"none"`                 |
| Port in use                      | Kill old process or use `--port=N`                      |
| Server dies when Electron closes | Use `--keep-server` flag or `keepServer: true`          |
