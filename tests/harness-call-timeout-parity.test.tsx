// A method the app gives up on at N ms must be given up on at N ms under test.
//
// `perfBudget.methods["cell:m"].timeout` is the ceiling `await cell.method()`
// waits before it stops waiting. Only the server boot applied it
// (`_setCallTimeouts` in aio.ts); the standalone runtime behind bootCells /
// testUI — and the Android APK — never did, and testUI did not even hand
// `perfBudget` to the runtime. So a method budgeted at 100 ms that took longer
// resolved normally in both harnesses and rejected against a real server: a
// test green over a timeout the app enforces.
//
// Every case asks the real server first, then asserts the harness agrees.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { testServer } from "../src/testing/server-test.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { h } from "../src/air/vdom.ts";

/** A gate the test opens AFTER it has seen the call give up, so the method
 *  finishes inside the test and leaves no timer behind. */
let open: () => void = () => {};
const slow = cell("ctoSlow", {
  state: { done: 0 },
  methods: {
    async work(s: { done: number }) {
      await new Promise<void>((r) => open = r);
      s.done++;
      return "finished";
    },
  },
});
const S = slow as unknown as { work: () => Promise<string>; done: number };
const perfBudget = { methods: { "ctoSlow:work": { timeout: 100 } } };

/** What `await slow.work()` answers, with the method held past its ceiling. */
async function outcome(): Promise<string> {
  const call = S.work().then((v) => `resolved ${v}`, (e: Error) => e.message);
  // Well past the 100 ms ceiling, and well short of the 30 s default.
  const t = setTimeout(() => open(), 400);
  const answer = await call;
  clearTimeout(t);
  open(); // let the method finish, so nothing outlives the test
  return answer;
}

Deno.test("call ceiling parity: the real server gives up at perfBudget's timeout", async () => {
  await using srv = await testServer({ cells: [slow], perfBudget });
  const answer = await outcome();
  assertStringIncludes(answer, "stopped waiting after 100ms");
  // The method itself still finished — the CALL gave up, not the work.
  const done = () =>
    (srv.state() as { ctoSlow: { done: number } }).ctoSlow.done;
  for (let i = 0; i < 50 && done() === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assertEquals(done(), 1, "the method still ran to completion");
});

Deno.test("call ceiling parity: bootCells gives up at the same ceiling", async () => {
  await using h = await bootCells([slow], { perfBudget });
  assertStringIncludes(await outcome(), "stopped waiting after 100ms");
  await h.settle();
  assertEquals(S.done, 1, "the method still ran to completion");
});

Deno.test("call ceiling parity: testUI gives up at the same ceiling", async () => {
  await using ui = await testUI(() => h("div", null, "x"), {
    cells: [slow],
    perfBudget,
  });
  assertStringIncludes(await outcome(), "stopped waiting after 100ms");
  await ui.settle();
});

Deno.test("call ceiling parity: a later boot without the budget is back to the default", async () => {
  // Set on EVERY boot, so one test's ceiling can never shorten the next one's.
  await using h = await bootCells([slow]);
  const call = S.work();
  const t = setTimeout(() => open(), 250);
  assertEquals(await call, "finished");
  clearTimeout(t);
  await h.settle();
});
