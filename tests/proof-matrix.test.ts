// The proof matrix is EVIDENCE, so it must be impossible to claim a run that
// did not happen — and impossible to quietly stop reporting one that has not.
//
// The beta gate names five things this machine cannot answer (todo.md). Every
// one is behind an opt-in env gate that is `ignored (0ms)` in a normal suite,
// and nothing recorded whether any had ever run: "we tested Windows" was a
// memory. This release keeps finding remembered things to be wrong, so the
// rows are written by the gates themselves, on success, at the last line.
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  CLAIMS,
  commitExists,
  rowStatus,
  STALE_DAYS,
} from "../scripts/proof.ts";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

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
  assertEquals(noGate.sort(), [
    "android",
    "macos",
    "remote",
    "windows",
    // The packaged Windows exe's doors (CSP meta, no TCP, snapshot off):
    // test:hosts proves them on Linux only, and no run on Windows is recorded.
    "windows",
  ]);
});

Deno.test("proof matrix: a row whose commit is gone is STALE, however recent", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const fresh = { date: "2026-09-23", commit: "abc1234" };
  assertEquals(rowStatus(fresh, true, now), { state: "ok", age: 1 });
  // History rewritten under it: a green from yesterday on code nobody can
  // name is a memory, not evidence — never a ✓.
  assertEquals(rowStatus(fresh, false, now).state, "gone");
  const old = { date: "2026-01-01", commit: "abc1234" };
  assertEquals(rowStatus(old, true, now).state, "old");
  assertEquals(rowStatus(old, false, now).state, "gone");
  // The boundary is the documented one.
  const edge = new Date(now - STALE_DAYS * 86_400_000).toISOString();
  assertEquals(rowStatus({ date: edge, commit: "c" }, true, now).state, "ok");
});

Deno.test("proof matrix: commitExists asks the repo — a tagged commit yes; untagged, amended or rewritten no", async () => {
  const dir = await tempDir("proof-commit-");
  try {
    const git = async (...args: string[]) => {
      const o = await new Deno.Command("git", {
        args: ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
        stdout: "piped",
        stderr: "null",
      }).output();
      assertEquals(o.success, true, `git ${args.join(" ")}`);
      return new TextDecoder().decode(o.stdout).trim();
    };
    await git("init", "-q");
    await Deno.writeTextFile(join(dir, "f"), "x\n");
    await git("add", "f");
    await git("commit", "-q", "-m", "one");
    const head = await git("rev-parse", "--short", "HEAD");
    // Untagged: nothing released it yet.
    assertEquals(commitExists(head, dir), false);
    await git("tag", "v1");
    assertEquals(commitExists(head, dir), true);
    // An amended draft: still an object, on no ref — never ✓.
    await Deno.writeTextFile(join(dir, "f"), "y\n");
    await git("commit", "-q", "--amend", "-a", "-m", "one'");
    await git("tag", "-f", "v1");
    assertEquals(
      commitExists(head, dir),
      false,
      "a dangling draft read as proven",
    );
    // Shaped like a real short hash, in no object store here.
    assertEquals(commitExists("2983410a8", dir), false);
    // A blob is an object but not a commit: still not the proven code.
    const blob = await git("rev-parse", "HEAD:f");
    assertEquals(commitExists(blob, dir), false);
  } finally {
    await dropTempDir(dir);
  }
});
