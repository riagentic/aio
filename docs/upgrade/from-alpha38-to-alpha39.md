# Upgrade: 1.0.0-alpha38 → 1.0.0-alpha39

**Nothing to do for almost every app.** One config key was renamed before it
ever shipped in a release, and everything else is additive. The wire protocol is
unchanged (alpha38 and alpha39 interoperate).

## 1. `journalRedact` → `redactActions` (rename, and it now covers everything)

Only affects apps that adopted `journalRedact` from the tip of `main` — it was
never in an alpha release.

```ts
// before
await aio.run({ cells, journal: true, journalRedact: ["vault:unlockWith"] });

// after
await aio.run({ cells, journal: true, redactActions: ["vault:*"] });
```

An unknown key fails loudly at boot, so a missed rename cannot go unnoticed.

Two reasons for the change, both worth knowing even if you never used the old
name:

- **It governs three sinks now, not one.** The durable journal, the in-memory
  timeline `am timeline` prints, and `logs/actions.jsonl` all honour the same
  list, built once at boot. The old name promised the journal and delivered only
  the journal, which is how a wallet's passphrase left the disk and stayed in
  the timeline ring, printable by `am timeline` and unreachable by any
  lock-and-wipe.
- **A trailing `*` matches by prefix.** `vault:*` covers every method of a cell.
  Naming methods one by one is the list that goes stale the day another is added
  — and it already had: a first version listed only the unlock method, leaving a
  seed phrase and a raw private key to be recorded in cleartext.

A redacted action keeps its type, sequence, timestamp and the state **paths** it
changed — replay ordering and "what did it touch" both still work — while its
payload and the before/after values it wrote become `"[redacted]"`.

**If you ran an earlier build with `journal: true` or `diagnostics.actionLog`
and a method that takes a secret, the old files still contain it.** Redaction
applies to new writes. Check `~/.<appId>/data/journal` and
`~/.<appId>/logs/actions.jsonl`, and delete them if they hold anything you would
not put in a backup. From alpha39, turning the action log or checkpoint **off**
deletes what it wrote, so this is a one-time cleanup.

## 2. New: pin the aio version your app was written against

Optional, and recommended for anything you ship.

```sh
am pin              # what this app is pinned to, and whether it matches
am pin v1.0.0-alpha39
am pin --latest     # newest release that does not cross a major
am fix              # repair a drifted pin
```

The pin is recorded in your app's `deno.json` as `aioVersion` and provisioned
from a git-worktree store, so several apps can sit on different aio versions on
one machine. `am create` pins new apps automatically. A committed pin is always
**exact** — `am pin main` records `main-<sha>` — and only tags reachable from
`origin/main` are pinnable, so an abandoned tag can never be adopted.

`aio doctor` and `am pin` both exit non-zero on drift, which makes either usable
as a CI check.

## 3. New: `am cost` — what your app actually moves

```sh
am cost                     # per-cell bytes/s, top keys, per-client price
am cost --window=5m --keys
am cost --json
```

aio has been telling apps their state might be too big — `aiol`'s typed-array
hint, its "N state keys across M cells" summary, the pressure monitor's advice —
without any way to find out whether you had the condition. This answers it with
measured numbers: what each cell pushes, which key inside it is the weight, what
one extra open window costs, and how much traffic belongs to no cell at all.

The reported total equals what a real socket receives, byte for byte; that is
asserted against a live WebSocket in the suite rather than assumed.

## 4. Also worth knowing

- **`testMultiClient(config, n)`** (`aio/testing`) — a real server plus N real
  clients, with `converged()` waiting for actual quiet rather than a fixed
  sleep. For anything whose whole claim is "every surface sees the same state".
- **`schedule.every(..., { skipIfRunning: true })`** — a tick that is still
  running when the next one is due is skipped instead of overlapping.
- **Per-method perf budgets** — `perfBudget.methods["cell:method"]`.
- **Diagnostic artifacts have a lifecycle** — turning `actionLog` or
  `checkpoint` off now removes `actions.jsonl` / `checkpoint.json`, including
  when diagnostics are disabled wholesale. Off means the file is gone, not
  merely no longer appended to.
- **`diagnostics.dev.timeTravel: false` is now honoured.** It was declared,
  defaulted and documented, and nothing read it — time travel was created purely
  from `!prod`. If you set it `false` for a reason (it keeps full state history
  in memory), that reason now takes effect.
- **Every full-state broadcast says why** at debug level, so a 400 KB frame is
  no longer the invisible case.
- **`dbPath` outside the app home warns.** It moves only the database;
  `auth.db`, `tls/`, `meta.json` and the journal stay put. Use `appDir` to move
  the whole app directory.
- **A worker cell's "did not become ready" error** now leads with the real
  cause: a worker re-imports your app entry, so every top-level side effect in
  it runs again inside the worker before the handshake. Guard that work with
  `if (!isCellWorker()) …`.
