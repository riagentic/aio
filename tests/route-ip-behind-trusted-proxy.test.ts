// Behind a trusted reverse proxy (`trustProxyHeader`), a WS call's
// `serverRequest().ip` was the forwarded CLIENT address, but an HTTP route's
// `ctx.ip` / `serverRequest().ip` was the TCP peer — the PROXY. The docs name
// that value as "the rate-limit key the client can't set", so every client of
// a proxied app collapsed into one bucket in route handlers.
import { assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("route ctx.ip and serverRequest().ip read the trusted proxy hop", async () => {
  const { cell, aio, route, serverRequest } = await import("../mod.ts");
  const port = freePort();
  const dir = await tempDir("aio-route-ip-");
  const app = await aio.run({
    cells: [cell("rip", { state: { n: 0 } })],
    appId: `test-route-ip-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: dir,
    trustProxyHeader: "x-forwarded-for",
    routes: {
      "/api/ip": route((ctx) =>
        ctx.json({ ctx: ctx.ip, ambient: serverRequest()?.ip })
      ),
    },
  });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ip`, {
      headers: { "x-forwarded-for": "198.51.100.9, 203.0.113.7" },
    });
    assertEquals(r.status, 200);
    assertEquals(await r.json(), {
      ctx: "203.0.113.7",
      ambient: "203.0.113.7",
    });
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
});
