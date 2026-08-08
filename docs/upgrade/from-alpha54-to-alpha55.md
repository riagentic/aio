# alpha54 → alpha55

**Nothing to do.** No removals, no renames, no deprecations. Every change is
additive or a behaviour improvement your app gets for free. This page exists to
tell you what changed underneath, because two of those behaviours are visible.

## Your app can now use the machine it is running on

V8 fixes its heap ceiling when a process starts and Deno's default is **~4 GB
whatever the hardware**. That is why an aio app could die with "out of memory"
on a 32 GB machine with 28 GB free — nothing in aio set that limit, which is
exactly why nobody had chosen it.

From alpha55 the ceiling is **25% of physical RAM, never below 4 GB**:

| Machine | Ceiling before | Ceiling now                            |
| ------- | -------------- | -------------------------------------- |
| 8 GB    | 4 GB           | 4 GB (floor — never worse than before) |
| 32 GB   | 4 GB           | 8 GB                                   |
| 128 GB  | 4 GB           | 32 GB                                  |

Applied by whatever starts your app: `am start`, `run.sh` and the test harness
resolve it for the machine they are on; a **compiled binary bakes it at build
time** (a compiled artifact ignores `DENO_V8_FLAGS` — only
`deno compile --v8-flags=` reaches it). **Rebuild to pick it up.**

A bare `deno run src/app.ts` still gets V8's default, and now warns at boot with
the exact flag to add. Worker isolates inherit the ceiling — including the DB
worker and every `worker: true` cell.

### If your app legitimately needs more than a quarter

```jsonc
// deno.json
{ "memory": { "maxHeap": "12GB" } } // also "25%", "512MB", a number of MB, "default"
```

An explicit value is honoured **even above 25%** — you know your workload. Boot
says so, once, so the next person reading a log knows why this app may squeeze
the machine. For a hard total across every isolate, use the OS
(`systemd MemoryMax=`, a container limit): a V8 flag is per-isolate, and an app
has several.

### Your `onMemoryPressure` callback gets two new fields

`MemoryReport` gained `reason` (`"pressure" | "machine" | "growth"`) and
`machinePct`. Existing callbacks keep working — the fields are additions.

The monitor now reports three different problems instead of one:

- `pressure` — near the V8 ceiling, about to run out
- `machine` — a large share of the whole machine while the ceiling is nowhere
  near (the case that freezes a desktop; ceiling-relative thresholds are blind
  to it)
- `growth` — climbing steadily with nothing near a threshold, i.e. a leak,
  reported hours before either of the above

## Two behaviours that move a file

**Client logs in prod.** `initClientLog` was gated on dev while the UDS
transport wrote client frames regardless, so a prod Electron app wrote
`client.log` into a **cwd-relative `.aio/log`** — wherever it happened to be
launched from. It now goes where `am log --client` has always looked:
`~/.<appId>/logs/client.log`. If you collected those stray files, they stay
where they are; new ones land in the app's own directory.

**`wipeOnStart` clears log archives too.** It removed the live logs and left
every `<name>.N` a previous `backupLogs` run had made, so "clean slate" quietly
meant "plus everything from before". If you relied on those surviving a wipe,
set `backupLogs` instead of `wipeOnStart`.

## Two things that are now refused

Both were already broken; they just used to fail later and less clearly.

**`am fix` no longer accepts `src/main.ts` / `main.ts` as an entry.** The build
never recognised them, so `am fix` could pronounce a project healthy on the
strength of a file that would never compile. The rule is now shared: an explicit
`entry` in deno.json, else `src/app.ts`. If your app used `main.ts`, add
`"entry": "src/main.ts"` to deno.json — which is what the build needed all
along.

**An invalid `android.applicationId` is refused, not sanitized.** This is a new
option (`{ "android": { "applicationId": "com.example.wallet" } }`) so nothing
regresses, but it is worth saying why it refuses: an applicationId is permanent
once published, and silently "fixing" one would change an app's identity behind
its author's back. Without it you keep the derived `app.aio.<name>` — fine for
sideloading, unpublishable under your own name.

## New, if you want it

- **`testApps({ service, desk })`** from `aio/testing` — boot N independent apps
  in one test, with `connect(name)` for the client-of-another-app path. Cells
  bind to exactly one app, so write cells a client will bind as a factory.
- **`connectCli(url, { readyTimeoutMs })`** — reject `ready` when the FIRST
  connection cannot happen, instead of retrying forever behind an unsettled
  promise. Off by default; a UI client should out-wait a flaky network.
- **`scripts/xephyr.sh`** — a nested X display so GUI tests stop taking focus.
  Start it once; the tests find it and never close it.
