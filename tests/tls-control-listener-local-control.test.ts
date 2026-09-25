// The TLS control listener honours the machine owner's control credential.
//
// Under TLS the trojan is served by a second, plain-HTTP listener on
// 127.0.0.1, and `am` talks to THAT port (`trojanPort`) — presenting the
// per-boot `<data>/control.key` in `X-Aio-Control`, which is how it inspects a
// per-user app it has no account on. The main listener accepts that
// credential for `/__aio/trojan/*`; the control listener never consulted it,
// so on every exposed (TLS) per-user app `am state` / amui answered 401 — the
// exact lock-out the credential was minted to end.
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import { loadOrCreateCert } from "../src/server/tls.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { readControlKey } from "../src/server/app-key.ts";
import { freePort } from "../src/testing/server-test.ts";

Deno.test("control listener (TLS): the local control credential opens the trojan on a per-user app", async () => {
  _resetAuthFails();
  const dir = await tempDir("aio-ctl-local-");
  const cert = await loadOrCreateCert(join(dir, "tls"));
  const appId = `ctl-local-${crypto.randomUUID().slice(0, 8)}`;
  const server = createServer({
    port: freePort(),
    title: "ctl",
    appId,
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: false,
    users: { "user-tok": { id: "u", role: "user" } },
    cert: cert.cert,
    key: cert.key,
    trojan: {
      getState: () => ({ c: { n: 7 } }),
      getSchedules: () => [],
      startedAt: Date.now(),
    },
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!server.trojanPort && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const ck = readControlKey(appId);
    assertEquals(ck.error, undefined, "the dev server mints a control key");
    const base = `http://127.0.0.1:${server.trojanPort}`;
    const ok = await fetch(`${base}/__aio/trojan/state`, {
      headers: { "x-aio-control": ck.key! },
    });
    const body = await ok.text();
    assertEquals(ok.status, 200, `control credential refused: ${body}`);
    assertEquals(JSON.parse(body), { c: { n: 7 } });
    // …and it opens the trojan ONLY: the same header is no identity anywhere
    // else on this listener.
    const snap = await fetch(`${base}/__aio/snapshot`, {
      headers: { "x-aio-control": ck.key! },
    });
    await snap.body?.cancel();
    assertEquals(snap.status, 401, "the control key is not an app identity");
    // A wrong control key is still refused.
    const bad = await fetch(`${base}/__aio/trojan/state`, {
      headers: { "x-aio-control": "nope" },
    });
    await bad.body?.cancel();
    assertEquals(bad.status, 401);
  } finally {
    _resetAuthFails();
    await server.shutdown();
    await dropTempDir(dir);
  }
});
