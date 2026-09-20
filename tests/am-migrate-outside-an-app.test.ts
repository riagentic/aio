// `am migrate` run where there is no app answered "✓ nothing to migrate".
//
// It took its scan root from `Deno.cwd()` and never asked whether that cwd was
// an app at all. Two failures from the one missing question:
//
//  1. A CONFIDENT WRONG ANSWER. In `~`, in a checkout's parent, in any
//     directory that is not an app, `am migrate` walked whatever happened to be
//     there, found no retired spelling, printed the clean bill and exited 0 —
//     the all-clear is the most common outcome of this command, so nothing
//     about it looked wrong. A migration gate in CI that cd'd one directory too
//     far reported "nothing to migrate" for an app it never opened.
//  2. AN UNBOUNDED WALK. `appSourceFiles` reads the app's own `exclude` /
//     `fmt.exclude` / `.gitignore` to know what is not its code; a directory
//     that declares none of that excludes nothing. Run from `/` (or `$HOME`)
//     `am migrate` therefore recursed the whole filesystem — over 30 s with no
//     output in an am CLI fuzz, and then the same false all-clear.
//
// Its sibling over the same scope, `am pin`, already asks: "No deno.json or
// deno.jsonc in <dir>. am pin reads and writes an app's pin, so it has to run
// inside one." — refusal, exit 1, and a `fix` line. `am migrate` scans an app
// and reports on it, so it has the same precondition and now gives the same
// answer.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname;

async function am(
  args: string[],
  cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${REPO}src/am.ts`, ...args],
    cwd,
    env: { ...Deno.env.toObject(), AIO_AM_NO_DELEGATE: "1", NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: p.code,
    out: new TextDecoder().decode(p.stdout),
    err: new TextDecoder().decode(p.stderr),
  };
}

Deno.test("am migrate outside an app refuses — in every output mode", async () => {
  const dir = await tempDir("am-migrate-no-app-");
  try {
    // Something scannable in it, so the refusal cannot be mistaken for "there
    // was nothing here to read".
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(`${dir}/src/x.ts`, "export const x = 1;\n");

    // The table: how it was asked, and where the refusal has to appear. A
    // piped stdout is JSON mode, so `--json` and the bare form agree here and
    // `--quiet` says it with the exit code alone.
    for (
      const [args, mode] of [
        [[], "json"],
        [["--json"], "json"],
        [["--from=alpha76"], "json"],
        [["--quiet"], "quiet"],
      ] as const
    ) {
      const r = await am(["migrate", ...args], dir);
      const where = `am migrate ${args.join(" ")}`;
      assertEquals(r.code, 1, `${where}: must refuse — ${r.out}${r.err}`);
      if (mode === "quiet") {
        assertEquals(r.out, "", `${where}: --quiet says it with the code`);
        continue;
      }
      const doc = JSON.parse(r.out);
      assert(
        typeof doc.error === "string",
        `${where}: --json refusals are {error} — got ${r.out}`,
      );
      assert(
        doc.findings === undefined,
        `${where}: never a findings list for an app that was not found`,
      );
      assertStringIncludes(doc.error, "deno.json");
      assertStringIncludes(doc.error, dir);
      // Doctrine: the message names the fix.
      assertStringIncludes(String(doc.fix ?? ""), "cd ");
    }
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am migrate outside an app refuses BEFORE it walks anything", async () => {
  // The bug's second half: the refusal has to come from the precondition, not
  // from a scan that found nothing. A tree big enough that walking it is
  // visible in the answer — if the walk happens, `deep/…/x.ts` is read.
  const dir = await tempDir("am-migrate-no-walk-");
  try {
    let p = dir;
    for (let i = 0; i < 12; i++) {
      p = `${p}/deep${i}`;
      await Deno.mkdir(p);
      await Deno.writeTextFile(`${p}/x.ts`, "export const x = 1;\n");
    }
    const t0 = performance.now();
    const r = await am(["migrate", "--json"], dir);
    assertEquals(r.code, 1, r.out + r.err);
    // The scan is what makes this command slow; the refusal must not pay for
    // it. Generous, because the cost measured here is `deno run` starting up.
    assert(
      performance.now() - t0 < 20_000,
      "the refusal must not wait for a filesystem walk",
    );
    assertStringIncludes(JSON.parse(r.out).error, "has to run inside one");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am migrate inside an app still scans it (the refusal is not a wall)", async () => {
  const dir = await tempDir("am-migrate-still-works-");
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(`${dir}/deno.json`, JSON.stringify({ name: "x" }));
    await Deno.writeTextFile(`${dir}/src/x.ts`, "export const x = 1;\n");
    const r = await am(["migrate", "--json"], dir);
    assertEquals(r.code, 0, r.out + r.err);
    assertEquals(JSON.parse(r.out).findings, []);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("a .jsonc app is an app (both names Deno accepts)", async () => {
  const dir = await tempDir("am-migrate-jsonc-");
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deno.jsonc`,
      '{\n  // the app\n  "name": "x"\n}\n',
    );
    await Deno.writeTextFile(`${dir}/src/x.ts`, "export const x = 1;\n");
    const r = await am(["migrate", "--json"], dir);
    assertEquals(r.code, 0, r.out + r.err);
    assertEquals(JSON.parse(r.out).findings, []);
  } finally {
    await dropTempDir(dir);
  }
});
