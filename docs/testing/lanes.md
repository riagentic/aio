# Testing lanes — more confidence, less wall-clock

Coverage counts what ran. Hunters showed that is not the same as what can break.
aio therefore splits testing into **lanes** so the default loop stays short
while seam and hunter coverage stay obligatory.

| Lane                   | Task                                                                     | Wall-clock          | What it is for                                                                                              |
| ---------------------- | ------------------------------------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| **A — fast**           | `deno task test:fast`                                                    | seconds–~2 min      | Ratchets + lie detectors + small pins. Run on every edit.                                                   |
| **B — seam**           | `deno task test:seam`                                                    | minutes             | Harness ≠ wire, prod-parity, transport, hunter-seed catalogue. Run before push / when touching those areas. |
| **Hunters**            | `deno task test:hunters`                                                 | seconds–low minutes | Seed catalogue + named audit/wire pins. Not a full `check:audit` sweep.                                     |
| **Full**               | `deno task test`                                                         | long                | Release gate. Unchanged.                                                                                    |
| **Nightly / hardware** | `test:onboard`, `test:build`, `test:e2e`, `test:electron`, `lab`, `soak` | long                | Lane C. Do not pull into `test:fast`.                                                                       |

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
