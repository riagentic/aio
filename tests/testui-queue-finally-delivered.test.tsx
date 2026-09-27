// Bug hunt r2: the action queue's thenable (src/testing/ui-test.ts enqueue)
// marks a failure "delivered" in `then(onF, onR)` and `catch`, but NOT in
// `finally`. `await ui.X.click().finally(cleanup)` receives the rejection —
// the caller awaited and observed it — yet the next drain point rethrows the
// SAME error. The enqueue comment: "A failure the caller AWAITED ... is
// delivered there and must NOT resurface at the next drain point".
import { assertRejects } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";

function App() {
  return (
    <div>
      <button type="button" disabled onClick={() => {}}>Save</button>
    </div>
  );
}

Deno.test("queue: a failure awaited through .finally() is not reported twice", async () => {
  await using ui = await testUI(App);
  let cleaned = false;
  // Disabled control → the action rejects; the caller awaits it (via finally).
  await assertRejects(
    () => ui.SaveButton.click().finally(() => (cleaned = true)),
    Error,
    "disabled",
  );
  if (!cleaned) throw new Error("finally never ran");
  // Observed already — the next observation point must not rethrow it.
  await ui.settle();
});
