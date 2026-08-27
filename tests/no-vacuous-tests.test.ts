// The suite checks itself.
//
// A green test proves nothing unless its assertions RAN, on the value they
// claim to be about. Eight audits in one week found tests that passed while
// proving nothing — an assertion inside a loop over an empty collection, an
// `assert(err.length > 0)` that holds for any string, a function compared
// against itself on the release system's integrity primitive.
//
// `scripts/check-vacuous.ts` detects those shapes statically. This runs it as
// part of the ordinary suite, so a new one cannot land while the suite is
// green — which is the only moment anybody would notice.
//
// The known offenders are frozen in that script's LEDGER, which may only get
// SHORTER. Adding one is red. Fixing one is also red, with the line to delete.
//
//   deno task check:vacuous --all           see every offender, ledger included
//   deno task check:vacuous --print-ledger  regenerate the frozen list
import { assertEquals } from "@std/assert";
import { LEDGER, report, scan, verdict } from "../scripts/check-vacuous.ts";

Deno.test("no vacuous tests: the ledger of tests that prove nothing only shrinks", async () => {
  const root = new URL("../", import.meta.url).pathname;
  const v = verdict(await scan(root), LEDGER);
  assertEquals(v.added, [], report(v));
  assertEquals(v.fixed, [], report(v));
});
