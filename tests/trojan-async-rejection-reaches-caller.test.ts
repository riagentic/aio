// The operator's door answers for the METHOD. An async method that throws
// after its first `await` used to be logged as EFFECT_ASYNC_ERROR while the
// trojan dispatch route (and so `am dispatch`) had already answered
// {"ok":true}. Proven over a real server, not a mocked dispatch.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

const jobs = cell("jobs", {
  state: { n: 0 },
  methods: {
    async failLate(s) {
      s.n = 1;
      await new Promise((r) => setTimeout(r, 5));
      throw new Error("the disk said no");
    },
  },
});

Deno.test("trojan dispatch: a post-await throw is the route's answer, not a log line", async () => {
  const server = await testServer({ cells: [jobs], persist: false });
  try {
    const resp = await fetch(`${server.url}/__aio/trojan/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({ type: "jobs:failLate" }),
    });
    const body = await resp.json();
    assertEquals(body.ok, undefined, `answered ${JSON.stringify(body)}`);
    assertStringIncludes(String(body.error), "the disk said no");
  } finally {
    await server.close();
  }
});
