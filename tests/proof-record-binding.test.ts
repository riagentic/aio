// A proof row is bound to the run it is written from: the WHOLE suite, on the
// row's OS, of the commit named — said by the run's own first line.
//
// `deno task test tests/signal.test.ts > suite.log` ends "✓ all 1 shards
// passed" as a full run does, and was recorded as "native suite"; nothing in a
// log said which machine or commit it came from, and the row's date was the
// mtime of the copy. The runner now prints one line saying all four, and the
// recorder refuses a log without it or with the wrong answer in it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { suiteBinding } from "../scripts/proof-record.ts";
import { suiteHeader } from "../scripts/test-shards.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const SHA = "5eac592fe0123456789abcdef0123456789abcde";
const TAIL = [
  "1 test files → 1 parallel shards on 4 of 32 cores (no fence) · logs: .aio/test-shards/",
  "✓ shard 0  1 files  2s  ok | 7 passed | 0 failed (2s)",
  "",
  "✓ all 1 shards passed in 2s",
].join("\n");
const log = (full: boolean, os: string, commit: string, date = "2026-10-08") =>
  suiteHeader(full, os, commit, date) + "\n" + TAIL;

const why = (text: string, target = "windows", commit = SHA): string => {
  const b = suiteBinding(text, target, commit);
  assert(!b.ok, "a log that must be refused was accepted");
  return b.why;
};

Deno.test("update:proof — the runner's header round-trips, and the date is the run's", () => {
  assertEquals(suiteBinding(log(true, "windows", SHA), "windows", SHA), {
    ok: true,
    date: "2026-10-08",
  });
  // The row is `macos`; Deno calls that OS `darwin`. A short sha is the same commit.
  assertEquals(
    suiteBinding(
      log(true, "darwin", SHA.slice(0, 9), "2026-01-02"),
      "macos",
      SHA,
    ),
    { ok: true, date: "2026-01-02" },
  );
  // PowerShell's CRLF, and colour codes, are the same line.
  assertEquals(
    suiteBinding(
      "\x1b[2m" + log(true, "windows", SHA).replaceAll("\n", "\r\n"),
      "windows",
      SHA,
    ).ok,
    true,
  );
});

Deno.test("update:proof — a partial run, a headerless log, another OS or another commit is refused", () => {
  assertStringIncludes(why(log(false, "windows", SHA)), "PART of the suite");
  assertStringIncludes(why(TAIL), 'no "suite:');
  assertStringIncludes(why(log(true, "linux", SHA)), "was on linux");
  assertStringIncludes(why(log(true, "windows", SHA), "macos"), "on windows");
  const other = "a".repeat(40);
  assertStringIncludes(why(log(true, "windows", other)), `commit=${other}`);
  assertStringIncludes(
    why(log(true, "windows", "unknown")),
    "AIO_TEST_COMMIT",
  );
  assertStringIncludes(why(log(true, "windows", SHA + "+dirty")), "differed");
  // Too short to name a commit, and the empty prefix every sha starts with.
  assertStringIncludes(why(log(true, "windows", SHA.slice(0, 4))), "commit=");
  assertStringIncludes(why(log(true, "windows", SHA, "today")), "not a date");
});

Deno.test("update:proof — the runner says `full` only when no file was named, and prints the header", async () => {
  const src = await Deno.readTextFile(join(ROOT, "scripts/test-shards.ts"));
  assert(
    /console\.log\(\s*suiteHeader\(\s*named\.length === 0,\s*Deno\.build\.os,\s*runCommit\(\),/
      .test(src),
    "scripts/test-shards.ts must print suiteHeader(named.length === 0, Deno.build.os, runCommit(), …)",
  );
});

Deno.test("update:proof — the command refuses a one-file run, and dates a full one from its log", async () => {
  const dir = await tempDir("proof-record-binding-");
  try {
    const head = new TextDecoder().decode(
      new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: ROOT })
        .outputSync().stdout,
    ).trim();
    const run = async (text: string) => {
      const path = join(dir, "suite.log");
      await Deno.writeTextFile(path, text);
      const r = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          join(ROOT, "scripts/proof-record.ts"),
          "--row=windows (native suite)",
          `--from=${dir}`,
          `--commit=${head}`,
          "--dry-run",
        ],
        cwd: ROOT,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const d = new TextDecoder();
      return { code: r.code, out: d.decode(r.stdout) + d.decode(r.stderr) };
    };
    const partial = await run(log(false, "windows", head));
    assertEquals(partial.code, 1, partial.out);
    assertStringIncludes(partial.out, "PART of the suite");
    const bare = await run(TAIL);
    assertEquals(bare.code, 1, bare.out);
    // The file was written now; the row says when the RUN was.
    const full = await run(log(true, "windows", head, "2026-03-04"));
    assertEquals(full.code, 0, full.out);
    assertStringIncludes(full.out, "(2026-03-04)");
    assertStringIncludes(full.out, "not written");
  } finally {
    await dropTempDir(dir);
  }
});
