// `allowedOrigins` has TWO consumers, and they had drifted.
//
// The `Host` check (`hostAllowed`) trimmed and lowercased each entry and
// understood a full-origin spelling. The WebSocket `Origin` check did exact
// `Array.includes()` on the raw entries. So an entry with a capital letter, a
// stray space, a `host:port` form, or a full origin admitted the page over
// HTTP and refused its socket — the app LOADED and then could not connect,
// which reads as a network fault rather than a configuration one.
//
// It matters more than an ordinary drift because the Host refusal tells the
// operator this is "the same list the WebSocket origin check reads". That
// sentence has to be true, or the fix it suggests fixes half the problem.
//
// One decider now (`allowlistAdmits`); this states the property.
import { assertEquals } from "@std/assert";
import { allowlistAdmits, hostAllowed } from "../src/server/server-auth.ts";

import { freePort } from "../src/testing/server-test.ts";

const PORT = freePort();
/** The entry spelling under test — deliberately awkward in every way the old
 *  exact-`includes()` WS check could not survive: capitalised, padded, and
 *  written as a full origin. */
const ENTRY = "  HTTPS://App.Example.COM  ";

/** Raw WS handshake, so the Origin header can be set (the DOM WebSocket API
 *  cannot). Returns the HTTP status code of the upgrade. */
async function wsStatus(
  port: number,
  headers: Record<string, string>,
): Promise<number> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const key = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
    );
    await conn.write(
      new TextEncoder().encode([
        "GET /ws HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${key}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        "",
        "",
      ].join("\r\n")),
    );
    const buf = new Uint8Array(256);
    const n = await conn.read(buf) ?? 0;
    return Number(new TextDecoder().decode(buf.subarray(0, n)).split(" ")[1]);
  } finally {
    try {
      conn.close();
    } catch { /* already closed by the refusal */ }
  }
}

// The REAL socket, not the shared function. An earlier version of this file
// called `allowlistAdmits` directly on both sides and passed with the WS bug
// put back — it proved the decider was self-consistent, not that the WS check
// used it. That is the vacuous shape this repo gates against, so the assertion
// has to travel the handler.
Deno.test({
  name: "allowedOrigins: an awkward entry admits the page AND its socket",
  fn: async () => {
    const prev = Deno.env.get("AIO_APPS_DIR");
    const dir = await Deno.makeTempDir();
    Deno.env.set("AIO_APPS_DIR", dir);
    const { aio, cell } = await import("../mod.ts");
    const app = await aio.run({
      cells: [cell("probe", { state: { n: 0 }, methods: {} })],
      appId: `origins-parity-${Deno.pid}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      port: PORT,
      allowedOrigins: [ENTRY],
      baseDir: await Deno.makeTempDir(),
      // deno-lint-ignore no-explicit-any
    } as any);
    try {
      // HTTP admits it…
      assertEquals(
        hostAllowed("app.example.com", {
          bindHost: "127.0.0.1",
          allowedOrigins: [ENTRY],
        }),
        true,
        "the Host check must admit this deployment",
      );
      // …and so must the socket, or the app loads and then cannot connect.
      assertEquals(
        await wsStatus(PORT, { Origin: "https://app.example.com" }),
        101,
        "one config key, one meaning — the entry that admitted the page must " +
          "admit its socket",
      );
      // A foreign origin is still refused, on the same path.
      assertEquals(
        await wsStatus(PORT, { Origin: "https://evil.com" }),
        403,
        "a foreign origin must still be refused",
      );
    } finally {
      await app.close();
      if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prev);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test("allowedOrigins: a foreign origin is admitted by neither", () => {
  const entries = ["app.example.com"];
  const hostile = [
    "https://evil.com",
    "https://app.example.com.evil.com",
    "https://notapp.example.com",
  ];
  for (const origin of hostile) {
    const u = new URL(origin);
    assertEquals(
      allowlistAdmits(entries, {
        hostname: u.hostname,
        hostPort: u.host,
        origin,
      }),
      false,
      origin,
    );
    assertEquals(
      hostAllowed(u.host, { bindHost: "0.0.0.0", allowedOrigins: entries }),
      false,
      u.host,
    );
  }
});

Deno.test("allowlistAdmits: an empty or absent list admits nothing", () => {
  // The list is the only way to widen the check; a blank entry must not be a
  // wildcard by accident.
  assertEquals(
    allowlistAdmits(undefined, { hostname: "app.example.com" }),
    false,
  );
  assertEquals(allowlistAdmits([], { hostname: "app.example.com" }), false);
  assertEquals(allowlistAdmits([""], { hostname: "app.example.com" }), false);
  assertEquals(
    allowlistAdmits(["   "], { hostname: "app.example.com" }),
    false,
  );
});
