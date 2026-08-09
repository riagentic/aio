// Shared-key mode can serve a BROWSER.
//
// The shell loaded with `?token=…`, and then the page requested `/App.tsx` and
// `/bundle.js` with no query and no Authorization header — nothing carried the
// credential, so every asset 401'd and the shell rendered nothing. Key mode was
// native-clients-only by accident, and `key:` + `auth:` were refused together,
// so an app that wanted a browser had no shared-key option at all.
//
// The fix hands the browser the credential on the ONE request that proved it
// has the key. What that cookie may and may not do is the substance here, so
// each property is its own test.
import { assert, assertEquals } from "@std/assert";
import { keyCookieHeader, keyCookieNameFor } from "../src/server/server.ts";
import { testServer } from "../src/cell-test.ts";
import { cell } from "../mod.ts";
import { join } from "@std/path";

Deno.test("key cookie: named per app — cookies ignore the port", () => {
  // Two aio apps on one host share a cookie jar. A single `aio_key` would have
  // them overwriting each other's credential, each 401-ing on the other's.
  assertEquals(keyCookieNameFor("wallet"), "aio_key_wallet");
  assertEquals(keyCookieNameFor("My App"), "aio_key_my-app");
  assertEquals(keyCookieNameFor(undefined), "aio_key_app");
  assert(keyCookieNameFor("a") !== keyCookieNameFor("b"));
});

Deno.test("key cookie: HttpOnly + SameSite=Strict, always", () => {
  const c = keyCookieHeader(new URL("http://localhost:8000/?token=x"), "sec");
  // HttpOnly — script cannot read it. Strictly better than the `?token=` URL it
  // replaces, which leaks to history, referrers and proxy logs.
  assert(c.includes("HttpOnly"), c);
  // SameSite=Strict — never sent cross-site. This is what stops ambient cookie
  // authority from becoming CSRF.
  assert(c.includes("SameSite=Strict"), c);
  assert(c.includes("Path=/"), c);
  // Session-scoped: a shared key is not something to leave on disk after the
  // window closes.
  assert(!c.includes("Max-Age"), c);
});

Deno.test("key cookie: Secure exactly when the page is https", () => {
  // Taken from the REQUEST, not from config: a server behind a TLS-terminating
  // proxy sees http, and marking that cookie Secure would silently break it.
  const plain = keyCookieHeader(new URL("http://box:8000/"), "sec");
  const tls = keyCookieHeader(new URL("https://box:8000/"), "sec");
  assert(!plain.includes("Secure"), plain);
  assert(tls.includes("; Secure"), tls);
});

Deno.test("key cookie: the value is the key, encoded", () => {
  const c = keyCookieHeader(new URL("http://b/"), "a b;c=d");
  assert(c.startsWith("aio_key_app=a%20b%3Bc%3Dd;"), c);
  // A raw `;` or `=` in the value would truncate the cookie or forge an
  // attribute — the one parsing bug that turns a credential into a footgun.
  assert(!c.slice(0, c.indexOf(";")).includes(" "), c);
});

// ── The behaviour, against a real keyed server ───────────────────────────────
//
// `expose: true` always brings TLS (there is no config switch for that — only a
// CLI flag), so these speak https and pin the app's own self-signed cert. That
// is what a browser does too, once the user has accepted it.

const cellFor = (id: string) =>
  cell(id, {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });

type Keyed = {
  base: string;
  client: Deno.HttpClient;
  close: () => Promise<void>;
};

async function keyedServer(appId: string): Promise<Keyed> {
  const baseDir = await Deno.makeTempDir({ prefix: "aio-skb-" });
  const srv = await testServer({
    appId,
    cells: [cellFor(appId)],
    expose: true,
    key: "secret-key-123",
    baseDir,
  } as never);
  const cert = await Deno.readTextFile(
    join(baseDir, ".aio", "data", "tls", "tls-cert.pem"),
  );
  const client = Deno.createHttpClient({ caCerts: [cert] });
  return {
    base: `https://127.0.0.1:${srv.port}`,
    client,
    close: async () => {
      client.close();
      await srv.close();
      await Deno.remove(baseDir, { recursive: true }).catch(() => {});
    },
  };
}

/** fetch through the pinned client, body always drained. */
async function get(
  k: Keyed,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const r = await fetch(
    `${k.base}${path}`,
    { headers, client: k.client } as
      & RequestInit
      & { client: Deno.HttpClient },
  );
  await r.body?.cancel();
  return r;
}

Deno.test("shared key: the shell hands the browser a cookie, and assets then load", async () => {
  const k = await keyedServer("skb-one");
  try {
    // 1. The browser opens the share link.
    const shell = await get(k, "/?token=secret-key-123");
    assertEquals(shell.status, 200, "the shell itself was always fine");
    const setCookie = shell.headers.get("set-cookie");
    assert(
      setCookie?.includes("aio_key_skb-one="),
      `no key cookie on the shell: ${setCookie}`,
    );

    // 2. …then it asks for an asset the way a browser does: no query, no header.
    assertEquals(
      (await get(k, "/App.tsx")).status,
      401,
      "no credential means no asset — unchanged",
    );

    // 3. With the cookie it was just handed, the asset loads. This is the whole
    //    fix: before it, shared-key mode could not serve a browser at all.
    const cookie = setCookie!.split(";")[0]!;
    const ok = await get(k, "/App.tsx", { cookie });
    assert(
      ok.status !== 401,
      `the asset must load for a browser holding the cookie (got ${ok.status})`,
    );
  } finally {
    await k.close();
  }
});

Deno.test("shared key: a WRONG cookie is refused like any wrong credential", async () => {
  const k = await keyedServer("skb-two");
  try {
    const r = await get(k, "/App.tsx", {
      cookie: "aio_key_skb-two=not-the-key",
    });
    assertEquals(r.status, 401);
  } finally {
    await k.close();
  }
});

Deno.test("shared key: another app's cookie is not this app's credential", async () => {
  // The per-app name is what makes this true; one shared `aio_key` would have
  // each app's browser silently authenticated against the other.
  const k = await keyedServer("skb-three");
  try {
    const r = await get(k, "/App.tsx", {
      cookie: "aio_key_other=secret-key-123",
    });
    assertEquals(r.status, 401);
  } finally {
    await k.close();
  }
});

Deno.test("shared key: the cookie is issued once, not on every request", async () => {
  // Re-sending a credential the client already stored is noise at best.
  const k = await keyedServer("skb-four");
  try {
    const first = await get(k, "/?token=secret-key-123");
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    const second = await get(k, "/", { cookie });
    assertEquals(
      second.headers.get("set-cookie"),
      null,
      "a request already carrying the cookie is not re-issued one",
    );
  } finally {
    await k.close();
  }
});
