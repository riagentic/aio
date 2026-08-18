# Defaults kata — strict when detectable, never when only observable

The axis is not restrictive ↔ permissive. It is **loud ↔ silent**.

|                 | loud (refuses, names the fix) | silent (behavior just changes) |
| --------------- | ----------------------------- | ------------------------------ |
| **restrictive** | ✅ nearly free                | 💥 the only forbidden quadrant |
| **permissive**  | ✅ fine                       | ⚠️ old bugs live forever       |

## The rule

- If a wrong choice is detectable at **boot, build or lint** → be strict:
  REFUSE, name the offending value, and print the exact replacement. Costs a
  newcomer nothing — they learn at the moment of the mistake with the fix in
  hand, instead of building on sand
- If a wrong choice is only observable by **watching runtime behavior** → the
  default NEVER changes. Ship it opt-in, forever, or gate the flip on a version
  the app declares in `deno.json`. There is no third option, and a boot WARN is
  not one — an app that still runs, differently, is the silent-wrong-outcome
  class this project treats as disqualifying
- a strict default is only affordable while its escape hatch is **one token**
  (`transaction: false`) and `aiol --safe-fix`/`am fix` can write it
- strictness and onboarding do not trade off — strict-and-loud defaults TEACH.
  What trades off is strictness vs EXISTING apps, which is `major.md`'s
  compatibility kata, not this one. Never fuse the two

## Applying it

- rename with a working alias + a one-time hint at the old spelling → loud, fine
  (`cellDefaults.ui:` → `visible:`, effects off `return` → `s.$do()`)
- refuse at boot and name the pattern to write → loud, fine (a route wildcard
  that is not last; `electronBinReady` on a missing binary)
- a default that re-specifies code that still compiles and still runs → banned,
  whatever the quality of the new semantics
- a lint rule may only be added strict when its probe runs over **masked** code
  — a rule that fires on a comment, or falls silent because of one, teaches
  people to stop reading the linter, and the rest of it is load-bearing

## The worked example — `transaction` (alpha52 → alpha57)

- alpha52 made `transaction: true` the async default. Better semantics on the
  merits: snapshot reads, one atomic commit, conflict detection
- and it silently re-specified every async method already written. Pinned reads
  make a stand-down guard (`if (s.query !== query) return`) permanently inert;
  buffered writes stop a `s.busy = true` spinner ever reaching the client. No
  type error, no runtime error, no failing test — the field case cost a day
- it also broke `major.md` outright: compatibility with the previous alpha
- alpha57 returned it to opt-in. Nothing about the feature was wrong; the
  DEFAULT was. Cells that want isolation ask for it; the hint, the aiol
  migration and its safe-fix are gone with the flip that needed them
- gate: `tests/transaction-default.test.ts` — an async cell with no
  `transaction` key gets live reads and incremental commits, and boots silent
