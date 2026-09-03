// What the HTTP front door answers to malformed, mis-aimed and half-sent
// requests. Every case here used to be a 500 — the one status that tells an
// operator "the server is broken" about a request the CLIENT got wrong.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import {
  AIO_ROUTE_METHODS,
  snapshotShapeError,
} from "../src/server/server-static.ts";

const probe = () =>
  cell(`probe-${crypto.randomUUID().slice(0, 6)}`, {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });

/** Send a raw request line + headers over TCP and return the status line
 *  and the body — the shape a fetch() cannot produce (fetch refuses to send a
 *  malformed Host). */
async function raw(
  port: number,
  request: string,
): Promise<{ status: number; head: string; body: string }> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    await conn.write(new TextEncoder().encode(request));
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(65536);
    // Read until the peer closes or a full response has landed.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const n = await Promise.race([
        conn.read(buf),
        new Promise<null>((r) => setTimeout(() => r(null), 300)),
      ]);
      if (n === null) break;
      chunks.push(buf.slice(0, n));
      const text = new TextDecoder().decode(concat(chunks));
      const m = /content-length:\s*(\d+)/i.exec(text);
      const split = text.indexOf("\r\n\r\n");
      if (split !== -1 && m && text.length >= split + 4 + Number(m[1])) break;
    }
    const text = new TextDecoder().decode(concat(chunks));
    const split = text.indexOf("\r\n\r\n");
    const head = split === -1 ? text : text.slice(0, split);
    const body = split === -1 ? "" : text.slice(split + 4);
    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
    return { status, head, body };
  } finally {
    conn.close();
  }
}
function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

Deno.test("http: a malformed Host header is the client's 400, not a 500", async () => {
  await using srv = await testServer({ cells: [probe()] });
  for (const host of ["[::1", "127.0.0.1:abc", "a b", ":"]) {
    const r = await raw(srv.port, `GET / HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
    assert(
      r.status === 400 || r.status === 403,
      `Host "${host}" → ${r.status} (expected 400 malformed or 403 refused)\n${r.head}`,
    );
  }
  // …and the server is still up afterwards.
  const ok = await srv.fetch("/__aio/health");
  assertEquals(ok.status, 200);
  await ok.text();
});

Deno.test("http: GET /ws without an Upgrade is 426, never a 500", async () => {
  await using srv = await testServer({ cells: [probe()] });
  const res = await srv.fetch("/ws");
  const body = await res.text();
  assertEquals(res.status, 426, body);
  assertEquals(res.headers.get("upgrade"), "websocket");
  assertStringIncludes(body, "Upgrade: websocket");
  // A handshake that CLAIMS websocket but is missing the key is the client's
  // 400 — still not a 500.
  const r = await raw(
    srv.port,
    `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
  );
  assert(r.status === 400 || r.status === 426, `${r.status}\n${r.head}`);
  const ok = await srv.fetch("/__aio/health");
  assertEquals(ok.status, 200);
  await ok.text();
});

// ── The framework's own endpoints answer methods consistently ──────────────
//
// Every `/__aio/*` handler answered whatever method arrived, because none of
// them looked: `TRACE /__aio/health`, `DELETE /__aio/metrics`, `BREW
// /__aio/vitals` all returned 200 and a body. Meanwhile `/__aio/snapshot`
// refused HEAD with a 405 while serving GET (HEAD rides with GET, per HTTP),
// and `GET /__aio/client-error` fell through to a 404 claiming the route did
// not exist. Four different answers to one question. One table decides now
// (`AIO_ROUTE_METHODS`), and this test walks it rather than restating it — a
// route added to the table is covered the day it is added.
Deno.test("http: every framework endpoint obeys ONE method table", async () => {
  await using srv = await testServer({ cells: [probe()] });
  // The table IS the fix — if a refactor emptied or renamed it, the loop below
  // would iterate nothing and this test would still pass while every endpoint
  // answered whatever it liked. So: name what must be in it, and count what
  // was actually matched.
  const paths = Object.keys(AIO_ROUTE_METHODS).sort();
  assertEquals(paths, [
    "/__aio/client-error",
    "/__aio/error",
    "/__aio/health",
    "/__aio/icon",
    "/__aio/metrics",
    "/__aio/snapshot",
    "/__aio/vitals",
  ]);
  let matched = 0;
  for (const [path, entry] of Object.entries(AIO_ROUTE_METHODS)) {
    for (const method of ["TRACE", "DELETE", "PATCH", "BREW"]) {
      if (entry.methods.includes(method)) continue;
      // Raw TCP, not fetch(): fetch refuses to SEND a TRACE, and TRACE
      // answering 200 with the request echoed back was one of the four
      // answers this table replaced.
      const r = await raw(
        srv.port,
        `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\n` +
          `Content-Length: 0\r\n\r\n`,
      );
      assertEquals(
        r.status,
        405,
        `${method} ${path} → ${r.status}\n${r.head}`,
      );
      assertStringIncludes(
        r.head.toLowerCase(),
        `allow: ${entry.methods.join(", ").toLowerCase()}`,
      );
      matched++;
    }
    // HEAD rides with GET, always.
    if (entry.methods.includes("GET")) {
      assert(
        entry.methods.includes("HEAD"),
        `${path} serves GET but not HEAD — HEAD is GET without a body`,
      );
    }
  }
  assertEquals(
    matched,
    28,
    "every listed endpoint × every method it does not serve must be refused",
  );
});

// ── A snapshot whose cell value is not an object ───────────────────────────
//
// `POST /__aio/snapshot` took `{"counter": 1}` and answered 200. It loaded —
// and then every later dispatch on that cell died with `Cannot create property
// 'count' on number`, thrown inside the method, arbitrarily far from the
// request that caused it. A cell's state is ALWAYS an object
// (`cell({ state: {…} })`), so this is a shape the door can refuse.
Deno.test("http: a snapshot with a non-object cell value is refused, naming the cell", async () => {
  await using srv = await testServer({ cells: [probe()] });
  for (
    const bad of [
      '{"counter":1}',
      '{"counter":null}',
      '{"counter":[]}',
      '{"counter":"str"}',
    ]
  ) {
    const res = await srv.fetch("/__aio/snapshot", {
      method: "POST",
      headers: { "X-AIO": "1" },
      body: bad,
    });
    const body = await res.text();
    assertEquals(res.status, 400, `${bad} → ${res.status} ${body}`);
    assertStringIncludes(body, '"counter"');
  }
  // A whole-body shape that is not an object at all.
  for (const bad of ["[]", "7", '"x"', "null"]) {
    const res = await srv.fetch("/__aio/snapshot", {
      method: "POST",
      headers: { "X-AIO": "1" },
      body: bad,
    });
    assertEquals(res.status, 400, `${bad} → ${res.status}`);
    await res.text();
  }
  // CONTROL: a well-shaped snapshot still loads.
  const good = await srv.fetch("/__aio/snapshot");
  const json = await good.text();
  const ok = await srv.fetch("/__aio/snapshot", {
    method: "POST",
    headers: { "X-AIO": "1" },
    body: json,
  });
  assertEquals(ok.status, 200, await ok.text());
});

Deno.test("snapshotShapeError: the pure decider both doors share", () => {
  assertEquals(snapshotShapeError({ a: {} }), null);
  assertEquals(snapshotShapeError({ a: { b: 1 } }), null);
  assert(snapshotShapeError({ a: 1 })?.includes('"a"'));
  assert(snapshotShapeError({ a: null })?.includes("null"));
  assert(snapshotShapeError({ a: [] })?.includes("an array"));
  assert(snapshotShapeError([])?.includes("must be a JSON object"));
  assert(snapshotShapeError(null)?.includes("must be a JSON object"));
});

// ── A client that hangs up mid-body is not the route's bug ─────────────────
//
// `req.json()` throws INSIDE the handler when the peer leaves, so the failure
// was logged as `ERROR route "/api/text" threw — BadResource: Cannot read
// body…` with a stack pointing into the app's own code. People debugged a
// handler that was never wrong.
Deno.test("http: a client that disconnects mid-body is logged as a client abort, not a route error", async () => {
  const seen: string[] = [];
  await using srv = await testServer({
    cells: [probe()],
    routes: {
      "/api/text": async (req: Request) => {
        try {
          return new Response(await req.text());
        } catch (e) {
          seen.push(String(e));
          throw e;
        }
      },
    },
  } as never);

  // Declare 100 bytes, send 10, close.
  const conn = await Deno.connect({ hostname: "127.0.0.1", port: srv.port });
  await conn.write(
    new TextEncoder().encode(
      `POST /api/text HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\n` +
        `Content-Length: 100\r\n\r\nhalf-body`,
    ),
  );
  await new Promise((r) => setTimeout(r, 50));
  conn.close();
  await new Promise((r) => setTimeout(r, 150));

  assert(seen.length > 0, "the handler must have seen the body read fail");
  const { isClientAbort } = await import("../src/server/server.ts");
  assert(
    isClientAbort(new Deno.errors.BadResource("Cannot read body")),
    "a BadResource body read IS a client abort",
  );
  // …and a genuine handler bug is still an error, not excused as an abort.
  assert(!isClientAbort(new TypeError("x is not a function")));
  // The server is still up.
  const ok = await srv.fetch("/__aio/health");
  assertEquals(ok.status, 200);
  await ok.text();
});
