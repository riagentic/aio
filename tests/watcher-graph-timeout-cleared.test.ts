// The dev watcher races the root's graph check against a timeout (2 s by
// default), and the check almost always wins. The timeout's timer was never
// cleared, so every save of the root component left a 2 s timer armed after
// its reload had long been broadcast. Measured: the work was done at 126 ms
// and the process could not unload until 2106 ms — and with the budget set to
// 3777 ms, unload moved to 3882 ms, which names the timer. Under the leak
// sanitizer this test ends right after the broadcast, so a still-armed loser
// fails it.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createFileWatcher } from "../src/server/server-watcher.ts";
import { stopEsbuild } from "../src/server/server-transpile.ts";

Deno.test({
  name:
    "watcher: the graph-check timeout is cleared once the check wins the race",
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "aio-watch-race-" });
    const entry = join(tmp, "App.tsx");
    await Deno.writeTextFile(entry, "export default () => <div>hi</div>;\n");
    const sent: string[] = [];
    const watcher = createFileWatcher({
      absBaseDir: tmp,
      importMapObj: {},
      debug: () => {},
      broadcastWs: (m) => sent.push(m),
      // Far past anything a two-line graph needs, and far past the test: a
      // loser left armed cannot fire and complete before the sanitizer looks.
      graphTimeoutMs: 60_000,
    });
    try {
      await Deno.writeTextFile(entry, "export default () => <div>hi2</div>;\n");
      watcher.scheduleReload(entry);
      const t0 = Date.now();
      while (sent.length === 0 && Date.now() - t0 < 10_000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assertEquals(sent.length, 1, "the reload is broadcast");
    } finally {
      watcher.shutdown();
      await stopEsbuild();
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  },
});
