// A server with vitals off still answers `vitals-ping`. The page's
// silent-socket watchdog judges a connection by the server's pongs: a page
// that had talked to a vitals server, reconnected to the same build restarted
// with `diagnostics: { vitals: false }`, heard no pong — and could not tell
// "vitals off" from "network gone". The bare pong (no loop health) is the
// answer to "does this server speak?".
import { assert, assertEquals } from "@std/assert";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("vitals off: a ping is still answered with a pong", async () => {
  const { aio, cell } = await import("../mod.ts");
  const dir = await tempDir("aio-vitals-off-pong-");
  const port = freePort();
  const app = await aio.run({
    watch: false,
    cells: [cell("vopCell", { state: { n: 0 }, methods: {} })],
    appId: "vitals-off-pong",
    appDir: dir,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    persist: false,
    port,
    diagnostics: false,
    // deno-lint-ignore no-explicit-any
  } as any);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    const pong = new Promise<Record<string, unknown>>((resolve) => {
      ws.onmessage = (e) => {
        const f = dec(String(e.data));
        if (f?.t === "vitals-pong") resolve(f.d as Record<string, unknown>);
      };
    });
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    ws.send(enc("vitals-ping", { t1: 12345, ms: 0 }));
    let t: ReturnType<typeof setTimeout> | undefined;
    const d = await Promise.race([
      pong,
      new Promise<null>((r) => t = setTimeout(() => r(null), 3000)),
    ]).finally(() => clearTimeout(t));
    assert(d !== null, "no pong from a vitals-off server");
    assertEquals(d.t1, 12345);
    assertEquals(typeof d.t2, "number");
  } finally {
    ws.close();
    await app.close();
    await dropTempDir(dir);
  }
});
