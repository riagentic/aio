// Bug hunt r4 — `am expect` comparisons.
//
// 1. `eq`/`ne`/`contains` compare by JSON.stringify, which is KEY-ORDER
//    sensitive: `am expect counter eq '{"b":2,"a":1}'` FAILS against state
//    `{a:1,b:2}` — the same JSON object. State key order is an accident of
//    insertion order, so a correct assertion fails (and `ne` falsely passes).
// 2. `contains` on a STRING re-serialises the JSON-parsed value instead of the
//    text typed: `am expect label contains 1.50` checks for "1.5" (false PASS
//    against "total: 1.5"), and `contains 1e3` checks for "1000" (false FAIL
//    against "1e3 units").
import { assertEquals } from "@std/assert";
import { cmdExpect, compareValue } from "../src/am/am-cmd-state.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";
import { freePort } from "../src/testing/server-test.ts";

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

async function expectExit(
  state: unknown,
  args: string[],
): Promise<{ code: number; out: string }> {
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const p = new URL(req.url).pathname;
      const json = (d: unknown) =>
        new Response(JSON.stringify(d), {
          headers: { "content-type": "application/json" },
        });
      if (p === "/__aio/health") return json({ status: "healthy" });
      if (p === "/__aio/trojan/state") return json(state);
      return new Response("not found", { status: 404 });
    },
  );
  const logs: string[] = [];
  const l = console.log, e = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const realExit = Deno.exit;
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    throw new ExitSignal(c ?? 0);
  };
  let code = 0;
  try {
    const flags: GlobalFlags = {
      json: true,
      port,
      app: `zz-r4-expect-${Deno.pid}`,
    };
    await cmdExpect(args, flags);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    code = err.code;
  } finally {
    Deno.exit = realExit;
    console.log = l;
    console.error = e;
    await server.shutdown();
  }
  return { code, out: logs.join("\n") };
}

Deno.test("compareValue: eq/ne on objects ignore key order", () => {
  assertEquals(
    compareValue({ a: 1, b: 2 }, "eq", { b: 2, a: 1 }, true).ok,
    true,
  );
  assertEquals(
    compareValue({ a: 1, b: 2 }, "ne", { b: 2, a: 1 }, true).ok,
    false,
  );
  assertEquals(
    compareValue([{ a: 1, b: 2 }], "contains", { b: 2, a: 1 }, true).ok,
    true,
  );
});

Deno.test("am expect: eq on a cell object with keys typed in another order PASSES", async () => {
  const r = await expectExit({ counter: { a: 1, b: 2 } }, [
    "counter",
    "eq",
    '{"b":2,"a":1}',
  ]);
  assertEquals(r.code, 0, r.out);
});

Deno.test("am expect: contains on a string looks for the TEXT typed", async () => {
  // "total: 1.5" does not contain "1.50".
  const falsePass = await expectExit({ label: "total: 1.5" }, [
    "label",
    "contains",
    "1.50",
  ]);
  assertEquals(falsePass.code, 1, `false PASS: ${falsePass.out}`);
  // "1e3 units" does contain "1e3".
  const falseFail = await expectExit({ label: "1e3 units" }, [
    "label",
    "contains",
    "1e3",
  ]);
  assertEquals(falseFail.code, 0, `false FAIL: ${falseFail.out}`);
});
