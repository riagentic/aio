// HTTP/1.1 over a LocalListener — the handler-on-a-socket path Windows uses
// (a named pipe), proven here on Linux over a unix LocalListener with the SAME
// code. Request parsing (Content-Length, chunked), response framing (status,
// headers, Content-Length vs chunked, 204/304/HEAD), STREAMING (the handler's
// ReadableStream is written chunk by chunk, never buffered), a 20 MB body,
// malformed → 400 + close, handler throw → 500.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import {
  chunkFrame,
  parseRequestHead,
  responseHeadBytes,
  serveHttpOverLocal,
  statusHasNoBody,
} from "../src/server/http-over-conn.ts";
import {
  connectLocal,
  listenLocal,
  type LocalConn,
} from "../src/server/local-listen.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Wire helpers (a deliberately independent HTTP/1.1 client) ─────────────

type Reply = { status: number; headers: Headers; body: Uint8Array };

async function readAll(conn: LocalConn): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of conn.readable) parts.push(c);
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function findSeq(buf: Uint8Array, seq: string, from = 0): number {
  const s = enc.encode(seq);
  outer: for (let i = from; i + s.length <= buf.length; i++) {
    for (let j = 0; j < s.length; j++) if (buf[i + j] !== s[j]) continue outer;
    return i;
  }
  return -1;
}

/** Parse a full response (Content-Length or chunked), with a body-framing
 *  check: chunked responses must end in the terminating `0\r\n\r\n`. */
function parseReply(raw: Uint8Array): Reply {
  const end = findSeq(raw, "\r\n\r\n");
  assert(end >= 0, "no response head");
  const head = dec.decode(raw.subarray(0, end)).split("\r\n");
  const m = /^HTTP\/1\.1 (\d{3}) (.*)$/.exec(head[0]!);
  assert(m, `bad status line ${head[0]}`);
  const headers = new Headers();
  for (const l of head.slice(1)) {
    const i = l.indexOf(":");
    headers.append(l.slice(0, i), l.slice(i + 1).trim());
  }
  let rest = raw.subarray(end + 4);
  let body: Uint8Array;
  if (headers.get("transfer-encoding") === "chunked") {
    const parts: Uint8Array[] = [];
    while (true) {
      const nl = findSeq(rest, "\r\n");
      assert(nl >= 0, "chunk size line missing");
      const size = parseInt(dec.decode(rest.subarray(0, nl)), 16);
      rest = rest.subarray(nl + 2);
      if (size === 0) {
        assertEquals(dec.decode(rest), "\r\n", "chunked terminator");
        break;
      }
      parts.push(rest.subarray(0, size));
      assertEquals(dec.decode(rest.subarray(size, size + 2)), "\r\n");
      rest = rest.subarray(size + 2);
    }
    body = concat(parts);
  } else {
    body = rest;
    const cl = headers.get("content-length");
    if (cl !== null) assertEquals(body.length, Number(cl), "content-length");
  }
  return { status: Number(m[1]), headers, body };
}

async function withServer(
  handler: Parameters<typeof serveHttpOverLocal>[1],
  f: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "aio-hoc-" });
  const path = join(dir, "h.sock");
  const srv = serveHttpOverLocal(listenLocal(path), handler);
  try {
    await f(path);
  } finally {
    await srv.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function roundtrip(
  path: string,
  raw: string | Uint8Array,
): Promise<Reply> {
  const conn = await connectLocal(path);
  const w = conn.writable.getWriter();
  await w.write(typeof raw === "string" ? enc.encode(raw) : raw);
  w.releaseLock();
  const out = await readAll(conn);
  conn.close();
  return parseReply(out);
}

// ── Pure parts ────────────────────────────────────────────────────────────

Deno.test("parseRequestHead: request line + headers, folded values kept as-is", () => {
  const h = parseRequestHead(
    "POST /a/b?c=1 HTTP/1.1\r\nHost: app\r\nX-Two: a\r\nx-two: b\r\nContent-Length: 3",
  );
  assertEquals(h.method, "POST");
  assertEquals(h.target, "/a/b?c=1");
  assertEquals(h.version, "1.1");
  assertEquals(h.headers.get("host"), "app");
  assertEquals(h.headers.get("x-two"), "a, b");
  assertEquals(h.headers.get("content-length"), "3");
});

Deno.test("parseRequestHead: refuses what is not HTTP/1.x", () => {
  for (
    const bad of [
      "",
      "GET /",
      "GET / HTTP/2.0",
      "get / HTTP/1.1",
      "GET / HTTP/1.1\r\nno-colon",
      "GET / HTTP/1.1\r\n: empty",
      "GET / HTTP/1.1\r\nBad Name: x",
    ]
  ) {
    let threw = false;
    try {
      parseRequestHead(bad);
    } catch {
      threw = true;
    }
    assert(threw, `accepted ${JSON.stringify(bad)}`);
  }
});

Deno.test("chunkFrame: hex size, CRLF framing", () => {
  assertEquals(dec.decode(chunkFrame(enc.encode("hello"))), "5\r\nhello\r\n");
  assertEquals(
    dec.decode(chunkFrame(new Uint8Array(256))).slice(0, 5),
    "100\r\n",
  );
});

Deno.test("responseHeadBytes: status line with reason, headers, blank line", () => {
  const b = dec.decode(
    responseHeadBytes(404, "", new Headers({ "x-a": "1" })),
  );
  assertEquals(b, "HTTP/1.1 404 Not Found\r\nx-a: 1\r\n\r\n");
  assertEquals(
    dec.decode(responseHeadBytes(299, "Custom", new Headers())),
    "HTTP/1.1 299 Custom\r\n\r\n",
  );
});

Deno.test("statusHasNoBody: 1xx, 204, 304", () => {
  for (const s of [100, 101, 204, 304]) assert(statusHasNoBody(s));
  for (const s of [200, 201, 301, 400, 404, 500]) assert(!statusHasNoBody(s));
});

// ── Over the wire ─────────────────────────────────────────────────────────

Deno.test("GET: URL, method, headers reach the handler; status + headers + body come back intact", async () => {
  let seen: Request | null = null;
  await withServer((req, info) => {
    seen = req;
    assertEquals(info.remoteAddr.transport, "unix");
    return new Response("hi there", {
      status: 201,
      headers: { "x-custom": "yes", "content-type": "text/plain" },
    });
  }, async (path) => {
    const r = await roundtrip(
      path,
      "GET /page?x=1 HTTP/1.1\r\nHost: app\r\nX-In: v\r\n\r\n",
    );
    assertEquals(r.status, 201);
    assertEquals(r.headers.get("x-custom"), "yes");
    assertEquals(r.headers.get("content-type"), "text/plain");
    assertEquals(r.headers.get("connection"), "close");
    assertEquals(dec.decode(r.body), "hi there");
    assert(seen);
    const req = seen as Request;
    assertEquals(req.method, "GET");
    assertEquals(req.url, "http://app/page?x=1");
    assertEquals(req.headers.get("x-in"), "v");
  });
});

Deno.test("POST Content-Length body arrives whole", async () => {
  await withServer(
    async (req) => new Response(`got:${await req.text()}`),
    async (path) => {
      const r = await roundtrip(
        path,
        "POST /in HTTP/1.1\r\nContent-Length: 11\r\n\r\nhello world",
      );
      assertEquals(r.status, 200);
      assertEquals(dec.decode(r.body), "got:hello world");
    },
  );
});

Deno.test("POST chunked body is de-chunked (with a chunk extension and trailers)", async () => {
  await withServer(
    async (req) => new Response(`got:${await req.text()}`),
    async (path) => {
      const r = await roundtrip(
        path,
        "POST /in HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n" +
          "5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nX-Trailer: t\r\n\r\n",
      );
      assertEquals(dec.decode(r.body), "got:hello world");
    },
  );
});

Deno.test("request body split across many writes still arrives whole", async () => {
  await withServer(
    async (req) => new Response(`n=${(await req.arrayBuffer()).byteLength}`),
    async (path) => {
      const conn = await connectLocal(path);
      const w = conn.writable.getWriter();
      await w.write(
        enc.encode("POST /x HTTP/1.1\r\nContent-Length: 3000\r\n\r\n"),
      );
      for (let i = 0; i < 30; i++) await w.write(new Uint8Array(100).fill(65));
      w.releaseLock();
      const r = parseReply(await readAll(conn));
      conn.close();
      assertEquals(dec.decode(r.body), "n=3000");
    },
  );
});

Deno.test("response stream is written chunk by chunk — not buffered", async () => {
  // The handler enqueues chunk 1, then BLOCKS until the client has seen it on
  // the wire. A buffering server would deadlock here (and the test's timeout
  // would fire).
  let release!: () => void;
  const gate = new Promise<void>((r) => release = r);
  await withServer(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(ctrl) {
            ctrl.enqueue(enc.encode("first"));
            await gate;
            ctrl.enqueue(enc.encode("second"));
            ctrl.close();
          },
        }),
      ),
    async (path) => {
      const conn = await connectLocal(path);
      const w = conn.writable.getWriter();
      await w.write(enc.encode("GET / HTTP/1.1\r\n\r\n"));
      w.releaseLock();
      const reader = conn.readable.getReader();
      let got: Uint8Array = new Uint8Array(0);
      while (findSeq(got, "5\r\nfirst\r\n") < 0) {
        const { value, done } = await reader.read();
        assert(!done, "closed before the first chunk");
        got = concat([got, value]);
      }
      assert(
        findSeq(got, "second") < 0,
        "second chunk must not have been sent yet",
      );
      release();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        got = concat([got, value]);
      }
      const r = parseReply(got);
      assertEquals(r.headers.get("transfer-encoding"), "chunked");
      assertEquals(dec.decode(r.body), "firstsecond");
      conn.close();
    },
  );
});

Deno.test("a 20 MB streamed body arrives byte-exact", async () => {
  const MB = 1024 * 1024;
  await withServer(
    () => {
      let i = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(ctrl) {
            if (i === 20) return ctrl.close();
            ctrl.enqueue(new Uint8Array(MB).fill(i));
            i++;
          },
        }),
      );
    },
    async (path) => {
      const r = await roundtrip(path, "GET /big HTTP/1.1\r\n\r\n");
      assertEquals(r.body.length, 20 * MB);
      for (let i = 0; i < 20; i++) {
        assertEquals(r.body[i * MB], i);
        assertEquals(r.body[(i + 1) * MB - 1], i);
      }
    },
  );
});

Deno.test("declared Content-Length is honoured (no chunking)", async () => {
  await withServer(
    () =>
      new Response("12345", {
        headers: { "content-length": "5" },
      }),
    async (path) => {
      const r = await roundtrip(path, "GET / HTTP/1.1\r\n\r\n");
      assertEquals(r.headers.get("transfer-encoding"), null);
      assertEquals(r.headers.get("content-length"), "5");
      assertEquals(dec.decode(r.body), "12345");
    },
  );
});

Deno.test("204 / 304 / HEAD carry no body", async () => {
  await withServer(
    (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/204") return new Response(null, { status: 204 });
      if (u.pathname === "/304") return new Response(null, { status: 304 });
      return new Response("a body the HEAD must not see", {
        headers: { "x-h": "kept" },
      });
    },
    async (path) => {
      const a = await roundtrip(path, "GET /204 HTTP/1.1\r\n\r\n");
      assertEquals(a.status, 204);
      assertEquals(a.body.length, 0);
      assertEquals(a.headers.get("content-length"), null);
      const b = await roundtrip(path, "GET /304 HTTP/1.1\r\n\r\n");
      assertEquals(b.status, 304);
      assertEquals(b.body.length, 0);
      const c = await roundtrip(path, "HEAD /x HTTP/1.1\r\n\r\n");
      assertEquals(c.status, 200);
      assertEquals(c.headers.get("x-h"), "kept");
      assertEquals(c.body.length, 0);
      const d = await roundtrip(path, "GET /empty-null HTTP/1.1\r\n\r\n");
      assertEquals(d.status, 200); // a null-body 200 → Content-Length: 0
    },
  );
});

Deno.test("null body on 200 → Content-Length: 0", async () => {
  await withServer(() => new Response(null), async (path) => {
    const r = await roundtrip(path, "GET / HTTP/1.1\r\n\r\n");
    assertEquals(r.headers.get("content-length"), "0");
    assertEquals(r.body.length, 0);
  });
});

Deno.test("malformed request → 400 and the connection is closed; the handler never runs", async () => {
  let ran = false;
  await withServer(() => {
    ran = true;
    return new Response("no");
  }, async (path) => {
    for (
      const bad of [
        "NOT HTTP\r\n\r\n",
        "GET / HTTP/1.1\r\nContent-Length: abc\r\n\r\n",
        "GET / HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n",
      ]
    ) {
      const r = await roundtrip(path, bad);
      assertEquals(r.status, 400, bad);
      assertMatch(dec.decode(r.body), /bad request|malformed|unsupported/);
    }
    assert(!ran);
  });
});

Deno.test("a peer that connects and closes without a request is not an error (liveness probe)", async () => {
  let ran = false;
  await withServer(() => {
    ran = true;
    return new Response("no");
  }, async (path) => {
    const c = await connectLocal(path);
    c.close();
    await new Promise((r) => setTimeout(r, 30));
    assert(!ran);
    // …and the server still answers the next request.
    const r = await roundtrip(path, "GET / HTTP/1.1\r\n\r\n");
    assertEquals(r.status, 200);
  });
});

Deno.test("handler throw → 500, connection closed, server keeps serving", async () => {
  let n = 0;
  await withServer(() => {
    if (n++ === 0) throw new Error("boom");
    return new Response("fine");
  }, async (path) => {
    const a = await roundtrip(path, "GET / HTTP/1.1\r\n\r\n");
    assertEquals(a.status, 500);
    const b = await roundtrip(path, "GET / HTTP/1.1\r\n\r\n");
    assertEquals(b.status, 200);
    assertEquals(dec.decode(b.body), "fine");
  });
});

Deno.test("concurrent requests are served independently", async () => {
  await withServer(
    async (req) => {
      const u = new URL(req.url);
      await new Promise((r) => setTimeout(r, Number(u.searchParams.get("d"))));
      return new Response(u.pathname);
    },
    async (path) => {
      const rs = await Promise.all(
        [30, 0, 15].map((d, i) =>
          roundtrip(path, `GET /r${i}?d=${d} HTTP/1.1\r\n\r\n`)
        ),
      );
      assertEquals(rs.map((r) => dec.decode(r.body)), ["/r0", "/r1", "/r2"]);
    },
  );
});

Deno.test("close(): stops accepting and settles", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-hoc-" });
  const path = join(dir, "h.sock");
  const srv = serveHttpOverLocal(listenLocal(path), () => new Response("x"));
  await srv.close();
  await srv.close(); // idempotent
  let refused = false;
  try {
    await connectLocal(path);
  } catch {
    refused = true;
  }
  assert(refused);
  await Deno.remove(dir, { recursive: true });
});
