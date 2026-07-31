# Upgrade: alpha40 → alpha41

Most apps upgrade with **no changes**. The space-invaders field app (85 tests

- full e2e) passed against alpha41 with zero edits. The items below are the
  removals and behavior changes to know about.

## Behavior changes (fixes you may have worked around)

- **`aio.run({ appDir })` now places ALL data in the configured directory.** The
  config bridge used to drop it: logs obeyed `appDir`, but `state.db`, auth and
  journal went to the default location. If you shipped with `appDir` set, your
  data lives in the DEFAULT dir (`~/.<appId>/data`) — move it into
  `<appDir>/data` once, or keep `appDir` unset. `renderBudget` is likewise now
  honored (it was silently dropped, and missing from the CellsConfig type).
- **Assigning proxy-derived values back into state now works** in async methods:
  `s.x = { ...s.x, y }` behaves exactly like the sync path. The old refusal (and
  the snapshot-first workaround) are unnecessary; the aiol rule that flagged the
  pattern is retired. Existing workaround code keeps working.
- **`await cell.method()` in a browser** now waits from the server's resolved
  ceiling (`effectTimeoutMs` / `perfBudget.methods[...].timeout`, `0` =
  indefinitely) instead of a hardcoded 15s with a misleading error.
- **A stored cell no longer disappears when a build stops declaring it.** Its
  slice is preserved and announced at every boot. To migrate a rename: read the
  old slice in `onRestore`, move what you need, `delete` the key to consume it.
  To keep the old (dropping) behavior, delete the key in `onRestore` without
  copying.
- **Time travel** records state references (no clones): window is 2000 entries;
  `diagnostics: { dev: { skipActions: ["cell:tick"] } }` keeps high-frequency
  actions out of history.
- **`am --port=N` refuses a port answering as a different app** (identity check
  via `/__aio/health`). Set the right port, or stop the other instance.
  `AIO_APPS_DIR` now also scopes the lock/socket dir — one env var fully
  isolates an instance (tests, sandboxes).
- **`am start`** of an electron/client target on a headless box fails fast —
  pass `--client=browser` or `--client=server-only`.

## Removals (compile-time errors, with the fix)

| removed                                                                                                       | use instead                                                     |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `draft`, `matchEffect`, `UnionOf` (aio/extras)                                                                | methods-style cells (`cell({ state, methods })`)                |
| `connectCliUDS` from aio/extras                                                                               | `aio/server`                                                    |
| `DEFAULT_PRAGMAS` from aio/extras                                                                             | `aio/db` (or `aio/server`)                                      |
| `shipApp` / `buildShipManifest` / `verifyShipManifest` / `generateSigningKey` / `sha256Hex` from `aio/server` | `aio/build` (sha256Hex: use `@std/crypto`)                      |
| `authUser` from `aio/air`                                                                                     | `useUser()` / `signOut()`                                       |
| `parseCron`, `nextCronTime`, `CronFields`, `createScheduleManager` from `aio/schedule`                        | internal — `schedule`/`isScheduleEffect` remain                 |
| `FLOW_STEP_ERROR` / `FLOW_UNCAUGHT` codes, `FlowStepRecord`                                                   | removed with the pre-v2 flows (alpha27) — nothing produced them |
| `_CellBuiltins` / `_InferState` / `_InferSend` (main entry)                                                   | were `@internal` type helpers                                   |

`useCell` is **deprecated** (not removed): its `.state` is a live view —
stashing it and diffing later compares state against itself. Use direct cell
access; aiol flags remaining usage.

## New, opt-in

`useInterval(fn, ms, active?)` (client cadence) · `ui.X.keyDown/keyUp` (testUI
hold semantics) · `diagnostics.skipActions` · `docs/state/real-time.md` (where
high-frequency state belongs) · one-line source execution:
`curl -fsSL …/run.sh | sh` (see `docs/build/run-from-source.md`).
