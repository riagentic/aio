// plugin-hook-async-rejection.test.ts — a plugin hook that REJECTS is guarded
// the same as one that throws.
//
// `composeHooks` wrapped each hook in try/catch, which only sees a synchronous
// throw. An `async` onAction — or one that returns the cell-method call it made
// — rejects instead, and that escaped as an unhandled rejection: logged by the
// crash handler while the app ran, and fatal ("Uncaught (in promise)") during
// shutdown, where hooks see each cell's `__destroy`. Measured on a booted app
// with `definePlugin({ onAction: async () => { throw … } })`.
import { assertEquals } from "@std/assert";
import { composeHooks } from "../src/server/plugin.ts";

Deno.test("hooks: a rejecting onAction is reported through onError, and the rest still run", async () => {
  const order: string[] = [];
  const errors: unknown[] = [];
  const composed = composeHooks<[unknown]>(
    [
      // deno-lint-ignore require-await
      async () => {
        order.push("p1");
        throw new Error("async plugin hook boom");
      },
      () => void order.push("p2"),
    ],
    () => void order.push("app"),
    (e) => errors.push(e),
  )!;
  composed({ type: "x:go" });
  assertEquals(order, ["p1", "p2", "app"]);
  // The rejection settles on a later microtask; give it one macrotask.
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(errors.length, 1);
  assertEquals((errors[0] as Error).message, "async plugin hook boom");
});

Deno.test("hooks: a LONE plugin hook returning a rejected method call is reported", async () => {
  const errors: unknown[] = [];
  const composed = composeHooks<[unknown]>(
    [() => Promise.reject(new Error("dispatch after close()"))],
    undefined,
    (e) => errors.push(e),
  )!;
  composed({ type: "x:__destroy" });
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(errors.length, 1);
});
