// `scripts/proof.ts --require-current` existed and no gate ran it: the release
// check printed the proof matrix report-only, so a row proven BEFORE its
// target's build last changed never held a release. `check:release
// --require-proof` makes that gate block; the default stays report-only (a
// cut made on Linux cannot be held by a Mac the machine does not have).
import { assertEquals } from "@std/assert";
import { gateCommand } from "../scripts/release-check.ts";

const PROOF = ["deno", "task", "check:proof"];

Deno.test("release check: --require-proof turns the proof gate into a blocking one", () => {
  assertEquals(gateCommand("check:proof", PROOF, false), PROOF);
  assertEquals(gateCommand("check:proof", PROOF, true), [
    ...PROOF,
    "--require-current",
  ]);
  // Only that gate.
  const t = ["deno", "task", "test"];
  assertEquals(gateCommand("test", t, true), t);
});
