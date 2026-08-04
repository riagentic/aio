# Upgrade: alpha43 → alpha44

**No code changes required.** Nothing was removed and no option was renamed;
every API change is additive. The release theme is one promise: **what you see
in dev is what you ship** — the dev server and every build target now resolve
the app's files by the same single rule, and a handful of things that failed
quietly now finish their work or say why they can't.

Three behavior changes are worth reading before you upgrade; none needs code
unless you were relying on the old (buggy) behavior.

## Shutdown now lets an in-flight method finish writing

Closing an app (Ctrl-C, window close, `am stop`) used to close the dispatch
queue first — an async method streaming into state died mid-write with
`EFFECT_ASYNC_ERROR`, and its last writes were lost. Now shutdown:

1. **aborts every in-flight method's `s.$signal` first**, so a long-running
   method takes its own cancellation path immediately,
2. waits (up to 3 s) for those methods to finish their writes — commits from
   running effects still land while draining,
3. then seals the queue: late _client_ input still drops, new work never starts.

If your methods already check `s.$signal.aborted` (the documented pattern),
their partial state now survives to the next boot. A method that ignores its
signal can no longer hold a window open — it is cut off at the 3 s deadline, and
the log says so.

The contract covers the corners too: a `serialize: true` call that starts
_during_ the drain is born aborted (it takes its cancellation path on the first
check instead of streaming blind through the deadline), and a `worker: true`
cell's isolate aborts and drains its own in-flight methods before acknowledging
close — previously it was terminated after a flat 50 ms.

## `client.log` now obeys the log policy

Forwarded browser/Electron console output (`client.log`) was appended to forever
— the rotation written for it was never wired, so the file grew for the life of
the app. It is now a first-class log kind under the one on-start policy every
other log follows: **wiped on start by default, rotated to `.N` when
`backupLogs` is on.** If you were relying on `client.log` accumulating across
restarts, turn on `backupLogs`.

## `useInterval` / `useRaf`: `active` works now

The `active` flag was read once at mount, so
`useInterval(fn, ms, game.screen === "playing")` could neither start after mount
nor stop on pause — the documented example did not work. `active` is now live:
the timer really starts when it becomes true and really stops when it becomes
false. If a component accidentally depended on the frozen snapshot, it will now
do what its code says.

## New, additive

- **Per-method perf budgets** —
  `perfBudget: { methods: { "cell:method": { effect: 240_000, timeout: 300_000 } } }`
  lets one cmake-running method keep a long deadline without blinding every
  tight reducer (misspelled keys warn; boot-fail under `strictCells`).
- **`schedule.every(..., { skipIfRunning: true })`** — drops a tick while the
  previous one is still in flight instead of stacking copies; a rejected tick
  clears the guard.
- **`ui.keyDown(key)` / `ui.keyUp(key)`** in `testUI`, and
  `am trigger <idx> "<path>" keyDown|keyUp <key>` — hold/release for games and
  drag UIs (`press` remains a tap).
- **`useInterval`** is exported from `aio/air` alongside `useRaf`.
- **`examples/contacts`** — the end-to-end CRUD example: one array in cell
  state, one `db:` table kept in step, validation that refuses in plain code,
  parameterized selectors, no transport code anywhere.

## Sharper edges (things that now fail loud instead of quietly)

- A build with a missing `App.tsx`, a stray `src/style.css` in an app whose
  entry lives elsewhere, or an `out:` dir pointing at the app's own sources is
  **refused with the reason** — previously these shipped broken or, in the
  `out:` case, could delete app sources.
- The build freshness cache works again (it had been rebuilding every time) and
  stamps artifacts per **target**, so an android build can never reuse a
  browser-shaped bundle. `--force` still forces.
- `am` numeric flags (`--timeout`, `top` interval, client indexes) reject
  garbage like `--timeout=2s` with the flag name instead of silently doing the
  wrong thing.
- A client that forges the internal `_source`/`_syncOp` markers on a dispatch
  has them stripped at every entry point, with a warning in the log — forged
  values could previously sneak a write past the shutdown gate or make a sync
  write silently non-durable. `_source` arrives at your hooks re-stamped as
  `"UI"` (what it really is), so `onAction`/`beforeReduce` can still tell client
  input from server work.
- `am` global flags (`--port`, `--lines`, `--wait`, `--client`) reject
  unparseable values the same way.
