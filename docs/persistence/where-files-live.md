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
  logs/     ← ② regenerable: app.log, error.log, client.log, stdout.log …
  launch.json ← ② the flags `am` started it with, so `am restart` replays them

$XDG_RUNTIME_DIR/aio/   ← ③ must NOT survive a reboot
  wallet.sock  wallet.pid  wallet.lock
```

Three tiers, and the only question that separates them is **what a backup
contains**:

| Tier         | Lose it and…                        | Where                             |
| ------------ | ----------------------------------- | --------------------------------- |
| ① critical   | the data is gone                    | `~/.<appId>/data/`                |
| ② expendable | the app recreates it                | `~/.<appId>/logs/`, `launch.json` |
| ③ temporary  | it must not survive a reboot at all | `$XDG_RUNTIME_DIR/aio/`           |

**Why tier ③ isn't in the app directory** — it's the one deliberate split, and
it buys three things: a `.sock`/`.lock` must NOT survive a reboot (in `$HOME`
they linger and lie about a running app), unix sockets don't work on network/NFS
homes while `/run/user` is tmpfs, and socket paths have a ~108-character limit
that a long home path can blow. `am data` prints the location, so you never have
to remember it.

`data/` is created `0700` — it holds the auth store and a TLS private key, so
the mode assumes the worst file in the tree.

`logs/stdout.log` is the raw stdout+stderr of an app that `am start` launched —
where a bare `console.log` in a cell and the stack trace of a crash _before the
logger is up_ end up. The framework's own structured logs are the other files.

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
