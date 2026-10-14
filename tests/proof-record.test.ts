// `deno task update:proof` writes a proof row from another machine's suite
// log — and refuses every log that is less than "the whole suite passed".
//
// The row is the release's evidence that the suite ran on Windows and macOS.
// A recorder that would write it from a run with a red shard, from a run that
// was cut before its verdict, or from half a log, turns the matrix back into
// a claim. Every refusal below is a run that really happened in this project.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  decodeLog,
  SUITE_ROWS,
  suiteRow,
  suiteVerdict,
} from "../scripts/proof-record.ts";
import { CLAIMS } from "../scripts/proof.ts";

// What scripts/test-shards.ts prints, colour codes and all.
const GREEN = [
  "2433 test files → 2 parallel shards on 4 of 32 cores (taskset -c 28-31) · logs: .aio/test-shards/",
  "\x1b[32m✓\x1b[0m shard 1  1191 files  1627s  ok | 6644 passed (55 steps) | 0 failed | 15 ignored (26m55s)",
  "✓ shard 0  1242 files  1639s  ok | 6723 passed (288 steps) | 0 failed | 89 ignored (1 step) (27m7s)",
  "",
  "✓ all 2 shards passed in 1639s",
  "no orphaned aio processes (0 stale lock dir(s))",
].join("\n");

const why = (log: string, exit?: number): string => {
  const v = suiteVerdict(log, exit);
  assert(!v.ok, "a run that must be refused was accepted");
  return v.why;
};

Deno.test("update:proof — a green suite log gives the run's own counts", () => {
  assertEquals(suiteVerdict(GREEN), {
    ok: true,
    passed: 13367,
    failed: 0,
    ignored: 104,
    files: 2433,
    shards: 2,
    seconds: 1639,
  });
  // CRLF (a log written on Windows) and a zero exit named by a wrapper.
  const v = suiteVerdict(GREEN.replaceAll("\n", "\r\n") + "\r\nEXIT=0\r\n", 0);
  assertEquals(v.ok && v.passed, 13367);
  // A shard with nothing ignored prints no `ignored` field at all.
  const none = suiteVerdict(
    "✓ shard 0  3 files  2s  ok | 7 passed | 0 failed (2s)\n✓ all 1 shards passed in 2s",
  );
  assertEquals(none.ok && [none.passed, none.ignored], [7, 0]);
});

Deno.test("update:proof — a run with a failure, a cut run, or a non-zero exit is refused", () => {
  // A red shard: the runner's own closing line is the failure.
  const red = GREEN
    .replace(
      "✓ shard 0  1242 files  1639s  ok | 6723 passed (288 steps) | 0 failed",
      "✗ shard 0  1242 files  1639s  FAILED | 6721 passed (288 steps) | 2 failed",
    )
    .replace("✓ all 2 shards passed in 1639s", "✗ 1 shard(s) failed (1639s):");
  assertStringIncludes(why(red), "the run failed");
  // Cut before the verdict (a closed ssh session): every shard line green,
  // and no verdict.
  assertStringIncludes(
    why(GREEN.replace("✓ all 2 shards passed in 1639s", "")),
    "no closing",
  );
  // Half a log: the verdict names two shards, one line is there.
  assertStringIncludes(
    why(GREEN.split("\n").filter((l) => !l.includes("shard 1 ")).join("\n")),
    "names 2 shards and the log has 1",
  );
  // A shard that printed no summary (killed) but is otherwise marked ✓.
  assertStringIncludes(
    why(
      "✓ shard 0  3 files  2s  exit 0\n✓ all 1 shards passed in 2s",
    ),
    "shard 0 did not pass",
  );
  // A failed count under a green mark is still a failure.
  assertStringIncludes(
    why(
      "✓ shard 0  3 files  2s  ok | 7 passed | 1 failed (2s)\n✓ all 1 shards passed in 2s",
    ),
    "1 failed test(s)",
  );
  // The exit code, given or written into the log by the wrapper that ran it.
  assertEquals(why(GREEN, 1), "the run exited 1");
  assertEquals(why(GREEN + "\nWIN_EXIT=1\n"), "the run exited 1");
  // A test escaped the store sandbox: the runner exits 1 after a green list.
  assertStringIncludes(
    why(GREEN + "\n✗ the run wrote a REAL per-user store (…)"),
    "real per-user store",
  );
  // Not a suite log at all, and a suite that ran nothing.
  assertStringIncludes(why("ok | 3 passed | 0 failed (1s)"), "no closing");
  assertStringIncludes(
    why(
      "✓ shard 0  0 files  0s  ok | 0 passed | 0 failed (0s)\n✓ all 1 shards passed in 0s",
    ),
    "passed no test",
  );
});

Deno.test("update:proof — only the suite rows, each a claim the matrix prints", () => {
  assertEquals(suiteRow("windows (native suite)"), SUITE_ROWS[0]);
  assertEquals(suiteRow(" macos (native suite) "), SUITE_ROWS[1]);
  assertEquals(suiteRow("windows (real hardware)"), SUITE_ROWS[2]);
  // A gate's own row is not this recorder's to write, nor is a typo.
  for (
    const n of [
      "cli (binary)",
      "windows (wine)",
      "windows",
      "linux (native suite)",
      "",
    ]
  ) {
    assertEquals(suiteRow(n), null, n);
  }
  for (const r of SUITE_ROWS) {
    const c = CLAIMS.find((c) => c.target === r.target && c.env === r.env);
    assert(c?.auto, `${r.target} (${r.env}) must be an automatic claim`);
    assertStringIncludes(c.how, "deno task update:proof");
  }
});

Deno.test("update:proof — a PowerShell-redirected log (UTF-16, BOM) reads as the same run", () => {
  const u16 = new Uint8Array(2 + GREEN.length * 2);
  u16.set([0xff, 0xfe]);
  for (let i = 0; i < GREEN.length; i++) {
    const c = GREEN.charCodeAt(i);
    u16.set([c & 0xff, c >> 8], 2 + i * 2);
  }
  assertEquals(decodeLog(u16), GREEN);
  assertEquals(decodeLog(new TextEncoder().encode(GREEN)), GREEN);
  assertEquals(suiteVerdict(decodeLog(u16)).ok, true);
});
