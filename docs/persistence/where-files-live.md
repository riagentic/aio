# Where Files Live

One app, one directory. Everything an aio app writes is under `~/.<appId>/`, and
the part you back up is one subdirectory of it.

```
~/.wallet/
  data/     ← ① back this up. Nothing here can be recreated.
    state.db        cell state + db: tables + the sync op-log
    state.db-wal    (SQLite sidecars — copy them WITH state.db)
    auth.db         users + sessions          🔒 secret
    journal         durable action journal (journal: true)
    tls/            self-signed cert + key    🔒 secret
    files/          whatever your app writes
    app.key         the persisted access token (key: true)  🔒 secret
    backups/        pre-update store snapshots (3 kept) — see updates
  logs/     ← ② regenerable: app.log, error.log, client.log, stdout.log …
  cache/    ← ② regenerable BULK your app writes: downloads, build trees, thumbnails
  app/      ← ② the unpacked binaries a packaged app RUNS from (AppImage) 🔒 0700
  launch.json ← ② the flags `am` started it with, so `am restart` replays them

$XDG_RUNTIME_DIR/aio/   ← ③ must NOT survive a reboot
  wallet.sock  wallet.pid  wallet.lock
```

Four tiers, and the only question that separates them is **what a backup
contains**:

| Tier         | Lose it and…                          | Where                                   |
| ------------ | ------------------------------------- | --------------------------------------- |
| ① critical   | the data is gone                      | `~/.<appId>/data/`                      |
| ② expendable | the app recreates it                  | `~/.<appId>/logs⎪cache/`, `launch.json` |
| ②b payload   | it re-unpacks — but not while it runs | `~/.<appId>/app/`                       |
| ③ temporary  | it must not survive a reboot at all   | `$XDG_RUNTIME_DIR/aio/`                 |

**Why tier ③ isn't in the app directory** — it's the one deliberate split, and
it buys three things: a `.sock`/`.lock` must NOT survive a reboot (in `$HOME`
they linger and lie about a running app), unix sockets don't work on network/NFS
homes while `/run/user` is tmpfs, and socket paths have a ~108-character limit
that a long home path can blow. `am data` prints the location, so you never have
to remember it.

`data/` is created `0700` — it holds the auth store and a TLS private key, so
the mode assumes the worst file in the tree.

`cache/` is where an app puts regenerable bulk — a 20 GB source tree, extracted
downloads, generated thumbnails. It is deliberately OUTSIDE `data/` so it never
enters a backup: `am backup` copies `data/` only, and losing `cache/` costs
time, not information. Reach it with `appDirs(appId).cache` (`aio/server`).

`app/` is where a **packaged app unpacks itself**. An AppImage stages its
contents into `$TMPDIR` before a single line of your app runs, so the launcher
is the only place that can choose where — every aio launcher points it here, at
mode `0700`.

The default (`/tmp`) is not merely untidy. Measured on the runtime aio ships:

- the FUSE-less **extract** path names its directory after a **digest of the
  AppImage** — predictable to anyone on the host — and creates it `0755`, so the
  unpacked app is world-readable. (The FUSE mount path is `0700` and user-only;
  only the extract path leaks.)
- the digest is per-**file**, not per-user, so a second user running the same
  AppImage lands in the first user's directory. The runtime does not fail there:
  it warns, exits 0, and runs whatever tree is already present.
- `/tmp` is `noexec` on hardened hosts (the app won't start), tmpfs on most
  distros (a ~200 MB unpack goes to RAM), and tmp-cleaners delete underneath
  long-running apps.

Launching an AppImage yourself? Do what the launchers do:

```sh
TMPDIR=~/.wallet/app ./wallet-x86_64.AppImage      # the path: deno run -A jsr:@riagentic/aio/build --print-app-tmpdir
```

An app that finds itself unpacked somewhere world-writable says so at boot (a
`security` warning naming the path and the fix) — it still runs; it just never
does it silently. Empty `.mount_*` stubs left by a crash are swept on the next
start; extracted trees are kept deliberately, as a warm start.

`logs/stdout.log` is the raw stdout+stderr of an app that `am start` launched —
where a bare `console.log` in a cell and the stack trace of a crash _before the
logger is up_ end up. The framework's own structured logs are the other files.

Every one of them keeps history: on start the live file rotates to `.1` and the
older archives shift up, bounded by `backupKeep` (7) and by a byte ceiling over
the whole directory (`logBudget`, 200 MB), which evicts the oldest run first and
says so in `app.log`. `--no-backup-logs` restores the old wipe-on-start.
`stdout.log` rotates too — done by `am` just before it spawns the app, because
the shell redirect that writes it holds the fd for the life of the run.

## The program vs its data

`run.sh` installs a built app into a directory you can open, and keeps its data
where the app itself writes:

```
~/app/<name>/versions/<version>/<name>.AppImage   the artifact
~/app/<name>/<name>.AppImage → that               the stable name
~/app/<name>/<name>.svg                           its icon
~/.local/share/applications/<name>.desktop
~/.<appId>/                                       ← everything the app OWNS
```

The VERSION is the directory and the file keeps the app's name, deliberately: a
deno-compiled binary derives its identity from its own file name at runtime, so
installing it as `<name>-<version>` renamed the app — it wrote to
`~/.<name>-<version>/`, and the next version started from empty state while the
real data sat in the previous directory. `mv app app.bak` is the same trap. A
compiled aio app now takes its id from the deno.json embedded in the binary, so
its data survives being renamed at all.

The split is the contract. `am remove <name>` deletes the first group and keeps
`~/.<appId>/`, saying so; `am remove <name> --data` deletes both, and nothing
implies it. An update writes a NEW versioned file beside the old one and
re-points the stable symlink — so the previous version is the rollback, and a
launcher pointing at the stable name never breaks.

```
~/app/<name>/installed.json     where it came from: repo, commit, version,
                                target, the aio version it built against
```

That record is what makes the directory more than files. `am installed` reports
version and source; `am upgrade <name>` rebuilds from that source (cloning a
repo, or building a local checkout in place); and installing a DIFFERENT repo
under a name that is already taken is refused rather than silently overwriting a
program that shares `~/.<appId>/` with it.

Old versions are the rollback, bounded: the newest three are kept
(`AIO_KEEP_VERSIONS`), oldest pruned first, and the one the stable symlink
points at is never removed. Without that bound, one ~156 MB artifact per update
accumulates forever — the same shape as a log directory with no ceiling.

`AIO_INSTALL_ROOT` moves the install root; `am installed` lists what is there.

## Secrets in recorded actions

An action's payload is its arguments. `vault.unlockWith(passphrase)` therefore
records the passphrase — in the journal (`journal: true`, a file in `data/`,
right beside the database it opens and inside every backup of it), in the
in-memory ring `am timeline` prints, and in `logs/actions.jsonl` if the action
log is on. This is not hypothetical: it shipped in a real wallet.

`redactActions` names the actions whose recorded values are kept nowhere:

```ts
await aio.run({
  cells: [vault],
  journal: true,
  redactActions: ["vault:*"], // or an exact "vault:unlockWith"
});
```

A listed action keeps its type, sequence, timestamp and the state **paths** it
changed — "what did it touch" still works — while its payload and the
before/after values it wrote become `"[redacted]"`. One list governs every sink;
they cannot disagree. That includes the diagnostic **checkpoint**, which holds
current state rather than actions and so cannot redact per action: the whole
slice of a listed cell is withheld (`"[redacted]"` in place of the state), and
the file is created `0600` like the journal. An async method's write-set commit
(`cell:__setMethod`) is covered by whichever pattern covers the method itself,
so an exact `"vault:unlockWith"` protects both. A trailing `*` matches by
prefix, because a list of individual method names is the list that goes stale
the day someone adds another unlock method — and a stale redaction list fails
open.

**A redacted action cannot be replayed.** Its payload _is_ its arguments, and
they were deliberately never written, so boot **skips** it and says so:

```
journal: 1 action(s) COULD NOT be replayed — their payload was dropped by
redactActions … Whatever those actions wrote after the last snapshot is NOT in
the recovered state.
```

That is the cost of redaction, stated rather than hidden: the app still boots
(it must — the journal tail persists, so a boot that failed on it would fail on
every restart), and recovery never silently reports success for state it did not
reconstruct. `am replay` refuses the same entries (`⊘`) and `am record` emits a
commented, unreproducible gap instead of a call with no arguments. Redact
narrowly — an action whose payload you need for crash recovery should not be on
the list.

The journal file is created `0600`. Turning the action log or checkpoint **off**
also deletes what it already wrote — a flag that only stops new writes leaves
the old secret sitting there.

## Ask the app

```bash
am data                 # every path, with sizes, and which tier each one is
am data --json          # the same, machine-readable
```

## Back up, restore

```bash
am stop wallet          # a live SQLite file can copy mid-write
am backup               # → ./wallet-backup-20260726-113000/
am backup /mnt/usb/w1   # …or wherever you want it

am restore /mnt/usb/w1  # refuses another app's archive; keeps what it replaces
```

`am backup` refuses while the app is running (`--force` overrides, and marks the
result as possibly torn). `am restore` has no such override — a running app
holds the databases open and would write its in-memory pages straight back over
the restored file. The data being replaced is **moved** to
`data.replaced-<timestamp>`, never deleted, so restoring the wrong archive is
undoable.

Nothing stops you doing it by hand — that's the point of one directory:

```bash
tar czf wallet-$(date +%F).tgz -C ~/.wallet data
```

## Moving it

Two knobs, one rule each — the author names **one app's** folder, whoever runs
it names the **root all apps** sit under:

| Who        | What                            | Result                      |
| ---------- | ------------------------------- | --------------------------- |
| the author | `aio.run({ appDir: "/opt/w" })` | `/opt/w/{data,logs}`        |
| the runner | `AIO_APPS_DIR=/srv/aio`         | `/srv/aio/<appId>/{data,…}` |
| nobody     | —                               | `~/.<appId>`                |

```ts
await aio.run({
  appId: "wallet",
  // A system service: FHS path, root-owned, backed up by whatever backs up /var.
  appDir: "/var/lib/wallet",
  cells: [account],
});
```

The environment variable exists because the person who needs to move the data
usually **can't edit the code** — they were handed a binary — and because a test
suite spawns apps whose ids it doesn't control, so one inherited variable covers
all of them. `appDir` always outranks it.

Note the dot appears only in the default: `~/.wallet` hides in a home directory,
`/srv/aio/wallet` has no reason to.

`dbPath` still overrides the state database alone, for the case where state
belongs on a different disk from everything else.

Dev and production resolve **identically** — there is no "dev writes to the
project directory" mode. Compiling a binary therefore doesn't move your data,
and `deno run` against the same `appId` sees exactly what the binary sees.

## Tests

A test that boots a real app process inherits the same default, so pin it:

```jsonc
// deno.json
{
  "tasks": {
    // Inherited by every spawned app, so no test can reach the real home.
    "test": "AIO_APPS_DIR=$INIT_CWD/.test-home deno test -A"
  }
}
```

`libraryMode: true` (what `bootCells()` and `testCell()` use) already defaults
its data dir under `baseDir`, so in-process tests are hermetic without any
flags.

## Upgrading from an older aio

Before alpha38 the same app wrote to four places: a state database next to the
project, the auth store under `~/.local/share/<appId>/`, and two dot-dirs in the
project for TLS material and logs. The first boot on alpha38 moves all of it
into `~/.<appId>/` and prints each move:

```
data: moved into /home/me/.wallet (one dir = one backup):
data:   /home/me/code/wallet/data.db → /home/me/.wallet/data/state.db
data:   /home/me/.local/share/wallet/auth.db → /home/me/.wallet/data/auth.db
data: back up /home/me/.wallet/data — everything outside it is disposable
```

It never overwrites an existing file, moves each SQLite database with its
`-wal`/`-shm` sidecars as one set, and refuses entirely while the app is
running. `--no-data-migrate` skips it.

## Related

- [How It Works](how-it-works.md) — the write path into `state.db`
- [SQLite](sqlite.md) — schema, queries, WAL
- [Auth](../auth/auth.md) — what lives in `auth.db`
