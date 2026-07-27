// risoto 2026-07-27: a dispatch that changes NOTHING used to trigger a
// FULL-STATE broadcast. The full-state branch is the fallback when there are
// no patches to send — and with any ticking field (a clock cell) the
// "unchanged since last full send" guard never holds, so every idempotent
// poll cost a complete state frame. Measured: 438 KB every ~2s, 12 MB in 20
// seconds, on state that had not meaningfully changed.
//
// Writing reducers that skip pointless writes is exactly what an app SHOULD
// do; the framework must not punish it.
import { assert, assertEquals } from "@std/assert";
import { aio } from "../mod.ts";
import { cell } from "../src/state/cell.ts";

Deno.test("a dispatch with no patches broadcasts nothing", async () => {
  const ticker = cell("ticker", {
    state: { now: 0, flag: false },
    methods: {
      tick(s) {
        s.now = s.now + 1;
      },
      // Idempotent: writes only when the value actually differs.
      setFlag(s, v: boolean) {
        if (s.flag !== v) s.flag = v;
      },
    },
    persist: "none",
    ui: "all",
  });

  const sent: string[] = [];
  const app = await aio.run({
    appId: `noop-broadcast-${Math.floor(performance.now())}`,
    cells: [ticker],
    libraryMode: true,
    persist: false,
    client: "server-only",
  });
  try {
    // Stand in for the broadcaster: count what WOULD go out.
    const server = (app as unknown as {
      _server?: { broadcast: (p?: unknown) => void };
    })._server;
    if (server) {
      const original = server.broadcast.bind(server);
      server.broadcast = (p?: unknown) => {
        sent.push(p === undefined ? "FULL" : "PATCHES");
        original(p);
      };
    }

    ticker.tick(); // a real change → a patch broadcast
    ticker.setFlag(false); // NO change → nothing at all
    ticker.setFlag(false);
    await new Promise((r) => setTimeout(r, 50));

    assertEquals(ticker.now, 1);
    assertEquals(ticker.flag, false);
    if (server) {
      assert(!sent.includes("FULL"), `no full-state fallback, got ${sent}`);
      assertEquals(sent.length, 1, "one broadcast for the one real change");
    }
  } finally {
    await app.close();
  }
});
