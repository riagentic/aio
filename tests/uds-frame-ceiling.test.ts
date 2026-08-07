// The UDS frame ceiling is the twin of `wsLimits.maxMessageBytes`, and it must
// track it.
//
// The failure it closes (found field-testing a messenger against dep/aio): an
// app raised its WS frame limit so a ~9MB attachment could travel as base64,
// which worked over WS — and then the SAME payload over the Electron/UDS hop
// hit a hardcoded 10MB buffer cap, and the connection was reset mid-send with
// no refusal anywhere. One transport honoured the app's ceiling; the other did
// not.
//
// Two halves are pinned, because the dangerous mistake in a "raise the limit"
// option is LOWERING it: the ceiling follows the app's value upward, and never
// drops below the long-safe floor whatever is passed. The rule is a pure
// function so this costs microseconds instead of multi-megabyte writes; that
// the connection handler USES it is pinned by the source assertion below.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { udsFrameCeiling } from "../src/server/uds.ts";

const FLOOR = 10 * 1024 * 1024;

Deno.test("uds frame ceiling: the floor holds by default", () => {
  assertEquals(udsFrameCeiling(undefined), FLOOR);
  assertEquals(udsFrameCeiling(0), FLOOR);
});

Deno.test("uds frame ceiling: an app's raised WS limit raises it too", () => {
  assertEquals(udsFrameCeiling(32 * 1024 * 1024), 32 * 1024 * 1024);
  assertEquals(udsFrameCeiling(FLOOR + 1), FLOOR + 1);
});

Deno.test("uds frame ceiling: a smaller value never lowers it", () => {
  // The option exists to RAISE the cap. A 1MB app limit must not make the UDS
  // hop refuse frames the WS hop accepts.
  assertEquals(udsFrameCeiling(1024 * 1024), FLOOR);
  assertEquals(udsFrameCeiling(-1), FLOOR);
});

Deno.test("uds frame ceiling: the connection handler uses the decider", async () => {
  // A second implementation of the rule is how the two transports diverged in
  // the first place — the buffer check must read this function, not a literal.
  const src = await Deno.readTextFile(
    new URL("../src/server/uds.ts", import.meta.url),
  );
  assertStringIncludes(src, "const MAX_BUF = udsFrameCeiling(maxFrameBytes);");
});
