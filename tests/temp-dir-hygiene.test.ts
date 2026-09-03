// Nothing a test makes in /tmp outlives the test process.
//
// `scripts/check-orphans.ts` counts ownerless `/tmp/aio-*` directories and
// fails `deno task test` above a ceiling; one suite run used to leave 143 of
// them, and a developer machine had 5,612 holding 4.3 GB. Every one was the
// same shape: a temp dir removed on the happy path only, skipped by the test
// that threw.
//
// `src/testing/temp-dir.ts` is the one decider now, and this file pins the two
// properties that make it worth having: the registry survives a FAILING test
// (the case a hand-written `finally` keeps missing), and nobody hand-rolls the
// child-coverage dir a second time.
import { assert, assertEquals } from "@std/assert";
import { childCoverageDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;

Deno.test("temp-dir: a dir made by a FAILING test is gone when the process exits", async () => {
  const work = await tempDir("aio-tdh-");
  const marker = `${work}/dir.txt`;
  // A child `deno test` whose only test throws — the exact path a hand-written
  // cleanup call at the end of the happy path never reaches.
  await Deno.writeTextFile(
    `${work}/leaky.test.ts`,
    `import { tempDir } from "${ROOT}src/testing/temp-dir.ts";\n` +
      `Deno.test("throws after making a temp dir", async () => {\n` +
      `  const d = await tempDir("aio-tdh-child-");\n` +
      `  await Deno.writeTextFile(${JSON.stringify(marker)}, d);\n` +
      `  throw new Error("boom");\n` +
      `});\n`,
  );
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["test", "-A", "--no-check", `${work}/leaky.test.ts`],
    env: { ...Deno.env.toObject(), DENO_COVERAGE_DIR: childCoverageDir() },
    stdout: "null",
    stderr: "null",
  }).output();
  assertEquals(
    out.code,
    1,
    "the child test must have FAILED — that is the point",
  );

  const leaked = (await Deno.readTextFile(marker)).trim();
  assert(leaked.startsWith("/"), `child did not report its dir: ${leaked}`);
  assertEquals(
    await Deno.stat(leaked).then(() => "still there").catch(() => "gone"),
    "gone",
    `${leaked} outlived the failing test process`,
  );
});

Deno.test("temp-dir: the child-coverage dir has exactly one definition", async () => {
  const offenders: string[] = [];
  for await (const e of Deno.readDir(`${ROOT}tests`)) {
    if (!e.isFile || !e.name.endsWith(".ts")) continue;
    const src = await Deno.readTextFile(`${ROOT}tests/${e.name}`);
    // The idiom this replaced: `DENO_COVERAGE_DIR ?? makeTempDirSync(...)`,
    // copied into 24 files, each making its own directory and removing none.
    if (/makeTempDir(Sync)?\(\{\s*prefix:\s*["'`]aio-child-cov-/.test(src)) {
      offenders.push(e.name);
    }
  }
  assertEquals(
    offenders,
    [],
    `these re-implement childCoverageDir() instead of importing it from ` +
      `src/testing/temp-dir.ts: ${offenders.join(", ")}`,
  );
});
