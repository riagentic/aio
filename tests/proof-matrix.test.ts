// The proof matrix is EVIDENCE, so it must be impossible to claim a run that
// did not happen — and impossible to quietly stop reporting one that has not.
//
// The beta gate names five things this machine cannot answer (todo.md). Every
// one is behind an opt-in env gate that is `ignored (0ms)` in a normal suite,
// and nothing recorded whether any had ever run: "we tested Windows" was a
// memory. This release keeps finding remembered things to be wrong, so the
// rows are written by the gates themselves, on success, at the last line.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  behindLine,
  BUILD_PATHS,
  changedSince,
  CLAIMS,
  commitExists,
  countsOf,
  proofRefusal,
  recordingAsked,
  rowStatus,
  STALE_DAYS,
  uncommittedChanges,
  unrecordedLine,
} from "../scripts/proof.ts";
import { fromFileUrl, join } from "@std/path";
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
  // The off-box remote run has no mechanism at all. (android-on-a-device was
  // listed here until its lane learned `AIO_ANDROID_SERIAL` and its own row.)
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

// A row can be recent, on a tagged commit, and still be about the build
// BEFORE the one the tree ships: the Windows row predated the rewritten stub.
// Reported under the row (and failed only under --require-current).
Deno.test("proof matrix: a row recorded before its target's build path changed is BEHIND — by that path only", async () => {
  // The map itself: every claimed target has a line, every path is in the tree.
  const root = fromFileUrl(new URL("../", import.meta.url));
  assertEquals(
    CLAIMS.map((c) => c.target).filter((t) => !(t in BUILD_PATHS)),
    [],
    "a claimed target with no BUILD_PATHS line",
  );
  const all = Object.entries(BUILD_PATHS).flatMap(([t, ps]) =>
    ps.map((p) => `${t}: ${p}`)
  );
  assert(all.length > 20, "the map lost its paths");
  const gone: string[] = [];
  for (const line of all) {
    const p = line.slice(line.indexOf(": ") + 2);
    if (!await Deno.stat(join(root, p)).catch(() => null)) gone.push(line);
  }
  assertEquals(gone, [], "a build path that is not in the tree");
  const dir = await tempDir("proof-behind-");
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
    const commit = async (file: string, text: string) => {
      await Deno.mkdir(join(dir, "build"), { recursive: true });
      await Deno.writeTextFile(join(dir, file), text);
      await git("add", "-A");
      await git("commit", "-q", "-m", file);
      return await git("rev-parse", "--short", "HEAD");
    };
    await git("init", "-q");
    const proven = await commit("build/win.ts", "1\n");
    assertEquals(changedSince(proven, ["build"], dir), []);
    await commit("docs.md", "elsewhere\n");
    assertEquals(changedSince(proven, ["build"], dir), [], "another path");
    await commit("build/win.ts", "2\n");
    const newest = await commit("build/win.ts", "3\n");
    const changed = changedSince(proven, ["build"], dir);
    assertEquals(changed.length, 2);
    assert(changed[0]!.startsWith(newest + " "), "newest first");
    assertEquals(changedSince(proven, [], dir), [], "no path list: no claim");
    assertEquals(changedSince("2983410a8", ["build"], dir), [], "commit gone");
    assertEquals(behindLine("windows", []), "");
    const line = behindLine("windows", changed);
    assertStringIncludes(line, "BEHIND: 2 commit(s)");
    assertStringIncludes(line, newest);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("proof: a gate run on uncommitted code records nothing — HEAD is not the code that ran", () => {
  // A clean tree (or only this file, rewritten by an earlier gate in the same
  // run) may record.
  assertEquals(uncommittedChanges(""), []);
  assertEquals(uncommittedChanges(" M proof-matrix.json\n"), []);
  // Any other change — modified, staged, or a new file — makes the row a lie.
  assertEquals(
    uncommittedChanges(
      " M src/server/aio.ts\nM  deno.json\n?? src/server/new.ts\n M proof-matrix.json\n",
    ),
    [" M src/server/aio.ts", "M  deno.json", "?? src/server/new.ts"],
  );
});

// The end-of-run check alone had more doors: a tree DIRTY when the gate
// started and clean at the end (changes reverted or stashed, same HEAD), a
// HEAD that moved during the run (a commit made mid-soak — 72 h), and a
// status query that FAILED, which read as a clean tree. Each named code that
// never ran.
Deno.test("proof: a row is refused when the tree was dirty at the start, HEAD moved, or git could not say", () => {
  const clean = { head: "abc1234", dirty: [] as string[] };
  assertEquals(proofRefusal(clean, clean), null);
  assertEquals(proofRefusal(clean), null); // no start stamp: the end check alone
  assert(proofRefusal(clean, { head: "abc1234", dirty: [" M a.ts"] }));
  assert(proofRefusal({ head: "def5678", dirty: [] }, clean));
  assert(proofRefusal({ head: "abc1234", dirty: [" M a.ts"] }, clean));
  assert(proofRefusal({ head: "abc1234", dirty: null }, clean));
  assert(proofRefusal(clean, { head: "abc1234", dirty: null }));
  // No git at all (a tarball): nothing to compare — the row says "unknown",
  // which the matrix prints as stale.
  const none = { head: "unknown", dirty: null };
  assertEquals(proofRefusal(none, none), null);
});

// "Tested on Windows and macOS as on Linux" was 1.0.19's headline, and the
// matrix had no row that could say so. The rows exist now; until a real run
// is recorded they print as what they are.
Deno.test("proof matrix: the native-suite rows exist, and an unrecorded row says how to record it", () => {
  const claim = (target: string, env: string) => {
    const c = CLAIMS.find((c) => c.target === target && c.env === env);
    assert(c, `${target} (${env}) is not a claim`);
    return c;
  };
  for (
    const [t, e] of [
      ["windows", "native suite"],
      ["macos", "native suite"],
      ["windows", "real hardware"],
    ] as const
  ) {
    const line = unrecordedLine(claim(t, e), () => false);
    assertEquals([line.mark, line.counts], ["✗", "missing"]);
    assertStringIncludes(line.text, "never recorded — to record it:");
    assertStringIncludes(
      line.text,
      `deno task update:proof -- --row="${t} (${e})"`,
    );
  }
  // No mechanism at all is a different fact, and keeps its own mark.
  const none = unrecordedLine(claim("remote", "off-box"), () => false);
  assertEquals([none.mark, none.counts], ["·", "no-gate"]);
});

// `✗ windows (lab-vm) never run` was printed at every release for a gate
// nobody runs any more: the suite itself runs on that VM now, which proves
// the VM boots and far more. A line that is red forever teaches the reader to
// skip the red ones.
Deno.test("proof matrix: a lab row left unrecorded points at the row that covers it — never 'never run'", () => {
  for (const target of ["windows", "macos"]) {
    const lab = CLAIMS.find((c) => c.target === target && c.env === "lab-vm")!;
    assertEquals(lab.coveredBy, "native suite");
    // The covering row must be a real claim of the same target.
    assert(CLAIMS.some((c) => c.target === target && c.env === lab.coveredBy));
    const asked: string[] = [];
    const open = unrecordedLine(lab, (env) => (asked.push(env), false));
    assertEquals(asked, ["native suite"]);
    assertEquals([open.mark, open.counts], ["·", "covered"]);
    assertStringIncludes(open.text, `record ${target} (native suite) instead`);
    const done = unrecordedLine(lab, () => true);
    assertStringIncludes(
      done.text,
      `covered by     — ${target} (native suite)`,
    );
    assertEquals(done.counts, "covered");
  }
});

Deno.test("proof matrix: a row recorded from a suite log prints that run's counts", () => {
  const row = { target: "macos", env: "native suite", commit: "c", date: "d" };
  assertEquals(countsOf(row), "");
  assertEquals(
    countsOf({ ...row, passed: 13367, failed: 0, ignored: 104 }),
    "  13367 passed · 0 failed · 104 ignored",
  );
});

// A test run must leave the tree as it found it. `recordProof` wrote the
// tracked proof-matrix.json from any gated test that passed on a clean tree —
// so `deno task test` (with Chromium installed) and `deno task test:build`
// ended with ` M proof-matrix.json`, and a row's date moved for a run nobody
// meant as proof. Recording is asked for now: AIO_PROOF_RECORD=1, which the
// release check sets for its gates.
Deno.test("proof: recording is asked for — only AIO_PROOF_RECORD=1", () => {
  assertEquals(recordingAsked("1"), true);
  for (const v of [undefined, "", "0", "true", "yes"]) {
    assertEquals(recordingAsked(v), false, `AIO_PROOF_RECORD=${v}`);
  }
});

Deno.test("proof: a passing gate leaves `git status` empty; under AIO_PROOF_RECORD=1 it writes the row", async () => {
  // The real recorder, in a repository of its own: scripts/proof.ts finds its
  // matrix beside itself, so a copy records into the copy.
  const dir = await tempDir("proof-explicit-");
  try {
    const git = async (...args: string[]) => {
      const o = await new Deno.Command("git", {
        args: ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(o.success, true, `git ${args.join(" ")}`);
      return new TextDecoder().decode(o.stdout);
    };
    await Deno.mkdir(join(dir, "scripts"));
    await Deno.copyFile(
      fromFileUrl(new URL("../scripts/proof.ts", import.meta.url)),
      join(dir, "scripts", "proof.ts"),
    );
    // The stand-in for `deno task test:build`: what its gated test does on
    // its last line, and nothing else.
    await Deno.writeTextFile(
      join(dir, "gate.ts"),
      `import { recordProof } from "./scripts/proof.ts";\n` +
        `await recordProof("cli", "binary", "stand-in");\n`,
    );
    await Deno.writeTextFile(join(dir, "proof-matrix.json"), "[]\n");
    await git("init", "-q");
    await git("add", ".");
    await git("commit", "-q", "-m", "one");
    await git("tag", "v1");
    const gate = async (env: Record<string, string>) => {
      const o = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--no-lock",
          "--config",
          fromFileUrl(new URL("../deno.json", import.meta.url)),
          join(dir, "gate.ts"),
        ],
        cwd: dir,
        env: { AIO_PROOF_RECORD: "", ...env },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const text = new TextDecoder().decode(o.stdout) +
        new TextDecoder().decode(o.stderr);
      assertEquals(o.success, true, text);
      return text;
    };
    const plain = await gate({});
    assertEquals(await git("status", "--short"), "", "a plain run wrote");
    assertStringIncludes(plain, "cli/binary passed — not recorded");
    // The control: the same gate, asked to record, does write — so the empty
    // status above is the switch, not a recorder that cannot write here.
    await gate({ AIO_PROOF_RECORD: "1" });
    assertEquals(await git("status", "--short"), " M proof-matrix.json\n");
    const rows = JSON.parse(
      await Deno.readTextFile(join(dir, "proof-matrix.json")),
    );
    assertEquals(rows.length, 1);
    assertEquals([rows[0].target, rows[0].env], ["cli", "binary"]);
  } finally {
    await dropTempDir(dir);
  }
});
