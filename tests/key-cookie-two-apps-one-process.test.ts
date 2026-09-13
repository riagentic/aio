// Each keyed server names its key cookie after ITSELF, even beside another.
//
// `keyCookieHeader` read the cookie name from a module-level appId that
// `createServer` overwrote — so with two apps in one process (a test run, a
// multi-app host) the one booted FIRST handed out the cookie named for the one
// booted LAST. It never reads that name back, so the browser's follow-up
// asset requests 401'd: the exact failure the key cookie exists to fix.
import { assert } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";

async function keyed(appId: string) {
  const baseDir = await Deno.makeTempDir({ prefix: "aio-kc2-" });
  const srv = await testServer({
    appId,
    cells: [cell(`c_${appId}`, { state: { n: 0 }, methods: {} })],
    expose: true,
    key: "secret-key-123",
    baseDir,
  } as never);
  const cert = await Deno.readTextFile(
    join(baseDir, ".aio", "data", "tls", "tls-cert.pem"),
  );
  const client = Deno.createHttpClient({ caCerts: [cert] });
  return {
    get: async (path: string, headers: Record<string, string> = {}) => {
      const r = await fetch(
        `https://127.0.0.1:${srv.port}${path}`,
        { headers, client } as RequestInit & { client: Deno.HttpClient },
      );
      await r.body?.cancel();
      return r;
    },
    close: async () => {
      client.close();
      await srv.close();
      await Deno.remove(baseDir, { recursive: true }).catch(() => {});
    },
  };
}

Deno.test("key cookie: the first of two servers in one process names it after itself", async () => {
  _resetAuthFails();
  const a = await keyed("kc2-first");
  const b = await keyed("kc2-second");
  try {
    const shell = await a.get("/?token=secret-key-123");
    const set = shell.headers.get("set-cookie") ?? "";
    assert(set.startsWith("aio_key_kc2-first="), `A handed out: ${set}`);
    // …and that cookie authenticates A's own follow-up request.
    const cookie = set.split(";")[0]!;
    const health = await a.get("/__aio/health", { cookie });
    assert(health.status === 200, `A's own cookie → ${health.status}`);
  } finally {
    await b.close();
    await a.close();
    _resetAuthFails();
  }
});
