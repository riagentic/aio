// waitFor checked its deadline BEFORE the predicate, so `timeoutMs: 0` — or
// a first settle() slower than the budget — timed out without asking once,
// failing a condition that was already true.
import { assertEquals, assertRejects } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";

function Hello() {
  return <div>ready</div>;
}

Deno.test("waitFor: a true predicate passes even with timeoutMs: 0", async () => {
  await using ui = await testUI(Hello);
  let asked = 0;
  await ui.waitFor(() => {
    asked++;
    return true;
  }, { timeoutMs: 0 });
  assertEquals(asked, 1);
});

Deno.test("waitFor: a false predicate still times out", async () => {
  await using ui = await testUI(Hello);
  await assertRejects(
    () => ui.waitFor(() => false, { timeoutMs: 50, msg: "never" }),
    Error,
    "timed out",
  );
});
