# alpha57 → alpha58

**One behaviour change, and it is about disk: logs are kept now instead of
wiped.** Everything else is additive — including four new pieces for desktop
apps that drive an external process (see the end).

## Logs rotate on start instead of being wiped

`logging.backupLogs` defaulted to `false`, so every start emptied
`~/.<appId>/logs`. That destroyed the logs of the run you restarted _because of_
— and in dev, where saving a cell file respawns the process, the crash you had
just reproduced was erased by the reload that followed it.

It now defaults to `true`:

```
app.log      ← this run
app.log.1    ← the run that just ended
app.log.2    ← the one before that      (bounded by backupKeep, default 7)
```

Nothing about your app changes; a run that used to find an empty directory now
finds up to `backupKeep` archives beside its own logs. To get the old behaviour
back, one token:

```ts
await aio.run({ logging: { backupLogs: false } }); // or --no-backup-logs
```

The first boot that archives something says so in `app.log`, with that flag —
this is a default whose effect is only visible on the filesystem, and
`.katana/_aio.md` does not allow such a change to happen quietly.

## New: `logging.logBudget` — a byte ceiling for the log directory

Retention is only safe if it is bounded, and **nothing rotates a log mid-run**:
`app.log`, `debug.log` and `client.log` grow until the next start. "Keep the
last 8 runs" without a ceiling is "keep 8× unbounded".

`logBudget` (default **200 MB**, `0` = unlimited, `--log-budget=500MB`) is
enforced at boot, right after rotation:

- archives are evicted **oldest run first**, whole runs at a time — never half
  of one, because a run whose `app.log.3` survived and whose `client.log.3` did
  not is worse than no archive at all;
- every eviction is logged;
- **live files are counted but never evicted.** If they alone exceed the budget
  you get a warning naming the directory and the fix, not a deleted log of the
  run that is happening.

If you keep logs on a small volume, or you run at `level: "debug"` with a chatty
browser console, set it deliberately:

```ts
await aio.run({
  logging: { backupKeep: 3, logBudget: 50 * 1024 * 1024 },
});
```

## `stdout.log` is under the same policy

`am start` truncated `~/.<appId>/logs/stdout.log` on every launch — the one file
in a directory of rotating logs that silently kept no history. It now rotates
too, done by `am` just before it spawns the app.

It has to be `am` and not the app: the shell redirect that writes `stdout.log`
holds its fd for the whole run, so rotating from inside the app would carry the
writer into `stdout.log.1`, and deleting it would send every line to a file with
no name. `--no-backup-logs` in the launch flags wipes it, like everything else.

## Nothing to do if…

…you never configured logging. The only visible difference is that
`~/.<appId>/logs` now has `.1`, `.2`, … files in it, capped at 7 runs and 200
MB.

---

## New, and worth deleting code for

If your app picks paths or drives a subprocess, four things you probably wrote
by hand are now framework — see [desktop jobs](../clients/desktop-jobs.md) for
the whole shape.

**Native dialogs** — `pickFile()` / `pickDirectory()` from `aio/server`.
Cancelled is `null`; a missing dialog binary, a headless box or a broken dialog
**throw**. If you have a zenity wrapper, this replaces it — and it does the one
thing hand-rolled versions get wrong, which is telling "no dialog installed"
apart from "the user pressed Cancel" (same exit code).

**`spawn()`** — a child process with `onLine` streaming (`\r` progress bars
included), `pause()` / `resume()` / `kill()`, and a `signal` option you can hand
`s.$signal`. Every child gets its own process group, so `kill()` reaps the whole
tree. **Check your own kill code while you are here**:
`Deno.Command("kill", ["-STOP", "-<pid>"])` exits 0 and signals nothing — procps
`kill` does not read a negative pid as a group the way the shell builtin does.
An app that shipped that had been orphaning its GPU workers for months.

**`long`** — move `perfBudget.methods["job:colorize"].timeout = 0` out of
`aio.run()` and onto the cell:

```ts
cell("job", {
  long: ["colorize", "refreshScratch"], //  checked against the method list
  methods: { async colorize(s) {/* hours */} },
});
```

A typo now throws at `cell()` time instead of surfacing as a runtime rejection,
and it applies in tests too — `await job.colorize()` in `testCell`/`testUI`
instead of starting the method and polling. Existing `perfBudget` entries keep
working and still win.

**`// aio-ok: server-only`** — silences a `server-only-api` warning on the line
or the line above it, for a path that genuinely only runs on the server:

```ts
// aio-ok: server-only — cleanup of a file this method itself created
await Deno.remove(tmp);
```

Blocking errors (a `node:` import in browser-reachable code) are not
silenceable.

## Two messages that changed

- aio config at the **top level of `deno.json`** (`ui`, `port`, `auth`, …) now
  warns at boot: aio never read it there, and it used to say nothing. Move it
  into `aio.run({ … })`.
- A client that disappears without a close frame (closing the window) is logged
  as a disconnect at debug level. `WARN ws error — Unexpected EOF` on every
  clean shutdown is gone; a real socket error still warns.
