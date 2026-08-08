# Channelled app updates — design

Status: **SHIPPED and wired** — `updates: "<url>"` in `aio.run()` turns it on.
See [Implementation status](#implementation-status) for what is covered and the
two deliberate gaps. Date: 2026-08-08. Supersedes the "Part 2 — `am update-app`"
section of
[`2026-07-26-data-dir-and-updates.md`](./2026-07-26-data-dir-and-updates.md) and
the open `aio ship` auto-update client item in `todo.md`.

Origin: "every app needs some way to be updated, so it seems like a general use
case that should be supported on aio side."

Part 1 of the data-dir spec (one `~/.<appId>/` directory, data outside the
binary) is the prerequisite and shipped in alpha38. The signable half —
`aio ship`'s manifest with sha256 + Ed25519 signature + least-privilege
`runFlags` (`src/build/ship.ts`) — shipped too. What is missing is everything
between: channels, the client that notices, and the swap.

---

## The decision, in one line

**Detect in-process (a built-in cell, opt-in, identical in dev and prod); apply
out-of-process, with a strategy per target.** Channels are a URL convention and
a signed field, not a subsystem.

The seam is the whole design. An app is the only thing that has a UI and a user
session, so it must be what notices and asks. A process cannot safely replace
its own running binary, so it must not be what swaps. Splitting there gives
**universal detect, per-target apply** — which is why Electron and Android can
have the notification even where they cannot have the swap.

### Why this belongs to aio rather than to each app

The three hard parts — signature verification, the permission wiring that lets a
least-privilege binary reach its release host at all, and a swap that rolls back
when the new build does not come up — are precisely what an app author gets
wrong quietly. That is a framework concern by aio's own first convention. The
easy part (a banner, a dialog, when to ask) stays with the app, because it is
design, and aio has no business having an opinion about it.

Against the inclusion razor: useful (every deployed app), not duplicate (nothing
in aio does it), 2+ app types (service, AppImage, Electron, CLI binary). Passes.

---

## Layer 0 — the artifact contract

### The manifest, extended

`ShipManifest` today carries `name`, `version`, `sha256`, `size`,
`capabilities`, `runFlags`, `signature?`, `publicKey?`. It gains — all inside
the signature:

```ts
channel: string;          // "dev" | "test" | "prod" | any app-defined name
target: UpdateTarget;     // "binary" | "appimage" | "electron-appimage"
                          //   | "electron-zip" | "android"
platform: { os: string; arch: string };
url: string;              // artifact location; relative to the manifest, or absolute
releasedAt: string;       // ISO
notes?: string;           // shown in the prompt — a line, or a link to the changelog
minFrom?: string;         // refuse to update FROM older than this (forced-step release)
```

Every one of these is a field a client must be able to _refuse on_. That is the
reason they are signed rather than inferred from the path: the realistic failure
here is not an attacker, it is **a test build published to the prod path**, and
only a signed, self-describing manifest catches that.

### Channel layout — three files on a static host

```
<source>/<channel>/<os>-<arch>.json      the manifest
<source>/<channel>/latest.json           alias for the host's own platform, optional
<source>/<channel>/<artifact>            the binary/AppImage/zip
```

`<source>` is any URL `fetch` understands. Both cases are first-class and share
one code path:

- **remote** — `https://releases.example.com/wallet` (S3, GitHub Releases,
  nginx, a Pages site). No server, no API, no auth to design.
- **local** — `file:///mnt/releases/wallet`, a mounted share, a USB stick, a CI
  output directory. This is what makes the E2E test real rather than mocked, and
  it is the honest answer for air-gapped and LAN deployments.

Adding a registry or a release API here would fail the razor. Three static files
per channel is the whole distribution story.

### Stamping the channel into the artifact

`aio ship --channel=test` writes the channel into the manifest **and** into the
build. `build-compile.ts` already embeds the app's `deno.json` as its identity —
precisely so a compiled binary reports its own version rather than adopting the
version of whatever project it is launched from. The channel rides that same
path (`build.channel` in `deno.json`, overridable per ship). One mechanism, one
place, already load-bearing.

---

## Layer 1 — detect: the `updates` cell

### Configuration

```ts
updates: {
  source: string,             // https://… or file://… — required
  channel?: string,           // default: the artifact's stamp (see resolution below)
  interval?: number,          // ms; default by channel: dev 60_000 · test 300_000 · prod 21_600_000
                              //   0 = never poll (manual check() only)
  onBoot?: boolean,           // check once at startup — default true
  key?: JsonWebKey,           // pinned verify key; omitted ⇒ TOFU on first verified install
  policy?: "notify" | "prompt" | "auto",   // default "notify"
  prerelease?: boolean,       // default false — ignore prerelease versions in this channel
}
```

Omitted entirely ⇒ the cell is not registered, nothing polls, nothing ships in
the client bundle. Off by default, zero cost when unused.

### Polling defaults, and why not one minute everywhere

A one-minute poll is right where you are iterating and wrong where users live:
it is 1440 requests per day per instance for something that changes weekly, on
somebody else's machine and somebody else's bandwidth. So the interval is **per
channel** (`dev 1m · test 5m · prod 6h`), jittered to avoid a fleet thundering
the release host on the same second, and every check sends `If-None-Match` so an
unchanged manifest costs a 304 and no body. One minute stays available for
anyone who wants it — it is a default, not a ceiling.

### Cell state — the entire public surface for an app author

```ts
s.updates = {
  channel: string,
  current: string, // running version
  available: null | { version, notes, size, releasedAt },
  status: "idle" | "checking" | "available" | "downloading" |
    "staged" | "applying" | "error",
  progress: number, // 0..1 during download
  lastChecked: string | null,
  error: string | null,
  dismissed: string | null, // the version the user said "no" to
};
```

Methods: `check()` · `download()` · `apply()` · `dismiss()` · `setChannel(c)`.

A cell rather than an API because a cell is already everything this needs:
reactive UI binding, automatic sync to every connected client, `testCell` and
`testUI` coverage, visibility in `am state` and `am timeline`, and persistence
of `dismissed` across restarts. Zero new concepts for the app author — it is
state, like everything else.

### The dialog is the app's, the prompt is aio's

aio ships **no visual component**. `src/ui/` is three files and should stay
small, and an update banner is a design decision that belongs to whoever
designed the rest of the app. The app renders from `s.updates` — a banner, a
menu item, a settings pane, a red dot, nothing at all. A copy-paste
`<UpdateBanner/>` lands in `examples/` and in the docs so it is thirty seconds
of work rather than a design exercise.

The **manual check button** is `updates.check()`. That is the whole feature.

The one prompt aio does own is the **TTY prompt**, because a headless service
has no app UI to delegate to: `policy: "prompt"` on an interactive terminal asks
y/n on stdin. `policy: "notify"` never asks (state only — the app decides).
`policy: "auto"` applies without asking, for unattended fleets.

### Dev and prod run the same code — this is not a compiled-only feature

The instinct is to gate the whole thing on "production build only". That would
be a silent behavioural fork, which this project bans, and it has a concrete
cost: you could never see your own update banner while building it.

So the split is not dev-vs-prod, it is **artifact-vs-source**:

- **detect** is identical everywhere. Same poll, same cell state, same UI. Under
  `deno task dev` you point `source` at a `file://` directory and develop the
  banner against real manifests.
- **apply** dispatches on `target`, and the target for a source tree is
  `"source"`, whose strategy is **refuse, loudly**: _"running from source —
  there is no artifact to swap; build and ship first."_

Dev is stricter and louder than prod; prod never does something dev did not.
Category (b) of the dev/prod rule, which is the allowed direction.

---

## Layer 2 — apply: one pipeline, five strategies

Every strategy runs the same spine — **fetch manifest → verify signature → check
channel/target/platform match → download → verify sha256 → stage → swap →
restart → health check → roll back on failure**. Only the swap and the restart
differ.

| Target                           | Swap                                                                 | Restart                                                                                   |
| -------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **binary / service**             | download beside → verify → `ln -sfn app-<ver> app` (atomic)          | `am restart` replaying `launch.json` → poll `/__aio/health` → auto-rollback               |
| **binary, CLI-launched**         | same                                                                 | **check before serving**: found → y/n on TTY → swap → re-exec self with the original argv |
| **AppImage / electron-appimage** | download beside → verify → `chmod +x` → `rename()` over the old path | takes effect at next launch; offer relaunch now                                           |
| **electron-zip** (win/mac)       | download → verify → unpack to `app-<ver>/`                           | flip the launcher path → relaunch                                                         |
| **android**                      | ✗ not supported                                                      | detect only — surface the release/store link                                              |
| **source** (`deno task dev`)     | ✗ refuse loudly                                                      | —                                                                                         |

Three notes where the detail matters:

- **Check-on-restart is the best answer for services, and it is nearly free.**
  The hard part of updating a service is that something is running; at boot,
  nothing is. A CLI-launched binary checks before it opens its port, asks on the
  TTY, swaps, and re-execs. There is no downtime to manage because there is no
  running instance yet. Under systemd the prompt is impossible and unwanted, so
  a non-TTY launch never asks — it notifies, or applies if `policy: "auto"`, and
  lets the unit's own restart do the rest.
- **`rename()` works on a running executable.** Linux refuses a _write_ to a
  busy binary (`ETXTBSY`) but a rename only moves a directory entry; the running
  process keeps its inode and its mounted AppImage. So the swap is atomic and
  immediate, and the new version is what launches next. No "apply on quit"
  bookkeeping, no shutdown hook that can be skipped by a crash.
- **Electron is in scope after all.** The earlier spec put it out of scope on
  the grounds that platforms have their own channels — but aio _builds_ the
  Electron distributable itself (`build-electron.ts` → AppImage on Linux, zip on
  Windows/macOS), so there is no platform updater to defer to, and the swap is
  the same rename. Android stays out: an APK install is an OS-mediated flow, and
  pretending otherwise would be the worse lie.

---

## Layer 3 — the safety floor

Non-negotiable, each one a gate rather than a guideline:

- **Signature or nothing.** Ed25519 verify against a pinned key, TOFU-pinned
  into `data/meta.json` on first verified install with a loud one-time line
  naming the key. `--allow-unsigned` exists for a private LAN build and says so
  at every step, in every output mode.
- **Refuse on mismatch.** `channel`, `target`, `platform` come from the signed
  manifest and must match what the client asked for. Abort before anything is
  downloaded.
- **Monotonic versions.** A lower version never installs itself. The only bypass
  is an explicit channel switch or `--force`, both confirmed, because crossing
  channels legitimately moves you backwards.
- **TLS for `https:`.** `file:` and plain-HTTP LAN sources are allowed and say
  what they are.
- **Back up before a migration.** When the incoming version bumps any cell
  `version`, `am backup` runs first. A rollback after a forward migration is the
  one thing an updater cannot repair, so it is the one thing it refuses to walk
  into. `--no-backup` to override.
- **Keep N artifacts** (`--keep=3`), so manual rollback is a symlink flip.
- **Health before deletion.** Nothing old is removed until the new build answers
  `/__aio/health`. Failure flips back, restarts, exits non-zero, and says
  precisely what it rolled back and why.
- **The capability trap.** `scanCapabilities` (`src/build/capabilities.ts`)
  reports `net: false` for an app with no `fetch` in its source — so a purely
  local app that enables `updates` compiles to a least-privilege binary that
  **cannot reach its own release host, in production only**. Configuring
  `updates` must force `net: true` into the capability manifest, and `ship` must
  refuse when it has not. This is the highest-value item in this document: it is
  a dev-works/prod-dies divergence, invisible until a user needs the update
  most.

---

## Layer 4 — how this gets proven

- `testCell` over the updates cell: every status transition, including the ones
  that must not happen (downgrade, wrong channel, wrong platform, dismissed).
- `testUI`: banner appears on `available`, y/n dialog drives `apply`/`dismiss`.
- **E2E over `file://`**, in CI, as a `test:build`-class gate — the local source
  is what makes this a real test rather than a mock:
  1. build v1, `ship --channel=test`; build v2, ship. Run v1.
  2. assert the cell notices, `apply()`, assert v2 is running **and
     `~/.<appId>/data/` is byte-identical**.
  3. publish a v3 with a corrupted sha256 → assert abort before staging.
  4. publish a v4 that fails its health check → assert automatic rollback to v2,
     running and healthy, non-zero exit, and a message that names the reason.
  5. publish a v2 manifest onto the `prod` path → assert a `prod` client refuses
     it on the channel field.
- Property test: no manifest field outside the signature; no target strategy
  that can reach `swap` without passing `verify`.

---

## Rollout

1. **Manifest v2 + the `updates` cell, detect only.** Channels, local and remote
   sources, `check()`, the cell state, the `file://` E2E harness. Useful the day
   it lands: notification, a manual check button, and the app's own banner.
2. **Apply for binary/service**: `am update-app`, check-before-serving with TTY
   prompt and re-exec, health check, rollback, the backup gate.
3. **AppImage and Electron strategies**, `am channel`, `--keep`.
4. **`policy: "auto"`** for unattended fleets, `minFrom` forced-step releases,
   and a documented deployment recipe (symlink layout, unit file, CI publish
   job).

Each stage is shippable alone, and stage 1 carries no swap code at all — which
is the point of putting the seam where it is.

## Open questions

- **`am update-app` vs `am upgrade`.** `am update` would update the _framework_;
  both spellings invite the same confusion. Leaning `am update-app`, ugly and
  unambiguous, until something better appears.
- **Does `updates.apply()` get to trigger the swap directly, or is the cell
  strictly notify-only** with a human or CI running `am update-app`? Leaning: it
  triggers, because "smooth when the developer needs it" is the whole request —
  but it does so by handing off to a detached updater process and exiting, never
  by swapping in-process. The rule that survives either answer is the same one.
- **Should a dismissed version stay dismissed across a channel switch?** Leaning
  no — a channel switch is a new context.

---

## Data compatibility — the rule that outranks the rest

An update never breaks the app or its data. Everything else in this document
bends to that, and it is enforced by a **signed data contract** rather than by
care at release time.

`aio ship` records, per cell: the schema `version` this build writes, and the
oldest version it can `migratesFrom`. That second number is derived from what
the cell actually declares, never guessed:

| The cell declares                | `migratesFrom` | Consequence                               |
| -------------------------------- | -------------- | ----------------------------------------- |
| `version: 3` **and** `onMigrate` | `1`            | migrates any older store — offer freely   |
| `version: 3`, **no** `onMigrate` | `3`            | can only read what it wrote — **blocked** |
| explicit `migratesFrom: 2`       | `2`            | ancient shapes deliberately dropped       |

The middle row is the point. Bumping a version and forgetting the migration
stops being a data-loss incident at some user's next boot and becomes an update
that is simply **never offered to them**.

The client then runs the gate before it calls anything an update
(`dataCompatibility` in `src/server/updates-core.ts`):

- release older than the data on disk → blocked
- persistence schema goes backwards → blocked
- a cell's version bumped past what the release can migrate from → blocked
- a cell disappeared → **warning**, not a block (the rows stay; they stop being
  read, and that was the author's deliberate choice)
- any migration at all → allowed, and flagged `migrates: true`, which makes
  `am backup` part of the apply rather than an option

A blocked release is reported as its own state — `status: "blocked"`, with the
reasons — and never as `available`. Hiding it would read to the user as "you are
up to date", which is false; putting it in `available` would render a Yes button
that must not exist. There is no code path from blocked to installed.

A rollback cannot un-migrate a store, so the backup taken before a migrating
update is recorded in the pending marker and restored by the rollback.

## Sources are agnostic — a repository is a source

`<channel>` is a name the source interprets: a **directory** under a manifest
source, a **git ref** under a git source. Nothing above that layer changes.

| Source                           | Kind     | "New version" is | Applying it     |
| -------------------------------- | -------- | ---------------- | --------------- |
| `https://rel.example.com/wallet` | manifest | a newer semver   | download + swap |
| `file:///mnt/releases/wallet`    | manifest | a newer semver   | download + swap |
| `https://github.com/you/app`     | git      | the ref moved    | rebuild + swap  |

This exists because apps installed by the one-line `run.sh` runner already treat
a repository as the source of truth; following it is the same principle, not a
second mechanism. Two honest differences, both stated rather than papered over:

- **No signature.** A git source's authenticity rests on the repository URL and
  the transport, exactly as the one-line installer's does. Said out loud.
- **The data gate runs later.** What a commit does to the store is only knowable
  once it is built, so the check happens after the build and before the restart,
  and `decideGit` reports that instead of implying safety.

Inference is deliberately narrow: `github.com/you/app` is a repository,
`rel.example.com/wallet` is a manifest location, and anything ambiguous (a deep
forge path) **throws** asking for `kind:` rather than picking. A wrong guess
here points an app at a location that never answers, and "no updates available"
is indistinguishable from "up to date" — the exact silent failure this project
bans.

## The boot report

An app should never leave anyone guessing what they are running.
`src/server/boot-facts.ts` adds, to the existing report: `build` (source vs
compiled, and the artifact kind), `artifact` (the file on disk — inside an
AppImage the `.AppImage`, not the squashfs mount), `platform` + runtime, `data`
(the one directory to back up), `cells`, and `updates` (channel · kind · cadence
· ask-vs-auto) with its `source`. Every value is read from the running process
rather than from configuration, because configuration gets copied between
machines and a report that repeats intent rather than fact is worse than none.

An app with no update path prints `updates  not configured` — once, at the only
moment anyone is looking, rather than leaving its absence to be discovered when
an update is needed.

## Implementation status

**Built and tested** (51 new tests; full core suite 3835/0; check · lint ·
boundaries · api all green):

- `src/build/ship.ts` — manifest v2. `channel`, `target`, `platform`, `url`,
  `releasedAt`, `notes`, `minFrom` and the `data` contract, **all inside the
  signature**. The signature moved from covering only the binary digest to
  covering a canonical manifest core — v1 signed the bytes but none of the
  coordinates, so a genuine `test` build moved onto the `prod` path verified
  perfectly. v1 manifests are now refused rather than downgraded to.
- Verification demands a **trusted** key (pinned, or TOFU'd): a self-signed
  manifest with its own key attached is internally consistent and worthless.
  Unsigned is refused unless explicitly allowed, and refused outright once a key
  is pinned (stripping a signature must not downgrade anyone).
- `src/build/capabilities.ts` — `updates:` forces `net`. A local-only app scans
  to `net: false` and its least-privilege binary then cannot reach its own
  release host: the check dies **in production only**, silently.
- `src/server/updates-core.ts` — config resolution (a bare URL is the whole
  configuration), channel precedence, per-channel cadence, source
  classification, semver with prerelease, the data gate, `decide`/`decideGit`.
- `src/state/updates-cell.ts` — the cell: state, `check`/`apply`/`dismiss`/
  `setChannel`, an access rule that opens up on a loopback-bound app and
  requires a user once exposed, and a persist filter that keeps only the
  dismissal (a stale "update available" for a pulled release must not survive).
- `src/server/updates-apply.ts` — `$APPIMAGE`-aware artifact resolution, target
  detection, the atomic swap (copy-aside then rename — `rename` works on a
  running executable where a write gets `ETXTBSY`), prune-to-N, the pending
  marker, boot-verified rollback, and the relaunch handshake.
- `src/server/boot-facts.ts` — the boot report above, wired and verified.

**The relaunch handshake, specifically.** aio takes a single-instance lock per
appId and refuses to start while one is held, so the obvious "spawn the new
process, then exit" loses the race: the successor asks for the lock while the
predecessor still owns it, is refused, and the app is simply gone. The successor
is therefore started with `--__aio-relaunch-after=<pid>` and waits for its
predecessor to disappear before booting. No helper binary — the artifact at that
path is already the new version, and it is the one doing the waiting. Bounded at
30s, because hanging with no UI and no logs is worse than a lock diagnostic.

**Wired, and working end to end:**

- `updates?: UpdatesInput` on `AioConfig`/`CellsConfig`, in the config
  vocabulary and the `aio.run({…})` help table.
- `src/server/updates-check.ts` — fetch (http + file), ETag/304, the trust
  store, `git ls-remote`. `src/server/updates-runtime.ts` — the ORDER the pieces
  run in, which is the part that has to be right every time.
  `src/server/updates-boot.ts` — the three boot moments.
- `aio/updates` is a published entry, mapped for the browser too, so a UI binds
  `updates.available` like any other cell state.
- `<binary> --aio-data-contract` prints the contract derived from the cells the
  build actually contains; `aio ship` runs it, so a published contract cannot
  drift from what the binary does. Ship says so loudly when it cannot.
- `--channel=` on any app; `AIO_UPDATE_CHANNEL` in any environment.
- `docs/deploy/updates.md`, and `examples/updates/` (banner, blocked state,
  progress, manual check).

**Three defects the tests and a live boot found, all fixed:**

1. A progress dispatch that failed aborted the whole download. Progress is
   observe-only; reporting must never break the thing it reports on.
2. The cell registered in EVERY app, because the server value-imported it — the
   exact thing the separate entry point exists to prevent. Every path from the
   server is now dynamic, and `tests/updates-optin.test.ts` pins it.
3. Running from source, every check reported "refused", so an update banner
   could not be developed in dev. Detection is universal; only `apply` refuses.

**Both remaining targets closed (this pass):**

- **`electron-zip` (Windows / macOS).** Verify the archive → unpack to a sibling
  → hand the directory swap to the system shell. The indirection is forced, not
  stylistic: a process cannot move the directory it is running from, and Windows
  locks the running `.exe` inside it, so neither the old install nor the new one
  can perform the move. `/bin/sh` and `cmd.exe` live in neither directory and
  are always present. The script waits for the app to exit, moves both
  directories, starts the new launcher, and puts the old one back on failure.
  The pending marker is written BEFORE the hand-off, so boot-verified rollback
  still applies. The install root requires the launcher AND the bundled
  `electron/` together — a lone `run.sh` in someone's home directory must never
  be mistaken for one.
- **git rebuild.** Shallow-clone the ref into a throwaway directory, run the
  repo's own `compile` task, find the artifact **by time** (the same rule
  `run.sh` uses — a second copy of the framework's naming rules here would go
  stale silently), probe it for its data contract, run the gate, then copy it
  beside the running artifact and swap. A temp build directory is usually a
  different filesystem, so the copy is what makes the following `rename` atomic.
  The commit is recorded on success; `run.sh` now exports `AIO_BUILD_COMMIT` so
  a fresh install has something to compare against instead of refusing forever.

The git path is the one place the ordering differs, and it is forced: a commit
cannot state what it does to persisted data until it has been BUILT, so the gate
runs after the build rather than before the download. Everything the gate
protects is still protected — nothing is installed until it passes, and a
blocked build is discarded with its temp directory.

Coverage is now complete: `binary`, `appimage`, `electron-appimage`,
`electron-zip` and `git` all install; `android` detects and points at the OS;
`source` detects and refuses to swap. One spine, six endings.

## After updates: the rest of the lifecycle

Two adjacent gaps closed in the same pass, both for the same reason — they are
mechanisms aio already had the data for, and an app author cannot assemble.

- **Problem reports** (`docs/debugging/feedback.md`). Every field a maintainer
  asks for is something aio already holds: the boot facts above, cell state, the
  dispatch timeline, the diagnostic bus, the log. The load-bearing rule is that
  a report honours the app's existing `redactActions` list — the same one the
  journal, timeline and checkpoint honour — because a report that ignored it
  would be precisely the leak that list exists to prevent. It closes a loop with
  updates: "this build is broken" now carries which build, which channel, and
  which commit.
- **Release publishing** (`aio ship github`). A workflow file, emitted rather
  than integrated. The channel layout is the part aio owns and the part that
  must not drift; the transport is GitHub's and stays theirs.

Deliberately NOT built: a project website. It shares no mechanism with the
runtime, every app wants a different one, and the channel manifests are already
a machine-readable index of every release — a static page can read them. That is
a docs recipe, not a framework feature.
