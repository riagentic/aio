// Two small contract holes, and one guard:
// - (guard) aio/cli args(): a `number` flag refuses "0x10" / "1e3" / "0b1" —
//   suspected lenient, found already strict; pinned so it stays that way.
// - fail(msg, { code: 0 }) exited 0, though fail "ENDs the process with a
//   non-zero code" — a failure a calling script read as success.
// - a feedback report's BODY skipped the credential masking its title and
//   log tail get: a pasted share link carried the app key.
import { assert, assertEquals } from "@std/assert";
import { args } from "../src/cli/args.ts";
import { fail } from "../src/cli/exit.ts";
import { CliExit, testIO } from "../src/cli/io.ts";
import { buildReport } from "../src/server/report.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const spec = { name: "t", flags: { n: { type: "number" } } } as const;

function exitOf(fn: () => unknown): number | null {
  try {
    fn();
  } catch (e) {
    if (e instanceof CliExit) return e.code;
    throw e;
  }
  return null;
}

Deno.test("args(): a number flag is decimal — hex, exponent and binary are refused", () => {
  for (const bad of ["0x10", "1e3", "0b1", "Infinity", ""]) {
    const io = testIO();
    assert(
      exitOf(() => args(spec, { argv: [`--n=${bad}`], io })) !== 0,
      `--n=${bad} accepted`,
    );
  }
  for (
    const [good, want] of [["16", 16], ["-2.5", -2.5], [".5", 0.5]] as const
  ) {
    const io = testIO();
    const a = args(spec, { argv: [`--n=${good}`], io });
    assertEquals(a.flags.n, want);
  }
});

Deno.test("fail(): code 0 still ends non-zero", () => {
  const io = testIO();
  const code = exitOf(() => fail("boom", { code: 0, io }));
  assert(code !== null && code > 0, `exited ${code}`);
});

Deno.test("buildReport: the body is masked like the title", async () => {
  const dir = await tempDir("aio-report-body-");
  const KEY = "k".repeat(40);
  try {
    const r = await buildReport({
      kind: "error",
      title: "it broke",
      body: `I opened http://192.168.1.4:8000/?token=${KEY} and…`,
    }, {
      appId: "a",
      appVersion: "1",
      aioVersion: "1",
      dataDir: dir,
      logsDir: dir,
      exposed: true,
      persist: false,
      cells: [],
    });
    assert(!JSON.stringify(r).includes(KEY), "the app key left in the body");
  } finally {
    await dropTempDir(dir);
  }
});
