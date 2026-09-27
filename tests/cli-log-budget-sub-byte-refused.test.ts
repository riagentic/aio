// `--log-budget=0.5` floored to 0 — the documented "unlimited" — so a flag
// written to SET a ceiling silently removed it. 0 is unlimited only when said.
import { assertEquals, assertThrows } from "@std/assert";
import { parseCli } from "../src/server/aio-cli.ts";

Deno.test("--log-budget: a sub-byte value is refused, not read as unlimited", () => {
  for (const v of ["0.5", "0.4B", "0.9b"]) {
    assertThrows(() => parseCli([`--log-budget=${v}`]), Error, "--log-budget");
  }
});

Deno.test("--log-budget: 0 is still unlimited, and real sizes parse", () => {
  assertEquals(parseCli(["--log-budget=0"]).logBudget, 0);
  assertEquals(parseCli(["--log-budget=1"]).logBudget, 1);
  assertEquals(parseCli(["--log-budget=0.5KB"]).logBudget, 512);
  assertEquals(parseCli(["--log-budget=200MB"]).logBudget, 200 * 1024 ** 2);
});
