// HTTP/1.1 over a LocalListener — the handler-on-a-socket path every local
// HTTP door uses (a Windows named pipe, a unix socket, in dev and production),
// proven here on Linux over a unix LocalListener with the SAME code. Request parsing (Content-Length, chunked), response framing (status,
// headers, Content-Length vs chunked, 204/304/HEAD), STREAMING (the handler's
// ReadableStream is written chunk by chunk, never buffered), a 20 MB body,
// malformed → 400 + close, handler throw → 500.

import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  bodyFraming,
  chunkFrame,
  parseRequestHead,
  responseHeadBytes,
  serveHttpOverLocal,
  statusHasNoBody,
  targetFormOk,
  trimOws,
} from "../src/server/http-over-conn.ts";
import {
  connectLocal,
  listenLocal,
  type LocalConn,
  type LocalListener,
} from "../src/server/local-listen.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

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
 *  check: chunked responses must end in the terminating `0\r\n\r\n`, and a
 *  Content-Length is the body's length — unless the reply is to a `HEAD`,
 *  whose length is that of the body it does not carry. */
function parseReply(raw: Uint8Array, toHead = false): Reply {
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
    if (cl !== null && !toHead) {
      assertEquals(body.length, Number(cl), "content-length");
    }
  }
  return { status: Number(m[1]), headers, body };
}

/** A listener whose connections have only their streams — what the Windows
 *  pipe backend offers. The unix backends also read and write directly, and
 *  `tests/http-over-conn-differential.test.ts` runs the server over those;
 *  the cases here keep the stream path honest. */
function streamsOnly(inner: LocalListener): LocalListener {
  return {
    path: inner.path,
    close: () => inner.close(),
    async *[Symbol.asyncIterator]() {
      for await (const c of inner) {
        yield {
          readable: c.readable,
          writable: c.writable,
          remoteAddr: c.remoteAddr,
          drain: () => c.drain!(),
          close: () => c.close(),
        };
      }
    },
  };
}

async function withServer(
  handler: Parameters<typeof serveHttpOverLocal>[1],
  f: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await tempDir("aio-hoc-");
  const path = join(dir, "h.sock");
  const srv = serveHttpOverLocal(streamsOnly(listenLocal(path)), handler);
  try {
    await f(path);
  } finally {
    await srv.close();
    await dropTempDir(dir);
  }
}

async function roundtrip(
  path: string,
  raw: string | Uint8Array,
): Promise<Reply> {
  const conn = await connectLocal(path);
  const w = conn.writable.getWriter();
  await w.write(closing(typeof raw === "string" ? enc.encode(raw) : raw));
  w.releaseLock();
  const out = await readAll(conn);
  conn.close();
  return parseReply(out, isHead(raw));
}

/** `raw` with `Connection: close` after its request line: the reply is read
 *  to the end of the connection, which the server otherwise keeps. */
function closing(raw: Uint8Array): Uint8Array {
  const at = findSeq(raw, "\r\n");
  return at < 0 ? raw : concat([
    raw.subarray(0, at + 2),
    enc.encode("Connection: close\r\n"),
    raw.subarray(at + 2),
  ]);
}

const isHead = (raw: string | Uint8Array) =>
  (typeof raw === "string" ? raw : dec.decode(raw.subarray(0, 5)))
    .startsWith("HEAD ");

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
  // A method is any token without a lowercase letter, not only letters.
  assertEquals(parseRequestHead("M-SEARCH /x HTTP/1.1").method, "M-SEARCH");
});

Deno.test("trimOws: the spaces and tabs at the edges, and no other byte JS calls whitespace", () => {
  assertEquals(trimOws(" \t v \t "), "v");
  assertEquals(trimOws("a b\tc"), "a b\tc");
  assertEquals(trimOws(""), "");
  assertEquals(trimOws(" \t "), "");
  // NBSP, VT, FF, NEL, the bytes of U+2028, a BOM: all of them `.trim()` cuts.
  const kept = ["\xa0", "\x0b", "\x0c", "\x85", "\xe2\x80\xa8", "\ufeff"];
  assertEquals(
    kept.map((w) => trimOws(` ${w}v${w}\t`)),
    kept.map((w) => `${w}v${w}`),
  );
  // …and so a header value keeps them, at both edges.
  const h = parseRequestHead(
    "GET / HTTP/1.1\r\nX: \t voil\xc3\xa0 \r\nY:\xa0y",
  );
  assertEquals(h.headers.get("x"), "voil\xc3\xa0");
  assertEquals(h.headers.get("y"), "\xa0y");
});

Deno.test("bodyFraming: chunked is the last coding, once, and HTTP/1.1's", () => {
  const f = (te: string, version?: string) =>
    bodyFraming(new Headers({ "transfer-encoding": te }), version);
  assertEquals(f("chunked"), "chunked");
  assertEquals(f("gzip,\tCHUNKED "), "chunked");
  const refused = ([te, version]: [string, string?]) => {
    try {
      f(te, version);
      return false;
    } catch {
      return true;
    }
  };
  const bad: [string, string?][] = [
    ["chunked, chunked"],
    ["chunked, gzip"],
    ["gzip,\xa0chunked"],
    ["\x0bchunked"],
    ["chunked,"],
    [",chunked"],
    ["gzip,,chunked"],
    ["gzip, , chunked"],
    ["identity, chunked"],
    ["gzip, Identity, chunked"],
    [""],
    ["chunked", "1.0"],
  ];
  assertEquals(bad.map(refused), bad.map(() => true), JSON.stringify(bad));
});

Deno.test("targetFormOk: origin- or absolute-form; * for OPTIONS alone; the authority-form for CONNECT alone", () => {
  const ok: [string, string][] = [
    ["GET", "/"],
    ["GET", "//a/b"],
    ["GET", "/*"],
    ["GET", "http://a/b"],
    ["POST", "x+y.z-1://a"],
    ["GET", "http:///x"],
    ["OPTIONS", "*"],
    ["OPTIONS", "/x"],
    ["CONNECT", "a:443"],
    ["CONNECT", "[::1]:80"],
    ["CONNECT", "a"],
  ];
  const bad: [string, string][] = [
    ["GET", "*"],
    ["POST", "*"],
    ["M-SEARCH", "*"],
    ["OPTIONS", "**"],
    ["OPTIONS", "a:80"],
    ["GET", "a:80"],
    ["GET", "a"],
    ["GET", "?q"],
    ["GET", "#f"],
    ["GET", "./a"],
    ["GET", "http:/a"],
    ["GET", "http://"],
    ["GET", "mailto:a@b"],
    ["GET", "1x://a"],
    ["GET", "a_b://c"],
    ["GET", "://a"],
    ["CONNECT", "/a"],
    ["CONNECT", "*"],
    ["CONNECT", "http://a/"],
    ["CONNECTX", "a:443"],
  ];
  assertEquals(ok.map((a) => targetFormOk(...a)), ok.map(() => true));
  assertEquals(bad.map((a) => targetFormOk(...a)), bad.map(() => false));
  // …and a head whose target is in no form is not a request.
  assertThrows(() => parseRequestHead("GET a:80 HTTP/1.1\r\nHost: h"));
});

Deno.test("parseRequestHead: refuses what is not HTTP/1.x", () => {
  for (
    const bad of [
      "",
      "GET /",
      "GET / HTTP/2.0",
      "get / HTTP/1.1",
      "Get / HTTP/1.1",
      "G(T / HTTP/1.1",
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
        enc.encode(
          "POST /x HTTP/1.1\r\nConnection: close\r\nContent-Length: 3000\r\n\r\n",
        ),
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
      await w.write(enc.encode("GET / HTTP/1.1\r\nConnection: close\r\n\r\n"));
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
      // …and the length its GET would carry.
      assertEquals(c.headers.get("content-length"), "28");
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
  const dir = await tempDir("aio-hoc-");
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
  await dropTempDir(dir);
});

Deno.test("a server pipe is DRAINED before it is closed (real Windows: EPIPE)", async () => {
  // On real Windows a server named pipe that closes with unread bytes in its
  // buffer DISCARDS them, and the client sees `read EPIPE` after a 200. It hit
  // the very FIRST page request of a packaged one-file exe (2026-09-17), so
  // the window failed `did-fail-load` while the same bytes were fine on unix
  // (which flushes on close). The server must call `drain()` before `close()`;
  // this pins the order and that close still happens.
  const order: string[] = [];
  const drained = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const conn: LocalConn = {
    readable: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("GET / HTTP/1.1\r\n\r\n"));
        c.close();
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write() {
        order.push("write");
      },
    }),
    remoteAddr: { transport: "unix", path: "/fake" },
    drain() {
      order.push("drain");
      drained.resolve();
      return Promise.resolve();
    },
    close() {
      order.push("close");
      closed.resolve();
    },
  };
  const listener = {
    path: "/fake",
    close() {},
    async *[Symbol.asyncIterator]() {
      yield conn;
    },
  };
  void serveHttpOverLocal(listener, () => new Response("hello"));
  // `serveConn` runs detached; the signals are its own `drain` and `close`,
  // not timers — nothing here can pass or fail on scheduling luck.
  await drained.promise;
  await closed.promise;
  assertEquals(order.includes("drain"), true, `drain must run: ${order}`);
  assert(
    order.indexOf("drain") < order.indexOf("close"),
    `drain must precede close: ${order}`,
  );
});

Deno.test("a connection's read buffer starts small and grows only for a connection that fills it", async () => {
  // Every connection used to get 64 KB to read into, whatever it sent: a
  // process that opened connections and sent half a head held 64 KB of this
  // one each. The buffer now starts at 4 KB and grows after a read that
  // filled it — a page request never needs more, an upload gets there in
  // three reads.
  const run = async (input: Uint8Array) => {
    const asked: number[] = [];
    let off = 0, got = 0;
    const closed = Promise.withResolvers<void>();
    const conn: LocalConn = {
      // (Never used: a connection that can be read raw is read raw.)
      readable: new ReadableStream<Uint8Array>(),
      writable: new WritableStream<Uint8Array>(),
      remoteAddr: { transport: "unix", path: "/fake" },
      read(buf) {
        asked.push(buf.length);
        if (off === input.length) return Promise.resolve(null);
        const n = Math.min(buf.length, input.length - off);
        buf.set(input.subarray(off, off + n));
        off += n;
        return Promise.resolve(n);
      },
      write: () => Promise.resolve(),
      close: () => closed.resolve(),
    };
    const listener = {
      path: "/fake",
      close() {},
      async *[Symbol.asyncIterator]() {
        yield conn;
      },
    };
    void serveHttpOverLocal(listener, async (req) => {
      got = (await req.arrayBuffer()).byteLength;
      return new Response("ok");
    });
    await closed.promise;
    return { asked, got };
  };
  const page = await run(enc.encode("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
  assertEquals(page.asked.every((n) => n === 4096), true, `${page.asked}`);
  assert(page.asked.length >= 1);

  const size = 1 << 20;
  const head = enc.encode(
    `POST / HTTP/1.1\r\nHost: x\r\nContent-Length: ${size}\r\n\r\n`,
  );
  const upload = new Uint8Array(head.length + size);
  upload.set(head);
  const up = await run(upload);
  assertEquals(up.got, size, "the upload did not reach the route whole");
  assertEquals(up.asked.slice(0, 3), [4096, 16384, 65536]);
  assertEquals(Math.max(...up.asked), 65536);
});

Deno.test("a head or a chunk line that arrives in pieces is read whole — what is left of one read survives the next", async () => {
  // The connection is read into ONE buffer, again and again. Bytes of the
  // last read that are still waiting (half a head, half a chunk-size line)
  // must be moved out before the next read lands on them.
  const pieces = [
    "POST /split?x=1 HT",
    "TP/1.1\r\nHost: x\r\nTransfer-Encod",
    "ing: chunked\r\n\r\n",
    "000",
    "5\r\nhel",
    "lo\r",
    "\n0\r\n\r\n",
  ].map((p) => enc.encode(p));
  const seen: string[] = [];
  const wrote: string[] = [];
  const closed = Promise.withResolvers<void>();
  const conn: LocalConn = {
    // (Never used: a connection that can be read raw is read raw.)
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
    remoteAddr: { transport: "unix", path: "/fake" },
    read(buf) {
      const p = pieces.shift();
      if (!p) return Promise.resolve(null);
      buf.set(p);
      return Promise.resolve(p.length);
    },
    write(bytes) {
      wrote.push(new TextDecoder().decode(bytes));
      return Promise.resolve();
    },
    close: () => closed.resolve(),
  };
  const listener = {
    path: "/fake",
    close() {},
    async *[Symbol.asyncIterator]() {
      yield conn;
    },
  };
  void serveHttpOverLocal(listener, async (req) => {
    const u = new URL(req.url);
    seen.push(`${req.method} ${u.pathname}${u.search} ${await req.text()}`);
    return new Response("ok");
  });
  await closed.promise;
  assertEquals(seen, ["POST /split?x=1 hello"]);
  assertEquals(wrote.join("").slice(0, 15), "HTTP/1.1 200 OK");
});

for (const how of ["close", "dropConnections"] as const) {
  Deno.test(`${how}(): nothing new is started on the connection — a request pipelined behind the one just answered never reaches the handler`, async () => {
    // The moment that can go wrong: the answer is written, the next head is
    // already in the buffer, and the connection is ended before it is taken.
    // `completed` settles exactly there.
    const dir = await tempDir("aio-hoc-");
    const path = `${dir}/h.sock`;
    const seen: string[] = [];
    const srv = serveHttpOverLocal(listenLocal(path), (req, info) => {
      seen.push(new URL(req.url).pathname);
      if (seen.length === 1) info.completed.then(() => void srv[how]());
      return new Response("x");
    });
    try {
      const conn = await connectLocal(path);
      const w = conn.writable.getWriter();
      await w.write(enc.encode(
        ["/a", "/b", "/c"].map((p) => `GET ${p} HTTP/1.1\r\nHost: x\r\n\r\n`)
          .join(""),
      ));
      w.releaseLock();
      const got = dec.decode(await readAll(conn));
      conn.close();
      assertEquals(
        { seen, answers: got.split("HTTP/1.1 200").length - 1 },
        { seen: ["/a"], answers: 1 },
      );
    } finally {
      await srv.close();
      await dropTempDir(dir);
    }
  });
}
