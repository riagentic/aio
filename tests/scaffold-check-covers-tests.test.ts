// report 9b §7: replace the scaffold's cell with `export const pomodoro = …`
// and `deno task check` exits 0 — it ran `deno check src/` — while
// `deno task test` fails with `TS2305 … has no exported member 'counter'` from
// the starter test. The break has to show up at the gate an agent runs FIRST,
// so the scaffold's `check` type-checks `tests/` too, and the starter test
// says what to do with it when the cell it tests is gone.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { scaffold, TEMPLATES } from "../src/am/am-cmd-create.ts";
import { TARGETS } from "../src/am/am-help-text.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** The `deno check …` half of a scaffold's `check` task, as argv. */
function denoCheckArgs(denoJson: string): string[] {
  const check = String(JSON.parse(denoJson).tasks?.check ?? "");
  const first = check.split("&&")[0]!.trim().split(/\s+/);
  assert(first[0] === "deno" && first[1] === "check", `check task: ${check}`);
  return first.slice(1);
}

Deno.test("scaffold: every template × target's `check` type-checks tests/ when it scaffolds tests/", () => {
  assert(TEMPLATES.length > 0 && TARGETS.length > 0, "nothing to check");
  let checked = 0;
  for (const t of TEMPLATES) {
    for (const target of TARGETS) {
      const f = scaffold(`p-${t}`, t, true, target);
      const hasTests = Object.keys(f).some((p) => p.startsWith("tests/"));
      const args = denoCheckArgs(f["deno.json"]!);
      assert(args.includes("src/"), `${t}/${target}: ${args.join(" ")}`);
      assert(
        args.includes("tests/") === hasTests,
        `${t}/${target}: check runs \`deno ${args.join(" ")}\` but the ` +
          `scaffold ${hasTests ? "has" : "has no"} tests/`,
      );
      checked++;
    }
  }
  assertEquals(checked, TEMPLATES.length * TARGETS.length);
});

Deno.test("scaffold: the starter test says to rewrite or delete it with the cell", () => {
  assert(TEMPLATES.length > 0, "no templates to check");
  let checked = 0;
  for (const t of TEMPLATES) {
    const f = scaffold(`p-${t}`, t, true, "browser");
    const tests = Object.entries(f).filter(([p]) => p.startsWith("tests/"));
    assert(tests.length > 0, `${t} scaffolds a starter test`);
    for (const [path, body] of tests) {
      assertStringIncludes(
        body,
        "Replace the cell → delete or rewrite",
        `${t}/${path}`,
      );
    }
    checked++;
  }
  assertEquals(checked, TEMPLATES.length);
});

Deno.test({
  name:
    "scaffold: a starter test that no longer compiles fails `check`, not only `test` (report 9b §7)",
  sanitizeOps: false, // aio-ok: `deno check` child
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const repo = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const dir = await tempDir("aio-check-tests-");
    try {
      const f = scaffold("checkprobe", "counter", true, "browser");
      for (const [name, body] of Object.entries(f)) {
        const path = `${dir}/${name}`;
        await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
          recursive: true,
        });
        // The report's shape: the cell was replaced, the starter test was not.
        await Deno.writeTextFile(
          path,
          name === "tests/cell.test.ts"
            ? body.replaceAll("counter", "pomodoro")
            : body,
        );
      }
      await Deno.mkdir(`${dir}/dep`, { recursive: true });
      await Deno.symlink(repo, `${dir}/dep/aio`);
      const out = await new Deno.Command(Deno.execPath(), {
        args: denoCheckArgs(f["deno.json"]!),
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const err = new TextDecoder().decode(out.stderr);
      assert(!out.success, "check passed on a test that does not compile");
      assertStringIncludes(err, "pomodoro");
    } finally {
      await dropTempDir(dir);
    }
  },
});
