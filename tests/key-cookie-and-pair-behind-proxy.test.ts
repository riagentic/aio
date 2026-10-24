// Shared-key mode behind a trusted TLS proxy, and the pairing reply.
//
// • The `?token=` → key cookie was marked `Secure` from the request URL only,
//   and behind a TLS-terminating proxy that URL is http — so the app key rode
//   a non-Secure cookie. With `trustProxyHeader` set, the proxy's
//   `X-Forwarded-Proto: https` now marks it Secure (`servedOverHttps`, the
//   rule the session cookie follows); without the setting the header is not
//   read.
// • `POST /__aio/pair` answers with the app KEY in its body and carried no
//   `Cache-Control` (plus an ETag). It now says `no-store`, like every
//   identity-bearing auth response.
import { assert, assertEquals, assertFalse } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { currentPin } from "../src/server/pairing.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const KEY = "k3y-0123456789abcdefghijklmnop";

async function keyed(trust: boolean) {
  const dir = await tempDir("aio-key-proxy-");
  const port = freePort();
  const app = await aio.run({
    ...(trust ? { trustProxyHeader: "x-forwarded-for" } : {}),
    cells: [
      cell(`keyproxy_${trust}`, { state: {}, visible: "all", methods: {} }),
    ],
    appId: `test-key-proxy-${crypto.randomUUID().slice(0, 8)}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    baseDir: dir,
    watch: false,
    port,
    expose: true,
    host: "127.0.0.1",
    tls: false,
    key: KEY,
  });
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await app.close();
      await dropTempDir(dir);
    },
  };
}

const keyCookie = async (base: string) => {
  const r = await fetch(`${base}/?token=${KEY}`, {
    headers: { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" },
  });
  await r.body?.cancel();
  return r.headers.getSetCookie().find((c) => c.startsWith("aio_key_")) ?? "";
};

Deno.test("key cookie: Secure behind a trusted TLS proxy, not otherwise", async () => {
  const trusted = await keyed(true);
  try {
    const c = await keyCookie(trusted.base);
    assert(/;\s*Secure/.test(c), `trusted proxy: ${c.replace(KEY, "<KEY>")}`);
  } finally {
    await trusted.close();
  }
  const direct = await keyed(false);
  try {
    const c = await keyCookie(direct.base);
    assert(c.length > 0, "the cookie is still set");
    assertFalse(/Secure/.test(c), "X-Forwarded-Proto unread without trust");
  } finally {
    await direct.close();
  }
});

Deno.test("pairing reply (carries the app key) is no-store", async () => {
  const s = await keyed(false);
  try {
    const r = await fetch(`${s.base}/__aio/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: currentPin(KEY) }),
    });
    const body = await r.json();
    assertEquals(r.status, 200);
    assertEquals(body.key, KEY, "control: this is the reply with the key");
    assertEquals(r.headers.get("cache-control"), "no-store");
  } finally {
    await s.close();
  }
});
