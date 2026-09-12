// `am restart` must not throw away the flags the app was started with.
//
// Replay used to be all-or-nothing: ANY flag on the restart command line
// skipped the recorded launch entirely. So `am restart --force` — where
// `--force` means "yes, take over that other checkout" and says nothing about
// how the app should boot — dropped the `--cdp --port=8140` it was started
// with, and the app came back with `port: 0` and no debugging port (report 4
// §5, report 1 §22.4). The downstream error was excellent; the cause was silent,
// which is the half that costs an afternoon.
//
// The rule is per FLAG now, and it is pure, so it is pinned here rather than by
// launching processes.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { mergeLaunchFlags } from "../src/am/am-cmd-process.ts";
import { argsShapeHint as argsShapeHintFor } from "../src/am/am-cmd-state.ts";

Deno.test("am restart: an am-only flag does not suppress the recorded launch", () => {
  // THE reported bug.
  const m = mergeLaunchFlags(["--cdp", "--port=8140"], ["--force"]);
  assertEquals(
    m.launch,
    ["--cdp", "--port=8140"],
    "--force threw away the app's launch flags — it steers the RESTART, not " +
      "the app",
  );
  assertEquals(m.replayed, ["--cdp", "--port=8140"]);
  assertEquals(m.overridden, []);
});

Deno.test("am restart: every am-only flag is transparent to replay", () => {
  for (const f of ["--json", "--quiet", "--wait=5", "--long", "--timeout=9"]) {
    const m = mergeLaunchFlags(["--cdp"], [f]);
    assertEquals(m.launch, ["--cdp"], `${f} suppressed the replay`);
  }
});

Deno.test("am restart: a typed flag OVERRIDES the recorded one, and says so", () => {
  const m = mergeLaunchFlags(["--cdp", "--port=8140"], ["--port=9000"]);
  assertEquals(
    m.launch,
    ["--cdp", "--port=9000"],
    "the override must win and the rest must survive",
  );
  assertEquals(m.replayed, ["--cdp"]);
  assertEquals(
    m.overridden,
    ["--port"],
    "an override has to be REPORTED — silently replacing a recorded flag is " +
      "the same silence in the other direction",
  );
});

Deno.test("am restart: `--port` and `--port=N` are one flag", () => {
  // Matched on the NAME, or a bare `--cdp` would sit next to a recorded
  // `--cdp=9222` and the app would be handed both.
  const m = mergeLaunchFlags(["--cdp=9222"], ["--cdp"]);
  assertEquals(m.launch, ["--cdp"]);
  assertEquals(m.overridden, ["--cdp"]);
});

Deno.test("am restart: nothing recorded means nothing invented", () => {
  const m = mergeLaunchFlags([], ["--cdp"]);
  assertEquals(m.launch, ["--cdp"]);
  assertEquals(m.replayed, []);
  assertEquals(m.overridden, []);
});

Deno.test("am restart: a typed app flag lands even with nothing to merge", () => {
  const m = mergeLaunchFlags(["--env-file=.env"], ["--cdp", "--force"]);
  assertEquals(
    m.launch,
    ["--env-file=.env", "--cdp"],
    "the recorded --env-file must survive (the field report that started " +
      "this: restart dropped it and the vault stopped auto-unlocking), and " +
      "--force must not reach the app",
  );
});

// ── `am dispatch --args` has two readings, and only one is what you meant ───
//
// `--args` is the ARGUMENT LIST: `--args='["a","b"]'` passes TWO arguments, and
// what people usually mean is one array. The app then throws about a value its
// author never knowingly passed — `v.startsWith is not a function` (report 3 §4)
// — and nothing in that message points back at the command line.
//
// Both readings are legal, so this is never a refusal. It is one line, offered
// only after the app has already refused the call.

Deno.test("am dispatch: a failed --args call offers the other reading", async () => {
  const { argsShapeHint } = await import("../src/am/am-cmd-state.ts");

  const hint = argsShapeHint('["a","b"]', {
    type: "net:scan",
    payload: { args: ["a", "b"] },
  });
  assertEquals(
    typeof hint,
    "string",
    "a failed --args dispatch must offer the single-array reading",
  );
  assertStringIncludes(hint!, "2 arguments");
  assertStringIncludes(
    hint!,
    `--args='[["a","b"]]'`,
    "the hint has to hand back the exact command line, not describe it",
  );
});

Deno.test("am dispatch: no --args, no hint", () => {
  // Positional dispatch has no such ambiguity, and a hint that fires on every
  // failure is noise that buries the app's own message.
  assertEquals(
    argsShapeHintFor(undefined, { type: "x", payload: { args: ["a"] } }),
    undefined,
  );
  // An empty list has no other reading either.
  assertEquals(
    argsShapeHintFor("[]", { type: "x", payload: { args: [] } }),
    undefined,
  );
});
