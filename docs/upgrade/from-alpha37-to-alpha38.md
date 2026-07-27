# Upgrade: 1.0.0-alpha37 → 1.0.0-alpha38

**Nothing to do for most apps.** Your app's files move to one directory,
automatically, on the first boot. The wire protocol is unchanged (alpha37 and
alpha38 interoperate).

## 0. Your data moves to `~/.<appId>/` (automatic)

An app used to write to four places. Now it writes to one:

| Before                            | After                      |
| --------------------------------- | -------------------------- |
| `./data.db` (next to the project) | `~/.<appId>/data/state.db` |
| `~/.local/share/<appId>/auth.db`  | `~/.<appId>/data/auth.db`  |
| `./data.db.journal`               | `~/.<appId>/data/journal`  |
| `./.aio-tls/`                     | `~/.<appId>/data/tls/`     |
| `./.aio/log/`                     | `~/.<appId>/logs/`         |
| `~/.local/share/<appId>/app.key`  | `~/.<appId>/data/app.key`  |

The first alpha38 boot moves everything and prints what it did:

```
data: moved into /home/me/.wallet (one dir = one backup):
data:   /home/me/code/wallet/data.db → /home/me/.wallet/data/state.db
data:   /home/me/.local/share/wallet/auth.db → /home/me/.wallet/data/auth.db
data: back up /home/me/.wallet/data — everything outside it is disposable
```

The migration never overwrites an existing file, moves each SQLite database
together with its `-wal`/`-shm` sidecars, and **refuses while the app is
running** (stop it and start again). Pass `--no-data-migrate` to skip it.

Why: a backup used to mean knowing four locations, two of which changed when you
compiled the app. Now it is one directory — and `data/` inside it is the only
part that can't be recreated.

**Check it, if you like:**

```sh
am data          # every path, by tier, with sizes
```

### If you pinned paths yourself

`dbPath` still works and still overrides the state database alone. What's new is
`appDir`, which moves _everything_:

```ts
await aio.run({
  appId: "wallet",
  appDir: "/var/lib/wallet", // system service: FHS path, one backup unit
  cells: [account],
});
```

Or, without touching the code, `AIO_APPS_DIR=/srv/aio` moves **every** app (→
`/srv/aio/<appId>`). Those are the only two knobs.

## 1. Pin your tests (do this if your tests spawn a real app)

An app that persists now writes to `~/.<appId>` by default, and a test that
spawns a real app process inherits that. Pin the root once, in the task — child
processes inherit the environment, so one variable covers every spawned app:

```jsonc
// deno.json
{
  "tasks": {
    "test": "AIO_APPS_DIR=$INIT_CWD/.test-home deno test -A"
  }
}
```

(In-process tests — `testCell()`, `bootCells()`, `libraryMode: true` — are
already hermetic: their data dir defaults under `baseDir`.)

Symptom if you skip this: stray `~/.<appId>` directories, and state carrying
over between runs so a persistence assertion reads a count from a previous run.

## 2. `am` gained three commands

```sh
am data                 # where everything is, by tier: ① backup ② regenerable ③ temporary
am backup [dest]        # copy data/ (stop the app first, or --force)
am restore <dir>        # put it back — refuses another app's archive
```

`am restore` moves the data it replaces to `data.replaced-<stamp>` instead of
deleting it. See [Where Files Live](../persistence/where-files-live.md).

## 3. `am restart` now survives a reboot

`am`'s launch record (the flags to replay, e.g. `--env-file`) moved from
`$XDG_RUNTIME_DIR/aio/` to `~/.<appId>/launch.json`. The runtime directory is
cleared on logout by design, which silently dropped those flags across a reboot.
Records written by an older `am` are still read, so an app already running
through the upgrade restarts correctly.

Also tidied, so there are fewer places to look:

- `am start`'s stdout capture: `<project>/.aio.log` →
  `~/.<appId>/logs/stdout.log` (no more stray file in your project; `am log`
  still finds the old one)
- `~/.<appId>/cache/` is gone — created on every boot, written by nothing

`AIO_HOME` is untouched and still means one thing: the aio framework checkout
that `am link` / `am fix` bind your project to.

## 4. Two additions you may want (nothing breaks without them)

```ts
// Durability: NORMAL can lose the last committed transactions on power loss.
await aio.run({
  dbPragmas: ["PRAGMA journal_mode = WAL", "PRAGMA synchronous = FULL"],
});

// A `worker: true` cell re-imports your entry — skip top-level side effects there.
import { isCellWorker } from "aio";
if (!isCellWorker()) await migrateOnce();
```

## 5. Free: less bandwidth, no action needed

A dispatch that produces no patches no longer broadcasts the entire state. If
your app has a ticking field and idempotent setters (a poll that writes the same
value), you were paying a full state frame per dispatch. One app measured 800
KB/s → 85 KB/s. Nothing to change.

## 6. Environment variables, if you set any

| Was             | Is                                                                            |
| --------------- | ----------------------------------------------------------------------------- |
| `AIO_DATA_HOME` | `AIO_APPS_DIR`                                                                |
| `AIO_DATA_DIR`  | removed — use `AIO_APPS_DIR=<root>` (→ `<root>/<appId>`) or `appDir:` in code |
| `AUI_ROOTS`     | `AMUI_ROOTS`                                                                  |

`AIO_HOME` is unchanged. None of these shipped in alpha37 except `AUI_ROOTS`, so
in practice only an amui user has anything to change.

## 7. Bump the pin

```jsonc
// deno.json
{
  "imports": {
    "aio": "https://raw.githubusercontent.com/riagentic/aio/v1.0.0-alpha38/mod.ts"
  }
}
```

Then:

```sh
deno task am fix        # refresh the local symlink/config
aio doctor              # integrity sweep
```
