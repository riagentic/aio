// The big-cell warning's latch is per APP (server-broadcast.ts
// `warnBigFullState`'s `owner`): in one process (library mode, testApps) app
// A's warning about its `catalog` must not silence app B's about a different
// `catalog`. The WS broadcaster passed its app's `getUIState` as the owner;
// the UDS snapshot passed nothing, so on the desktop transport every app in
// the process shared ONE latch and the second app's oversized cell was never
// named.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createUDSListener } from "../src/server/aio.ts";
import {
  _resetBigStateWarnings,
  BROADCAST_FULL_WARN_BYTES,
} from "../src/server/server-broadcast.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";

Deno.test({
  name: "uds: two apps in one process each get their own big-cell warning",
  sanitizeResources: false, // aio-ok: both probe conns are closed below
  sanitizeOps: false, // aio-ok: as above
  async fn() {
    _resetBigStateWarnings();
    const dir = await Deno.makeTempDir({ prefix: "aio-bigstate-apps-" });
    const rows = "x".repeat(BROADCAST_FULL_WARN_BYTES + 1024);
    const listen = (name: string) =>
      createUDSListener(
        join(dir, `${name}.sock`),
        () => ({ catalog: { rows } }),
        () => {},
        () => {},
      );
    const a = listen("a");
    const b = listen("b");
    const conns: Deno.Conn[] = [];
    const seen: string[] = [];
    const prev = getLogger();
    setLogger({
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn" && msg.includes("full-state frame")) seen.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
    } as unknown as LogSink);
    try {
      for (const name of ["a", "b"]) {
        conns.push(
          await Deno.connect({
            path: join(dir, `${name}.sock`),
            transport: "unix",
          }),
        );
        await new Promise((r) => setTimeout(r, 80));
      }
      assert(
        seen.every((w) => w.includes('"catalog"')),
        JSON.stringify(seen),
      );
      assertEquals(
        seen.length,
        2,
        `app B's oversized cell must be named even though app A's was: ${
          JSON.stringify(seen)
        }`,
      );
    } finally {
      setLogger(prev);
      for (const c of conns) {
        try {
          c.close();
        } catch { /* already gone */ }
      }
      a.shutdown();
      b.shutdown();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      _resetBigStateWarnings();
    }
  },
});
