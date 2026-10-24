// `errorSummary(e)`: one line for a failure — the code, then the first
// sentence of the message — for a CI gate or an agent scanning a wall of
// failures (field report: the prose is right, just hard to scan). The message
// is not changed: its first line is what apps' tests match.
import { assertEquals } from "@std/assert";
import { errorCode, errorSummary } from "../mod.ts";
import { createAioError } from "../src/diagnostics/error.ts";

Deno.test("errorSummary: code + first sentence, one line", () => {
  const e = Object.assign(
    new Error(
      '"notes:add" refused: this boot is dead. The app was replaced.\n\nMore prose here.',
    ),
    { code: "DEAD_BOOT" },
  );
  assertEquals(
    errorSummary(e),
    'DEAD_BOOT: "notes:add" refused: this boot is dead',
  );
  assertEquals(
    e.message.startsWith('"notes:add" refused'),
    true,
    "the message is untouched",
  );
});

Deno.test("errorSummary: no code — the sentence alone; not an Error — its text", () => {
  assertEquals(errorSummary(new Error("disk full; retry later")), "disk full");
  assertEquals(errorSummary("plain"), "plain");
  assertEquals(errorSummary({ message: "obj. x" }), "obj");
});

Deno.test("errorSummary: a message that leads with its code says it once; long text is capped", () => {
  const e = createAioError(
    "ACCESS_DENIED",
    "[ACCESS_DENIED] not a member. Sign in.",
    {},
  );
  assertEquals(errorCode(e), "ACCESS_DENIED");
  assertEquals(
    errorSummary(e).startsWith("ACCESS_DENIED: "),
    true,
    errorSummary(e),
  );
  assertEquals(errorSummary(e).includes("[ACCESS_DENIED]"), false);
  const long = errorSummary(new Error("x".repeat(500)), 40);
  assertEquals([long.length, long.endsWith("…")], [40, true]);
});
