// A call still running at shutdown's drain deadline. A worker cell's caller
// is rejected when its worker closes; an in-isolate cell's caller used to
// stay pending until the method ended — or its 30 s ceiling — and the
// deadline warning said only "1 call still running", never which. Now both
// runtimes answer the caller at the deadline (DISPATCH_CLOSED, the worker's
// code) and the warning names the method.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";

const stubborn = cell("stuckShutdown", {
  state: { n: 0 },
  methods: {
    // Ignores its abort signal: runs well past the 3 s drain deadline.
    async hold(s) {
      await new Promise((r) => setTimeout(r, 4500));
      s.n += 1;
    },
  },
});
const S = stubborn as unknown as { hold(): Promise<void> };

Deno.test({
  name:
    "shutdown: a call still running at the drain deadline is rejected, and the warning names it",
  // aio-ok: the stuck method's own wait never ends by design — it is what close() must reject
  sanitizeOps: false,
  async fn() {
    const warns: string[] = [];
    setLogger(
      {
        pub: (lvl: string, _cat: string, msg: string) => {
          if (lvl === "warn" && msg.includes("still running")) warns.push(msg);
        },
      } as unknown as LogSink,
    );
    try {
      const srv = await testServer({ cells: [stubborn] });
      const call = S.hold();
      let settledAt = 0;
      const outcome = call.then(
        () => "resolved",
        (e: Error & { code?: string }) => `${e.code}: ${e.message}`,
      ).finally(() => settledAt = Date.now());
      await new Promise((r) => setTimeout(r, 50));
      const t0 = Date.now();
      await srv.close();
      const closedAt = Date.now();
      const out = await outcome;
      assert(out.startsWith("DISPATCH_CLOSED"), out);
      assertStringIncludes(out, "stuckShutdown:hold");
      assert(settledAt <= closedAt, "the caller is answered by close()");
      assert(closedAt - t0 < 4000, `close took ${closedAt - t0}ms`);
      assertEquals(warns.length, 1, warns.join("\n"));
      assertStringIncludes(warns[0]!, "stuckShutdown:hold");
    } finally {
      setLogger(null);
    }
    // Let the abandoned method body finish before the next test file.
    await new Promise((r) => setTimeout(r, 4600));
  },
});
