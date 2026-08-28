// `deno task ship --help` is a QUESTION: usage on stdout, exit 0. It used to
// be an unknown-flag refusal (exit 1) — the help you asked for, as an error.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { isHelpRequest, SHIP_USAGE } from "../src/build/ship.ts";

const SHIP = new URL("../src/build/ship.ts", import.meta.url).pathname;

Deno.test("isHelpRequest: --help / -h anywhere", () => {
  assert(isHelpRequest(["--help"]));
  assert(isHelpRequest(["dist/app", "-h"]));
  assert(!isHelpRequest(["dist/app", "--channel=prod"]));
});

Deno.test("ship --help prints usage and exits 0", async () => {
  for (const flag of ["--help", "-h"]) {
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", SHIP, flag],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(r.code, 0, `${flag}: ${new TextDecoder().decode(r.stderr)}`);
    const out = new TextDecoder().decode(r.stdout);
    assertStringIncludes(out, "usage: ship <binary>");
    assertStringIncludes(out, "ship keygen");
    assertEquals(out.trim(), SHIP_USAGE.trim());
  }
});

Deno.test("no argument is still an error (exit 1, usage on stderr)", async () => {
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", SHIP],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(r.code, 1);
  assertStringIncludes(new TextDecoder().decode(r.stderr), "usage: ship");
});
