# Building an aio app without a human in the loop

> **One command instead of this page:** `am agent` prints all of aio on one page
> — the four rules that protect the user's machine, the model, building a new
> app from `am create` to a shipped binary, the full API, every `am` verb,
> testing, debugging — straight into your context, with nothing to open.
> `am agent --min` for a small context window, `am agent --max` for everything,
> `am agent --task=<slug>` for one section (deeper ones too: `loop`, `run`,
> `auth`, `sync`, `api`, `pitfalls`…), `--list` for the index. This page is the
> long form of its driving loop.

Five verbs. If you read one page before starting, read this one.

Three field reports finished a whole build and only then discovered `am expect`,
`am timeline` and `am record`. One wrote `am state <path> | python3 -c …` about
thirty times instead. The pattern they named: _an agent greps `am help` for its
own word, does not find it, and composes primitives it already knows — it will
not browse._ So here are the words.

| I want to…                    | Use                                      | Not                                |
| ----------------------------- | ---------------------------------------- | ---------------------------------- |
| **verify** a fact about state | `am expect <path> eq <value>`            | piping `am state` through a parser |
| **drive** the app             | `am dispatch <cell:method> --args='[…]'` | clicking, or a fake                |
| **see** the UI, semantically  | `am surface --path=App/Panel`            | dumping the whole tree             |
| **debug** what happened       | `am timeline --lines=20`                 | guessing from logs                 |
| **reproduce** it              | `am replay N..M`                         | re-running by hand                 |

Two more once you have a window: `am shot` (a PNG of the real Electron window)
and `am eval '<js>'` (geometry, computed styles, a fetch from the page's own
origin — everything `am surface` cannot see). Both need the app started with
`--cdp`; `am instances` reports the port as `cdpPort`.

## The loop that works

Order: **check → run → test**. Types and aiol first, a running app second, tests
last. A green window beats a green suite you invented before anything booted.
The scaffold's starter test imports the template cell — delete or rewrite it in
the same step you replace the cell, or `deno task check` stays red on a stale
import.

```sh
deno task check && deno task lint   # types + aiol — before you invent tests
am start --cdp                      # daemonised — `deno task dev` follows your
                                    # terminal and dies when your shell exits
am surface --json                   # what is on screen, by NAME
am dispatch todo:add --args='["x"]' # drive the state machine
am expect todo.items[0].text eq x   # assert, don't parse
am timeline --lines=10              # what happened, with state diffs
deno task test                      # last — after it runs
```

**Observe → act → observe, one call per step.** The reply to `am trigger`
already contains the fresh surface, so you rarely need a second read.

## Things that will cost you an hour each

1. **The app mounts into `#root`.** Style that, not a wrapper of your own. A
   `#id` in your stylesheet that matches no element warns in dev — read it.
2. **`am state` is the SERVER's state; `am surface` is the CLIENT's UI.** They
   answer different questions, and a stale belief about which you are holding is
   the most expensive mistake available.
3. **`deno task dev` follows your terminal.** Every command you run is a fresh
   short-lived shell, so the app vanishes. Use `am start`.
4. **`interface` for cell state.** Use a `type` alias. TypeScript fails inside
   aio; `aiol` names the fix. See `CellState`.
5. **Window stuck at 800×600.** `ui.width`/`ui.height` win when the declaration
   changes; only an explicit `--width` overrides. See Electron window docs.
6. **Writing tests before the app runs.** check → run → test. Delete or rewrite
   the scaffold `tests/cell.test.ts` when you replace the cell.
7. **`am doctor` vs `am fix` vs `am migrate`.** Running vs disk · clone repair ·
   retired APIs. Three questions — see the app-manager verb map.

## Write tests you did not write by hand

```sh
am record tests/repro.test.ts   # a bootCells replay test of what the RUNNING app dispatched
                                # (its timeline); a stopped app: its crash journal
```

And in-process, with no server and no DOM: `testCell` for a cell,
[`testUI`](testing/ui-testing.md) for a component — the same semantic names
`am surface` reports, so what you test in and what you drive with cannot drift.

## When something looks wrong

- **Renderer errors land in the server log.** `am logs` shows `ERROR renderer …`
  — you do not need devtools to see a browser exception.
- **Read the error.** aio's messages name the fix, and usually the reason. An
  error that says "did you forget it in `aio.run({ cells })`?" is answering the
  question you were about to ask.
- **`am surface` misses list the available paths.** A wrong name tells you the
  right ones.

## See also

- [aio for AI agents](ai.md) — what to read first, what to measure, the rules
- [The app manager](clients/app-manager.md) — every verb, in full
- [UI testing](testing/ui-testing.md) — the selector-free harness
- [Where code runs](basics/where-code-runs.md) — the six contexts, one table
- [Real-time apps](state/real-time.md) — read this BEFORE designing a hot loop
