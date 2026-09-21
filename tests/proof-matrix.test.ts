// The proof matrix is EVIDENCE, so it must be impossible to claim a run that
// did not happen — and impossible to quietly stop reporting one that has not.
//
// The beta gate names five things this machine cannot answer (todo.md). Every
// one is behind an opt-in env gate that is `ignored (0ms)` in a normal suite,
// and nothing recorded whether any had ever run: "we tested Windows" was a
// memory. This release keeps finding remembered things to be wrong, so the
// rows are written by the gates themselves, on success, at the last line.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { CLAIMS } from "../scripts/proof.ts";

Deno.test("proof matrix: every beta claim is listed, with how it is proven", () => {
  // These are todo.md's "Facts this side cannot change". A claim quietly
  // dropped from the matrix is a claim nobody is asked about again.
  for (const t of ["windows", "macos", "android", "soak", "remote"]) {
    assertEquals(
      CLAIMS.some((c) => c.target === t),
      true,
      `${t} is a named beta gate and is not in the matrix`,
    );
  }
  // Not a bare loop: the count is asserted, so an empty CLAIMS fails here
  // instead of passing every assertion below it zero times.
  assertEquals(CLAIMS.length >= 5, true, `only ${CLAIMS.length} claims listed`);
  let checked = 0;
  for (const c of CLAIMS) {
    if (c.auto) {
      // A gated claim must name the command that proves it, or the row is a
      // to-do with no instructions.
      assertEquals(
        /AIO_[A-Z_]+=|deno task /.test(c.how),
        true,
        `${c.target} (${c.env}) claims a gate but names no command: ${c.how}`,
      );
    } else {
      assertStringIncludes(c.how, "NO GATE", c.target);
    }
    checked++;
  }
  assertEquals(checked, CLAIMS.length);
});

Deno.test("proof matrix: a claim with no gate says so", () => {
  // android-on-a-device and the off-box remote run have no mechanism at all.
  // That is different from "has a gate, never run", and the matrix has to keep
  // saying which — otherwise the honest answer ("nobody can prove this yet")
  // reads like ordinary backlog.
  //
  // `windows`/`macos` joined them in 1.0.7-beta, and the reason is the point
  // of this whole file: the row that read `windows (real) ✓` was written by a
  // gate that checks the LAB's viewer and artifact share, not an app. A ✓
  // there claimed an aio app had run on Windows. The lab rows are
  // `windows (lab-vm)` / `macos (lab-vm)` now, and the app-level claims are
  // separate rows with NO GATE — the releases that WERE fixed on a real
  // Windows VM and a real Mac were driven by hand, and nothing automates that.
  //
  // A spelled-out ledger, not a derived set, so adding a NO-GATE claim stays a
  // conscious act: "we are shipping a claim nobody can prove" should cost a
  // line in a test.
  const noGate = CLAIMS.filter((c) => !c.auto).map((c) => c.target);
  assertEquals(noGate.sort(), ["android", "macos", "remote", "windows"]);
});
