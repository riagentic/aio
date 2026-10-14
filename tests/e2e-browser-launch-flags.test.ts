// Every test that launches a real browser spreads `browserOsFlags`
// (tests/e2e-harness.ts) into its arguments.
//
// On Windows a Chromium started on a fresh profile without `--guest` costs
// the Windows user one FAILED LOGON (Security event 4625, from the browser),
// and ten of those in ten minutes lock the account — measured: ten test
// browsers, the machine's user locked out for ten minutes, twice. One launch
// site without the flag is enough to do it again, so the rule is checked over
// every file rather than remembered.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { browserOsFlags } from "./e2e-harness.ts";

const TESTS = fromFileUrl(new URL(".", import.meta.url));
/** A browser's own flag: no aio command has `--headless=new`. */
const LAUNCH = /^\s*"--headless=new",$/;

Deno.test("every real-browser launch in tests/ carries the per-OS flags", () => {
  const bare: string[] = [];
  let sites = 0;
  for (const e of Deno.readDirSync(TESTS)) {
    if (!e.isFile || !/\.tsx?$/.test(e.name)) continue;
    const lines = Deno.readTextFileSync(join(TESTS, e.name)).split("\n");
    lines.forEach((line, i) => {
      if (!LAUNCH.test(line)) return;
      const flagged = lines[i - 1]?.trim() === "...browserOsFlags,";
      // A launch: the first argument of a command — not a list a test
      // compares a launcher's flags against.
      if (!lines[flagged ? i - 2 : i - 1]?.trimEnd().endsWith("args: [")) {
        return;
      }
      sites++;
      if (!flagged) bare.push(`${e.name}:${i + 1}`);
    });
  }
  assert(sites >= 15, `the scan found only ${sites} launch sites`);
  assertEquals(bare, [], "a browser launch without `...browserOsFlags`");
});

Deno.test("browserOsFlags: a guest window on Windows, nothing elsewhere", () => {
  assertEquals(
    [...browserOsFlags],
    Deno.build.os === "windows" ? ["--guest"] : [],
  );
});
