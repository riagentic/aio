# App Manager

Manage your aio app without `ps`, `kill`, or `curl`. Works for humans and AI
agents alike.

```sh
deno task am <command> [args] [--flags]
```

> Prefer a GUI? **amui** (Aio Manager UI) is the visual app manager — discover,
> inspect (cells, merged state with persist/UI flags, metrics, files), and
> start/stop every aio app on your machine. Launch it with `am ui`
> (`--client=browser` for a tab). See [amui](amui.md).

Output auto-detects: terminal -> pretty text, piped -> JSON. Override with
`--json` or `--quiet`.

## If you are an AI agent (`am agent`)

```sh
am agent                # the page (Markdown)
am agent --min          # compact: rules, model, the loop, a cell, a component, a test
am agent --max          # everything, deep sections included
am agent --list         # the sections, with the size each appears at
am agent --task=rules   # one of them
```

One command, no page to find. It prints the contract for working on an aio app:
what a cell is, which verb answers which question, and the habits that cost the
human on the other end something — ending apps by process match
(`pkill -f app.ts` matches EVERY aio app on the machine, not just yours),
opening windows on their desktop, and scripting around `am` for answers a verb
already has.

It prints as text even into a pipe, because the text is the payload; `--json`
gives the sections addressable. `am create` writes an `AGENTS.md` into every new
app that points here — and a one-line `CLAUDE.md` importing it, because Claude
Code loads that file and not `AGENTS.md` — so an agent that never opens a doc
still finds it.

## Diagnose, repair, migrate — which verb?

Three verbs people conflate. Each answers a different question:

| Question                                                               | Verb               | Mutates the tree?                                               |
| ---------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------- |
| Is the _running_ process on the aio that is on disk right now?         | `am doctor`        | No — names `am restart` when stale                              |
| Is _deno.json / pin / tasks_ healthy?                                  | `deno task doctor` | No (config diagnosis)                                           |
| Make a clone/checkout runnable (symlink, env, electron, missing tasks) | `am fix`           | Yes — safe, reversible, mostly machine-local; `--dry-run` first |
| Only the `dep/aio` symlink                                             | `am link`          | Yes — the tiny sibling of `fix`                                 |
| What _retired APIs_ does this app still use?                           | `am migrate`       | No — inventory; rewrites live in `aiol --safe-fix`              |

`am fix` is not an API migrator. `am migrate` is not a clone repairer.
`am doctor` is not either.

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

Task repair is **add-only and scoped to the fleet**: `am fix` adds the universal
tasks (`dev`, `build`, `compile`, `test`, `check`, `fmt`, `am`, `doctor`,
`lint`) plus `install:electron` when the app's declared targets need it — read
from `client` (formerly `target`) and `build.targets` (either spelling: the
array `["browser"]` or the object form with per-target overrides). A task the
app already has is never rewritten or removed, so a curated task list survives
every repair.

`am fix` also renames the deprecated deno.json `target` key to `client`
(mechanical, value untouched), and when it sees the pre-alpha52 task matrix
(`dev:service`, `compile:remote:*`, …) it points at the migration:

```sh
am fix --migrate-tasks
```

`--migrate-tasks` converts an old scaffold to the one vocabulary: pristine
old-scaffold tasks are **deleted** (the new matrix covers them — dev flags pass
through, `deno task build` builds the fleet) or rewritten; `*:service` names
rename to `*:server`; anything whose command you customized is **kept** and
reported as "review manually" — it never deletes a user-edited task.

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
✗ v1.0.0-alpha42 would break this app — 1 removed API(s) still in use (by directory: src/ 1):
  src/cell/app.ts:61
    | machine: { initial: "idle", states: { idle: {} } },
    cell config key 'machine:' was removed in alpha27 — guards are a guard line
    — `if (s.status !== "idle") return;`. Migrate: docs/upgrade/restructure.md
    — or run it unchanged on the version it was written for:
    `am pin v1.0.0-alpha26 && am fix`.
  Migrate them, pin a version that still runs them, or re-run with --force to
  pin anyway. A directory that is not this app's code is skipped once deno.json
  `exclude` / `fmt.exclude` or .gitignore says so.
```

The pin does not change; nothing is written. `--force` pins anyway — the check
informs, it does not forbid. The scan reads **code**, not text: a removed key
spelled inside a string, a template literal, a comment or a regex is not a hit,
and every hit quotes the line it matched (`| …`). A hit on a **test/fixture
path** (`tests/`, `test/`, `*.test.*`, `fixtures/`, `util/selftest`) is an app's
own upgrade fixture, not a config it boots with: it is printed as a warning with
the same quoted line, and the pin proceeds. Moving **backward** to a version
that still accepts the old spelling is silent, and `main` (or a path pin) counts
as the tip, so it is checked like the newest release.

A removed **cell-config key** (`execute:`, `machine:`, `actions:`,
`generators:`…) counts only inside a cell config literal: a `cell(…)` argument
list, or an object bound to a name that a `cell(…)` call receives
(`cell("c", config)`, `{ ...base }`). Those are ordinary English words, and a
plain object key elsewhere — a tool-name alias table, a record of scope labels —
is not a hit.

The scan reads **the app's own source**: never `dep/`, `node_modules/`, `dist/`,
`build/`, `coverage/`, `target/` or a dot-directory, and never a path the app
declares is not its code — deno.json `exclude`, deno.json `fmt.exclude`, or
`.gitignore`. A vendored copy of another project kept for reference is answered
by listing it there; `am migrate` and `aiol` read the same declaration. The
refusal leads with the count per top-level directory, so a wall of findings from
one place reads as the decision it is.

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

**Related:** `am doctor` asks the other half of the question — is the process
answering `am state` running the framework that is on disk right now? A newer
`dep/aio` (a pull, an `am fix`) than the instance's start time is a finding, and
the finding names its fix: `am restart`. It also lists each running instance's
settings that have more than one home, with who decided each —
`persist  false (config)`, `dbPath  "/srv/x.db" (flag)` — so "which of my flag,
config and deno.json won?" is answered by the process itself (the same lines
`--verbose` prints at boot). `deno task doctor` diagnoses deno.json config only
(read-only, PASS/FAIL); `am link` is the narrow primitive that only (re)creates
the `dep/aio` symlink (`--aio=<path>` / `$AIO_HOME` to point it elsewhere).
`am fix` includes both.

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

| Flag           | Effect                                                                                                                                                                                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--app=X`      | Target a specific app by ID (default: from `deno.json` `appId`)                                                                                                                                                                                                                                                 |
| `--port=N`     | Target a specific TCP port. Normally unneeded: `am` reads the port — or the socket — from the app's lock file (see "Which transport")                                                                                                                                                                           |
| `--wait[=N]`   | `start` blocks by DEFAULT (10s; `--no-wait` opts out). `stop` blocks by DEFAULT too, until the process is gone (11s — the graceful budget of 8s plus the exit watchdog's slack — then SIGKILL; exit 1 if it survives even that; `--no-wait` returns once the signal is sent). state: poll every Ns (default 2s) |
| `--no-wait`    | `start`: return as soon as the child is spawned, before it has picked a port. `stop`: return once the stop is sent, before the process is gone                                                                                                                                                                  |
| `--json`       | Force JSON output                                                                                                                                                                                                                                                                                               |
| `--quiet`      | Suppress output (exit code only)                                                                                                                                                                                                                                                                                |
| `--profile=X`  | Start or target profile `X` of the app — a name (`~/.<appId>-X`, key `<appId>@X`) or a path. `am start myapp@X` is the short form. See [Profiles](#profiles-several-copies-of-one-app)                                                                                                                          |
| `--home=DIR`   | The path form of `--profile`: start or target the instance whose data home is `DIR`. `am start --home` starts one there (1.0.9 refused). See [Profiles](#profiles-several-copies-of-one-app)                                                                                                                    |
| `--timeout=MS` | `surface`/`trigger`: how long to wait for the live client (default 8000; must exceed the server's own 5000 ms client wait)                                                                                                                                                                                      |

A value `am` cannot act on is refused before any verb runs, never guessed:
`--app=` and `--entry=` with nothing after the `=` are errors (an unset shell
variable used to make `am` infer a target the script never named), and the same
flag given twice with two different values — `--app=one --app=two` — is a
contradiction rather than a preference for the last one. The same value twice is
fine, and after `--` anything flag-shaped is an argument.

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

**Where the data is.** Three things are spelled like "where this app lives" and
only one moves the database:

|                       |                                                        |
| --------------------- | ------------------------------------------------------ |
| `--profile <name>`    | a separate home beside the app's own (`<home>-<name>`) |
| `--home <dir>`        | that exact folder — the path form of `--profile`       |
| `AIO_APPS_DIR`        | moves the ROOT that homes resolve under                |
| `aio.run({ appDir })` | moves the app's own directory, and the data with it    |

The first two are per RUN (pass them on every verb); see
[Profiles](#profiles-several-copies-of-one-app) for which one to use.

`am instances --json` reports `dataDir` on every row (`null` for a lock written
before 1.0.0-beta), and `--long` shows a `DATA` column when it differs from
`home`.

## Accounts and trust (`am auth`, `am trust`)

```sh
am auth users             # list accounts: role, email, 2FA, locked (auth: true)
am auth create <id>       # add one (prints a generated password if none given)
am auth passwd <id>       # set a password (also clears the lockout + sessions)
am auth unlock <id>       # clear a lockout
am auth totp <id> off     # clear the second factor (lost device)
am auth revoke <id>       # revoke every session of a user
am trust                  # show this machine's aio root + how to install it (browsers stop warning); `am trust path` prints just the file
```

## Pairing a client (`am pair`)

```sh
am pair            # a fresh single-use PIN, without restarting the app
```

A keyed app prints a pairing PIN at boot, single-use and short-lived. Once it is
used or expires, `am pair` issues another — previously the only way to get a new
one was to restart the app, which the docs told you to do with a command that
did not exist.

## Build and run (`am build`, `am compile`, `am dev`)

Each of these IS the app's own task, run for you — the same command line, in the
same process tree, so `am build` and `deno task build` can never differ (the
maintainer's rule: a difference between the two is a bug, not a feature).

```sh
deno task am build                  # = deno task build: every deno.json build.targets → dist/
deno task am build server electron  # = deno task build --targets=server,electron
deno task am build --list           # = deno task build --list  (the target table)
deno task am compile                # = deno task compile: the default target (deno.json "client")
deno task am compile cli            # = deno task build --targets=cli  (one target, named)
deno task am dev                    # = deno task dev: foreground, your Ctrl-C
deno task am dev --client=electron  # flags pass through (--expose, --port=N, …)
```

Fleet flags pass through unchanged (`--release`, `--force`, `--platforms=…`,
`--all-platforms`, `--out=…`); an unknown one is refused by the build itself,
exactly as it is under `deno task`. An app with no such task (hand-rolled,
pre-scaffold) is refused with the repair — `am fix` adds the standard tasks —
rather than built some other way.

| you want                                | run          |
| --------------------------------------- | ------------ |
| the app in your terminal while you edit | `am dev`     |
| the app in the background, supervised   | `am start`   |
| every artifact you ship                 | `am build`   |
| just the one you run here               | `am compile` |

## Process management

```sh
deno task am start                # start app (kills zombies, refuses if running)
deno task am start                # starts AND WAITS until healthy (10s) — the default
deno task am start --no-wait      # return as soon as it is spawned (no port yet)
deno task am start --wait=30      # start with 30s timeout
deno task am start --port=9000    # start on specific port
deno task am stop                 # graceful shutdown — exit 1 if state did NOT reach disk
deno task am stop --no-wait       # return once the stop is sent (stop waits by default)
deno task am stop --all           # every app OF THIS PROJECT (refused outside one —
                                  # no deno.json above the cwd means no project; an
                                  # app launched inside a NESTED project is that
                                  # project's, and is named and left running)
deno task am kill                 # end it now, no asking (SIGTERM + drop the lock)
deno task am kill --stale         # reap ORPHANS — processes still serving with no
                                  # lock: the ones that answer `am state` with old
                                  # numbers while `am status` says stopped.
                                  # --port=N for an orphan on an unrecorded port
deno task am restart              # stop + start — exit 1 + NOT SAVED if the final write was refused (the app still restarts)
                                  # keeps the port it had when that port is still free
deno task am status               # stopped|starting|started|stopping|maintenance
deno task am open                 # open THIS app in a browser (--print writes the URL)
```

In a repo that declares COMPONENTS (below), `start`, `stop`, `restart` and
`status` mean the whole project, and take a component label to mean one of it.

Exit codes: `started` -> 0, `stopped` -> 1, `starting`/`stopping`/`maintenance`
-> 2. `maintenance` is `am backup` / `am restore` holding the app's lock
(`--json`: `{ appId, status, op, pid }`); `start`, `stop` and the app verbs
refuse while it lasts, naming it. `am instances` lists the hold the same way
(`status: "maintenance"`, `op`, no `stopWith`). `am kill` is the one verb that
acts on it: it interrupts the op (SIGTERM), which removes its partial copy and
exits 143 with `data/` as it was. A holder that is wedged and ignores even that
(a hung disk, a stopped process) is ended with `kill -9 <pid>`: the lock names a
dead pid from then on, and whatever finds it next — `am start`, `am status`,
`am instances`, or the app's own boot — reclaims it, saying which op was killed
and naming the partial copy it left. A killed backup leaves `<dest>.partial`
(refused by name, never reused); a killed restore leaves `data/` old or restored
(killed between the swap's two renames: missing, with the previous data in
`data.replaced-*`), plus a `data.restoring-*` that the next restore names.

A global flag given to a verb that does not read it is warned about on stderr
and ignored — the verb still runs, with its own exit code — and the warning
names the verbs that do read it (`am timeline --follow` → "--follow does nothing
for timeline — ignored", "--follow is read by: am logs"):
`--all --filter --follow --lines --stale --tables --print --long --ui
--as-server --body --args --data`.
The cross-cutting ones
(`--app --port
--profile --home --json --quiet --wait --timeout --client-index --entry --force`)
and the launch flags (`--no-wait --transport`) are accepted everywhere. `--`
ends am's options: what follows is an argument, never a flag.

**A booting app is never killed.** A second `am start` while the first boot is
still running (`status: starting`, process alive, nothing listening yet) prints
`note: still starting (pid N) — waiting` and waits for THAT process — same pid,
no second child. When a wait runs out on a live process that has bound nothing,
`am start` exits 1 with
`still starting after 10s (pid N alive, …) — am status
follows it (exit 2 = transitional); a cold start may need --wait=60`;
"not responding" is kept for a process that IS listening and does not answer. A
`starting` instance is reclaimed only when it listens and never answers past the
10 s grace, or when neither its lock nor its log has moved for 50 s. A boot that
crashes is reported by its `error:` line and the `→ fix:` lines under it, with
stack frames left out.

**`restart` keeps the port.** An app that declares no port gets the port it had
before the restart, if that port is still free. If something else has taken it,
a `note:` says so and the app picks a free one. `--port=N` or a declared port
still wins, and the port restart reuses is never written into the launch record.

**`restart` reports the app, not its own child.** Save a cell file and run
`am restart` at once, and the app's dev watcher relaunches it while `am restart`
launches its own: one wins the lock. When the watcher's did, restart used to say
`did not start` (exit 1) with the app up. Now, when the instance holding the
lock is this app (same appId, home and profile, this checkout, not the pid it
stopped) and answers, restart reports THAT instance — its pid and port, exit 0 —
with a `note:` on stderr that its own child stood down.

`start` and `stop` both WAIT by default (`--no-wait` opts out; since 1.0.11 for
`stop`, which used to return while the process was still alive). `restart`
always waits for stop internally, then spawns and returns immediately. `stop`
tries graceful shutdown via trojan API, falls back to SIGTERM, escalates to
SIGKILL after timeout. Kill sequence: SIGTERM -> wait 2s -> SIGKILL.

### A project that is more than one app (components)

Some repos hold several runnable things — a relay, an agent, a control UI — and
declare them as labelled build targets with their own entries:

```jsonc
// deno.json
"build": {
  "targets": {
    "relay":   { "kind": "server",   "entry": "src/relay/app.ts" },
    "agent":   { "kind": "electron", "entry": "src/agent/app.ts" },
    "control": { "kind": "electron", "entry": "src/control/app.ts" }
  }
}
```

`am` reads that same declaration, so the process verbs mean the project:

```sh
am start                 # starts relay, agent and control
am start agent           # …just that one
am stop                  # stops the project
am restart control       # one component
am status                # one line each; exit 0 only when every one is up
```

Every other command takes the label through `--app`, because their first
argument is already a state path or an action:

```sh
am state --app=agent
am dispatch session:close --app=relay
am logs --app=control
```

Two rules make this predictable:

- **Distinct ENTRIES are what make components.**
  `"targets": ["server",
  "electron"]` — and any object form whose targets
  share one entry — is one app built for several shells, and behaves exactly as
  it always has.
- **Each component needs its own identity.** They get separate lock files, data
  directories and ports, so `aio.run({ appId: "relay" })` in each entry is what
  keeps them apart. If two resolve to the same id, `am` refuses and says which —
  sharing one `~/.<appId>/` is how two apps quietly open one database.

**Each component runs as its `kind`.** A `"server"` component starts
`--client=server-only`, a browser kind `--client=browser`, `"cli"`
`--client=cli` — not the project's default client. An `"electron"` component
keeps the project's client (a GUI client is never forced). An explicit
`--client=` (or `--headless`/`--service`) on the command line wins.

**`am` never invents a port.** A component that declares none gets a free one
from the runtime — the same `findFreePort()` behind `deno task dev` — and
`am status` lists what each one bound. Declare `port` in `aio.run()` when
something else needs to find it at a fixed address.

### Singleton behavior

Controlled by `singleton` in `aio.run()`:

| Value            | Behavior                              |
| ---------------- | ------------------------------------- |
| `true` (default) | Refuse if another instance is running |
| `'takeover'`     | Kill existing instance, start new one |
| `false`          | Allow multiple instances              |

Lock files at `/tmp/aio/` (or `$XDG_RUNTIME_DIR/aio/`) as `{appId}.lock`. Stale
locks (dead PID) are auto-cleaned. Zombies (alive and listening, but not
answering) are killed automatically on `start`; an instance that is still
booting is waited for, never killed (see Process management).

**Identity is appId AND data home.** An app booted again from a different
`appDir` (an isolated smoke-test or screenshot boot beside the user's own) is a
different instance: its lock is `{appId}@{hash8(home)}.lock`, its control socket
follows the same name, and it starts with one info line ("another instance of X
runs from a different home; this one continues") that names no port and no pid.
The default home keeps the plain `{appId}.lock`, so nothing migrates. A refusal
("Already running … (home …)") therefore always means the SAME home — a true
duplicate, whose port and pid are your own instance's. `am --home=<dir>` (or
`AIO_APPS_DIR=<root>`) targets the instance you mean; `am instances` shows each
instance's `home`. A named profile's key is `{appId}@{name}` rather than a hash
— see [Profiles](#profiles-several-copies-of-one-app).

**Filters.** A substring cannot ask "warnings and worse", "from this cell", or
"since the restart":

```sh
am logs --level=warn              # warn AND above (debug < info < warn < error)
am logs --tag=cell:todo           # exact tag
am logs --tag=cell                # …or the whole namespace: cell:todo, cell:notes
am logs --since=15m               # a duration (s/m/h/d) or a timestamp
am logs --level=error --follow    # same filters live as in the tail
```

The unit is the **event**, not the line — an `ERROR` keeps its stack trace. A
line whose header cannot be parsed passes every filter, because dropping what
cannot be classified is how a filter hides the one line that mattered. An
unreadable `--since` is refused, never ignored: a filter silently treated as no
filter turns "I could not read that" into "nothing happened".

## Instance discovery

```sh
deno task am instances            # list running aio apps in this scope (--instance / AIO_APPS_DIR list separately)
deno task am instances --json     # JSON output
deno task am discover             # find exposed aio apps on the LAN (UDP broadcast; --timeout=ms)
```

Each row names the aio version the instance booted with (`aio=1.0.0-alpha68`;
`aio=?` for a lock written before the field existed) and marks one that differs
from the `am` reading it (`≠ am 1.0.0-alpha68`) — two checkouts on one machine
is the normal dev setup, and a version mismatch is the first thing to rule out.
JSON: `aio`, `aioMismatch`.

Scans lock files, validates each PID is alive, returns active instances with
appId, port, PID, uptime, home, and cwd.

**`port` is the WS transport port** — `0` for any app on a Unix socket. The
DevTools port is separate and reported as **`cdpPort`** (a `CDP` column appears
when any instance has one); it is `null` unless the app was started with
`--cdp`. Use that one for `am eval`, `am shot` and anything else that drives the
window. Do not go looking for it in `ss -ltnp`: on a machine running two aio
apps, that scan is ambiguous and it resolves _silently_ into the other app's DOM
— a field report lost a long stretch to exactly that, believing its own correct
routes were broken while every observation was about someone else's window.

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
deno task am state 'fleet[0].{name,active}' # pick specific fields (QUOTE it:
deno task am state 'fleet[*].{pair,status}' # …the shell expands bare braces)
deno task am state '{counter,page}'         # pick from root
deno task am state counter --wait=5         # poll every 5s
deno task am state --ui                     # UI state (cell-level ui filtered)
deno task am state --ui alice               # UI state for specific user
deno task am expect counter.count gt 3      # assert on state (eq/ne/gt/lt/contains/exists…); e2e; --wait=N
deno task am expect draft absent            # the one op that passes on a missing path
```

`am expect` FAILS on a path that is not there, for every op except `absent`
(`exists` fails too, by meaning) — a typo in the path is never a PASS. A
comparison op needs exactly one value; `exists`/`absent` take none. Quote a
value with spaces.

Path syntax: `fleet[0].stats.pnl` for traversal, `{id,name}` for field picking,
`[*]` for wildcard over arrays. **Quote a `{…}` pick** — bash expands bare
braces, so `am state fleet[0].{name,active}` reaches `am` as two arguments; it
takes one path and refuses the rest rather than answering the first. `am state`
= raw server state. `am state --ui` = what the browser sees (it was spelled
`am ui` before alpha52 — `am ui` now opens **amui**, the visual app manager).

## Action dispatch

```sh
# Cell methods — POSITIONAL args (no =): increment(5), setHost("10.0.0.1")
deno task am dispatch counter:increment 5                    # increment(5)
deno task am dispatch conn:setHost 10.0.0.1                  # setHost("10.0.0.1")
deno task am dispatch counter:reset                          # reset()
deno task am dispatch wallet:balance                         # → prints the method's RETURN value

# …the same, JSON-exact. Use it when a value contains '=' (a URL, a base64
# blob), or when the exact type matters.
deno task am dispatch conn:setHost --args='["192.168.1.9"]'  # setHost("192.168.1.9")
deno task am dispatch conn:configure --args='[{"host":"h","port":8000}]'

# One object argument, spelled as named pairs: configure({host, port})
deno task am dispatch conn:configure host=h port=8000

# A method that TAKES arguments, called with none, is refused rather than run
# with `undefined` (which writes a broken row and used to answer ok:true). If
# the method really does fill in its own defaults, say so: --args='[]'
deno task am dispatch conn:setHost                           # ✗ refused, names the method
deno task am dispatch counter:reset --args='[]'              # ✓ "I meant no arguments"

# Plain (non-cell) actions — named payload
deno task am dispatch BulkUpdate items='[1,2]'               # payload { items: [1,2] }

# Raw envelope
deno task am dispatch --body='{"type":"conn:setHost","payload":{"args":["192.168.1.9"]}}'

# A payload too big for a command line: read it from a FILE (@path) or stdin (-)
deno task am dispatch todo:add --args=@args.json             # args.json holds ["buy milk"]
echo '["buy milk"]' | deno task am dispatch todo:add --args=-
deno task am dispatch --body=@envelope.json                  # --body takes both too

deno task am actions                       # the time-travel history (the whole window)
deno task am actions 50                    # the newest 50 (= --lines=50; adds shown/total)
```

For a cell declared `access: false` (public read, server-only write), a network
dispatch is refused — including `am`'s. The operator door is
`am dispatch <cell:method> --as-server`: it dispatches with server provenance,
past the `access` gate. Dev-only, loopback-only and logged, like the rest of the
control plane; the denial message names it at the moment you need it.

A cell method is called with POSITIONAL arguments. Bare values (no `=`) become
those arguments, and `--args='[…]'` is the same list written as JSON — the
spelling to reach for when a value contains `=` or must keep its exact type.
Values without `--args` are auto-parsed: numbers, booleans, `null`, JSON
arrays/objects, else strings.

A positional is `key=value` only when the key is a property name (`host=h`,
`_id=3`): `"https://example.com/?q=1"` is one string argument, not a key called
`https://example.com/?q`. Everything after `--` is an argument too, however it
is spelled — `am dispatch notes:add -- --draft` passes `"--draft"`.

`key=value` pairs are collected into ONE object: after a `cell:method` type they
become the method's single object argument (`configure({host, port})`), and for
a plain action type they are the payload itself. A method taking one string
therefore has no `key=value` spelling — that is what `--args` is for.

`--body` is the whole envelope (`{type, payload}`) when it stands alone, and the
PAYLOAD of the action when a type is given positionally.

**`--args` and `--body` can read their value from a file or from stdin.** A
value that starts with `@` is a PATH: `--args=@rows.json` reads the argument
list from that file (relative to the directory you run in). A value that is
exactly `-` reads it from stdin, so a pipe works. Both flags take both forms,
and the content is the same JSON you would have typed by hand — `["buy milk"]`
for `--args`, a whole `{type, payload}` envelope for a bare `--body`.

That is the spelling for a payload too big for a command line: the kernel
refuses an argv entry of a few hundred KB, so a 300 KB `--args='…'` cannot be
spawned at all. It is additive — neither `@…` nor `-` is valid JSON, so no
command that worked before changes meaning. A file that cannot be read is
refused by name, with nothing dispatched and exit 1:
`--args=@rows.json: cannot read that file (No such file or directory …)`.

**`dispatched` / `ok: true` means APPLIED, not on disk.** The method ran and its
commit is broadcast to every client; the write reaches SQLite with the next
persist window (`persistDebounceMs`, 100 ms by default — `journal: true` appends
it at once). `am persist` is the door that answers for durability. What
`am dispatch` does say, without forcing a flush, is whether persistence is
ALREADY refusing writes: the reply then carries `unsaved` (`⚠ NOT SAVED — …`),
the same verdict `/__aio/health`'s `persist.ok` and `am stop` report. Its exit
code is about the method; the disk has its own verb.

## Time-travel

In browser (dev mode): press **Ctrl+.** to toggle the time-travel panel. Shows
action history with timestamps and performance metrics (`reduce:ms effects:ms`).

From the CLI, three commands expose the DISPATCH history — what ran, what
triggered it, and what it changed:

```sh
deno task am timeline                       # recent dispatches + payload + state diff (live)
deno task am timeline --lines=50            # last 50
deno task am timeline --from=<data>/journal  # offline, from a durable journal file
deno task am timetravel undo|redo           # step back/forward
deno task am timetravel goto <id>          # jump to one entry (the id `am actions` lists)
deno task am timetravel pause|resume        # freeze/unfreeze state
#   an undo at the oldest entry (or redo at the newest) moves nothing: the reply
#   stays ok (exit 0) and says so — "moved": false plus a "note" in --json
deno task am replay 5..12                   # re-dispatch journal seq 5..12 for repro
deno task am replay 5..12 --dry             # show what would replay, dispatch nothing
deno task am record flow.test.ts            # what the running app dispatched → a bootCells test
deno task am record flow.test.ts --from=J   # …the same, from a journal file
```

- **`am timeline`** reads a live, always-on in-memory ring on the running app —
  each entry carries the compact state diff the dispatch produced
  (`counter.n: 0 → 1`). With `--from=<journal>` it reads a durable journal file
  instead (payloads only — the on-disk journal, `journal: true`, stores actions,
  not diffs). It prints **payloads**, so an action called with a secret shows
  that secret here: list it in `redactActions`
  ([where files live](../persistence/where-files-live.md#secrets-in-recorded-actions)).
- **`am timetravel`** moves state in memory only — persistence pauses during
  time-travel
  ([how it works](../persistence/how-it-works.md#concurrency--safety)), so an
  undo reaches disk with the next persist cycle (`am persist` forces one), never
  on its own. Under `journal: true` a jump is journalled as the state it put in
  place, so a crash after it — paused there, or after `resume` and more actions
  — recovers the state the app actually had, never the pre-jump snapshot with
  the later actions replayed on top. It shows in `am timeline` as
  `time travel: goto N (state restored)`.
- **`am replay <range>`** re-dispatches a journal range against the running app,
  in order, stopping at the first failure — deterministic repro for the "froze
  in the client but the test passed" class. Point it at a fresh instance to
  reproduce a captured session. `--dry` lists the range without dispatching,
  counting exactly what the real run sends. It sends **inputs only**: each
  journal line records its `cause`, and a line an earlier action caused — the
  inc a `later()` timer fires, an async method's `__set…` write-set, what a
  cell's `onInit` dispatched at boot — is not sent, because its cause re-creates
  it (both outputs list them, with why). A tick of the app's `schedules:` is an
  input. Where such lines fell between two inputs, the recorded gap is kept (up
  to 5 s) so the timer lands where it did. A journal written before `cause` was
  recorded says so: its caused lines cannot be told apart and may apply twice. A
  line stamped with a cell `version` the running app would refuse at boot
  (older, on a cell with an `onMigrate`; or newer) is not sent either — the same
  rule as crash recovery — and is listed with its stamp. When no running app
  reports its versions (a `--dry` with none up), the output says the stamps were
  not checked.
- **`am record [out.test.ts]`** writes a `bootCells` test that re-calls, in
  order, every method the **running** app dispatched since boot — its live
  timeline (the last 500 dispatches; a full ring is warned about, since the
  flow's start may have rotated out). Reproduce the bug, then record. A
  `redactActions` call appears as a commented gap rather than a call with
  invented arguments, and a `diagnostics: false` cell is not in the timeline. An
  async call that threw in the run is emitted as `assertRejects(…)`, and an
  action another one caused (or a cell's `onInit` did) is not called — its cause
  re-creates it, with `h.advance(ms)` walking the virtual clock through the
  recorded gaps so a scheduled one fires. Calls that overlapped live — a later
  one started before an earlier async call's run left its last write — are
  started together in one `Promise.all`, so a race the app really had (a lost
  update) happens in the test too. With the app stopped it reads the journal
  instead — which holds only what no snapshot had yet taken, i.e. a crashed
  run's tail.

Range forms: `N` (one seq), `N..M` (inclusive), or omit for all. `am replay`
reads `<data>/journal` by default; `am replay`, `am record` and `am timeline`
all take `--from=<path>` for a journal file.

**`sync: true` cells are not in this history.** Their changes are durable in the
CRDT op-log rather than the dispatch journal, so the timeline and replay do not
carry them — read current values with `am state`, and see
[CRDT Protocol](../persistence/crdt-protocol.md) for how those writes are stored
and replayed. (This section previously said the commands show "every state
change", which was not true of sync cells.)

## Persistence and snapshots

```sh
deno task am persist                        # flush to SQLite now; "persisted" = on disk (exit 1 if refused)
deno task am snapshot                       # dump state to stdout
deno task am snapshot save backup.json      # save to file
deno task am snapshot load backup.json      # restore from file — "loaded" = restored AND written
                                            # (refuses a file whose cell set is not this app's)
deno task am snapshot load other.json --force   # …load it anyway, replacing ALL state
deno task am migrations                     # cell versions + shape drift
```

`am persist` is the one honest answer to "is my data safe?": `ok: true` means
the write is on disk, and a refused cycle is a 500 **on every cycle it
happens**, not only the first. `am stop` asks the same question before it closes
the door, so a shutdown that could not save exits 1 and says which cell;
`am restart` takes the same verdict on its way down — the app still comes back
up, from what IS on disk, and the command says `NOT SAVED` and exits 1.
`am snapshot load` closes the persist window before it answers: `loaded` means
restored and written, or the reply carries `unsaved` and the command exits 1.
`/__aio/health` carries the same verdict as `persist: { ok }` — `status` is
`degraded` while a write is being refused, so a monitor sees it without polling
a CLI. A `journal: true` app whose journal cannot be appended to shows up there
too (`degraded: [{ name: "journal:<appId>" }]`): its state still reaches disk —
every refused append closes the persist window at once — but the promise the
option was set for is broken, and health says so from the first refusal.

**`am snapshot load` replaces the WHOLE state.** A file whose cell set is not
this app's is refused by name — both the cells it would destroy (missing from
the file) and the ones this app does not declare. Loading another app's snapshot
used to wipe everything and report `"status":"loaded"`. `--force` is how you say
you meant it.

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
am pin --latest           # newest release in this app's major (`am pin latest` is the same)
am pin /path/to/aio       # LOCAL-DEV pin: follow a framework checkout on this machine
```

The framework CLI itself, and apps `run.sh` installed into `~/app/`:

```sh
am upgrade                # update am itself to the latest release
am uninstall              # remove am (your aio apps are untouched)
am installed              # list installed apps, with version + where each came from
am upgrade <app>          # rebuild and reinstall an installed APP from its recorded source
am remove <app> [--data]  # uninstall one — the PROGRAM; --data also deletes ~/.<app>/
                          # (only when it is an aio data dir — data/state.db, data/meta.json,
                          #  launch.json… — never another program's ~/.<name>, --force or not)
am theme adopt            # take aio's stylesheet INTO this app (src/aio-theme.css) — yours from then on
am publish [--key=K]      # build, sign and lay out the channel directory an update client fetches
```

A **path pin** is **per-machine**: `am pin /abs/checkout` writes the path to the
git-ignored `.aio/pin.local` (one line; `.aio/` is added to `.gitignore` if
missing) and leaves the committed `aioVersion` untouched — a clone still builds
against the release in `deno.json`, while this machine follows the checkout.
Every later `am fix` keeps linking that checkout, which is the workflow for
developing an app against a work-in-progress framework. The one pin reader
prefers the local override and says so once per process
(`aio: local path pin → /abs/checkout`); a dangling override (no `mod.ts` at the
path) fails loudly instead of falling back. Pinning a release
(`am pin --latest`, `am pin v…`) **removes** `.aio/pin.local`, so the release
really is what runs. A legacy `aioVersion: "path:…"` in `deno.json` is still
read, with a one-time warning telling you to move it (`am pin <that path>`).

Inside a path-pinned app, the installed `am` **delegates** to the pinned
checkout's own am (announced on stderr; `AIO_AM_NO_DELEGATE=1` opts out) — so am
behavior always matches the framework the app is built against, unpushed
commands included. To use a checkout's am **everywhere** (even before any app
exists), switch the global install: `am upgrade /path/to/aio` — a dev am on live
files, so your edits apply immediately. Plain `am upgrade` returns to the
released am; it never git-mutates a dev checkout it happens to be running from.
First switch, when the installed am is a release that predates this verb: run
the checkout's own am once — `cd <checkout> && deno task am upgrade .`

`am create app --client=electron` picks the default shell for `deno task dev` /
`compile` — the same word as deno.json's `client` (`--target=` is the old
spelling, still accepted; the two disagreeing is refused).

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
`deno task doctor` fails the `framework pin matches dep/aio` line. `am fix`
corrects it.

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

`am create <name>` looks first: when the new app's home
(`$AIO_APPS_DIR/<appId>`, else `~/.<appId>`) already exists — an earlier app
with the same id — it says so, with that data's aio version and date from
`meta.json`, because the first `deno task dev` boots on it. `--json` carries it
as `existingData` (null when the home is fresh).

```sh
am data                      # every path this app uses + sizes, by tier
am data --json               # machine-readable

am stop wallet               # a live SQLite file can copy mid-write
am backup                    # → ~/.wallet/backups/wallet-backup-<stamp>/
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
  — and another PROFILE's: a `--profile=p1` backup into the default home, or a
  default backup into `--profile=dev`, would leave a home boot refuses. It is
  refused before anything moves (no `--force`), naming both and the command that
  restores it into its own home (`am restore <dir> --profile=p1`). It refuses
  outright while the app runs — a running app would write its in-memory pages
  back over what you restored. There is no `--force` for that. It also refuses a
  directory that is not an archive at all (no `meta.json` and no `state.db`):
  restoring nothing over your data is not a restore.

A restore **moves** the data it replaces to `data.replaced-<stamp>` rather than
deleting it, so restoring the wrong archive is recoverable. The name is never
reused: a second restore within the same second gets `data.replaced-<stamp>-2`.
A `data.restoring-*` left by a killed restore is named on the next restore
(never deleted for you). The copy goes to that `data.restoring-*` sibling first,
so a failed or interrupted copy never touches `data/`; the swap after it is two
renames (`data/` → `data.replaced-*`, then the copy → `data/`), not one atomic
step — a process killed between them leaves `data/` missing and the previous
data in `data.replaced-*`. Both verbs also refuse an instance running on the
same home from another lock scope (booted under another `AIO_APPS_DIR`,
`--instance`, an appDir app), which this `am`'s lock dir cannot see: the data
folder's own OS lock names it ("… under another lock scope — stop it first").

## UI inspection and interaction (dev mode)

Inspect and drive the live UI from the CLI through the **semantic UI surface** —
the same facility `testUI` uses, so what you do here and what a test does behave
identically. Elements are addressed by component/name, not CSS selectors.

```sh
deno task am state --ui                      # server-side UI state
deno task am surface                         # semantic surface of the newest UI client: every component + triggerable element
deno task am surface 3                       # …of ONE client, by its `am clients` index
deno task am trigger App:SubmitButton click        # click by component:name path
deno task am trigger App:Email type "a@b"          # type into an input — APPENDS
deno task am trigger App:Email setValue "a@b"      # REPLACE the field's value
deno task am trigger App:Search focus               # focus / blur / hover / scroll / press
deno task am trigger App:Stage keyDown ArrowLeft    # HOLD a key (games, drag) …
deno task am trigger App:Stage keyUp ArrowLeft      # … then release it — press is a tap
deno task am trigger window press "Escape"         # a WINDOW-level key (onGlobalKey)
```

A path need not be exact, as in `testUI`: a bare name (`opencode-model`) or a
name under components on its path (`App:opencode-model`,
`ModelSelect:opencode-model` for `App/ModelSelect:opencode-model`) resolves when
exactly ONE live element matches. Several → refused, with the candidates' full
paths in `available`.

`window` is the address for a key that belongs to no element. `onGlobalKey`
registers on the document, so nothing on the surface owns the binding — and
aiming the key at an `<input>` instead does nothing at all, because
`onGlobalKey` ignores the chord while focus is in a field. It accepts `press` /
`keyDown` / `keyUp` and refuses everything else: a click on the window is not a
gesture a user can make.

**Which client?** With no index, `surface` and `trigger` drive the **newest UI
client** — the page in front of you. An explicit index is the server's
per-connection **counter**, not a position: it starts wherever the server's
count is (in dev, index 0 is usually the reload socket, which has no UI), and
one page reload moves it. Pass one only to pick among several open clients, and
read the current numbers from `am clients` first.

**No client connected?** `am surface` (no index) then falls back to a
**server-side render** and says so in a `note:` line on stderr;
`am surface server` asks for one directly. Dev only: the server imports the
app's UI entry in-process, mounts it in a throwaway DOM against the LIVE cells,
and reads them the way a client does — a field hidden by `visible` is hidden
here too. It is an inspection, not a client: it has no layout (so `--rects` is
refused), and `am trigger` still needs a connected client. The server imports
the UI **once** and keeps that import, so after you edit `App.tsx` (or a
component under its directory) the render shows the UI as it was. When a UI
source file is newer than the import, the answer says so: a
`note: this server-side render is STALE — <file> changed …` line on stderr, and
a `stale: { file, changedAt, importedAt, note }` field on each top-level node of
the `--json` answer. Open a client for the current UI. Every `--json` answer
says which renderer answered: `"render": "server" | "client"` on each top-level
node, and at the top level of `--names --json` (`{names, render}`) and
`--rects --json` (`{roots, measured, render}`). If no client is connected,
`am trigger` refuses and names a launch that keeps off your screen:
`am start --client=electron` (on the nested display) or `--client=browser`.

`type` APPENDS to the field's current value (a user typing into a field that
already has one); `setValue` clears first, then types — use it to drive a form,
where replacing is the usual intent. Same two words, same two meanings as
`testUI`'s `ui.X.type()` / `ui.X.setValue()`, because both drive the same UI.

**Which path each command takes** — they are not one thing seen three ways:
`am state --ui` is the SERVER's projection (`getUIState()`, no client involved);
`am surface N` / `am trigger N` talk to LIVE client `N` over the transport that
client is on (WS for a browser tab, UDS for the Electron window) and wait up to
`--timeout` for it to answer — a stalled or headless client is reported by index
with the connected indices listed; `am logs` reads the server's log store;
`am dispatch` runs the cell method on the server and prints what it returned.
With several instances of one app up, `--home=<dir>` picks the one to drive.

Run `am surface` first to see the addressable `Component:name` paths, then
`am trigger` them. This is the one unified UI facility — the old CSS-selector
`am interact`/`am click` and raw `am dom` snapshot were removed in favour of it.

Scope a big surface instead of piping it into a script:

```sh
am surface --component=CtxControls   # every instance, with its subtree
am surface --path=App/Main           # one subtree by path prefix
am surface --depth=1                 # top level only
am surface --full                    # untruncated element text
am surface --rects                   # + layout geometry per element
```

A filter that matches nothing exits non-zero and lists the components that ARE
in the surface — an empty result is nearly always a typo.

`--rects` adds `w x h @x,y` (CSS pixels, viewport-relative) to every element, so
"the app looks fine" becomes "the Stage is 6886 px tall". It needs a real
client: `getBoundingClientRect()` answers everywhere, and with no layout engine
behind it, it answers `0x0` for everything — indistinguishable from a UI that
really has collapsed. So the server-side render refuses `--rects` outright, and
a live client whose elements all measure `0x0` exits 1 with both readings named
rather than printing a grid of zeroes that looks like data. Under `--json` the
document becomes `{ roots, measured: { measurable, laidOut } }`; without
`--rects` the top level is still the roots array, so nothing that parses
`am surface --json` today has to change.

### A typed test client (`am testgen`)

```sh
deno task am testgen                      # → tests/ui.gen.ts
deno task am testgen --out=tests/ui.ts    # somewhere else
deno task am testgen src/Admin.tsx        # a different entry
```

`ui.App["tab-settings"]` is a string key, and a typo in one is a runtime
`undefined`. This writes a client typed from what the app actually **renders**,
so `ui.App.SaveButton.click()` autocompletes and a renamed button breaks the
test at compile time.

It renders headlessly against the app's own cells, so nothing has to be running.
Re-run it after a UI change — the types describe the render, which is the point:
a `t=` prop inside a branch that never renders is not a locator anyone can use.

No UI entry exits 1 and says so. A file written in silence for an app with no UI
is indistinguishable from one written for an app whose components all returned
null, and only one of those is fine. Full guide:
[UI testing → Typed clients](../testing/ui-testing.md#typed-clients-am-testgen).

### Does the client graph build? (`am check`)

`deno check` type-checks; it does not bundle. In aio those are different
questions: `"aio"` resolves to `mod.ts` for the type-checker and to
`browser-air.ts` for the browser bundle, so TypeScript checks the **union**
while the bundle gets the **intersection**. Anything server-only imported into a
cell type-checks cleanly and then fails to build.

```sh
am check                    # walk the client graph from the UI entry
am check src/Other.tsx      # a different entry
am check --json             # {entry, checked, modules, errors, warnings}
```

Exits non-zero on anything that would stop the bundle, naming file, line and the
fix. Warnings never fail it — a gate that cries wolf is one people learn to pass
with `|| true`.

Scaffolded apps run it as part of `deno task check`, so the task's name is true
and CI catches the same thing dev boot does. `am fix` adds it to an existing
app.

If it prints **`NOTHING CHECKED`**, it found no UI entry: correct for a
`server-only` app, and otherwise a sign the entry is elsewhere — pass it, or set
`entry` in deno.json, rather than leaving a green task that looked at nothing.

### Which context does a file run in? (`am where`)

```sh
am where src/ui/Panel.tsx
am where src/helpers.server.ts --json
```

aio has one syntax and six places it executes, and almost nothing in a source
file says which one you are in. This answers from the module graph the dev
server already walks: the context, the **import chain from the UI entry** that
put the file there, and the rules that follow (`Deno.*`, hidden
`visible.exclude` fields, whether a read subscribes).

```
  file        src/ui/Panel.tsx
  context     the browser links this at boot (static import from the UI)
  reached by  src/App.tsx  →  src/panels.ts  →  src/ui/Panel.tsx

  · `Deno.*` and `@std/*`: NO — this code is in a browser
  · hidden (`visible.exclude`) fields: a read THROWS, dev and prod alike
  · a read subscribes ONLY inside a component body, never in a handler …
```

A **cell file gets an extra line**, because it is two contexts at once: the
module is linked into the bundle, while its async methods run in server context
and may use `Deno.*` — with the imports they need in a `*.server.ts` module,
never at the top of the cell file. Saying only the first is how a reader
concludes something false about their own methods.

Four verdicts, all derived from the graph rather than guessed: `browser-eager`
(statically imported from the UI), `browser-deferred` (reached only through a
dynamic import — the browser may never load it), `server-only` (not in the
client graph) and `unreached` (nothing the UI loads imports it: server context,
or dead code). A `*.server.ts` filename overrides all four.

The full map is [Where does this code run?](../basics/where-code-runs.md).

### Screenshots (`am shot`)

A PNG of the live Electron window, headlessly, over the Chrome DevTools
Protocol. The protocol is **opt-in**: start the app with `--cdp` (or
`AIO_CDP=1`, or `--cdp=<port>`) and it binds a debugging port on 127.0.0.1 only,
prints it on the boot line (`cdp  127.0.0.1:<port> (opt-in, loopback)`) and
records it in the lock. Without the flag the app binds nothing extra — "no TCP
port" stays literally true — and `am shot` refuses with the flag to add.

```sh
deno task am start --cdp                      # or: AIO_CDP=1 deno task dev
deno task am shot                             # → <appId>-<stamp>.png in the cwd
deno task am shot --out=before.png            # name the file
deno task am shot --full                      # capture beyond the viewport
deno task am shot 1                           # the second app window
deno task am shot --json                      # {"file","bytes","url"}
deno task am shot --selector='#chart'         # crop to one element
```

The target is the window whose URL is the app's own (`aio://…` or its http
origin); DevTools' own pages are never captured. `--home=<dir>` picks the
instance, as everywhere in `am`.

`--pose=<json>` is **not** supported: the app decides its own camera. Expose a
cell method that sets the view, drive it with `am dispatch`, then `am shot`.

**Freshness.** A screenshot is whatever the compositor last painted, which is
not necessarily what you just did — dispatch, then capture, and the render may
still be queued. `am shot` waits for the window to commit a frame before
capturing, and reports whether it got one:

```json
{ "file": "app-1234.png", "bytes": 20481, "url": "…", "painted": true }
```

`"painted": false` (plus a `warning`, and a `! STALE RISK` line in plain output)
means the window did not paint within `--timeout` — a hidden, minimised or
occluded window is not composited. The file is still written, because an
unconfirmed screenshot is worth having; it just cannot be vouched for. Raise the
window, or raise `--timeout=`.

**One element (`--selector`).** Takes a CSS selector and crops to that element's
box, measured **in the page** with `getBoundingClientRect` — so it is still
right after a scroll, a transform or a `position: sticky`. An element that
matches nothing, or that measures `0x0`, is an error rather than a 1×1 image:
"captured a collapsed element" and "captured successfully" must not look the
same. (`am surface --names` lists aio's semantic paths; this flag takes CSS.)

**Visual regression (`--update` / `--check`).** aio already had the three hard
parts — headless capture, deterministic state via `am snapshot load`, and any
state reachable with `am dispatch`. This is the comparison:

```sh
deno task am snapshot load fixtures/cart-with-3-items.json
deno task am shot --update=baseline/cart.png   # record, once, and commit it
…
deno task am shot --check=baseline/cart.png    # assert — exits 1 if it moved
```

- It compares **pixels, not bytes**. The same image re-encoded is a different
  file, and a check that fails on a screenshot no human can tell apart is one
  people delete.
- There is a **tolerance**, because antialiasing and subpixel text move a
  channel by one or two between identical captures: `--threshold=N` per channel
  (default 2) and `--max-diff=RATIO` of pixels (default 0 — a moved button is
  not "a few pixels").
- A **missing baseline fails**. It is the one case where "nothing to compare"
  and "nothing changed" look identical, and a pass there is a check that never
  ran.
- A failure writes `<baseline>.actual.png` beside it, because "they differ" with
  nothing to look at is a report nobody can act on. Accept it with `--update=`.
- A **size change is reported as a size change**, not as 100% of pixels — a
  resized window would otherwise send you hunting a visual change that never
  happened.

**Video (`--video`).** Records the window until Ctrl-C, then writes a video:

```sh
deno task am shot --video                     # → <appId>-<stamp>.mp4, Ctrl-C to stop
deno task am shot --video=demo.webm           # the extension picks MP4 (H.264) or WebM (VP8)
deno task am shot --video=demo.mp4 --duration=20   # stops by itself (SIGTERM stops it too)
```

While recording, the window's own screencast sends a JPEG each time it paints,
saved to a temp folder — nothing is encoded yet, so the app runs at its real
speed. After it stops, the window's built-in encoder turns them into the file
(no ffmpeg). So a window that is hidden or never changes gives a one-picture
video, and says so in a `warning`. If the window closes while recording, nothing
is written and the frames' folder is named. `--full`, `--selector`, `--check`,
`--update`, `--threshold`, `--max-diff` and `--out` shape one picture and are
refused with `--video`. To record a UI **test** instead, see
[A video of the test](../testing/ui-testing.md#a-video-of-the-test---video).

### Evaluate in the live window (`am eval`)

`am surface` reads the UI **semantically** — components, names, text, values.
`am eval` reads everything it cannot: **geometry**, **computed styles**, and a
**fetch from the page's own origin**.

```sh
am eval 'document.title'
am eval 'document.querySelector(".stage").getBoundingClientRect()'
am eval 'getComputedStyle(document.querySelector(".row")).height'
am eval 'fetch("/api/health").then(r => r.status)'      # promises are awaited
am eval 'document.body'                                  # a node → name, id, class, rect, text
am eval '[...document.querySelectorAll(".row")].length'
am eval --window=1 'location.href'                       # the second window
```

Same gate as `am shot`: the app must be running with `--cdp`. Nothing new is
exposed — this drives the port the app already opted into, on 127.0.0.1 only.

The result is JSON (`--json` gives `{value, type, url}`). An expression that
**throws** exits non-zero and names the exception; it never comes back as a
quiet `undefined`.

Three things it does for you, each because the raw protocol gets them wrong:

- a **`DOMRect` keeps its numbers** (raw CDP serialises it to `{}`, because its
  numbers are prototype getters — and geometry is the main reason to reach for
  this);
- `{ a: 1 }` is the **object** you wrote, not the labelled block JavaScript
  reads at statement position;
- a **DOM node** answers with its name, id, class, rect and first 200 characters
  of text, rather than the `{}` that `JSON.stringify` gives.

Why it exists: without it, every agent driving an aio app writes the same
fifteen lines of CDP client. Three field reports did, independently.

## What this app has to change (`am migrate`)

```sh
deno task am migrate                  # since the app's own aio pin
deno task am migrate --from=alpha76   # since a release you name
deno task am migrate --json           # for a script or an agent
```

It SCANS rather than lists. "Everything removed since alpha76" is a changelog
and the changelog already exists; the useful answer is the intersection with
your code — usually far shorter, always actionable, and most often empty, which
it says in one line.

Each finding names the file and line, the retired spelling, the one-line fix,
and the upgrade guide with the full recipe. Renames are marked `[fixable]` —
`aiol --safe-fix` rewrites those. A hit under `tests/` is marked as a probable
fixture rather than treated as work, the same call `am pin` makes. It reads the
same source `am pin` does — cell-config keys only inside a cell config literal,
and nothing the app excludes in deno.json `exclude` / `fmt.exclude` or
`.gitignore`.

It scans the app you are standing in, so it refuses to run where there is no
`deno.json` / `deno.jsonc` — the same question `am pin` asks, and for the same
reason: the clean bill is this command's most common answer, and a directory
that is not an app would have produced one about code it never opened.

It exits 1 when anything is found, so it works as a CI step. `--from` narrows
the registry to what was removed AFTER that release; omitted, it reads the app's
own pin, because the version an app is on is a fact the tool can look up and a
person has to remember.

Detection is deliberately generous — a false positive costs a warning you can
overrule, a miss costs an app that boots and then explodes — so it shows you the
line and lets you judge.

## The Electron runtime cache (`am prune`)

```sh
deno task am prune                 # REPORT: every entry, its size, its verdict
deno task am prune --yes           # delete exactly what that report named
deno task am prune --days=90       # only what nothing has opened in 90 days
deno task am prune --keep=43.4.1   # …and never this version, whatever its age
deno task am prune --json          # the same plan as data
```

`~/.cache/aio/tools/electron/` holds one directory per Electron version and
platform — 250–370 MB each, plus the cross-build `.zip` downloads at ~150 MB —
and nothing ever removed one. A working machine reached **7.7 GB across 32
entries**, Electron 41.2.1 through 44.4.2.

It is also shared by **every aio app on the machine**, which is why this is a
verb you run and never something that happens to you. The app you are standing
in cannot know which Electron the app next door starts from, and deleting that
one turns its next launch into a 250 MB download — which an offline machine
cannot make. So:

- **`am prune` deletes nothing.** It prints every entry with its size and the
  sentence that decided it, then the exact command that would act on it. `--yes`
  re-prints the same plan and removes exactly those paths.
- **Age comes from use, not from version order.** Every launch stamps the
  runtime it started from (`.aio-last-used`). An entry with no stamp yet falls
  back to its directory mtime, which is older than the truth and therefore only
  ever makes the plan more cautious, and the report says which of the two it
  used.
- **The Electron this aio ships is never offered**, at any age, on any platform
  — `am pin` and `am fix` are moving every app on the machine onto it.
- **Unknown is not unused.** An entry whose age cannot be established is kept.
- **A `.lock` is never touched** — another process may be downloading into it.

What it deliberately does NOT do: keep the N newest (an app pinned to an older
Electron loses its runtime), keep only this host's platform (cross-build
runtimes for Windows and macOS are build inputs, not leftovers), or run as part
of `am fix` (silent, remote, and unrecoverable without a network).

## Profiles: several copies of one app

A second copy of an app with its own data — a `dev` copy beside the one you use,
a clean one for a test run, a demo seeded with fixtures — is one flag:

```sh
am start --profile=dev                            # ~/.myapp-dev: own state.db, lock, socket, logs
am start myapp@dev                                # the same, short form (names only)
am dispatch --profile=dev todo:add --args='["x"]' # every verb takes it, every time
am instances                                      # APP column: myapp, myapp@dev
am stop myapp@dev                                 # a bare `am stop` never stops a profile
```

The app itself takes the same flag, so it works without `am`:
`deno task dev --profile=dev`, `./myapp.AppImage --profile=dev`, a packaged
Electron app, or `AIO_PROFILE=dev` in the environment (the flag wins over the
variable). `am restart` replays it from `launch.json`.

**The rules**

- **A name** — `^[a-z0-9][a-z0-9-]{0,31}$`, not `default`, not eight hex digits
  (that reads as a path hash) — is a home beside the app's own: `<base>-<name>`,
  where `<base>` is `~/.<appId>`, `$AIO_APPS_DIR/<appId>`, or the app's
  `appDir`. Its key is `<appId>@<name>`: lock `<appId>@<name>.lock`, socket
  `<appId>@<name>.sock`, Windows pipe `\\.\pipe\aio-<appId>@<name>`, and its own
  Electron (Chromium) profile.
- **A path** — contains `/` or `\`, starts with `~` or `.`, or a drive (`C:`) —
  is that exact folder. Its key is `<appId>@<hash8(path)>`, because two folders
  can share a last segment. `--home=<dir>` (the app reads `--home=` /
  `AIO_PROFILE=<path>`) is the same thing, path only. `--profile` and `--home`
  naming two different folders are refused:
  `… name two different folders — give one. --home is the path-only spelling of --profile.`
  A path that IS a named profile's folder (`--profile=~/.myapp-dev`) is that
  profile. A path is checked like a derived home: a folder holding another
  program's files, or a reserved name (`~/.ssh`, `~/.aio`, …), is refused.
- **`@` never occurs in an appId**, so `myapp@dev` is unambiguous:
  `am start myapp@dev`, `am stop myapp@dev`, `--app=myapp@dev`. Names only — a
  path goes in `--profile=` or `--home=`. A hash tag as `am instances` prints it
  (`myapp@1a2b3c4d`) also works, for an instance that is RUNNING under that key.
- **Every `am` verb takes it** — `start`, `stop`, `restart`, `status`, `logs`,
  `state`, `dispatch`, `backup`, `restore`, … — and `am instances --profile=dev`
  filters. Like `--instance`, it is passed each time: it picks which copy you
  are talking to.
- **Precedence:** `--home` / a path > a name / `AIO_PROFILE` > `appDir` >
  `AIO_APPS_DIR` > `~/.<appId>`. A name is placed relative to whichever of the
  last three applies.
- **A home knows its owner.** `data/meta.json` records the appId and profile;
  boot refuses a home owned by another app or profile:
  `<home> belongs to profile "dev" of app "myapp" (its data/meta.json says so), not to …`.
  The `dev` profile of `myapp` and an app called `myapp-dev` both derive
  `~/.myapp-dev`, and never open one database. A plain boot (no profile) is
  refused only by a `meta.json` a PROFILE wrote — a folder an older aio wrote is
  never refused.
- **One folder, one process.** `<home>/.aio-instance.lock` is an OS lock held
  for the life of the app (`.aio-instance.json` beside it names the holder), so
  two processes in different lock scopes (`--instance`, `AIO_APPS_DIR`) still
  cannot open one `state.db`: the second is refused with
  `already running from …`.
- **Ports do not change**: a free port unless the app fixes one (a packaged
  Electron app binds none). Two copies of an app with a fixed `port` clash; the
  refusal names the aio app holding the port and suggests `--port=0`.
- **`am remove --data` never removes a profile.** It lists the app's profile
  homes (`--json`: `profileHomes`) and leaves them; delete one by hand.
- **Listed like any instance**: `am instances` shows `myapp@dev` (the APP column
  is the key; `--json` adds `profile`), and amui shows it.

**When the app says no.** `aio.run({ profiles: false })` (default `true`) runs
from one folder only: every form — a name, a path, `--home`, `AIO_PROFILE` — is
refused at boot with exit 1:
`this app runs from one folder only (profiles: false) — <source> is refused. Unset it (AIO_APPS_DIR still moves the whole apps root).`

**When the app owns the flag.** An app that declares its OWN `--profile` or
`--home` flag keeps it: aio reads only `AIO_PROFILE`, and warns once if the flag
is on the command line. `am` forwards its argv unchanged, so for such an app
`am start --profile=dev` hands `--profile=dev` to the APP — use
`AIO_PROFILE=dev am start` instead.

**Mixed versions.** An app on aio 1.0.9 or older does not know the flag. `am`
forwards it as an argument, the app refuses the unknown flag, and nothing boots
on the real data.

Not to be confused with `am profile`, which exports the `.aioapp` pairing
profile (cert + key) for a client.

**Which one do I use?** For a copy of an app, `--profile=<name>`.

| You want                                              | Use                                  | Data home                         | Key                     |
| ----------------------------------------------------- | ------------------------------------ | --------------------------------- | ----------------------- |
| a second copy with its own data (dev, test, demo)     | `--profile=<name>` ✓                 | `~/.<appId>-<name>`               | `<appId>@<name>`        |
| a copy in a folder you choose                         | `--profile=<path>` / `--home=<path>` | that folder                       | `<appId>@<hash8(path)>` |
| a separate world: every app, lock dir, socket, log    | `--instance=<name>`                  | `~/.aio-instances/<name>/<appId>` | `<appId>`, own lock dir |
| every app under another root (you run it, not own it) | `AIO_APPS_DIR=<root>`                | `<root>/<appId>`                  | `<appId>`, own lock dir |
| the app's data in one fixed place (you wrote it)      | `aio.run({ appDir })`                | that folder                       | `<appId>@<hash8(home)>` |

A profile is per RUN and leaves the code alone; `appDir` is the author's, in the
code; `AIO_APPS_DIR` and `--instance` move every app at once.

## A private copy: `--instance=<name>`

The singleton lock is on the appId, and the appId picks the data home — so two
copies of one app are one app. An agent driving `am dispatch` and a human
clicking in the same window were sharing a session: the agent's actions landed
in the human's app, and the human's clicks landed in the agent's measurements.
`--takeover` steals the lock; it does not give you your own.

```sh
am --instance=agent1 start          # its own lock, data home, socket and logs
am --instance=agent1 dispatch todo:add --args='["x"]'
am --instance=agent1 stop
```

Every `am` command takes it, and it must be passed each time — it selects which
world you are talking to. The app started under it inherits the same scoping, so
nothing in the app needs to know.

It is not a new isolation mechanism: it resolves to
`AIO_APPS_DIR=~/.aio-instances/<name>`, which aio already scopes the data root
**and** the lock/socket directory by. An explicit `AIO_APPS_DIR` wins — it is
the more specific instruction — and `am` says so on stderr
(`--instance=agent1 is ignored — AIO_APPS_DIR is set …`) rather than letting the
flag do nothing in silence. `am instances --json` prints each row's `stopWith`
with the scope it was listed in (`--instance=<name>`, `AIO_APPS_DIR=<dir>`,
`--profile=<name>`, or `--home=<dir>` for any other home), so the command
reaches that copy and not the default one.

A second copy of ONE app, beside the real one in the same world, is a
[profile](#profiles-several-copies-of-one-app), not an instance. The two
compose: `am --instance=agent1 start --profile=dev` is the `dev` profile inside
agent1's world.

## Reporting findings about aio (`am feedback`)

Notes about aio itself — a bug, a rough edge, a suggestion — go in a file that
belongs to **you**, not to a framework version:

```sh
am feedback                      # the directory, and what is already in it
am feedback my-app               # the file my-app's findings belong in
am feedback my-app --create      # …and start it from a template
```

The location is outside the version store (`$AIO_FEEDBACK_DIR` overrides it, and
`XDG_DATA_HOME` is respected), so `am pin --latest` and pruning an old version
cannot delete it.

Do **not** write findings into `dep/aio/feedback/`. That path is inside the
pinned version's directory: it is absent from a release worktree entirely, and
the next `am pin` orphans anything written there.

## Manual VM labs (`am lab`)

A real Windows, macOS or Linux desktop — or the Android emulator — in a
container, driven by hand from a browser, with the app's `dist/` handed into the
guest. This is the manual tier next to `deno task test:wine` (headless, a gate)
and `deno task lab` (Ubuntu, a gate) — nothing here runs in `deno task test`.

```sh
am lab windows              # a VM: boot it, mount dist/, print the viewer URL
am lab windows --status     # up? which port? how big is the VM disk?
am lab windows --stop       # clean guest shutdown, then remove the container
am lab windows --reset      # DELETE the VM disk (tens of GB) and start over
am lab macos                # a VM, but setup is partly MANUAL
am lab linux                # an Ubuntu XFCE desktop: a container, not a VM —
                            #   no KVM, no disk, seconds; dist/ is /shared inside
am lab android              # the Android 14 emulator: needs /dev/kvm and an APK;
                            #   am waits for boot and adb-installs it (re-run = re-install)
```

Flags: `--port=N` (default: a free one), `--dist=<dir>`, `--tunnel` for all
four; `--ram=8G`, `--cpus=4`, `--disk=64G`, `--version=11` for the two VMs
(refused on a container); `--apk=<file>` for android.

A VM disk lives in `~/.cache/aio/labs/<os>/` and survives `--stop`, so the first
start installs an OS (Windows: ~30 min unattended, tens of GB) and every later
start is a boot; the two container labs keep nothing. Every lab hands `dist/` to
the guest over the same share (`http://host.lan:8007/` in the VMs) and prints
the line for it — a `curl` on Windows/macOS, a `cp /shared/…` on Linux, and on
Android the `adb install -r` that `am` ran. Full detail, costs, preflight fixes
and licensing: [VM labs](../testing/vm-labs.md).

## Monitoring

```sh
deno task am clients              # connected clients (type, transport)
deno task am client 0             # request component tree from client 0 (dev mode)
deno task am top                  # live runtime view (per-cell state sizes); --json = one shot
deno task am heap                 # what the process HOLDS: heap, the V8 ceiling, per-cell bytes
deno task am schedules            # active timers/cron
deno task am metrics              # uptime, connections, schedule count
deno task am health               # health check (exit 0 = ok)
deno task am doctor               # is the RUNNING process on the aio that is on disk? (fix: am restart)
deno task am config               # server config
deno task am sql "SELECT ..."     # read-only SQL query
deno task am tables               # list SQLite tables
deno task am logs                  # tail last 50 lines
deno task am logs --filter=ERROR   # filter log lines
deno task am logs --follow         # stream (like tail -f), also: -f
deno task am logs --client         # tail client log (~/.<appId>/logs/client.log)
deno task am errors               # last transpile error (dev mode)
deno task am preview src/Card.tsx --export=Card --props='{"title":"Inbox"}'
deno task am watch                # restart the app on a .ts/.tsx change under src/
deno task am watch lib            # …watch another directory (refuses one that isn't there)
deno task am add cell payments    # scaffold src/cell/payments.ts
deno task am add server billing   # scaffold src/server/billing.server.ts AND its import
deno task am report               # collect a problem report (logs + versions + state shape) for an app with feedback: true
deno task am version              # print version
```

### One component, in a state you choose (`am preview`)

Checking a component's empty state, its error card, or how it handles a very
long name meant driving the whole app into that state first — a dispatch, a
fixture, sometimes a login — or writing a throwaway script with happy-dom and a
document in it. Neither is something anyone does while iterating.

```sh
deno task am preview src/Card.tsx --export=Card --props='{"title":"Inbox"}'
deno task am preview src/Card.tsx --export=Card --props='{"title":"Inbox","count":7}'
```

```
Card
  Card:title  <h2>  Inbox
  Card:empty  <p>  Nothing here yet.
  Card:act  <button>  Go
```

The app does not need to be running: this renders the module directly, with the
cells it imports reading their declared state (selectors work; a method called
during the render refuses, since nothing runs) and the route at `/`. It is the
same renderer `am surface` uses and prints the same `Component:Element` paths
`am trigger` takes, so what you read here is what you would address there.

- The file is found the way your shell means it: relative to the current
  directory first, then the project root, then the app directory (so
  `src/Card.tsx` and `Card.tsx` both work from the project root).
- `--export=Name` picks a named export; without it, the default export (also
  spelled `--export=default` — a miss on a default-exported module says so).
- `--props=` is a JSON **object**. A number or an array is refused rather than
  spread into nothing, because a component rendering with every prop `undefined`
  looks exactly like the bug you are hunting.
- A component that renders no named elements says so, instead of printing an
  empty screen that could mean either thing.

### How much memory is it holding? (`am heap`)

`am state` says what an app is SERVING. `am heap` says what it is HOLDING:

```sh
deno task am heap          # rss, heapUsed, the V8 ceiling, % of it, per-cell bytes
deno task am heap --json   # the same as data
```

The number that matters is `heapLimit` — V8's `heap_size_limit`, the ceiling a
process OOMs against. `heapTotal` is lazily allocated and always sits just above
`heapUsed`, so it always looks reassuring and never answers "how close am I?".
When a runtime reports no V8 statistics, `heapLimit` and `heapPct` are `null`,
never `0`: a hard-coded zero would read as plenty of room.

`cells` breaks the heap down per cell, which is what turns "the process grew"
into "this cell grew".

## Trojan — Control REST API

REST API at `/__aio/trojan/*` for inspection and control. **Dev only** — a prod
build does not mount it and refuses it if reached (`am status`, which reads the
lock file, still works against a prod app).

### Which wire it answers on

The control plane follows the app's transport, and `am` follows the app:

| The app's transport | `am` reaches it via                      |
| ------------------- | ---------------------------------------- |
| WS (a TCP port)     | `http://127.0.0.1:<port>/__aio/trojan/*` |
| UDS (a Unix socket) | a `ctl` frame on the app's socket        |

Both arrive at the **same** server-side handler, so the routes, the answers and
every auth gate are identical either way — the transport does not decide what
the operator can do. `am` reads which one applies from the lock file the app
wrote, so an app that binds no TCP port at all is still fully inspectable. The
socket is the stricter door of the two: it lives in a `0700` directory, while a
loopback port admits any local process.

`curl` examples below assume the TCP case; for a socket-only app use `am`.

**Which transport.** You never choose. Every `am` command that talks to a
running app — `state`, `dispatch`, `surface`, `trigger`, `clients`, `timeline`,
`errors`, `health`, `metrics`, `snapshot`, `sql`, `tt`, `persist`, `migrations`,
`cost` — resolves ONE endpoint (`controlEndpoint` in `am-http.ts`) from the lock
the app wrote: a socket path means UDS, otherwise the recorded TCP port. The
lock is found wherever the instance keeps its data home, so a packaged desktop
app running from its own `appDir` on zero TCP ports (the default for a local
Electron app since alpha66) is reached exactly like a dev server on `:8000`. The
only case that still needs `--port=N` is a listener **no lock describes** — an
orphan whose lock was removed, or a foreign aio process you are pointing at
deliberately — and `am` then verifies the port answers as the app you named. A
UDS app whose socket stops answering is reported as exactly that
(`running
on a UDS socket with no TCP port … the socket did not answer`), never
as "not running". Two instances of one id from two homes is a real ambiguity;
`am` lists them and asks for `--home=<dir>` rather than picking one.

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
| `/__aio/trojan/errors`        | Recent server errors                                            |
| `/__aio/trojan/cells`         | Cells and their method names                                    |
| `/__aio/trojan/graph`         | Dev import-graph verdict: `pending`, `valid`, `errors[]` (dev)  |
| `/__aio/health`               | Cell health + `persist: { ok }` (**not** under `trojan/`)       |

### Control (POST)

All POST endpoints require the `X-AIO: 1` header (CSRF protection). All return
JSON. Auth is inherited — tokens required when `--expose` is active. `$PORT` is
the app's own port (`am instances` prints it — there is no fixed default).

```sh
# Dispatch action
curl -X POST localhost:$PORT/__aio/trojan/dispatch \
  -H 'X-AIO: 1' -H 'Content-Type: application/json' \
  -d '{"type":"INCREMENT","payload":{"by":1}}'

# Force persist
curl -X POST localhost:$PORT/__aio/trojan/persist -H 'X-AIO: 1'

# Time-travel (dev only)
curl -X POST localhost:$PORT/__aio/trojan/tt -H 'X-AIO: 1' -d '{"cmd":"undo"}'
curl -X POST localhost:$PORT/__aio/trojan/tt -H 'X-AIO: 1' -d '{"cmd":"goto","arg":3}'

# SQL query (read-only)
curl -X POST localhost:$PORT/__aio/trojan/sql -H 'X-AIO: 1' \
  -d '{"query":"SELECT * FROM users LIMIT 10"}'

# Drive the client UI — by semantic PATH, not a CSS selector
curl -X POST localhost:$PORT/__aio/trojan/trigger/0 \
  -H 'X-AIO: 1' -H 'Content-Type: application/json' \
  -d '{"path":"SubmitButton","action":"click"}'
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
deno task am trigger App:LoginButton click
deno task am logs --client --json | jq -r '.lines[]' | grep ERROR
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
