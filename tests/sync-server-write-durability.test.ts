// Server-origin writes to sync cells must survive a restart.
//
// Sync cells are excluded from KV persistence; only the op-log + compaction
// snapshot are replayed at boot. Client ops land in the op-log — but a
// SERVER-ORIGIN write (an effect, cron, `serverFn`, a plain server-side method
// call, or an async method's `__set` outcome) landed nowhere: it was broadcast
// live, looked committed, and silently vanished on the next restart unless a
// compaction happened to run afterwards. Now every non-op commit to a sync
// cell folds current state into the cell's sync snapshot (debounced 100ms;
// flushed on clean shutdown), so "the server said it was saved" is true.
import { assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

async function bootApp(dir: string) {
  const { cell, aio } = await import("../mod.ts");
  const notes = cell("swd-notes", {
    state: { items: [] as string[], fetched: "" },
    sync: true,
    methods: {
      add(s: { items: string[] }, v: string) {
        s.items.push(v);
      },
      async refresh(s: { fetched: string }, v: string) {
        await new Promise((r) => setTimeout(r, 1));
        s.fetched = v; // commits as a __set batch — must be durable too
      },
    },
  });
  const app = await aio.run({
    cells: [notes],
    appId: "swd-app",
    client: "server-only",
    persist: true,
    libraryMode: true,
    port: freePort(),
    appDir: dir,
  });
  return { app, notes };
}

Deno.test({
  name: "sync cells: server-origin writes survive a restart (shutdown flush)",
  async fn() {
    const dir = await Deno.makeTempDir();

    // Boot 1 — plain server-side sync-method call AND an async method's
    // outcome, then close IMMEDIATELY: the shutdown flush must fold both,
    // with no reliance on the debounce timer having fired.
    {
      const { app, notes } = await bootApp(dir);
      try {
        (notes as Any).add("from-server");
        await (notes as Any).refresh("fetched-value");
      } finally {
        await app.close();
      }
    }

    // The data actually lives under the CONFIGURED appDir. This pinned a
    // shipped bug: the config bridge dropped `appDir`, so logs went to the
    // configured directory while all data silently went to the default one.
    await Deno.stat(`${dir}/data/state.db`);

    // Boot 2 — the writes must be there, restored from the sync snapshot.
    {
      const { app } = await bootApp(dir);
      try {
        const s = app.getState() as Record<
          string,
          { items: string[]; fetched: string }
        >;
        assertEquals(
          s["swd-notes"]!.items,
          ["from-server"],
          "the server-origin sync-method write survived the restart",
        );
        assertEquals(
          s["swd-notes"]!.fetched,
          "fetched-value",
          "the async method's __set outcome survived the restart",
        );
      } finally {
        await app.close();
      }
    }
  },
});
