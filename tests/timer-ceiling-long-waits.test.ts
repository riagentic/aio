// A wait past setTimeout's int32 ceiling (2^31-1 ms ≈ 24.8 days).
//
// setTimeout truncates a longer delay to ~1 ms, so `sleep(30 days)` returned
// at once, a `race({ timeout: 30 days })` timed out at once, and a call
// ceiling of 30 days (`call({ timeoutMs })`, `perfBudget…timeout`) rejected
// the call immediately.
import { assertEquals } from "@std/assert";
import { race, sleep } from "../src/state/async-helpers.ts";
import { call } from "../src/state/cell-impl.ts";

const MONTH = 30 * 24 * 60 * 60 * 1000;
const held = <T>(p: Promise<T>) =>
  Promise.race([
    p.then(() => "settled", (e) => `rejected: ${e}`),
    new Promise<string>((r) => setTimeout(() => r("held"), 100)),
  ]);

Deno.test("sleep: a 30-day sleep does not return at once", async () => {
  // Real timers (FakeTime does not truncate past the ceiling, so it cannot
  // show the bug), recorded so the month-long one can be cleared at the end —
  // sleep() has no cancel, and a live timer trips the leak sanitizer.
  const real = globalThis.setTimeout;
  const armed: ReturnType<typeof setTimeout>[] = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = real(fn, ms);
    armed.push(id);
    return id;
  }) as typeof setTimeout;
  try {
    const p = sleep(MONTH);
    globalThis.setTimeout = real;
    assertEquals(await held(p), "held");
  } finally {
    globalThis.setTimeout = real;
    armed.forEach(clearTimeout);
  }
});

Deno.test("race: a 30-day timeout branch does not win at once", async () => {
  let done!: () => void;
  const other = new Promise<void>((r) => done = r);
  const p = race({ other, timeout: MONTH });
  assertEquals(await held(p), "held");
  done(); // `other` wins; race clears its timer
  assertEquals((await p).winner, "other");
});

Deno.test("call: a 30-day ceiling does not reject at once", async () => {
  let done!: () => void;
  const p = call(
    { timeoutMs: MONTH },
    () => new Promise<void>((r) => done = r),
  );
  assertEquals(await held(p), "held");
  done();
  await p;
});
