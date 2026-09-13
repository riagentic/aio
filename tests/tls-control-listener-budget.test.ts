// The TLS control listener refuses a guesser once its failure budget is spent.
//
// Under TLS a second, plain-HTTP listener on 127.0.0.1 serves the control
// plane. It learned to `recordAuthFail` for a wrong key, but never asked
// `authFailBudgetExceeded` — so the budget filled and guessing went on at full
// speed: 30 wrong keys, 30 × 401, never a 429. The main listener refuses a bad
// credential once over budget; a valid one is still served regardless.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import { loadOrCreateCert } from "../src/server/tls.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";

Deno.test("control listener (TLS): wrong keys hit 429; the right key is still served", async () => {
  _resetAuthFails();
  const dir = await Deno.makeTempDir({ prefix: "aio-ctl-budget-" });
  const cert = await loadOrCreateCert(join(dir, "tls"));
  const KEY = "k-" + crypto.randomUUID();
  const server = createServer({
    port: freePort(),
    title: "ctl",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    token: KEY,
    cert: cert.cert,
    key: cert.key,
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!server.trojanPort && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const base = `http://127.0.0.1:${server.trojanPort}`;
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const r = await fetch(`${base}/`, {
        headers: { authorization: `Bearer wrong-${i}` },
      });
      await r.body?.cancel();
      statuses.push(r.status);
    }
    assertEquals(
      statuses.includes(429),
      true,
      `15 wrong keys must reach 429 — got ${statuses.join(",")}`,
    );
    const ok = await fetch(`${base}/`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    await ok.body?.cancel();
    assertEquals(ok.status, 200, "a valid key is served regardless of budget");
  } finally {
    _resetAuthFails();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});
