# One data directory, and updating a deployed app — design

Status: **Part 1 SHIPPED in 1.0.0-alpha38** (see
[Where Files Live](../persistence/where-files-live.md) and the
[upgrade guide](../upgrade/from-alpha37-to-alpha38.md)); **Part 2 still
design**. Date: 2026-07-26. Origin: "what's the best way to update an aio app?"
plus the owner's rule — **all user data in ONE directory, so backup and
migration are one copy**.

What landed in Part 1, against this design: `src/server/app-dirs.ts`
(resolution + `resolveAppDirs`, the libraryMode rule, `meta.json`),
`src/server/app-dirs-migrate.ts` (the one-time move), `am data` / `am backup` /
`am restore` (`src/am/am-cmd-data.ts`), and `appDirs` exported from `aio/server`
so an app's own files land inside the one backup unit.

Deviations from this design, all decided while building it:

- `dataDir` shipped as **`appDir`** and `AIO_DATA_HOME` as **`AIO_APPS_DIR`** —
  every designed name said "data" while setting the folder that merely
  _contains_ `data/`, so `dataDir: "/opt/w"` read like a typo for `/opt/w/data`.
- the third resolution level `AIO_DATA_DIR` was **dropped**:
  `AIO_APPS_DIR=/var/lib` already yields `/var/lib/wallet`, and a third spelling
  of "put it here" is what made the names unreadable.
- `cache/` was **dropped** — created under every app on every boot, written by
  nothing.
- the launch record lives at **`~/.<appId>/launch.json`**, not `~/.aio/launch/`:
  those are one app's flags, so keeping them with the app retired the toolchain
  directory AND its env var (`AIO_HOME` already means the framework checkout —
  the collision that started this review).
- `am start`'s stdout capture moved out of `<project>/.aio.log` into
  `~/.<appId>/logs/stdout.log`, so one app's output isn't split across two dirs.
- `am data reset` was dropped (`rm -rf` is one command; a destructive alias
  earns nothing), and backups are directory copies rather than tarballs (no new
  dependency, and `tar` still works by hand).

Two halves, in this order: the data directory is a prerequisite for a sane
update story (you can't promise "swap the binary, keep the data" while the data
is in four places).

---

# Part 1 — `data/`: the one directory

## The problem today

An app's durable state is split, and differently in dev and prod:

| What                        | Dev                       | Compiled                  |
| --------------------------- | ------------------------- | ------------------------- |
| state (`data.db`)           | `./data.db` (cwd)         | `~/.local/share/<appId>/` |
| `auth.db` (users, sessions) | `~/.local/share/<appId>/` | same                      |
| journal                     | next to the state db      | next to the state db      |
| TLS certs                   | `./.aio-tls/`             | `./.aio-tls/`             |
| logs                        | `./.aio/log`              | `./.aio/log`              |

Consequences, all real:

- **Backup is a trap.** Copy the project directory in dev and you lose every
  user and session; copy the data dir and you lose the state.
- **"Where is my data?" has no single answer**, and it changes when you compile
  — the one moment you most want it to stay put.
- **Update instructions can't be honest**: "replace the binary, data survives"
  is only true for some of the data.

## The decision

**One dot-directory in `$HOME`, named after the app, is where everything the app
owns lives — in dev and in production alike.** Inside it, three tiers of data
that differ only in backup policy (owner's model, 2026-07-26):

| Tier             | Meaning                                               | Backed up?                           |
| ---------------- | ----------------------------------------------------- | ------------------------------------ |
| ① **critical**   | must survive: state, users, journal, keys, user files | yes — this is the archive            |
| ② **expendable** | regenerable: logs, cache                              | no by default (logs: `--with-logs`)  |
| ③ **temporary**  | must NOT survive a reboot: socket, pidfile, lock      | never — different directory entirely |

```
~/.wallet/                    ← ONE place to look (appId = "wallet")
  data/        ① EVERYTHING critical + secret. THE backup unit. 0700.
    state.db     state + `db:` tables + sync op-log       (was ./data.db)
    auth.db      secret — users + sessions                (was ~/.local/share/…)
    journal/     durable action journal (journal: true)
    tls/         secret — self-signed cert + key          (was ./.aio-tls/)
    files/       app-written uploads (bulk — symlink elsewhere when huge)
    meta.json    appId, aio version, schema versions — self-describing archive
  logs/        ② app.log · debug.log · error.log · warning.log · perf.log ·
                 client.log (+ rotations), checkpoint.json   (was ./.aio/log/)
  cache/       ② regenerable — deletable at any time

$XDG_RUNTIME_DIR/aio/   (fallback /tmp/aio)
  wallet.sock  ③   wallet.pid  ③   wallet.lock  ③   watch-<port>.tmp  ③
```

**The `data/` subdirectory is the whole point of the layout:** "back up
`~/.wallet/data/`" is a complete, correct instruction that needs no tool and no
knowledge of what any file is. Everything outside it is disposable by
definition. `am backup` then adds only _consistency_ (SQLite `VACUUM INTO` under
WAL while the app runs) — not the decision of what to include.

Why this split rather than "logs live somewhere else": it separates **where a
human looks** from **what a backup contains**. One directory answers "what is
this app keeping on my disk"; the subdirectories answer "what do I need to
copy". Splitting the location as well would mean two places to look and no
benefit.

Notes that follow from the tiers:

- **Logs are expendable, not unwanted.** After a crash the log is the most
  valuable file on disk, so `am backup --with-logs` exists; they're rotation-
  capped so they cannot grow unbounded in `$HOME`.
- **`cache/` is separate from `logs/`** because nothing ever wants it in an
  archive — which makes `am data reset --cache` safe on a running app.
- **`files/` is critical but bulk**, so it's the one subdir with its own
  override: uploads can live on another disk without moving anything else.
- **Tier ③ is already correct in the code today** (`$XDG_RUNTIME_DIR/aio`, with
  `/tmp/aio` as fallback) and exists for a specific reason: the socket, pidfile
  and lock must be **machine-session-scoped**. In the data dir, a crash followed
  by a reboot would leave a stale pidfile that makes `am status` lie about a
  running app, and a socket path would end up inside backups. `$XDG_RUNTIME_DIR`
  (`/run/user/<uid>`) beats `/tmp` on both axes that matter here: it is `0700`
  (vs world-writable + sticky, where another local user can see names and play
  path-pre-creation games against a control socket — the class aio already had
  to harden the watcher sentinel against), and it is cleared on logout rather
  than "usually on reboot". A **root system service has no session dir**, so it
  lands in `/tmp/aio`; systemd's `RuntimeDirectory=` (`/run/<app>`) is the
  native answer there. Nobody should have to think about any of this — that is
  the point of using the OS's directory instead of inventing one.
- **Secrets change the backup contract.** Consolidation puts `auth.db` and
  `tls/` in the same tree as innocuous state, so an archive now carries
  credentials where a stray `cp data.db` did not. `am backup` says so in its
  output, supports `--no-secrets`, and the directory is `0700`.

`cp -r ~/.wallet/data backup/` is a complete backup; `am backup` is the version
that is consistent under a running app and honest about what it includes.

## `~/.<app>` vs `~/.aio/<app>` — DECIDED: `~/.<app>`

A single framework root (`~/.aio/wallet`, `~/.aio/notes`, …) is tempting: home
stays clean, and `amui` can enumerate every app by listing one directory. It
loses on an asymmetry:

- If `~/.aio/wallet` is the wrong choice, the person it hurts is **the app's end
  user** — who never sees the config, and is left wondering why their wallet's
  data lives under a framework they have never heard of.
- If `~/.wallet` is the wrong choice, the person it hurts is **the developer
  with seven aio apps** — who owns the config and can change it in one line.

Pick the default whose failure mode is recoverable by whoever suffers it.

Two supporting arguments:

- **Uninstall.** "Remove the app and its data" is `rm -rf ~/.wallet` — obvious
  and safe. Under a shared root, a user deleting `~/.aio` to get rid of one app
  destroys every aio app's data on the machine. That foot-gun exists only in the
  grouped layout.
- **Namespace.** `~/.aio/<app>` implies aio owns the name; two apps called
  `wallet` from different authors collide in one root, for a reason the user
  cannot see. `~/.wallet` collides too, but visibly and understandably.

**The tidiness argument gets a knob, not the default** — see `AIO_DATA_HOME`
below, which puts every app under one roof on the machines where that's wanted
(and makes the discovery index optional rather than necessary).

## Resolution — three levels, each one line

```
config.dataDir  /  AIO_DATA_DIR=/var/lib/wallet   → exact path, this app
AIO_DATA_HOME=~/.aio                              → root for ALL apps → ~/.aio/wallet
(neither)                                         → ~/.<appId>/
```

**Dev and prod resolve identically at every level**, so "swap the binary, the
data is untouched" is true without an asterisk, and a compiled binary finds
exactly what `deno task dev` was writing.

- `AIO_DATA_DIR` — one app, exact location: a service account's home,
  `/var/lib/<app>`, a mounted volume.
- `AIO_DATA_HOME` — one line in a shell profile puts **every** aio app under a
  chosen root. This is the answer for a developer running many aio apps who
  wants them grouped and enumerable, without imposing a framework-named path on
  anybody's end users.
- Neither — `~/.<appId>/`, the standard every user already knows from `~/.ssh`,
  `~/.gnupg`, `~/.docker`, `~/.aws`.

Everything downstream (backup, restore, update, `am data path`) asks the
resolver for one path, so all three levels work identically with no extra code.

Two consequences to keep honest:

- Two checkouts of the same app share one data dir, because `appId` — not the
  directory you ran from — is the app's identity. Already true for compiled
  apps; now true everywhere, which is the point. Use a distinct `appId` (or
  `AIO_DATA_DIR`) for a second instance.
- Deleting the project no longer resets state. `am data reset` (confirm-gated,
  offers a backup first) is the deliberate way to start clean.

## `~/.aio/` — the toolchain's own state (a different category)

`~/.aio/` is not a competing location for app data; it holds what **aio itself**
owns, which no app's backup should contain:

```
~/.aio/
  apps.json       index: appId → { dataDir, version, lastSeen } (regenerable)
  launch/         am's per-app launch records (flags/entry/cwd) for `am restart`
  keys/           pinned signing keys trusted by `am update-app`
```

`am`'s launch records live in the **runtime dir** today
(`$XDG_RUNTIME_DIR/aio/<appId>.launch.json`), which means they evaporate on
reboot — so after a machine restart `am restart` has nothing to replay and falls
back to a warning. That is the residue of the `--env-file` report: the flags are
recorded, just not durably. Toolchain state that must outlive a reboot belongs
here, not in tier ③.

**amui is an app, not toolchain.** It is built with aio, so its data lives at
`~/.amui/data/` under exactly the same rule as any other app. Special-casing the
framework's own dogfood app would mean the convention doesn't apply to the one
app we fully control — and if `~/.<app>/data/` is awkward for amui, it is
awkward for everyone, which is something to feel rather than hide.

With `AIO_DATA_HOME=~/.aio` set, every app's data (amui included) resolves under
that root — so a developer's machine ends up with toolchain state and app data
in one tidy place, while a shipped app still defaults to `~/.<app>`. No special
case, both preferences served.

## Migrating an existing app

On boot, if the legacy paths exist and the new directory does not, aio **moves
them** and says so, once, per file:

```
INFO  data  moving to ~/.wallet (one dir = one backup):
INFO  data    ./data.db                     → ~/.wallet/state.db
INFO  data    ~/.local/share/wallet/auth.db → ~/.wallet/auth.db
INFO  data    ./.aio-tls/                   → ~/.wallet/tls/
INFO  data  done — set AIO_DATA_DIR to put it elsewhere
```

Moving (not copying) is deliberate: two copies of a state database is a
data-loss shape all of its own — the app writes one, the operator backs up the
other. `--no-data-migrate` skips it and keeps reading the legacy paths for one
release, with a warning; `am doctor` reports a split layout as a FAIL with the
exact `mv` commands.

## User-facing commands

```sh
am backup                     # → ./backups/<appId>-2026-07-26T12-03.tar.gz
am backup --to /mnt/nas/x.tgz # state only; --with-logs to include logs/ + cache/
am restore /mnt/nas/x.tgz     # refuses a different appId; warns on newer schema
am data path                  # prints the directory (scripts, and "where is it?")
am data reset                 # wipe it — confirm-gated, offers a backup first
```

`am backup` takes a **consistent** snapshot of a _running_ app: SQLite
`VACUUM INTO` for each database (safe under WAL, no writer pause), then the
plain files. A stopped app is a plain copy. This is the piece that makes the
one-directory rule pay off for a non-expert: one command, one file, restorable.

## Seams it touches

- `paths.ts` — `resolveDataDir` / `resolveDbPath` / `resolveKvPath` collapse
  into one resolver; every other module asks it for a subpath.
- `logger-core.ts` (`DEFAULT_LOG_DIR`), `aio-server.ts` (`.aio-tls`),
  `journal.ts`, `sessions.ts`/`auth-users.ts` (auth.db), `client-log.ts`.
- `am` — `backup`, `restore`, `data path`, `data reset`; `am doctor` gains the
  split-layout check.
- `~/.aio/apps.json` — written at boot (best-effort: a read-only home must never
  fail a boot), read by `am`/`amui` for enumeration.
- `.gitignore` in the scaffold: `data.db` and `.aio/` entries go away entirely —
  no app data lives in the project anymore, which is one less thing to explain.
- Docs: persistence, deployment, and the upgrade guide (this is a **breaking
  path change**, so it belongs in an alpha with the auto-migration above).

---

# Part 2 — `am update-app`: updating a deployed app

## What exists today

`aio ship` already produces the safety-critical half: a binary plus a manifest
carrying **sha256, size, Ed25519 signature, the verifying public key**, and the
least-privilege `runFlags`. What's missing is the client that consumes it.

Everything else an update needs is already true: state lives outside the binary
(after Part 1, in exactly one place), cell `version`/`onMigrate` run at boot,
shape drift is detected, connected clients reload on a new boot id, and a
version-skewed client gets a message naming which build is old.

## The decision

**An update is a verified file swap plus a restart, driven from the outside** —
never a process rewriting its own binary while serving requests.

```sh
am update-app --manifest=https://releases.example.com/wallet/latest.json
```

1. **Fetch** the manifest; compare `version` with the running app (`am status`).
   Nothing newer → exit 0, "already current".
2. **Download** the binary next to the current one (`app-1.4.0.partial`).
3. **Verify** — sha256 must match the manifest, and the Ed25519 signature must
   verify against a **pinned** public key (`--key=` or `data/meta.json`'s
   trusted key). A mismatch aborts before anything is swapped. This is the whole
   reason `ship` signs.
4. **Stage** — `chmod +x`, rename to `app-1.4.0`.
5. **Flip** — `ln -sfn app-1.4.0 app` (atomic). The old binary stays.
6. **Restart** — `am restart` (replaying the recorded launch flags) or
   `systemctl restart` when a unit owns it.
7. **Health check** — poll `/__aio/health` for `--health-timeout` (default 30s).
   Green → done, print old → new. Not green → **flip the symlink back, restart,
   exit non-zero**, and say precisely that it rolled back and why.

```
✓ verified  wallet 1.4.0  sha256 9f2a…  signed by key 4c11…
✓ staged    /usr/local/bin/wallet-1.4.0
✓ switched  wallet → wallet-1.4.0
✗ health    no response in 30s — rolled back to 1.3.2 (running, healthy)
```

## Rules that keep it boring

- **Never in-process.** The updater is `am`, a separate process. An app cannot
  replace its own running binary safely.
- **Never unsigned by default.** `--allow-unsigned` exists for a private LAN
  build, and says so loudly at every step.
- **Keep N old versions** (`--keep=3`) so a manual rollback is a symlink flip.
- **Data is never touched.** Not by update, not by rollback. Migrations are the
  app's job at boot, and they are already guarded (downgrade guard + shape
  drift). A rollback after a _forward_ migration is the one thing an updater
  cannot fix — so the health check runs BEFORE anything is deleted, and the
  guide says plainly: take `am backup` first when the release bumps a cell
  `version`.
- **Electron/Android are out of scope.** Those have platform update channels;
  pretending otherwise would be a worse lie than saying "not covered".

## Rollout

1. Part 1 (`data/`) with auto-migration + `am backup`/`restore` — the
   prerequisite, and useful on its own the day it lands.
2. `am update-app` against a local `file://` manifest (testable end-to-end in
   CI: build v1, ship, update to v2, assert state survived and a failed health
   check rolls back).
3. `--keep`, `--allow-unsigned`, systemd mode.
4. Documented deployment recipe: symlink layout + unit file + the update command
   in a cron/CI job.

## Open questions

- Should `am backup` be automatic before an update that bumps any cell
  `version`? (Leaning yes, with `--no-backup` — the failure it prevents is the
  unrecoverable one.)
- Where does the trusted signing key live for a first install — `meta.json`, a
  flag, or the app's own config? (Leaning: pinned in `meta.json` on first
  verified install, TOFU with a loud one-time line.)
- Is `am update-app` the right name next to `am update` (which updates the
  _framework_)? `am upgrade` reads better but invites the same confusion.
