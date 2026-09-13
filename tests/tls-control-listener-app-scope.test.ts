// The TLS control listener answers AS ITS APP.
//
// Under TLS a second, plain-HTTP listener on 127.0.0.1 serves the control
// plane (`/__aio/*`). The main listener's handler was wrapped in the boot's
// AsyncLocalStorage snapshot so two apps in one process each see their own
// logger, degraded rows and diagnostics — this one was not: `Deno.serve` runs
// its handler outside the boot's context, so a `/__aio/health` asked of app A
// through A's control listener listed a tracker only app B had tripped (no
// scope reads as "every app's rows").
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "../src/server/server.ts";
import { loadOrCreateCert } from "../src/server/tls.ts";
import { runAsApp } from "../src/server/aio-cells-bridge.ts";
import {
  _resetDegraded,
  degraded,
  degradedReport,
} from "../src/diagnostics/degraded.ts";
import { freePort } from "../src/testing/server-test.ts";

Deno.test("control listener (TLS): /__aio/health lists only its own app's degraded rows", async () => {
  _resetDegraded();
  const dir = await Deno.makeTempDir({ prefix: "aio-ctl-scope-" });
  const cert = await loadOrCreateCert(join(dir, "tls"));
  const KEY = "k-" + crypto.randomUUID();
  // One boot per app, each in its own app scope — as `aio.run` does.
  const bootApp = (name: string) =>
    runAsApp(() => ({
      server: createServer({
        port: freePort(),
        title: name,
        getUIState: () => ({}),
        dispatch: () => {},
        baseDir: dir,
        debug: () => {},
        prod: true,
        distDir: join(dir, "dist"),
        token: KEY,
        cert: cert.cert,
        key: cert.key,
        getHealth: () => ({ status: "healthy", degraded: degradedReport() }),
      }),
      asApp: AsyncLocalStorage.snapshot(),
    }));
  const A = bootApp("A");
  const B = bootApp("B");
  try {
    // B's code trips a tracker; A's never does.
    B.asApp(() => {
      for (let i = 0; i < 10; i++) degraded("b-only:op").fail("B broke");
    });
    const deadline = Date.now() + 5_000;
    while (
      (!A.server.trojanPort || !B.server.trojanPort) && Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const health = async (port: number | undefined) => {
      const r = await fetch(`http://127.0.0.1:${port}/__aio/health`, {
        headers: { authorization: `Bearer ${KEY}` },
      });
      assertEquals(r.status, 200);
      return await r.json() as { degraded: { name: string }[] };
    };
    const hb = await health(B.server.trojanPort);
    assertEquals(
      hb.degraded.map((d) => d.name),
      ["b-only:op"],
      "B's own row is on B",
    );
    const ha = await health(A.server.trojanPort);
    assert(
      !JSON.stringify(ha.degraded).includes("b-only:op"),
      `A's control listener listed B's tracker: ${JSON.stringify(ha)}`,
    );
  } finally {
    _resetDegraded();
    await A.server.shutdown();
    await B.server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});
