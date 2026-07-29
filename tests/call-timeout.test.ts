// `await cell.method()` used to give up after a hardcoded 30s and blame "the
// effect executor may have crashed or never resolved this call". Almost never
// true: the method was simply still running — and it stayed running, so its
// writes committed later, unannounced, on top of whatever the caller did next.
// A false cause plus a hidden true state, which is exactly what
// `.katana/errors.md` forbids, and it cost a production incident (an NFT queue
// starting new work on top of live work).
//
// Worse, it was a SECOND ceiling: `effectTimeoutMs` bounded the effect, this
// bounded the caller, both 30s, and raising the first left the second in place
// — a knob that looks like it worked. Now there is one ceiling.
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  _resetCallTimeouts,
  _setCallTimeouts,
  callTimeoutFor,
  registerCall,
  resolveCall,
} from "../src/state/cell-impl.ts";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";

Deno.test("call timeout: effectTimeoutMs raises the caller's ceiling too", () => {
  _resetCallTimeouts();
  assertEquals(callTimeoutFor("cell:m"), 30_000, "built-in default");
  _setCallTimeouts(120_000);
  assertEquals(
    callTimeoutFor("cell:m"),
    120_000,
    "raising effectTimeoutMs must raise THIS — the old bug was that it didn't",
  );
  _setCallTimeouts(120_000, { "cell:slow": 600_000 });
  assertEquals(callTimeoutFor("cell:slow"), 600_000, "per-method override");
  assertEquals(callTimeoutFor("cell:m"), 120_000, "others keep the default");
  _resetCallTimeouts();
});

Deno.test("call timeout: 0 waits indefinitely, and arms no timer", async () => {
  _resetCallTimeouts();
  _setCallTimeouts(0);
  assertEquals(callTimeoutFor(), 0);
  const p = registerCall("unbounded-1", "cell:m");
  // No pending timer to leak — Deno's op sanitizer would fail this test if the
  // "forever" path still armed a 30s setTimeout.
  resolveCall("unbounded-1", "done");
  assertEquals(await p, "done");
  _resetCallTimeouts();
});

Deno.test("call timeout: the message states what is true, not a guess", async () => {
  _resetCallTimeouts();
  _setCallTimeouts(20); // fast, deliberately
  const err = await assertRejects(
    () => registerCall("slow-1", "wallet:refresh"),
    Error,
  );
  const msg = String(err);
  assertStringIncludes(msg, "wallet:refresh");
  assertStringIncludes(msg, "stopped waiting after 20ms");
  // The two facts the old message got wrong: WHAT stopped, and what happens
  // to the work that didn't.
  assertStringIncludes(msg, "METHOD did not");
  assertStringIncludes(msg, "writes will still commit");
  // …and how to change it, naming both knobs.
  assertStringIncludes(msg, "effectTimeoutMs");
  assertStringIncludes(msg, 'perfBudget.methods["wallet:refresh"].timeout');
  // No invented cause.
  assertEquals(
    msg.includes("crashed"),
    false,
    `must not assert a crash it cannot know about: ${msg}`,
  );
  _resetCallTimeouts();
});

Deno.test("call timeout: a resolved call clears its timer (no late rejection)", async () => {
  _resetCallTimeouts();
  _setCallTimeouts(30);
  const p = registerCall("ok-1", "cell:m");
  resolveCall("ok-1", 42);
  assertEquals(await p, 42);
  await new Promise((r) => setTimeout(r, 50)); // past the ceiling
  _resetCallTimeouts();
});

// Through a REAL boot, because the failure mode this batch keeps meeting is a
// config key that is typed, documented and read by someone — and never
// carried from `aio.run({...})` to the code that acts on it. A unit test on
// `_setCallTimeouts` proves the mechanism, not the wiring.
Deno.test("call timeout: effectTimeoutMs from aio.run() reaches the caller's ceiling", async () => {
  const slow = cell("ct_boot", {
    state: { done: false },
    methods: {
      async work(s: { done: boolean }) {
        // Longer than the 30s default would ever allow if the ceiling were
        // still hardcoded — but this test does not wait 30s: the assertion is
        // on the RESOLVED ceiling the boot installed, plus a real call that
        // completes well inside it.
        await new Promise((r) => setTimeout(r, 20));
        s.done = true;
        return "finished";
      },
    },
  });
  await using srv = await testServer({
    cells: [slow],
    effectTimeoutMs: 90_000,
    perfBudget: { methods: { "ct_boot:work": { timeout: 300_000 } } },
  });
  assertEquals(
    callTimeoutFor("ct_boot:work"),
    300_000,
    "the per-method override survived the boot",
  );
  assertEquals(
    callTimeoutFor("ct_boot:other"),
    90_000,
    "…and so did effectTimeoutMs, which used to stop at the effect tracker",
  );
  assertEquals(
    await (slow as unknown as { work: () => Promise<string> }).work(),
    "finished",
  );
  void srv;
});
