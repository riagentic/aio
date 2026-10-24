// docs/testing/ui-testing.md's `testServer` example: it fetches a route the
// test declares and asserts the BODY. Its old form asserted `status === 200`
// on `/api/health` with `routes: {/* … */}` — green for a route that does not
// exist, because an unrouted path falls back to the app shell (200 HTML).
import { assertEquals, assertStringIncludes } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { cell } from "../mod.ts";

const cart = cell("routeExampleCart", { state: { n: 0 }, methods: {} });

Deno.test("testServer: the documented route example answers its route; an unrouted path is the shell", async () => {
  await using srv = await testServer({
    cells: [cart],
    routes: { "/api/health": () => Response.json({ ok: true }) },
  });
  const res = await srv.fetch("/api/health");
  assertEquals(await res.json(), { ok: true });
  const miss = await srv.fetch("/api/nothing-here");
  assertEquals(miss.status, 200);
  assertStringIncludes(miss.headers.get("content-type") ?? "", "text/html");
  await miss.body?.cancel();
});
