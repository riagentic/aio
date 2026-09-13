# aio for AI agents

How to work on an aio app when you are a model — and, it turns out, how a
careful human works on one too. [`AGENTS.md`](AGENTS.md) is the five verbs for
driving a running app; this page is everything around them: what to read first,
what to trust, what to measure, and the mistakes agents make on this framework
specifically.

## Read these first, in this order

0. **`am agent`** — run it. One command, one page, no file to find: the four
   rules that protect the human (never kill aio apps by process match, never
   open windows on their desktop, never script around `am`, learn before
   editing), the model, the new-app flow from `am create`, the whole API, every
   verb, testing, debugging and shipping — each fact gated against the code
   (`tests/am-agent-truth.test.ts`). `am agent --task=<slug>` for one section or
   a deeper one. Everything below is what to read when the brief points you at
   it.
1. The app's own `CLAUDE.md` / `README.md`, if it has one.
2. [`docs/content.md`](content.md) — the generated index of every page, by
   question. Search it before searching the source.
3. [`AGENTS.md`](AGENTS.md) — `am expect`, `am dispatch`, `am surface`,
   `am timeline`, `am replay`. The pattern that costs agents the most time is
   composing primitives they already know instead of finding the verb that
   exists.
4. [The upgrade guide for the version the app pins](upgrade/README.md) — it
   lists the workarounds you can delete and the behaviour that got stricter.

`am help` is the source of truth for the CLI; `am help <verb>` for one verb.

## Start with the app, not the framework

```sh
am instances                 # what is already running on this machine
am pin                       # which aio this app builds against
am check                     # does the bundle build — `deno task check` alone
                             # cannot tell you (it type-checks; it does not bundle)
am start --cdp               # daemonised, with the devtools port for am eval / am shot
```

Never run an app you did not start with `deno task dev` from a tool shell: the
shell exits, the app dies with it, and you spend an hour on a ghost. `am start`
daemonises. `am instances` shows the port, the data dir and the `cdpPort`;
scrape none of them.

## The three surfaces, and which one you are looking at

| surface         | answers                    | read with                      |
| --------------- | -------------------------- | ------------------------------ |
| server state    | what the cells hold        | `am state`, `am expect`        |
| the client's UI | what is on screen, by NAME | `am surface`, `am trigger`     |
| the real window | geometry, styles, pixels   | `am eval`, `am shot` (`--cdp`) |

A stale belief about which surface you hold is the most expensive mistake
available. `am state` can be right while the page is wrong, and the reverse.

## Change state through the door, never around it

- A method is the only write path. `am dispatch cell:method --args='[…]'` goes
  through the same validation, acks and refusals as a button — and the reply
  says whether the write **landed** (`ok: false` with a reason is an answer, not
  an error to retry).
- `am state --watch` gives a line per change; do not poll.
- `am timeline` shows each dispatch with its state diff; `am replay N..M`
  reproduces a range. Guessing from logs is slower than both.

## Test the way the framework tests

- **A cell method → `testCell`.** Dispatch, assert on state, read effects. Do
  not curl an initial state and call it tested: SSR plus a state read proves
  nothing about whether a method runs.
- **A component → `testUI`.** Names are `LABEL + ROLE` from the TSX
  (`<div class="button">Save</div>` → `ui.SaveButton`), the same names
  `am surface` reports, so what you test in and what you drive with cannot
  drift. Actions queue without `await`; `await` only observations.
- **The harness is the STRICTEST environment**, never the most lenient: every
  dev-mode tripwire fires in a test too. A test that passes by being lenient is
  the bug this project ranks above any other; do not add a shortcut.
- **Transport-boundary behaviour** (reconnects, acks, offline queues) needs a
  real socket: `deno task test:e2e`, or `aio.run` in-process plus a real client,
  as `tests/notify-loopback.test.ts` does.
- `am record tests/x.test.ts` writes a replay test you did not write by hand;
  `am testgen` a typed client for the UI.

## Windows without stealing the keyboard

A real Electron window opens on the user's desktop and takes focus mid-keystroke
— on every retry. Use the nested display:

```sh
scripts/xephyr.sh            # starts Xephyr on :77, ONCE; leave it running
DISPLAY=:77 am start --cdp   # everything the app opens lives inside it
```

`testDisplayEnv()` (`src/testing/test-display.ts`) is how the tests do the same.
A capture of what a launch _generated_ — the main script Electron was handed —
is cheaper than a window: `ELECTRON_PATH=<a script that copies $1>` replaces the
binary, as `tests/electron-launch-carries-ui.test.ts` shows.

## Measure; do not reason about the instrument

The costliest class of mistake on this codebase is a check that agrees with its
author. Before trusting a green result, ask what would be red:

- a test that passes with the fix reverted proved nothing — revert and run it
  once (`git stash`, run, `git stash pop`);
- a grep for `error` matches the hourly `errors=0` heartbeat;
- `deno lint | tail -1` prints "Checked N files" even when it found problems —
  read the whole output, or the exit code;
- a script whose own command line contains the pattern it `pgrep`s for matches
  itself and never exits. Select processes by a unique string in
  `/proc/<pid>/cmdline` or by `readlink /proc/<pid>/cwd`, never by name, and
  never `pkill` anything you did not start — this machine runs other apps;
- a generated file (`docs/content.md`, `docs/api-snapshot.json`) is regenerated
  by a task, never edited.

## The rules that shape every change

- **Fail loud, never silent.** A misconfiguration, a dropped write, an unmet
  invariant: throw or warn at the site. Never swallow; never degrade quietly. If
  you catch and continue, say why on that line (`aio-ok:`).
- **Dev == prod.** A dev/prod difference is allowed only when it is observe-only
  (a warning, an overlay) or dev is STRICTER. Never the reverse.
- **The public surface is frozen.** No removal, rename or reshape;
  `deno task check:api` refuses them and names the additive spelling. A new
  capability is a new door — a new key, a new function, an overload whose first
  signature is the old one.
- **One decider.** Two places that answer the same question drift; find the
  existing one before writing a second.
- **Every gate is a task.** `deno task check:release --fast` runs every static
  gate and every release surface in seconds; without `--fast` it runs the heavy
  ones too and writes the stamp a tag needs. Run the fast tier before every
  commit that touches `src/`.

## When you are done

- `deno task check:release --fast` green; the targeted tests green; for a
  cross-cutting change, `deno task test:core` (it takes ~18 minutes; run it
  detached, poll a marker line, never pipe it into `tail`).
- Commit; **never push and never tag unless asked in that same message** — `am`
  reads tags, so a push without a tag is not a release either.
- Say what you measured, what you did not, and what you refused — in that order.
  A refusal with its reason (`feedback/refused.md` is the shape) is worth more
  than a silent omission.

## See also

- [Building an aio app without a human in the loop](AGENTS.md) — the verbs
- [The app manager](clients/app-manager.md) — every verb, in full
- [UI testing](testing/ui-testing.md) — `testCell`, `testUI`, `uiRects`
- [Semver policy](basics/semver-policy.md) — what "frozen" promises
- [Pitfalls](basics/pitfalls.md) — the framework's own list
