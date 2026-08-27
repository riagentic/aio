# Proving the tests — the mutation, vacuous-test and dead-wiring gates

A green suite means the tests passed. It does not mean they would have noticed
the bug.

Eight audits of this repo in one week found the difference, and the findings
were not subtle:

- deleting the rollback body in the update path turned **no test red**;
- `sha256Hex` — the integrity primitive of the whole release system — was
  "tested" by comparing the function against itself, which passes for any
  deterministic 64-hex function;
- a vdom test looped `if (nodeName === "B")` over children while the bug it
  named _removed_ `<b>` entirely, so the assertion body never executed;
- a virtual-list test asserting "clamps to available items" iterated an empty
  collection;
- an `am create --force` test called the argument parser directly and stayed
  green for as long as the real CLI path was broken;
- a Windows rename test opened a _data_ file (which shares `DELETE`) and so
  passed on Windows while the production strategy could not work;
- several tests asserted only `error.length > 0`, which is true of any constant;
- `_noteDispatch` was exported, documented down to the names of its two callers,
  and called by **nothing in `src/`** — so every DevTools state frame for the
  life of the feature was attributed to the placeholder action `@@aio/state`.

Three gates now check the tests, and the code they claim to cover. They answer
different questions:

| Gate                          | Question                                        | Kind    | Cost   |
| ----------------------------- | ----------------------------------------------- | ------- | ------ |
| `deno task check:mutations`   | Would a test NOTICE if this invariant broke?    | dynamic | ~30 s  |
| `deno task check:vacuous`     | Can this test pass without asserting anything?  | static  | ~0.3 s |
| `deno task check:dead-wiring` | Does anything in `src/` ever reach this export? | static  | ~0.3 s |

All three are in `deno task check:release`. `check:vacuous` and
`check:dead-wiring` also run inside the ordinary suite
(`tests/no-vacuous-tests.test.ts`, `tests/no-dead-wiring.test.ts`), and the
mutation ledger's structure is checked there too
(`tests/mutation-ledger.test.ts`).

## The mutation gate

`scripts/check-mutations.ts` holds a **curated ledger** of the framework's
load-bearing invariants — the ones where a silent regression costs data, money
or security. For each one it copies the tree to scratch, breaks the enforcing
line on purpose, and requires the named test to go **red**.

```
✓ killed   expired bearer sessions keep authenticating forever — a lapsed
           token still resolves to a live user on HTTP, WS and every access: rule
✗ SURVIVED a network peer can dispatch framework-internal __actions at the WS entry point
  enforced at  src/server/server-ws.ts:1049
    if (_isFrameworkInternalActionType(parsed.type)) {
  disabled to  if (false && _isFrameworkInternalActionType(parsed.type)) {
  supposedly covered by  tests/wire-envelope.test.ts :: "envelope: dec rejects…"
  the invariant was DISABLED and 1 test(s) still passed.
```

A survivor is the finding: nothing in the suite guards that line.

```sh
deno task check:mutations               # the whole ledger
deno task check:mutations --only=totp   # entries whose what/file/test match
deno task check:mutations --jobs=8      # parallel workers (default 4)
deno task check:mutations --list        # print the ledger, run nothing
```

### Adding an entry

This must stay cheap — four fields, no registration anywhere else. If you fix a
bug that no test caught, the regression test you write next belongs here:

```ts
{
  what: "a tampered 100 MB Electron zip is unpacked and executed as the user's " +
    "desktop app — native code execution on every launch",
  file: "src/electron/electron-runtime-fetch.ts",
  find: "      const actual = await sha256Hex(bytes);",  // verbatim, unique in the file
  replace: "      const actual = expected;",             // the invariant, disabled
  test: "tests/electron-runtime-fetch.test.ts",
  filter: "ensureElectronRuntime: a tampered zip is REFUSED, and nothing is cached",
}
```

Rules the gate enforces on itself, so an entry can never quietly become a no-op:

- **`find` must occur exactly once** in `file`. If the line moves or is
  reworded, the gate says so instead of mutating nothing.
- **The named test must be GREEN unmutated.** A test that is already red — or
  whose name matches nothing — would "fail" under any mutation and prove
  nothing. That is a gate failure with its own message.
- **The mutation must compile.** A red that is a type error means the test never
  judged the mutation; the entry is reported as broken, not as a kill.
- **`what` is a cost, not a mechanism.** "sha256 check" says nothing to the
  person reading a failure at 2 a.m.; "a tampered zip runs as the user's desktop
  app" does. A `what` under eight words is refused.

### What belongs in the ledger

The ledger is deliberately curated, not exhaustive. Mutating every line of
`src/` would take hours, drown the reviewer in equivalent mutants, and get
switched off. ~30 invariants that each cost data, money or security, running in
half a minute, get run.

The named test must also be **hermetic in the scratch tree**: no network, and no
`.git` (the scratch copy is the working tree plus a symlinked `node_modules`,
with no repository). An invariant whose only test needs a git clone or a live
network belongs in the suite, not here.

## The vacuous-test detector

`scripts/check-vacuous.ts` reads every `*.test.ts(x)` and reports the shapes
above, with `file:line` and the rule:

| Rule              | Shape                                                               |
| ----------------- | ------------------------------------------------------------------- |
| `empty-loop`      | an assertion inside a loop over a collection never proven non-empty |
| `nonempty-string` | `assert(err.length > 0)` — true of every non-empty string           |
| `typeof-function` | `assert(typeof api.x === "function")` — presence, not behaviour     |
| `self-comparison` | `assertEquals(f(x), f(x))` — the function compared to itself        |
| `swallowing-try`  | assertions in a `try` whose `catch` does nothing                    |
| `no-assertions`   | a `Deno.test` body with no assertion in it at all                   |

```sh
deno task check:vacuous                 # red if the ledger moved
deno task check:vacuous --all           # every offender, ledger included
deno task check:vacuous --print-ledger  # paste-ready regenerated ledger
```

It is a **ledger that only shrinks**, the same pattern as
`tests/one-fact-one-spelling.test.ts` and `scripts/check-silent-catch.ts`: the
offenders that existed the day it landed are frozen in `LEDGER` so it could go
green immediately, and

- a **new** offender is red, named with `file:line` and the rule;
- an offender that has been **fixed** is also red, telling you which ledger line
  to delete. A ratchet allowed to sit above the real count is a ceiling, and a
  ceiling rots.

Being on the ledger is not absolution. It is a debt with your name on it.

### Silencing a false positive

A shape that is genuinely fine is silenced **in place**, with the repo's
existing acknowledgement convention (the same one `check:silent-catch` and
`graph-validator` use), on the offending line or the one above it:

```ts
// aio-ok: `targets` is the literal array declared two lines up.
for (const t of targets) assertEquals(t.os, "linux");
```

That is a claim a reviewer can check. A ledger entry is one nobody reads.

The detector already knows about the honest versions of these shapes and does
not report them: a loop over a non-empty literal or a `const TABLE = […]`
declared in the file; a `length > 0` whose test goes on to assert what the
message must contain; two sides of an equality that call one helper on
_different_ arguments.

## How to fix each shape

```ts
// ✗ passes if `items` is empty — which is exactly what the bug did
for (const it of ui.items) assertEquals(it.visible, true);

// ✓ the count is part of the claim
assertEquals(ui.items.length, 3);
for (const it of ui.items) assertEquals(it.visible, true);
```

```ts
// ✗ true of "x", and of every message that explains nothing
assert(errors.length > 0, "the failure must be reported");

// ✓ say what the message has to SAY — the reason it is worth producing
assertMatch(errors.join("\n"), /NOT NULL|notes/i);
```

```ts
// ✗ holds for any deterministic implementation, including a broken one
assertEquals(iconColors("atomic").hue, iconColors("atomic").hue);

// ✓ pin the value: this colour IS the app's identity across icon, theme, frame
assertEquals(iconColors("atomic").hue, 312);
```

```ts
// ✗ passes whether the assertion holds, fails, or is never reached
try {
  win.document.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "Escape" }),
  );
  assertEquals(closes, 1);
} catch { /* env may not support KeyboardEvent */ }

// ✓ only the genuinely-optional part is guarded; the assertion stands alone
const esc = new win.KeyboardEvent("keydown", { key: "Escape" });
win.document.dispatchEvent(esc);
assertEquals(closes, 1, "Escape on the render document must close the modal");
```

## The dead-wiring detector

A test that imports a helper proves the helper works. It does not prove the
**product** ever calls it. That is a whole bug class of its own, and it is the
cousin of the vacuous test one layer down:

```ts
/** Record an outgoing action for the DevTools trace. Called by the send path
 *  (browser-protocol's send wrapper + `client.send`). */
export function _noteDispatch(action) {
  _lastAction = action;
}
```

Exported, type-checked, documented — and neither named caller existed. A doc
comment is a **claim** about who calls a function; nothing checks it.

`scripts/check-dead-wiring.ts` is that check: **every symbol exported from a
non-entry file under `src/` must be referenced from `src/` itself.** Being
reached from `tests/`, `scripts/`, `amui/`, `aiol/`, `examples/` or a doc
snippet is not being wired.

Two things are deliberately exempt:

- the **public surface** — the root entry files `src/*.ts` and the `src/` paths
  in `deno.json`'s `exports` map (one list, `src/entries.ts`). Apps consume
  those, and this scan cannot see apps. A symbol that reaches an entry through
  an `export * from` chain is exempt with them;
- a symbol referenced only from **inside its own file**. It runs; the export may
  be redundant, which is a tidiness question, not a gate.

```sh
deno task check:dead-wiring                 # red if the ledger moved
deno task check:dead-wiring --all           # every offender, ledger included
deno task check:dead-wiring --print-ledger  # paste-ready regenerated ledger
```

Same ledger mechanics as above, and the same escape hatch on the declaring line
or the one above it — a genuine test-only seam says so out loud:

```ts
// aio-ok: a harness seam — the product must never reset this itself.
export function _resetSignals(): void {}
```

## The rule behind the gates

**A test earns its green by being able to go red.** If you cannot say which
change would break a test, it is not covering that change — and the cheapest way
to find out is to make the change and watch.
