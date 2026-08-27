// The source checks itself.
//
// `tests/no-vacuous-tests.test.ts` asks whether a green test proved anything.
// This asks the same question one layer down, of the code: does this exported
// function do anything, or does only its doc comment claim it does?
//
// `_noteDispatch` in `src/browser/protocol-subscription.ts` was exported,
// type-checked and documented down to the names of its two callers — and
// nothing in `src/` called it, so every DevTools state frame for the life of
// the feature was attributed to `@@aio/state` instead of the action that
// caused it. Being imported by a test is not being wired.
//
// `scripts/check-dead-wiring.ts` detects that statically: a symbol exported
// from a non-entry file under `src/` that no file under `src/` reaches. This
// runs it as part of the ordinary suite, so a new one cannot land while the
// suite is green — which is the only moment anybody would notice.
//
// The known offenders are frozen in that script's LEDGER, which may only get
// SHORTER. Adding one is red. Wiring one is also red, with the line to delete.
//
//   deno task check:dead-wiring --all           every offender, ledger included
//   deno task check:dead-wiring --print-ledger  regenerate the frozen list
import { assertEquals } from "@std/assert";
import { LEDGER, report, scan, verdict } from "../scripts/check-dead-wiring.ts";

Deno.test("no dead wiring: the ledger of exports nothing in src/ reaches only shrinks", async () => {
  const root = new URL("../", import.meta.url).pathname;
  const v = verdict(await scan(root), LEDGER);
  assertEquals(v.added, [], report(v));
  assertEquals(v.fixed, [], report(v));
});
