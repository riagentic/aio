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
import {
  childCoverageDir,
  dropTempDir,
  tempDir,
  tempDirSync,
} from "../src/testing/temp-dir.ts";
import { aioTestDir, aioTestRoot } from "../src/testing/test-strict.ts";

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

Deno.test("temp-dir: ONE root, the same one test-strict already used", async () => {
  // Two deciders for "where does a test's scratch go": this module called
  // itself the one decider and used `/tmp`, while `test-strict.ts` — which
  // argues the case at length, because a test's scratch holds an `auth.db`,
  // an `app.key` and TLS material under a world-writable parent — has always
  // used `~/tmp/aio/` and honoured `AIO_TEST_ROOT`.
  //
  // The measured cost of the split was the gate going blind: `check-orphans`
  // swept `/tmp/aio-*` only, so the other tree was ungated and had grown to
  // 151 directories, 122 of them over a day old.
  const root = aioTestRoot();
  const d = await tempDir("one-root-");
  try {
    assert(
      d.startsWith(root),
      `tempDir() made ${d}, which is not under the test root ${root}`,
    );
    assertEquals(
      aioTestDir("probe-").startsWith(root),
      true,
      "…and so does " +
        "test-strict, which is the point: one root, one sweep, one ls",
    );
  } finally {
    await dropTempDir(d);
  }
});

Deno.test("temp-dir: AIO_TEST_ROOT moves BOTH, or it moves neither usefully", () => {
  // A runner that points the root somewhere else must move every test
  // directory, not half of them.
  const prev = Deno.env.get("AIO_TEST_ROOT");
  // The alternate root the registry is about to be pointed at, removed below.
  // aio-ok: it must sit OUTSIDE the registry, or it is the thing under test.
  const here = Deno.makeTempDirSync({ prefix: "aio-root-probe-" });
  try {
    Deno.env.set("AIO_TEST_ROOT", here);
    assert(aioTestRoot().startsWith(here));
    assert(tempDirSync("moved-").startsWith(here), "tempDir follows it too");
    assert(aioTestDir("moved-").startsWith(here));
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_TEST_ROOT");
    else Deno.env.set("AIO_TEST_ROOT", prev);
    Deno.removeSync(here, { recursive: true });
  }
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
