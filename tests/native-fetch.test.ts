// `nativeFetch()` — `fetch` sent by the app, not the WebView, in a standalone
// Android APK.
//
// Field report (a crypto wallet app): a public JSON-RPC answers 403 to ANY
// request that carries an `Origin`. A standalone APK runs every fetch inside
// its WebView, so every read failed, and the app had to fork MainActivity.kt
// to add its own native HTTP bridge. The APK now ships one (`AioNativeFetch`,
// through `addWebMessageListener`), and `nativeFetch` is its page half.
//
// This file pins the page half against a stand-in bridge that answers the way
// the Kotlin one does, plus the Kotlin half's security rules as text. The run
// on a real APK — a server that 403s any Origin, reached through nativeFetch
// and refused to plain fetch — is the "native fetch" step of
// tests/android-emulator-e2e.test.ts (`deno task test:android`).
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { fromFileUrl } from "@std/path";
import { nativeFetch } from "../src/browser/native-fetch.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";

const KOTLIN = ANDROID_TEMPLATE["app/src/main/java/aio/app/MainActivity.kt"] ??
  "";
const G = globalThis as Record<string, unknown>;

/** A server that refuses any request carrying an Origin, like the API in the
 *  report, and echoes what it got otherwise. */
function originRefusingServer() {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (req) => {
      if (req.headers.has("origin")) {
        return new Response("origin refused", { status: 403 });
      }
      if (req.method === "PUT") return new Response(await req.arrayBuffer());
      return Response.json({
        method: req.method,
        type: req.headers.get("content-type"),
        body: await req.text(),
      }, { headers: { "x-echo": "1", "set-cookie": "s=1" } });
    },
  );
  return { server, url: `http://127.0.0.1:${server.addr.port}/rpc` };
}

type Msg = {
  id: number;
  url: string;
  method: string;
  headers: [string, string][];
  body: string | null;
};

/** A stand-in for the Kotlin bridge: performs each request itself (Deno sends
 *  no Origin, as HttpURLConnection does not) and answers in the same JSON. */
function fakeBridge(
  answer?: (m: Msg) => Record<string, unknown> | null,
) {
  const sent: Msg[] = [];
  let onMessage: ((e: { data: unknown }) => void) | null = null;
  const reply = (r: Record<string, unknown>) =>
    setTimeout(() => onMessage?.({ data: JSON.stringify(r) }), 0);
  const bridge = {
    sent,
    addEventListener(_t: string, f: (e: { data: unknown }) => void) {
      onMessage = f;
    },
    postMessage(raw: string) {
      const m = JSON.parse(raw) as Msg;
      sent.push(m);
      const custom = answer?.(m);
      if (custom === null) return; // never answers
      if (custom) return reply({ id: m.id, ...custom });
      void (async () => {
        const res = await fetch(m.url, {
          method: m.method,
          headers: m.headers,
          body: m.body === null
            ? undefined
            : Uint8Array.from(atob(m.body), (c) => c.charCodeAt(0)),
        });
        const bytes = new Uint8Array(await res.arrayBuffer());
        reply({
          id: m.id,
          status: res.status,
          statusText: res.statusText,
          headers: [...res.headers].filter(([k]) => k !== "set-cookie"),
          body: btoa(String.fromCharCode(...bytes)),
        });
      })();
    },
  };
  return bridge;
}

async function withGlobals(
  globals: Record<string, unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  Object.assign(G, globals);
  try {
    await fn();
  } finally {
    for (const k of Object.keys(globals)) delete G[k];
  }
}

Deno.test("nativeFetch: no bridge (server, desktop, browser) — it is plain fetch", async () => {
  const { server, url } = originRefusingServer();
  try {
    const r = await nativeFetch(url, { method: "POST", body: "hi" });
    assertEquals(r.status, 200);
    assertEquals((await r.json()).body, "hi");
  } finally {
    await server.shutdown();
  }
});

Deno.test("nativeFetch: in a standalone APK the request goes through the bridge, not the page's fetch", async () => {
  const { server, url } = originRefusingServer();
  const bridge = fakeBridge();
  const realFetch = globalThis.fetch;
  let pageFetches = 0;
  globalThis.fetch = (...a: Parameters<typeof fetch>) => {
    pageFetches++;
    return realFetch(...a);
  };
  try {
    await withGlobals(
      { AioNativeFetch: bridge, AioNativeStore: {} },
      async () => {
        const r = await nativeFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
        });
        assertEquals(r.status, 200);
        assertEquals(r.headers.get("x-echo"), "1");
        assertEquals(r.headers.get("set-cookie"), null);
        assertEquals(await r.json(), {
          method: "POST",
          type: "application/json",
          body: '{"jsonrpc":"2.0","method":"ping"}',
        });
        // A binary body survives both ways, and two requests in flight are
        // matched to their own answers.
        const bytes = new Uint8Array(256).map((_, i) => i);
        const [a, b] = await Promise.all([
          nativeFetch(url, { method: "PUT", body: bytes }),
          nativeFetch(new Request(url, { method: "DELETE" })),
        ]);
        assertEquals(new Uint8Array(await a.arrayBuffer()), bytes);
        assertEquals((await b.json()).method, "DELETE");
      },
    );
    assertEquals(bridge.sent.length, 3);
    assertEquals(bridge.sent[0]!.method, "POST");
    assertEquals(bridge.sent.find((m) => m.method === "DELETE")!.body, null);
    assertEquals(pageFetches - 3, 0, "the bridge's own fetches only");
  } finally {
    globalThis.fetch = realFetch;
    await server.shutdown();
  }
});

Deno.test("nativeFetch: a WebView whose Request has no .body (older than ~M105) still sends the body", async () => {
  // The bridge runs on ~M82+, `Request.body` arrived in ~M105: there a body
  // was judged by `req.body` (undefined) and every POST/PUT went out empty.
  const RealRequest = globalThis.Request;
  globalThis.Request = class extends RealRequest {
    override get body(): null {
      return undefined as unknown as null;
    }
  };
  const bridge = fakeBridge(() => ({ status: 200, headers: [], body: "" }));
  try {
    await withGlobals({ AioNativeFetch: bridge }, async () => {
      await nativeFetch("https://x.test/", { method: "POST", body: "hi" });
      await nativeFetch("https://x.test/", { method: "PUT", body: "" });
      await nativeFetch("https://x.test/");
    });
  } finally {
    globalThis.Request = RealRequest;
  }
  assertEquals(bridge.sent.map((m) => [m.method, m.body]), [
    ["POST", btoa("hi")],
    ["PUT", null],
    ["GET", null],
  ]);
});

Deno.test("nativeFetch: the native answer becomes a real Response — status, empty-body statuses, errors", async () => {
  await withGlobals({
    AioNativeFetch: fakeBridge((m) =>
      m.url.endsWith("/204")
        ? { status: 204, statusText: "No Content", headers: [], body: "" }
        : m.url.endsWith("/bad-header")
        ? {
          status: 200,
          statusText: "OK",
          headers: [["bad name", "x"]],
          body: "",
        }
        : m.url.endsWith("/403")
        ? {
          status: 403,
          statusText: "Forbidden",
          headers: [],
          body: btoa("no"),
        }
        : { error: "java.io.IOException: Cleartext HTTP traffic not permitted" }
    ),
  }, async () => {
    const empty = await nativeFetch("https://x.test/204");
    assertEquals(empty.status, 204);
    assertEquals(empty.body, null);
    const refused = await nativeFetch("https://x.test/403");
    assertEquals([refused.status, await refused.text()], [403, "no"]);
    const e = await assertRejects(
      () => nativeFetch("http://x.test/err"),
      TypeError,
    );
    assertStringIncludes(e.message, "GET http://x.test/err");
    assertStringIncludes(e.message, "Cleartext HTTP traffic not permitted");
    // An answer the Response constructor refuses rejects — never a promise
    // left pending forever.
    await assertRejects(() => nativeFetch("https://x.test/bad-header"));
  });
});

Deno.test("nativeFetch: an abort rejects with the signal's reason and drops the late answer", async () => {
  await withGlobals({ AioNativeFetch: fakeBridge(() => null) }, async () => {
    const ac = new AbortController();
    const p = nativeFetch("https://x.test/slow", { signal: ac.signal });
    ac.abort(new Error("gave up"));
    const e = await assertRejects(() => p, Error);
    assertEquals(e.message, "gave up");
    const pre = new AbortController();
    pre.abort();
    await assertRejects(
      () => nativeFetch("https://x.test/", { signal: pre.signal }),
      DOMException,
    );
  });
});

Deno.test("nativeFetch: a standalone APK WITHOUT the bridge fails loudly — never a fetch that carries an Origin", async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => {
    called = true;
    return Promise.resolve(new Response());
  };
  try {
    await withGlobals({ AioNativeStore: {} }, async () => {
      const e = await assertRejects(
        () => nativeFetch("https://x.test/"),
        TypeError,
      );
      assertStringIncludes(e.message, "no native fetch bridge");
    });
    assert(!called, "fell back to the page's fetch");
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("nativeFetch: an invalid request rejects, it never throws synchronously", async () => {
  await withGlobals({ AioNativeFetch: fakeBridge() }, async () => {
    await assertRejects(
      () => nativeFetch("https://x.test/", { method: "GET", body: "x" }),
      TypeError,
    );
  });
});

// ── the Kotlin half ─────────────────────────────────────────────────

Deno.test("nativeFetch: the page and the APK name the same global", () => {
  const src = Deno.readTextFileSync(
    fromFileUrl(new URL("../src/browser/native-fetch.ts", import.meta.url)),
  );
  const page = src.match(/NATIVE_FETCH_GLOBAL = "([^"]+)"/)?.[1];
  const kotlin = KOTLIN.match(/FETCH_GLOBAL = "([^"]+)"/)?.[1];
  assert(page && kotlin);
  assertEquals(page, kotlin);
  // …and the store global it uses to recognise a standalone APK.
  assertEquals(
    src.match(/NATIVE_STORE_GLOBAL = "([^"]+)"/)?.[1],
    KOTLIN.match(/STORE_GLOBAL = "([^"]+)"/)?.[1],
  );
});

Deno.test("nativeFetch: the bridge is standalone-only, own-origin-only, http(s)-only, bounded, cookie-free", () => {
  // Installed inside the same !TALKS_TO_SERVER block as the store: a client
  // or dev APK opens a server's pages and gets no network bridge.
  const guarded = KOTLIN.slice(
    KOTLIN.indexOf(
      "if (!TALKS_TO_SERVER) {\n                val store = AioNativeStore(",
    ),
  );
  const install = guarded.indexOf(
    'WebViewCompat.addWebMessageListener(this, FETCH_GLOBAL, setOf("https://$ASSET_HOST"), AioNativeFetch)',
  );
  assert(install > 0, "the listener is not installed under !TALKS_TO_SERVER");
  assert(
    install < guarded.indexOf("webViewClient = object"),
    "the listener moved out of the standalone-only block",
  );
  assertEquals(
    KOTLIN.split("addWebMessageListener(").length,
    2,
    "one install site",
  );
  // Removed again when a foreign page ever loads.
  assertStringIncludes(
    KOTLIN,
    "WebViewCompat.removeWebMessageListener(view, FETCH_GLOBAL)",
  );
  // A file: URL would read the app's own files.
  assertStringIncludes(
    KOTLIN,
    'if (url.protocol != "https" && url.protocol != "http") {',
  );
  assertStringIncludes(
    KOTLIN,
    "conn.connectTimeout = FETCH_CONNECT_TIMEOUT_MS",
  );
  assertStringIncludes(KOTLIN, "conn.readTimeout = FETCH_READ_TIMEOUT_MS");
  assertStringIncludes(KOTLIN, "if (body.size > FETCH_MAX_BODY)");
  assertStringIncludes(KOTLIN, "if (out.size() + n > FETCH_MAX_BODY)");
  assertStringIncludes(KOTLIN, 'k.equals("set-cookie", ignoreCase = true)');
  assert(!/CookieHandler\.setDefault|CookieManager\.getInstance/.test(KOTLIN));
});
