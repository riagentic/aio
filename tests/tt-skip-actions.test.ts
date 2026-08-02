// diagnostics.skipActions — a high-frequency action (a 60 fps game:tick) must
// be keepable OUT of the time-travel window, or the window holds seconds of
// noise instead of a session (a field report).
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dec } from "../src/protocol/envelope.ts";

Deno.test({
  name: "diagnostics.skipActions keeps an action type out of TT history",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const c = cell("loopy", {
      state: { n: 0, hits: 0 },
      methods: {
        tick(s: { n: number }) {
          s.n++;
        },
        score(s: { hits: number }) {
          s.hits++;
        },
      },
    });
    await using srv = await testServer({
      cells: [c],
      diagnostics: { dev: { skipActions: ["loopy:tick"] } },
      // deno-lint-ignore no-explicit-any
    } as any);

    // Collect tt-state broadcasts over a real WS.
    const ws = new WebSocket(srv.url.replace("http", "ws") + "/ws");
    const tt: { v: { entries: { type: string }[] } | null } = { v: null };
    ws.onmessage = (e) => {
      const f = dec(String(e.data));
      if (f?.t === "tt-state") {
        tt.v = f.d as { entries: { type: string }[] };
      }
    };
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = (e) => rej(e);
    });
    try {
      // Dispatch both action types through the real pipeline.
      // deno-lint-ignore no-explicit-any
      (c as any).tick();
      // deno-lint-ignore no-explicit-any
      (c as any).tick();
      // deno-lint-ignore no-explicit-any
      (c as any).score();
      // Wait for a tt broadcast that includes the score action.
      for (let i = 0; i < 100; i++) {
        if (tt.v?.entries.some((e) => e.type === "loopy:score")) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert(tt.v, "no tt-state broadcast arrived");
      const types = tt.v.entries.map((e) => e.type);
      assert(types.includes("loopy:score"), `score recorded: ${types}`);
      assertEquals(
        types.filter((t) => t === "loopy:tick").length,
        0,
        `skipActions kept tick out of history: ${types}`,
      );
    } finally {
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    }
  },
});
