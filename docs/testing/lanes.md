# Testing lanes — more confidence, less wall-clock

Coverage counts what ran. Hunters showed that is not the same as what can break.
aio therefore splits testing into **lanes** so the default loop stays short
while seam and hunter coverage stay obligatory.

| Lane                   | Task                                                                                     | Wall-clock          | What it is for                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| **A — fast**           | `deno task test:fast`                                                                    | seconds–~2 min      | Ratchets + lie detectors + small pins. Run on every edit.                                                   |
| **B — seam**           | `deno task test:seam`                                                                    | minutes             | Harness ≠ wire, prod-parity, transport, hunter-seed catalogue. Run before push / when touching those areas. |
| **Hunters**            | `deno task test:hunters`                                                                 | seconds–low minutes | Seed catalogue + named audit/wire pins. Not a full `check:audit` sweep.                                     |
| **Changed**            | `deno task test:changed`                                                                 | seconds–~1 min      | Only the test files that import (transitively) what you changed vs HEAD. Edit loop, not a gate.             |
| **Full**               | `deno task test`                                                                         | ~2.5 min (16 cores) | Release gate: every file, parallel processes; real-window tests one at a time. `test:serial` = old ~27 min. |
| **Nightly / hardware** | `test:onboard`, `test:build`, `test:e2e`, `test:electron`, `test:android`, `lab`, `soak` | long                | Lane C. Do not pull into `test:fast`.                                                                       |

## How the full run is parallel

`scripts/test-shards.ts` splits the files over N separate `deno test` processes
(default: half the usable cores, at most 16; `--shards=N` or `AIO_TEST_SHARDS`).
The run never takes the whole machine: on Linux every shard, and everything it
spawns, is pinned off the first 4 cores (`taskset`) and niced; `check:release`
runs every gate in the same fence. `AIO_TEST_FREE_CORES=N` keeps N cores free.
Processes, not `deno test --parallel`: that shares `Deno.cwd()` and `Deno.env`
between files, and dozens of tests change both. Each process gets its own
`AIO_APPS_DIR` (`.aio-test-shards/<n>/.aio-test-home`) and its own per-user
stores beside it (`.aio-test-shards/<n>/stores/`): `AIO_VERSIONS_DIR`,
`AIO_FEEDBACK_DIR`, `AIO_INSTALL_ROOT` and an empty `AIO_HOME` — a test never
provisions into the real `~/.local/lib/aio-versions` that every pinned app runs.
A single-file `deno test` gets the same from the harness and from every
`tempDir()`. The run snapshots the real version store and the install's worktree
registry before the first shard and fails, naming the entry, if anything was
added, changed or removed; `check:home-clean` also fails on a store entry whose
worktree points into a test sandbox.

- **Real-window tests run one at a time**, all in shard 0, beside the others. A
  test is one when its own source names `testDisplayEnv`, `Xephyr`,
  `ELECTRON_E2E`, `ffmpeg` or `DISPLAY` (`REAL_WINDOW`): two windows on one
  display overlap and spoil each other's screenshots. Headless Chromium runs in
  parallel.
- **Balance** comes from measured time: every run writes each file's time to
  `.aio/test-timings.json`, and the next run hands out the slowest files first.
- **Logs**: `.aio/test-shards/<n>.log`; a failure prints the shard's closing
  `FAILURES` list.
- **A test that fails only here is a real race**, not a runner quirk: load is
  what exposed a chmod the logger never awaited, an esbuild child that outlived
  `server.shutdown()`, and three sleep-based waits. Fix the wait, never
  serialize the file.

## Catalogue

`scripts/test-lanes.json` is the source of truth for fast and seam membership.
`deno task check:test-lanes` (also inside `check:ratchets`) refuses:

- a listed file that does not exist
- a file in both fast and seam
- a `*differential*` / `*prod-parity*` / transport-shaped test that is in
  neither seam nor the **demoted** list (demotions need a real `why`)

Demotions are how we keep confidence without stuffing a 30s fuzzer into every
edit. Example: `tests/db-state-differential.test.ts` stays in full, not fast.

## Hunter seeds

`tests/hunter-seeds.json` lists seeds that once killed a differential. The
replay test only checks that each pin’s text still exists in the named file —
cheap, and it stops “cleanup” from deleting the only memory of the bug. Full
randomized rounds remain `deno task check:audit` and `FUZZ_ROUNDS` sweeps.

## What to add when you fix a hunter finding

1. A **named** regression test (a sentence, not only a seed).
2. If it was a fuzzer kill, add a row to `tests/hunter-seeds.json`.
3. If it is harness≠wire / prod-parity shaped, add the file to the **seam** list
   (or demote with a why if it is too slow for Lane B’s budget).
4. Prefer extending an existing differential table over a third parallel suite.

## What not to do

- Raise line coverage as a goal.
- Add happy-path example boots to `test:fast`.
- Retry wrappers around flaky teardown (fix the teardown).
- A second undocumented file list that drifts from `test-lanes.json`.
