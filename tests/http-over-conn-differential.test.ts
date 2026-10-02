// `serveHttpOverLocal` against `Deno.serve` — the SAME handler, the SAME
// requests, the same answers.
//
// The app's page and routes are not served by `Deno.serve` on their unix
// socket but by the hand-written HTTP/1.1 server in
// `src/server/http-over-conn.ts` (which is also what a Windows named pipe has
// always used). A server that replaces the platform's is only as correct as
// its last comparison with it: every way the two differ reaches every app's
// window, scripts and `curl --unix-socket`.
//
// So: one handler, four servers on a unix socket — `Deno.serve`, this server
// over a plain listener, over the peer-credential listener the lockdown uses,
// and over a connection that is ONLY a stream pair (what the Windows pipe
// is) — and one raw client. Status, body bytes, semantic headers, what the
// handler saw (`req.url`, headers, body) and what it was told (`abort`,
// `cancel`) must be EQUAL. The differences that are deliberate are the
// EXCEPTIONS table at the bottom: each is asserted on BOTH sides, so neither
// server can drift without this file saying which.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  bodyFraming,
  chunkSize,
  requestUrl,
  serveHttpOverLocal,
} from "../src/server/http-over-conn.ts";
import { listenLocal, type LocalListener } from "../src/server/local-listen.ts";
import { requireLocalPeer } from "../src/server/local-peer.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

// Opened before any case — the sanitizer counts an FFI library per test.
requireLocalPeer();

const enc = new TextEncoder();
const MB = 1024 * 1024;

// ── The handler: one app, every behaviour a route can have ───────────────────

/** A cheap, order-sensitive digest — bodies are compared by it, not held. */
function digest(parts: Uint8Array[] | Uint8Array): string {
  let h = 0x811c9dc5, n = 0;
  for (const p of parts instanceof Uint8Array ? [parts] : parts) {
    for (let i = 0; i < p.length; i++) h = Math.imul(h ^ p[i]!, 0x01000193);
    n += p.length;
  }
  return `${n}:${(h >>> 0).toString(16)}`;
}

/** 70 KB holding every byte value, NUL and 0xFF included. */
const BINARY = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7) & 0xff);

type Counts = Record<string, number>;

function app() {
  /** What the handler was TOLD, per route: `abort` events and stream cancels. */
  const counts: Counts = {};
  const bump = (k: string) => counts[k] = (counts[k] ?? 0) + 1;
  /** Body bytes the `/count` route has been handed so far. */
  const progress = { bytes: 0 };
  const handler = async (
    req: Request,
    info: { remoteAddr: Deno.Addr; completed: Promise<void> },
  ): Promise<Response> => {
    const u = new URL(req.url);
    const p = u.pathname;
    req.signal.addEventListener("abort", () => bump(`abort ${p}`));
    info.completed.then(
      () => bump(`completed ${p}`),
      () => bump(`completed, rejected ${p}`),
    );
    switch (p) {
      case "/seen": {
        // Everything a route can read off a request.
        const parts: Uint8Array[] = [];
        if (req.body) { for await (const c of req.body) parts.push(c); }
        return Response.json({
          method: req.method,
          url: req.url,
          // Who the handler is told is calling: the server gates on this.
          peer: info.remoteAddr.transport,
          headers: [...req.headers].map(([k, v]) => [
            k,
            [...v].map((c) => c.charCodeAt(0).toString(16)).join(" "),
          ]),
          body: digest(parts),
        });
      }
      case "/204":
        return new Response(null, { status: 204, headers: { "x-a": "1" } });
      case "/304":
        return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      case "/302":
        return new Response(null, {
          status: 302,
          headers: { location: "/seen?from=302" },
        });
      case "/299":
        return new Response("custom", { status: 299, statusText: "Odd" });
      case "/status": {
        const code = Number(u.searchParams.get("c"));
        return new Response(code === 205 ? null : `status ${code}`, {
          status: code,
          statusText: "ignored",
        });
      }
      case "/cookies": {
        const h = new Headers({ "content-type": "text/plain" });
        h.append("set-cookie", "a=1; Path=/");
        h.append("set-cookie", "b=2; HttpOnly");
        h.append("x-multi", "one");
        h.append("x-multi", "two");
        return new Response("cookies", { headers: h });
      }
      case "/latin1":
        return new Response("latin1", { headers: { "x-title": "café" } });
      case "/binary":
        return new Response(BINARY, {
          headers: { "content-type": "application/octet-stream" },
        });
      case "/declared":
        return new Response("12345", { headers: { "content-length": "5" } });
      case "/stream30": {
        let i = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(ctrl) {
              if (i === 30) return ctrl.close();
              ctrl.enqueue(new Uint8Array(MB).fill(i++));
            },
          }),
        );
      }
      case "/early":
        // Answers WITHOUT reading the body.
        return new Response("early", { status: 401 });
      case "/cancelled":
        // Says it will not read the body.
        await req.body?.cancel();
        return new Response("cancelled", { status: 401 });
      case "/throw":
        throw new Error("boom");
      case "/notresp":
        return "not a response" as unknown as Response;
      case "/used": {
        const r = new Response("abc");
        await r.text();
        return r;
      }
      case "/sse":
        // One event, then silence: only the server can notice the client left.
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(enc.encode("data: x\n\n"));
            },
            cancel() {
              bump(`cancel ${p}`);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      case "/poll":
        // A long poll: no response until something happens — here, the abort.
        await new Promise((r) => req.signal.addEventListener("abort", r));
        bump("poll ended");
        return new Response("late");
      case "/count":
        for await (const c of req.body!) progress.bytes += c.length;
        return new Response(String(progress.bytes));
      case "/late": {
        // The body is read AFTER the response began.
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(ctrl) {
              await new Promise((r) => setTimeout(r, 30));
              const parts: Uint8Array[] = [];
              for await (const c of req.body!) parts.push(c);
              ctrl.enqueue(enc.encode(digest(parts)));
              ctrl.close();
            },
          }),
        );
      }
      case "/hops":
        // Answers at once, but not in one step — what any `async` route
        // with a few awaits of its own is.
        for (let i = 0; i < 100; i++) await null;
        return new Response("hops");
      case "/slow":
        await new Promise((r) =>
          setTimeout(r, Number(u.searchParams.get("d")))
        );
        return new Response(u.search);
      case "/zero": {
        // A stream with an EMPTY chunk in the middle.
        const parts = ["a", "", "b"].map((t) => enc.encode(t));
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(ctrl) {
              const next = parts.shift();
              if (next) ctrl.enqueue(next);
              else ctrl.close();
            },
          }),
        );
      }
      case "/readall":
        // Does a route that reads the whole upload learn it was cut short?
        try {
          bump(`read ${(await req.arrayBuffer()).byteLength}`);
        } catch (e) {
          bump(`read failed, ${(e as Error).name}`);
        }
        return new Response("read");
      case "/drip": {
        // A stream that takes a while and then ENDS.
        let i = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(ctrl) {
              await new Promise((r) => setTimeout(r, 60));
              if (i === 5) return ctrl.close();
              ctrl.enqueue(enc.encode(`drip ${i++}\n`));
            },
          }),
        );
      }
      case "/blob":
        return new Response(new Blob(["two ", "parts"]));
      case "/blob1":
        return new Response(new Blob(["one"]));
      case "/stream1":
        // A stream that is one chunk, complete before anyone reads it.
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(enc.encode("one"));
              ctrl.close();
            },
          }),
          // …with a length declared for it, when asked: `?cl=2`.
          u.searchParams.has("cl")
            ? { headers: { "content-length": u.searchParams.get("cl")! } }
            : undefined,
        );
      case "/spelled":
        // Header names in the handler's own spelling and order.
        return new Response("spelled", {
          headers: [["X-Zebra", "1"], ["Content-Type", "text/plain"], [
            "x-alpha",
            "2",
          ]],
        });
      case "/426":
        // A handler with a `Connection` header of its own.
        return new Response("upgrade required", {
          status: 426,
          headers: { connection: "Upgrade", upgrade: "websocket" },
        });
      case "/under":
        // A stream SHORTER than the length its handler declared for it.
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(ctrl) {
              await new Promise((r) => setTimeout(r, 5));
              ctrl.enqueue(enc.encode("abc"));
              ctrl.close();
            },
          }),
          { headers: { "content-length": "10" } },
        );
      case "/short": {
        // A stream longer than the length its handler declared for it.
        const parts = ["abc", "defgh", "ij"].map((t) => enc.encode(t));
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(ctrl) {
              await new Promise((r) => setTimeout(r, 5));
              const next = parts.shift();
              if (next) ctrl.enqueue(next);
              else ctrl.close();
            },
            cancel() {
              bump(`cancel ${p}`);
            },
          }),
          { headers: { "content-length": "5" } },
        );
      }
      case "/te":
        // A handler that names a framing of its own.
        return new Response("te-body", {
          headers: { "transfer-encoding": "chunked", "content-length": "7" },
        });
      case "/text":
        return new Response("x".repeat(4096), {
          headers: { "content-type": "text/plain" },
        });
      default:
        return new Response(`${req.method} ${p}`, { status: 404 });
    }
  };
  return { counts, handler, progress };
}

// ── Four servers, one handler ────────────────────────────────────────────────

const KINDS = ["Deno.serve", "over", "over+peer", "over+streams"] as const;
type Kind = typeof KINDS[number];
/** `v` once per server — what every one of them must answer. */
const each = <T>(v: T): T[] => KINDS.map(() => v);
/** `ref` for `Deno.serve`, `v` for each of this server's backends. */
const ours = <T>(ref: T, v: T): T[] => KINDS.map((_, i) => i === 0 ? ref : v);

/** A listener whose connections are a stream pair and nothing else — no
 *  `read`/`write` — so the server takes the path it takes on a Windows pipe.
 *  The streams are built on the connection's own reads and writes (a
 *  `Deno.Conn`'s `readable` closes the whole connection at end of input,
 *  which a pipe's does not). */
function streamsOnly(inner: LocalListener): LocalListener {
  return {
    path: inner.path,
    close: () => inner.close(),
    async *[Symbol.asyncIterator]() {
      for await (const c of inner) {
        yield {
          readable: new ReadableStream<Uint8Array>({
            async pull(ctrl) {
              const into = new Uint8Array(64 * 1024);
              const n = await c.read!(into).catch(() => null);
              if (n === null) ctrl.close();
              else ctrl.enqueue(into.subarray(0, n));
            },
          }),
          writable: new WritableStream<Uint8Array>({
            write: (chunk) => c.write!(chunk),
          }),
          remoteAddr: c.remoteAddr,
          drain: () => c.drain!(),
          close: () => c.close(),
        };
      }
    },
  };
}
type Srv = {
  kind: Kind;
  path: string;
  counts: Counts;
  progress: { bytes: number };
  close(): Promise<void>;
};

async function waitBound(p: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    try {
      if (Deno.lstatSync(p).isSocket) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`listener never bound ${p}`);
}

type Timing = { headDeadlineMs?: number; closeDrainMs?: number };

async function start(kind: Kind, dir: string, timing: Timing): Promise<Srv> {
  // Names of one length: a body that quotes `req.url` is then as long under
  // every server, and so is its Content-Length.
  const path = join(dir, `s${KINDS.indexOf(kind)}.sock`);
  const { counts, handler, progress } = app();
  if (kind === "Deno.serve") {
    // No `onError`: its DEFAULT answer to a throwing handler is the reference.
    const s = Deno.serve({ path, onListen: () => {} }, handler);
    return { kind, path, counts, progress, close: () => s.shutdown() };
  }
  const s = serveHttpOverLocal(
    kind === "over+streams"
      ? streamsOnly(listenLocal(path))
      : listenLocal(path, kind === "over+peer" ? { peer: true } : undefined),
    handler,
    undefined,
    { unixUrls: true, ...timing },
  );
  await waitBound(path);
  return { kind, path, counts, progress, close: () => s.close() };
}

async function lab(
  f: (servers: Srv[]) => Promise<void>,
  timing: Timing = {},
): Promise<void> {
  const dir = await tempDir("hoc-diff-");
  const servers: Srv[] = [];
  try {
    for (const k of KINDS) servers.push(await start(k, dir, timing));
    await f(servers);
  } finally {
    for (const s of servers) await s.close();
    await dropTempDir(dir);
  }
}

// ── The client: raw bytes in, a parsed answer out ────────────────────────────

type Answer = {
  /** `HTTP/1.x` of the status line. */
  version: string;
  status: number;
  reason: string;
  /** Interim (1xx) statuses that came first. */
  interim: number[];
  headers: Headers;
  /** The header names as written on the wire, in order. */
  names: string[];
  body: Uint8Array;
  /** Why the client could not finish writing its request, if it could not. */
  writeError: string | null;
  /** Nothing came back at all. */
  empty: boolean;
  ms: number;
};

const latin1 = (b: Uint8Array) =>
  Array.from(b, (x) => String.fromCharCode(x)).join("");

function find(buf: Uint8Array, seq: string, from = 0): number {
  outer: for (let i = from; i + seq.length <= buf.length; i++) {
    for (let j = 0; j < seq.length; j++) {
      if (buf[i + j] !== seq.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

/** `s` as bytes, one per character — for requests with bytes ≥ 0x80 in them,
 *  which `TextEncoder` would write as two. */
const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function parse(raw: Uint8Array): Omit<Answer, "writeError" | "ms"> {
  const interim: number[] = [];
  let at = 0;
  while (true) {
    const end = find(raw, "\r\n\r\n", at);
    if (end < 0) {
      return {
        version: "",
        status: 0,
        reason: "",
        interim,
        headers: new Headers(),
        names: [],
        body: raw.subarray(at),
        empty: raw.length === 0,
      };
    }
    // Header bytes are latin1 on the wire; decoded as such, never as UTF-8.
    const lines = latin1(raw.subarray(at, end)).split("\r\n");
    const m = /^HTTP\/(1\.[01]) (\d{3}) ?(.*)$/.exec(lines[0]!);
    assert(m, `bad status line ${JSON.stringify(lines[0])}`);
    at = end + 4;
    const status = Number(m[2]);
    if (status < 200) {
      interim.push(status);
      continue;
    }
    const headers = new Headers();
    const names: string[] = [];
    for (const l of lines.slice(1)) {
      const i = l.indexOf(":");
      names.push(l.slice(0, i));
      headers.append(l.slice(0, i), l.slice(i + 1).trim());
    }
    let rest = raw.subarray(at);
    if (headers.get("transfer-encoding") === "chunked") {
      const parts: Uint8Array[] = [];
      while (true) {
        const nl = find(rest, "\r\n");
        if (nl < 0) break; // truncated — the caller sees a short body
        const size = parseInt(latin1(rest.subarray(0, nl)), 16);
        rest = rest.subarray(nl + 2);
        if (size === 0) break;
        parts.push(rest.subarray(0, size));
        rest = rest.subarray(size + 2);
      }
      rest = concat(parts);
    }
    return {
      version: m[1]!,
      status,
      reason: m[3]!,
      interim,
      headers,
      names,
      body: rest,
      empty: false,
    };
  }
}

type Part = string | Uint8Array;

/** Send `parts` (each one write), read until the server closes. Writing and
 *  reading run side by side, as a real client's do — a server that answers
 *  before the upload is finished must not fail the upload's writer. */
async function send(
  path: string,
  parts: Part[] | AsyncIterable<Part>,
  o: { halfClose?: boolean; ms?: number } = {},
): Promise<Answer> {
  const c = await Deno.connect({ transport: "unix", path });
  const t0 = performance.now();
  const timer = setTimeout(() => {
    try {
      c.close();
    } catch { /* already closed */ }
  }, o.ms ?? 60_000);
  let writeError: string | null = null;
  const writing = (async () => {
    try {
      for await (const p of parts as AsyncIterable<Part>) {
        const b = typeof p === "string" ? enc.encode(p) : p;
        for (let off = 0; off < b.length;) {
          off += await c.write(b.subarray(off));
        }
      }
      if (o.halfClose) await c.closeWrite();
    } catch (e) {
      writeError = (e as Error).name;
    }
  })();
  const got: Uint8Array[] = [];
  try {
    const b = new Uint8Array(1 << 16);
    while (true) {
      const n = await c.read(b);
      if (n === null) break;
      got.push(b.slice(0, n));
    }
  } catch { /* closed by the deadline, or reset by the server */ }
  await writing;
  clearTimeout(timer);
  try {
    c.close();
  } catch { /* already closed */ }
  return { ...parse(concat(got)), writeError, ms: performance.now() - t0 };
}

/** A request head with `Connection: close`, so `Deno.serve` ends the
 *  connection after its answer the way the other server always does. */
const head = (line: string, ...headers: string[]) =>
  [`${line} HTTP/1.1`, "Host: localhost", "Connection: close", ...headers]
    .join("\r\n") + "\r\n\r\n";

/** How an unnamed host appears in `req.url` — the socket path, every byte
 *  that is not an ASCII letter or digit percent-encoded. Each server has its
 *  own socket, so its own path is replaced by a placeholder before comparing. */
const encodedPath = (p: string) =>
  Array.from(
    enc.encode(p),
    (b) =>
      /[A-Za-z0-9]/.test(String.fromCharCode(b))
        ? String.fromCharCode(b)
        : "%" + b.toString(16).toUpperCase().padStart(2, "0"),
  ).join("");

/** The one header that describes the moment, not the answer. The framing —
 *  `Content-Length` or `Transfer-Encoding` — and `Connection` are compared: a
 *  client sees them (`fetch().headers.get("content-length")`, a `HEAD` size
 *  probe, an agent deciding whether to reuse the connection). */
const FRAMING = new Set(["date"]);

/** What must be equal between two servers. */
function view(a: Answer, s: Srv) {
  const text = a.body.length <= 8192
    ? new TextDecoder().decode(a.body).replaceAll(encodedPath(s.path), "<SOCK>")
    : digest(a.body);
  return {
    status: a.status,
    reason: a.reason,
    interim: a.interim,
    headers: [...a.headers].filter(([k]) => !FRAMING.has(k)).sort(),
    body: text,
    writeError: a.writeError,
    empty: a.empty,
  };
}

/** Run one request against every server; all answers must equal `Deno.serve`'s.
 *  Returns the answers, reference first. */
async function same(
  servers: Srv[],
  name: string,
  parts: () => Part[] | AsyncIterable<Part>,
  o?: { halfClose?: boolean },
): Promise<Answer[]> {
  const answers: Answer[] = [];
  for (const s of servers) answers.push(await send(s.path, parts(), o));
  for (let i = 1; i < servers.length; i++) {
    assertEquals(
      view(answers[i]!, servers[i]!),
      view(answers[0]!, servers[0]!),
      `${name}: ${servers[i]!.kind} differs from Deno.serve`,
    );
  }
  return answers;
}

/** Several requests down ONE connection: each answer's status and what it
 *  says of the connection, and whether the server ended it within `ms`. */
async function talk(
  path: string,
  /** One byte per character. */
  raw: string,
  ms = 1000,
): Promise<{ answers: [number, string | null][]; closed: boolean }> {
  const c = await Deno.connect({ transport: "unix", path });
  await c.write(bytes(raw));
  const timer = setTimeout(() => c.close(), ms);
  let got = "", closed = false;
  try {
    const b = new Uint8Array(1 << 16);
    while (true) {
      const n = await c.read(b);
      if (n === null) {
        closed = true;
        break;
      }
      got += latin1(b.subarray(0, n));
    }
  } catch { /* closed by the timer: the server kept the connection */ }
  clearTimeout(timer);
  try {
    c.close();
  } catch { /* already closed */ }
  const answers = got.split(/(?=HTTP\/1\.[01] \d{3} )/).filter(Boolean).map(
    (a): [number, string | null] => [
      Number(a.slice(9, 12)),
      /\r\nconnection: ([^\r]*)/i.exec(a.split("\r\n\r\n")[0]!)?.[1] ?? null,
    ],
  );
  return { answers, closed };
}

/** What each handler was told (`abort`, `cancel`) must be equal too — polled,
 *  because a server learns a client left a moment after it did. */
async function sameCounts(servers: Srv[], name: string): Promise<void> {
  const settled = () =>
    servers.every((s) =>
      JSON.stringify(sorted(s.counts)) === JSON.stringify(sorted(ref.counts))
    );
  const ref = servers[0]!;
  for (let i = 0; i < 300 && !settled(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  // …and stays equal: a count that is still climbing is not a settled one.
  await new Promise((r) => setTimeout(r, 100));
  for (const s of servers.slice(1)) {
    assertEquals(
      sorted(s.counts),
      sorted(ref.counts),
      `${name}: what the handler was told under ${s.kind} differs from Deno.serve`,
    );
  }
}
const sorted = (c: Counts) =>
  Object.fromEntries(Object.entries(c).sort(([a], [b]) => a < b ? -1 : 1));

// ── The matrix ───────────────────────────────────────────────────────────────

Deno.test("differential: methods, statuses, headers and small bodies", async () => {
  await lab(async (servers) => {
    for (
      const m of [
        "GET",
        "DELETE",
        "OPTIONS",
        "HEAD",
        "PURGE",
        "M-SEARCH",
        "A1_B.C",
      ]
    ) {
      const [ref] = await same(
        servers,
        `${m} /seen`,
        () => [head(`${m} /seen?a=1&b=%20x`, "X-In: v", "Cookie: s=1")],
      );
      assertEquals(ref!.status, 200);
      assertEquals(ref!.body.length === 0, m === "HEAD");
    }
    for (const m of ["POST", "PUT", "PATCH"]) {
      const [ref] = await same(
        servers,
        `${m} /seen with a body`,
        () => [
          head(`${m} /seen`, "Content-Type: text/plain", "Content-Length: 11"),
          "hello world",
        ],
      );
      assertEquals(
        JSON.parse(latin1(ref!.body)).body,
        digest(enc.encode("hello world")),
      );
    }
    for (const p of ["/204", "/304", "/302", "/299", "/cookies", "/nowhere"]) {
      await same(servers, `GET ${p}`, () => [head(`GET ${p}`)]);
    }
    const [cookies] = await same(
      servers,
      "two Set-Cookie",
      () => [head("GET /cookies")],
    );
    assertEquals(cookies!.headers.getSetCookie(), [
      "a=1; Path=/",
      "b=2; HttpOnly",
    ]);
    assertEquals(cookies!.headers.get("x-multi"), "one, two");
    // HEAD of a route with a body, a GET that carries one, an empty POST.
    await same(servers, "HEAD /binary", () => [head("HEAD /binary")]);
    await same(
      servers,
      "GET with a body",
      () => [head("GET /seen", "Content-Length: 3"), "abc"],
    );
    await same(
      servers,
      "POST Content-Length: 0",
      () => [head("POST /seen", "Content-Length: 0")],
    );
    // Every status a Response can carry: the same status line, whatever
    // `statusText` the handler set.
    for (let c = 200; c < 600; c++) {
      if (c === 204 || c === 304) continue; // above
      const [a] = await same(
        servers,
        `status ${c}`,
        () => [head(`GET /status?c=${c}`)],
      );
      assertEquals(a!.status, c);
    }
    // A declared Content-Length is the one framing header both must send.
    const declared = await same(
      servers,
      "declared",
      () => [head("GET /declared")],
    );
    assertEquals(
      declared.map((a) => [
        a.headers.get("content-length"),
        a.headers.get("transfer-encoding"),
      ]),
      each(["5", null]),
    );
    // Every answer is dated.
    assertEquals(
      declared.map((a) =>
        Number.isNaN(Date.parse(a.headers.get("date") ?? ""))
      ),
      each(false),
    );
    await sameCounts(servers, "small requests");
  });
});

Deno.test("differential: framing — Content-Length for a body that is already whole, chunked for a stream, HEAD as its GET", async () => {
  await lab(async (servers) => {
    // [path, the GET's Content-Length — null: chunked]
    const rows: [string, string | null][] = [
      ["/299", "6"], // a string
      ["/binary", "70000"], // bytes
      ["/cookies", "7"],
      ["/latin1", "6"],
      ["/throw", "21"],
      ["/status?c=200", "10"],
      ["/status?c=206", "10"],
      ["/blob", null], // read part by part
      ["/drip", null],
      ["/zero", null],
      ["/stream30", null],
    ];
    for (const [p, length] of rows) {
      const [get] = await same(servers, `GET ${p}`, () => [head(`GET ${p}`)]);
      const [h] = await same(servers, `HEAD ${p}`, () => [head(`HEAD ${p}`)]);
      const framing = (a: Answer) => [
        a.headers.get("content-length"),
        a.headers.get("transfer-encoding"),
      ];
      assertEquals(
        framing(get!),
        length === null ? [null, "chunked"] : [length, null],
        `GET ${p}`,
      );
      assertEquals(framing(h!), [length, null], `HEAD ${p}`);
      assertEquals(h!.body.length, 0, `HEAD ${p}`);
    }
    // An empty chunk in the middle of a stream is not the end of it.
    const [zero] = await same(servers, "zero", () => [head("GET /zero")]);
    assertEquals(latin1(zero!.body), "ab");
    // A handler that names a framing of its own: never both on the wire.
    for (const m of ["GET", "HEAD"]) {
      const [te] = await same(servers, `${m} /te`, () => [head(`${m} /te`)]);
      assertEquals(
        [
          te!.headers.get("content-length"),
          te!.headers.get("transfer-encoding"),
        ],
        m === "GET" ? [null, "chunked"] : ["7", null],
      );
    }
    // A stream is cut at the length its handler declared for it.
    const [short] = await same(servers, "short", () => [head("GET /short")]);
    assertEquals(
      [latin1(short!.body), short!.headers.get("content-length")],
      ["abcde", "5"],
    );
    await sameCounts(servers, "framing");
  });
});

Deno.test("differential: what Deno.serve tolerates is tolerated — empty lines before the request, codings before the final chunked, an Upgrade offer that is not WebSocket", async () => {
  await lab(async (servers) => {
    for (const lead of ["\r\n", "\r\n\r\n\r\n", "\n"]) {
      const [ref] = await same(
        servers,
        `leading ${JSON.stringify(lead)}`,
        () => [lead + head("GET /299")],
      );
      assertEquals(ref!.status, 299);
    }
    // Codings before the final `chunked` — any name but `identity`, on one
    // line or several — are the route's to undo; the body is de-chunked.
    for (
      const lines of [
        ["Transfer-Encoding: gzip, chunked"],
        ["Transfer-Encoding: x-foo ,\tCHUNKED "],
        [
          "Transfer-Encoding: gzip",
          "Transfer-Encoding: gzip",
          "Transfer-Encoding: chunked",
        ],
        ["Transfer-Encoding: identityx;q=1, chunked"],
      ]
    ) {
      const [ref] = await same(servers, lines.join(" | "), () => [
        head("POST /seen", ...lines) + "3\r\nabc\r\n0\r\n\r\n",
      ]);
      assertEquals(ref!.status, 200, lines.join(" | "));
    }
    // `curl --http2` over a socket offers h2c; the server may ignore any
    // offer, and the request is served.
    for (const offer of ["h2c", "foo/2"]) {
      const [ref] = await same(servers, `Upgrade: ${offer}`, () => [
        "GET /seen HTTP/1.1\r\nHost: localhost\r\n" +
        `Connection: Upgrade, close\r\nUpgrade: ${offer}\r\n\r\n`,
      ]);
      assertEquals(ref!.status, 200);
    }
  });
});

Deno.test("differential: a body ends where its length says; an upload cut short FAILS the route reading it; a HEAD cancels the stream it does not send", async () => {
  await lab(async (servers) => {
    // Bytes after the declared length are not the body.
    const [extra] = await same(servers, "Content-Length: 3 + 8 bytes", () => [
      head("POST /seen", "Content-Length: 3") + "abcdefgh",
    ]);
    assertEquals(
      JSON.parse(latin1(extra!.body)).body,
      digest(enc.encode("abc")),
    );
    // 1000 of 100000 bytes, then the client is gone: a truncated upload must
    // never look like a complete one.
    for (const s of servers) {
      for (
        const framing of [
          "Content-Length: 100000\r\n\r\n",
          "Transfer-Encoding: chunked\r\n\r\n186a0\r\n",
        ]
      ) {
        const c = await Deno.connect({ transport: "unix", path: s.path });
        await c.write(enc.encode(
          `POST /readall HTTP/1.1\r\nHost: localhost\r\n${framing}`,
        ));
        await c.write(new Uint8Array(1000));
        await new Promise((r) => setTimeout(r, 50));
        c.close();
      }
    }
    // A HEAD of a streaming route: the stream is not sent, so it is cancelled.
    const [h] = await same(servers, "HEAD /sse", () => [head("HEAD /sse")]);
    assertEquals([h!.status, h!.body.length], [200, 0]);
    await sameCounts(servers, "bodies that end");
    assertEquals(sorted(servers[0]!.counts), {
      "abort /readall": 2,
      "abort /seen": 1,
      "abort /sse": 1,
      "cancel /sse": 1,
      "completed /readall": 2,
      "completed /seen": 1,
      "completed /sse": 1,
      "read failed, BadResource": 2,
    });
  });
});

Deno.test("differential: req.url — host, no host, absolute-form, asterisk", async () => {
  await lab(async (servers) => {
    const urlOf = (a: Answer, s: Srv) =>
      (JSON.parse(latin1(a.body)).url as string)
        .replace(encodedPath(s.path), "<SOCK>");
    const rows: [string, string, string][] = [
      // The frozen value: what a route on the unix socket has always seen.
      [
        "GET /seen?q=1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        "Host: localhost",
        "http+unix://localhost/seen?q=1",
      ],
      [
        "GET /seen HTTP/1.1\r\nHost: app:8080\r\nConnection: close\r\n\r\n",
        "Host with a port",
        "http+unix://app:8080/seen",
      ],
      [
        "GET /seen HTTP/1.1\r\nConnection: close\r\n\r\n",
        "no Host",
        "http+unix://<SOCK>/seen",
      ],
      [
        "GET /seen HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n",
        "an empty Host",
        "http+unix://<SOCK>/seen",
      ],
      [
        "GET http://other.example/seen?q=2 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        "absolute-form",
        "http://other.example/seen?q=2",
      ],
      [
        "GET /seen?x=%41%20b&y=a+b HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        "escapes are left as sent",
        "http+unix://localhost/seen?x=%41%20b&y=a+b",
      ],
    ];
    for (const [raw, name, want] of rows) {
      const answers = await same(servers, `req.url, ${name}`, () => [raw]);
      for (let i = 0; i < servers.length; i++) {
        assertEquals(
          urlOf(answers[i]!, servers[i]!),
          want,
          `${name} (${servers[i]!.kind})`,
        );
      }
    }
    await same(
      servers,
      "OPTIONS *",
      () => [
        "OPTIONS * HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      ],
    );
  });
});

Deno.test("differential: header bytes are latin1, both ways", async () => {
  await lab(async (servers) => {
    // é, and two bytes that are C1 controls in latin1 but letters in
    // windows-1252 — the decoder a `"latin1"` label would have picked.
    const req = () => [
      concat([
        enc.encode(
          "GET /seen HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nX-Title: caf",
        ),
        Uint8Array.of(0xe9, 0x80, 0x9f),
        enc.encode("\r\n\r\n"),
      ]),
    ];
    const [ref] = await same(servers, "request header ≥ 0x80", req);
    assertEquals(ref!.status, 200);
    const seen = new Map<string, string>(JSON.parse(latin1(ref!.body)).headers);
    assertEquals(seen.get("x-title"), "63 61 66 e9 80 9f");
    // (Equal across the servers, or `same` had thrown.)
    const [out] = await same(
      servers,
      "response header ≥ 0x80",
      () => [head("GET /latin1")],
    );
    assertEquals(out!.headers.get("x-title"), "caf\u00e9");
  });
});

Deno.test("differential: whitespace on the wire is SP and HTAB — no other byte is cut from a value's edge or stands between the members of a list", async () => {
  await lab(async (servers) => {
    // A value is BYTES. 0xA0 is a no-break space to JavaScript and the last
    // byte of a UTF-8 `à` to whoever sent it; 0x85 and U+2028 are "line
    // ends" to `\s`. All of them belong to the value.
    const rows: [string, string, string][] = [
      ["NBSP at both edges", "\u00a0v\u00a0", "a0 76 a0"],
      ["NEL at both edges", "\u0085v\u0085", "85 76 85"],
      [
        "U+2028, as UTF-8, at both edges",
        "\u00e2\u0080\u00a8v\u00e2\u0080\u00a8",
        "e2 80 a8 76 e2 80 a8",
      ],
      ["a UTF-8 à at the end", "voil\u00c3\u00a0", "76 6f 69 6c c3 a0"],
      ["SP and HTAB at both edges", " \t v \t ", "76"],
      ["HTAB inside", "a\tb", "61 9 62"],
    ];
    for (const [name, value, hex] of rows) {
      const [ref] = await same(servers, name, () => [
        bytes(head("GET /seen", `X-Edge: ${value}`)),
      ]);
      const seen = new Map<string, string>(
        JSON.parse(latin1(ref!.body)).headers,
      );
      assertEquals(seen.get("x-edge"), hex, name);
    }
    // A list member is its token, and `close` + NBSP is not `close`.
    const R = (...headers: string[]) =>
      ["GET /299 HTTP/1.1", "Host: localhost", ...headers].join("\r\n") +
      "\r\n\r\n";
    type Talk = Awaited<ReturnType<typeof talk>>;
    const kept: Talk = { answers: [[299, null], [299, "close"]], closed: true };
    const ended: Talk = { answers: [[299, "close"]], closed: true };
    const lists: [string, Talk][] = [
      ["Connection: close\u00a0", kept],
      ["Connection: \u00a0close", kept],
      ["Connection: x,\u00a0close", kept],
      ["Connection: x,\tclose\t", ended],
      ["Connection: x , CLOSE", ended],
    ];
    for (const [line, want] of lists) {
      const got = [];
      for (const s of servers) {
        got.push(await talk(s.path, R(line) + R("Connection: close")));
      }
      assertEquals(got, each(want), JSON.stringify(line));
    }
    // `websocket` + NBSP is no WebSocket offer (the request is served), and
    // `100-continue` + NBSP is no expectation (no interim answer).
    await same(servers, "Upgrade: websocket NBSP", () => [
      bytes(head("GET /299", "Upgrade: websocket\u00a0")),
    ]);
    const [quiet] = await same(servers, "Expect: 100-continue NBSP", () => [
      bytes(
        head("POST /seen", "Content-Length: 3", "Expect: 100-continue\u00a0"),
      ),
      "abc",
    ]);
    assertEquals([quiet!.status, quiet!.interim], [200, []]);
    // …and the real expectation is met for an HTTP/1.0 client too.
    const old = [];
    for (const s of servers) {
      const a = await send(s.path, [
        "POST /seen HTTP/1.0\r\nContent-Length: 3\r\nExpect: 100-continue\r\n\r\n",
        "abc",
      ]);
      old.push([a.status, a.interim]);
    }
    assertEquals(old, each([200, [100]]));
    // A length of sixteen digits is a length.
    const long: number[] = [];
    for (const s of servers) {
      long.push(
        (await send(s.path, [
          head("POST /early", "Content-Length: 1000000000000000") + "abc",
        ], { ms: 1500 })).status,
      );
    }
    assertEquals(long, each(401));
  });
});

Deno.test("differential: binary and streamed bodies, both directions", async () => {
  await lab(async (servers) => {
    const [bin] = await same(
      servers,
      "70 KB binary",
      () => [head("GET /binary")],
    );
    assertEquals(bin!.body, BINARY);
    const [big] = await same(
      servers,
      "30 MB stream",
      () => [head("GET /stream30")],
    );
    assertEquals(big!.body.length, 30 * MB);

    // Content-Length upload, 20 MB.
    const piece = new Uint8Array(MB).fill(9);
    const [up] = await same(
      servers,
      "20 MB Content-Length upload",
      () =>
        (async function* () {
          yield head("POST /seen", `Content-Length: ${20 * MB}`);
          for (let i = 0; i < 20; i++) yield piece;
        })(),
    );
    assertEquals(
      JSON.parse(latin1(up!.body)).body,
      digest(Array.from({ length: 20 }, () => piece)),
    );

    // Chunked upload in small chunks, with an extension and a trailer.
    const small = new Uint8Array(1000).fill(3);
    await same(
      servers,
      "chunked upload, 2000 small chunks",
      () =>
        (async function* () {
          yield head("POST /seen", "Transfer-Encoding: chunked");
          for (let i = 0; i < 2000; i += 100) {
            const frames: Uint8Array[] = [];
            for (let j = 0; j < 100; j++) {
              frames.push(enc.encode("3e8;x=1\r\n"), small, enc.encode("\r\n"));
            }
            yield concat(frames);
          }
          yield "0\r\nX-Trailer: t\r\n\r\n";
        })(),
    );

    // Chunked upload as ONE 64 MB chunk — a chunk is as large as the sender
    // likes. Collected whole before it was handed on, this took half a minute
    // and a third of a gigabyte; it must stream.
    const answers = await same(
      servers,
      "chunked upload, one 64 MB chunk",
      () =>
        (async function* () {
          yield head("POST /seen", "Transfer-Encoding: chunked");
          yield (64 * MB).toString(16) + "\r\n";
          for (let i = 0; i < 64; i++) yield piece;
          yield "\r\n0\r\n\r\n";
        })(),
    );
    assertEquals(
      JSON.parse(latin1(answers[0]!.body)).body.split(":")[0],
      String(64 * MB),
    );
    for (let i = 1; i < servers.length; i++) {
      assert(
        answers[i]!.ms < 10_000,
        `a 64 MB chunk took ${Math.round(answers[i]!.ms)} ms under ` +
          `${servers[i]!.kind} (Deno.serve: ${Math.round(answers[0]!.ms)} ms)`,
      );
    }

    // …and the proof that it does: the handler holds the first megabyte of
    // a 64 MB chunk while the other 63 have not been sent yet.
    const handedOn: unknown[] = [];
    for (const s of servers) {
      let seen = 0;
      const a = await send(
        s.path,
        (async function* () {
          yield head("POST /count", "Transfer-Encoding: chunked");
          yield (64 * MB).toString(16) + "\r\n";
          yield piece;
          for (let i = 0; i < 500 && s.progress.bytes === 0; i++) {
            await new Promise((r) => setTimeout(r, 10));
          }
          seen = s.progress.bytes;
          for (let i = 1; i < 64; i++) yield piece;
          yield "\r\n0\r\n\r\n";
        })(),
      );
      handedOn.push([s.kind, seen > 0, a.status, latin1(a.body)]);
    }
    assertEquals(
      handedOn,
      KINDS.map((k) => [k, true, 200, String(64 * MB)]),
      "a server handed the handler nothing until the whole chunk had arrived",
    );

    // Transfer codings before `chunked` are the handler's to undo.
    await same(servers, "Transfer-Encoding: gzip, chunked", () => [
      head("POST /seen", "Transfer-Encoding: gzip, Chunked"),
      "3\r\nabc\r\n0\r\n\r\n",
    ]);
    // Expect: 100-continue — the interim answer, then the real one.
    const [cont] = await same(servers, "Expect: 100-continue", () => [
      head("POST /seen", "Expect: 100-continue", "Content-Length: 3"),
      "abc",
    ]);
    assertEquals(cont!.interim, [100]);
    // …also when the handler then answers without reading the body.
    const [unread] = await same(servers, "Expect, body unread", () => [
      head("POST /early", "Expect: 100-continue", "Content-Length: 3"),
      "abc",
    ]);
    assertEquals([unread!.interim, unread!.status], [[100], 401]);
    // A client that accepts compressed answers gets the same bytes from both.
    for (const p of ["/text", "/seen"]) {
      const [a] = await same(servers, `Accept-Encoding, ${p}`, () => [
        head(`GET ${p}`, "Accept-Encoding: gzip, deflate, br, zstd"),
      ]);
      assertEquals(a!.headers.get("content-encoding"), null);
    }
    await sameCounts(servers, "bodies");
  });
});

Deno.test("differential: a route that answers WITHOUT reading the upload still answers", async () => {
  await lab(async (servers) => {
    // The window gets the app's 401 — not a reset connection. ~200 KB is where
    // a unix socket's buffers stop hiding an unread body.
    for (const size of [300_000, 4 * MB]) {
      const body = new Uint8Array(size);
      const [ref] = await same(servers, `unread ${size}-byte POST`, () => [
        head("POST /early", `Content-Length: ${size}`),
        body,
      ]);
      assertEquals([ref!.status, latin1(ref!.body), ref!.writeError], [
        401,
        "early",
        null,
      ]);
    }
    // The body can still be read once the response has begun.
    const late = new Uint8Array(3 * MB).fill(5);
    const [ref] = await same(
      servers,
      "body read after the response began",
      () => [
        head("POST /late", `Content-Length: ${late.length}`),
        late,
      ],
    );
    assertEquals(latin1(ref!.body), digest(late));
    await sameCounts(servers, "unread bodies");
  });
});

Deno.test("differential: a handler that throws, returns a non-Response, or a consumed one → 500", async () => {
  await lab(async (servers) => {
    for (const p of ["/throw", "/notresp", "/used"]) {
      const [ref] = await same(servers, p, () => [head(`GET ${p}`)]);
      assertEquals([ref!.status, latin1(ref!.body)], [
        500,
        "Internal Server Error",
      ]);
    }
    // …and the server keeps serving.
    await same(servers, "after the throws", () => [head("GET /299")]);
  });
});

Deno.test("differential: malformed requests are refused alike", async () => {
  await lab(async (servers) => {
    const statusOnly = (a: Answer) => a.status;
    for (
      const [name, raw] of [
        [
          "Content-Length: +3",
          head("POST /seen", "Content-Length: +3") + "abc",
        ],
        [
          "Content-Length: 0x3",
          head("POST /seen", "Content-Length: 0x3") + "abc",
        ],
        [
          "Content-Length: 3.0",
          head("POST /seen", "Content-Length: 3.0") + "abc",
        ],
        [
          "Content-Length: -1",
          head("POST /seen", "Content-Length: -1") + "abc",
        ],
        [
          "Content-Length: abc",
          head("POST /seen", "Content-Length: abc") + "abc",
        ],
        ["Content-Length empty", head("POST /seen", "Content-Length:") + "abc"],
        [
          "Content-Length: 3, 4",
          head("POST /seen", "Content-Length: 3", "Content-Length: 4") + "abcd",
        ],
        [
          "Transfer-Encoding + Content-Length",
          head(
            "POST /seen",
            "Content-Length: 3",
            "Transfer-Encoding: chunked",
          ) + "3\r\nabc\r\n0\r\n\r\n",
        ],
        [
          "Transfer-Encoding: gzip",
          head("POST /seen", "Transfer-Encoding: gzip") + "abc",
        ],
        ["header without a colon", head("GET /seen", "nocolon")],
        ["header name with a space", head("GET /seen", "Bad Name: x")],
        ["HTTP/0.9", "GET /seen\r\n\r\n"],
        ["HTTP/2.0", "GET /seen HTTP/2.0\r\nHost: localhost\r\n\r\n"],
        ["not HTTP", "NOT HTTP\r\n\r\n"],
        // Framing headers a second parser could read differently.
        [
          "a space before the colon",
          head("POST /seen", "Content-Length : 3") + "abc",
        ],
        [
          "a tab before the colon",
          head("POST /seen", "Transfer-Encoding\t: chunked") +
          "3\r\nabc\r\n0\r\n\r\n",
        ],
        [
          "a line that starts with a space (a folded line read as a header)",
          head("POST /seen", "X: a", " Content-Length: 3") + "abc",
        ],
        [
          "a line that starts with a tab",
          head("POST /seen", "X: a", "\tContent-Length: 3") + "abc",
        ],
        [
          "a first header line that starts with a space",
          "GET /seen HTTP/1.1\r\n X: a\r\nHost: localhost\r\n\r\n",
        ],
        ["a control byte in a value", head("GET /seen", "X: a\u0001b")],
        ["DEL in a value", head("GET /seen", "X: a\u007fb")],
        ["VT at a value's edges", head("GET /seen", "X: \u000bv\u000b")],
        ["FF at a value's edges", head("GET /seen", "X: \u000cv\u000c")],
        [
          "Transfer-Encoding: VT chunked",
          head("POST /seen", "Transfer-Encoding: \u000bchunked") +
          "3\r\nabc\r\n0\r\n\r\n",
        ],
        [
          "Transfer-Encoding: chunked, NBSP",
          head("POST /seen", "Transfer-Encoding: chunked\u00a0") +
          "3\r\nabc\r\n0\r\n\r\n",
        ],
        [
          "Transfer-Encoding: gzip, NBSP chunked",
          head("POST /seen", "Transfer-Encoding: gzip,\u00a0chunked") +
          "3\r\nabc\r\n0\r\n\r\n",
        ],
        [
          "Transfer-Encoding: chunked, on two lines",
          head(
            "POST /seen",
            "Transfer-Encoding: chunked",
            "Transfer-Encoding: chunked",
          ) + "3\r\nabc\r\n0\r\n\r\n",
        ],
        [
          "Transfer-Encoding: chunked, chunked",
          head("POST /seen", "Transfer-Encoding: chunked, chunked") +
          "3\r\nabc\r\n0\r\n\r\n",
        ],
        [
          "Transfer-Encoding from an HTTP/1.0 client",
          "POST /seen HTTP/1.0\r\nTransfer-Encoding: chunked\r\n\r\n" +
          "3\r\nabc\r\n0\r\n\r\n",
        ],
        [
          "Content-Length: NBSP 3",
          head("POST /seen", "Content-Length: \u00a03") + "abc",
        ],
        [
          "Content-Length: 3 FF",
          head("POST /seen", "Content-Length: 3\u000c") + "abc",
        ],
        [
          "Content-Length past 64 bits",
          head("POST /seen", "Content-Length: 18446744073709551616") + "abc",
        ],
        ["NUL in the target", head("GET /se\u0000en")],
        ["DEL in the target", head("GET /se\u007fen")],
        ["a target that is not UTF-8", head("GET /se\u00a0en")],
        // A coding list with an empty member, or `identity` in it.
        ...[
          ",chunked",
          " , chunked",
          "gzip,,chunked",
          "gzip, ,chunked",
          "chunked,",
          ",",
          "identity, chunked",
          "gzip, IDENTITY, chunked",
        ].map((te) =>
          [
            `Transfer-Encoding: ${te}`,
            head("POST /seen", `Transfer-Encoding: ${te}`) +
            "3\r\nabc\r\n0\r\n\r\n",
          ] as const
        ),
        [
          "Transfer-Encoding on two lines, the first ending in a comma",
          head(
            "POST /seen",
            "Transfer-Encoding: gzip,",
            "Transfer-Encoding: chunked",
          ) +
          "3\r\nabc\r\n0\r\n\r\n",
        ],
        // A target in a form its method may not use: `*` is for OPTIONS, the
        // authority-form for CONNECT, and anything else starts with `/` or
        // with `scheme://`.
        ...[
          "GET *",
          "POST *",
          "OPTIONS **",
          "TRACE *",
          "GET seen",
          "GET localhost:80",
          "OPTIONS localhost:80",
          "GET ?q=1",
          "GET #seen",
          "GET ./seen",
          "GET mailto:a@b",
          "GET http:/seen",
          "GET http://",
          "GET 1x://localhost/seen",
          "GET a_b://localhost/seen",
          "CONNECT /seen",
          "CONNECT *",
          "CONNECT http://localhost/",
        ].map((line) => [`the request line ${line}`, head(line)] as const),
      ] as const
    ) {
      const answers: Answer[] = [];
      for (const s of servers) answers.push(await send(s.path, [bytes(raw)]));
      assertEquals(answers.map(statusOnly), each(400), name);
    }
    // 128 header lines are a request; one more is not.
    const many = (n: number) =>
      head(
        "GET /299",
        ...Array.from({ length: n - 2 }, (_, i) => `X-${i}: v`),
      );
    const lines: number[][] = [];
    for (const s of servers) {
      lines.push([
        (await send(s.path, [many(128)])).status,
        (await send(s.path, [many(129)])).status,
      ]);
    }
    assertEquals(lines, each([299, 400]));
    // A request head has a ceiling, and it is the same one.
    const big = (n: number) => head("GET /299", `X-Big: ${"a".repeat(n)}`);
    const heads: number[][] = [];
    for (const s of servers) {
      heads.push([
        (await send(s.path, [big(60_000)], { ms: 3000 })).status,
        (await send(s.path, [big(100_000)], { ms: 3000 })).status,
      ]);
    }
    assertEquals(heads, each([299, 400]));
    // None of the refused ones reached the handler.
    assertEquals(
      servers.map((s) =>
        Object.keys(s.counts).filter((k) => !k.endsWith("/299"))
      ),
      each([]),
    );
    // A leading space is not part of the value.
    await same(servers, "Content-Length:  3", () => [
      head("POST /seen", "Content-Length:  3"),
      "abc",
    ]);
  });
});

Deno.test("differential: a client that leaves an idle stream or a long poll is NOTICED — abort and cancel", async () => {
  await lab(async (servers) => {
    /** Open, send, wait for the first byte (if any is due), and leave. */
    const leave = async (s: Srv, raw: string, awaitByte: boolean) => {
      const c = await Deno.connect({ transport: "unix", path: s.path });
      await c.write(enc.encode(raw));
      if (awaitByte) await c.read(new Uint8Array(4096));
      else await new Promise((r) => setTimeout(r, 30));
      c.close();
    };
    for (const s of servers) {
      for (let i = 0; i < 20; i++) {
        await leave(s, "GET /sse HTTP/1.1\r\nHost: localhost\r\n\r\n", true);
      }
      for (let i = 0; i < 5; i++) {
        await leave(s, "GET /poll HTTP/1.1\r\nHost: localhost\r\n\r\n", false);
      }
      // A POST whose small body nobody read, answered with an idle stream.
      for (let i = 0; i < 5; i++) {
        await leave(
          s,
          "POST /sse HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\n\r\nhello",
          true,
        );
      }
    }
    await sameCounts(servers, "clients that left");
    assertEquals(sorted(servers[0]!.counts), {
      "abort /poll": 5,
      "abort /sse": 25,
      "cancel /sse": 25,
      "completed /poll": 5,
      "completed /sse": 25,
      "poll ended": 5,
    });
  });
});

Deno.test("differential: a client that half-closes behind its request is ANSWERED by a route that answers at once; one kept waiting has left — no answer, abort, cancel", async () => {
  await lab(async (servers) => {
    // `printf 'GET … ' | nc -U app.http.sock` — the shell's way to ask. A
    // route that answers without waiting for anything answers it, whole.
    // (`/hops`: the request is not read past while the route's awaits run —
    // the end of input, already there, would take the client for gone.)
    for (
      const p of ["/299", "/seen", "/binary", "/declared", "/throw", "/hops"]
    ) {
      const [ref] = await same(servers, `half-close, ${p}`, () => [
        head(`GET ${p}`),
      ], { halfClose: true });
      assertEquals(ref!.empty, false, p);
    }
    // A client that half-closes in the MIDDLE of its body: the route reading
    // it is told (its read fails — a 500 from one that lets that through),
    // one that is not reading answers as it would have, and either answer is
    // written.
    const cut = (line: string) =>
      `${line} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nabc`;
    const [failed] = await same(servers, "half-close mid-body, read", () => [
      cut("POST /seen"),
    ], { halfClose: true });
    assertEquals(failed!.status, 500);
    const [chunkCut] = await same(servers, "half-close mid-chunk, read", () => [
      "POST /seen HTTP/1.1\r\nHost: localhost\r\n" +
      "Transfer-Encoding: chunked\r\n\r\n5\r\nab",
    ], { halfClose: true });
    assertEquals(chunkCut!.status, 500);
    const [unreadCut] = await same(
      servers,
      "half-close mid-body, not read",
      () => [cut("POST /slow?d=100")],
      { halfClose: true },
    );
    assertEquals(unreadCut!.status, 200);
    // …and in the middle of a HEAD — a connection's first, or a later one:
    // nobody asked anything, nothing is written.
    const [noHead] = await same(servers, "half-close mid-head", () => [
      "GET /29",
    ], { halfClose: true });
    assertEquals(noHead!.empty, true);
    const [oneAnswer] = await same(
      servers,
      "half-close mid second head",
      () => [
        "GET /299 HTTP/1.1\r\nHost: localhost\r\n\r\nGET /29",
      ],
      { halfClose: true },
    );
    assertEquals(latin1(oneAnswer!.body), "custom");
    for (const s of servers) for (const k in s.counts) delete s.counts[k];
    // End-of-input is the only way a closed connection shows; to a route
    // that is still working, or streaming, a half-close is the client leaving.
    for (const p of ["/slow?d=150", "/poll"]) {
      const [ref] = await same(servers, `half-close, ${p}`, () => [
        head(`GET ${p}`),
      ], { halfClose: true });
      assertEquals(ref!.empty, true, p);
    }
    // A route that had already answered: only what it is TOLD is compared.
    for (const s of servers) {
      await send(s.path, [head("GET /sse")], { halfClose: true });
    }
    // The slow route's own timer runs out inside this test, not the next.
    await new Promise((r) => setTimeout(r, 200));
    await sameCounts(servers, "half-closed clients");
    assertEquals(sorted(servers[0]!.counts), {
      "abort /poll": 1,
      "abort /slow": 1,
      "abort /sse": 1,
      "cancel /sse": 1,
      "completed /poll": 1,
      "completed /slow": 1,
      "completed /sse": 1,
      "poll ended": 1,
    });
  });
});

Deno.test("differential: 50 concurrent requests are answered independently", async () => {
  await lab(async (servers) => {
    const results: string[][] = [];
    for (const s of servers) {
      const answers = await Promise.all(
        Array.from(
          { length: 50 },
          (_, i) => send(s.path, [head(`GET /slow?d=${(i * 7) % 40}&i=${i}`)]),
        ),
      );
      results.push(answers.map((a) => `${a.status} ${latin1(a.body)}`));
    }
    assertEquals(results, each(results[0]));
    assertEquals(results[0]![49], "200 ?d=23&i=49");
    await sameCounts(servers, "concurrent");
  });
});

Deno.test("differential: keep-alive — a connection serves request after request until either side says close", async () => {
  await lab(async (servers) => {
    const R = (line: string, ...headers: string[]) =>
      [`${line} HTTP/1.1`, "Host: localhost", ...headers].join("\r\n") +
      "\r\n\r\n";
    const close = "Connection: close";
    // [what is sent down one connection, the answers, the server ended it]
    const rows: [string, string, [number, string | null][], boolean][] = [
      ["two, pipelined", R("GET /299") + R("GET /204"), [[299, null], [
        204,
        null,
      ]], false],
      [
        "the second says close; a third is not served",
        R("GET /299") + R("GET /299", close) + R("GET /299"),
        [[299, null], [299, "close"]],
        true,
      ],
      [
        "Close, in any case",
        R("GET /299", "Connection: Close") + R("GET /299"),
        [
          [299, "close"],
        ],
        true,
      ],
      [
        "close among other options",
        R("GET /299", "Connection: keep-alive, close") + R("GET /299"),
        [[299, "close"]],
        true,
      ],
      [
        "a body that was read, then another request",
        R("POST /seen", "Content-Length: 3") + "abc" + R("GET /299", close),
        [[200, null], [299, "close"]],
        true,
      ],
      [
        "a chunked body that was read, then another request",
        R("POST /seen", "Transfer-Encoding: chunked") +
        "3\r\nabc\r\n0\r\n\r\n" +
        R("GET /299", close),
        [[200, null], [299, "close"]],
        true,
      ],
      ["HEAD, then GET", R("HEAD /binary") + R("GET /299", close), [
        [200, null],
        [299, "close"],
      ], true],
      ["a stream, then GET", R("GET /drip") + R("GET /299", close), [
        [200, null],
        [299, "close"],
      ], true],
      ["a throw, then GET", R("GET /throw") + R("GET /299", close), [
        [500, null],
        [299, "close"],
      ], true],
      ["a request, then garbage", R("GET /299") + "NOT HTTP\r\n\r\n", [
        [299, null],
        [400, "close"],
      ], true],
      [
        // What the HANDLER says of the connection is sent on, not obeyed.
        "a handler's own Connection header",
        R("GET /426") + R("GET /299", close),
        [[426, "Upgrade"], [299, "close"]],
        true,
      ],
      [
        // The client is still waiting for the rest: only the close says
        // there is none.
        "a stream that ends short of its declared length",
        R("GET /under") + R("GET /299", close),
        [[200, null]],
        true,
      ],
      [
        "empty lines between requests",
        R("GET /299") + "\r\n" + R("GET /299", close),
        [
          [299, null],
          [299, "close"],
        ],
        true,
      ],
    ];
    for (const [name, raw, answers, closed] of rows) {
      const got = [];
      for (const s of servers) got.push(await talk(s.path, raw));
      const want = { answers, closed };
      assertEquals(got, each(want), name);
    }
    // An idle connection is kept for as long as its client keeps it — the
    // head deadline (200 ms here) is for a connection's first request.
    const idle: string[][] = [];
    for (const s of servers) {
      const c = await Deno.connect({ transport: "unix", path: s.path });
      const seen: string[] = [];
      for (let i = 0; i < 3; i++) {
        await c.write(enc.encode(R("GET /299")));
        const b = new Uint8Array(4096);
        const n = await c.read(b).catch(() => null);
        seen.push(latin1(b.subarray(0, n ?? 0)).slice(0, 12));
        await new Promise((r) => setTimeout(r, 300));
      }
      c.close();
      idle.push(seen);
    }
    const thrice = ["HTTP/1.1 299", "HTTP/1.1 299", "HTTP/1.1 299"];
    assertEquals(idle, each(thrice));
    await sameCounts(servers, "kept-alive connections");
  }, { headDeadlineMs: 200 });
});

Deno.test("differential: closing the server finishes the requests being answered, and drops a connection that asked nothing", async () => {
  await lab(async (servers) => {
    const got: unknown[] = [];
    for (const s of servers) {
      const idle = await Deno.connect({ transport: "unix", path: s.path });
      const half = await Deno.connect({ transport: "unix", path: s.path });
      await half.write(enc.encode("GET /299 HTTP/1.1\r\nHost: loc"));
      // …and one that was answered and is kept alive, idle.
      const kept = await Deno.connect({ transport: "unix", path: s.path });
      await kept.write(
        enc.encode("GET /299 HTTP/1.1\r\nHost: localhost\r\n\r\n"),
      );
      await kept.read(new Uint8Array(4096));
      const busy = [
        send(s.path, [head("GET /slow?d=300")]),
        send(s.path, [head("GET /drip")]),
        send(s.path, [head("GET /binary")]),
      ];
      // …and two that did NOT say close: one answered after the closing
      // began, one whose answer had begun before it.
      const keeping = [
        talk(
          s.path,
          "GET /slow?d=300 HTTP/1.1\r\nHost: localhost\r\n\r\n",
          3000,
        ),
        talk(s.path, "GET /drip HTTP/1.1\r\nHost: localhost\r\n\r\n", 3000),
      ];
      // …and two that read their answer and do NOT close their own side —
      // one that said `close`, one that did not. They are the LAST to be
      // answered: a connection whose request is answered is not waited for,
      // and its going idle is what the closing was waiting on.
      const staying = [];
      const stayers: Deno.Conn[] = [];
      for (
        const raw of [
          head("GET /slow?d=600"),
          "GET /slow?d=600 HTTP/1.1\r\nHost: localhost\r\n\r\n",
        ]
      ) {
        const c = await Deno.connect({ transport: "unix", path: s.path });
        await c.write(enc.encode(raw));
        stayers.push(c);
        staying.push((async () => {
          const b = new Uint8Array(4096);
          let text = "";
          for (let n; (n = await c.read(b)) !== null;) {
            text += latin1(b.subarray(0, n));
          }
          return text.slice(9, 12);
        })());
      }
      await new Promise((r) => setTimeout(r, 100));
      const t0 = performance.now();
      await s.close();
      const ms = performance.now() - t0;
      const answers = await Promise.all(busy);
      const kept2 = await Promise.all(keeping);
      const stayed = await Promise.all(staying);
      // (Only now: their own close would have ended the wait for them.)
      stayers.splice(0).map((c) => c.close());
      // The ones with no request under way are closed, unanswered.
      const closed = [];
      for (const c of [idle, half, kept]) {
        closed.push(await c.read(new Uint8Array(64)).catch(() => null));
        c.close();
      }
      got.push({
        answers: answers.map((a) => [a.status, a.body.length]),
        closed,
        keeping: kept2,
        stayed,
        waited: ms > 450,
        // …for the requests, not for a connection to ask another.
        prompt: ms < 1500,
      });
    }
    const want = {
      answers: [[200, 6], [200, 35], [200, 70_000]],
      closed: [null, null, null],
      keeping: [
        { answers: [[200, null]], closed: true },
        { answers: [[200, null]], closed: true },
      ],
      stayed: ["200", "200"],
      waited: true,
      prompt: true,
    };
    assertEquals(got, each(want));
    await sameCounts(servers, "closed while answering");
  });
});

Deno.test("differential: closing the server starts no new request — one pipelined behind the request in flight is never handed to the handler", async () => {
  await lab(async (servers) => {
    const got = [];
    for (const s of servers) {
      // One write: a request that takes a while, and two more behind it.
      const client = talk(
        s.path,
        "GET /slow?d=400 HTTP/1.1\r\nHost: localhost\r\n\r\n" +
          "GET /299 HTTP/1.1\r\nHost: localhost\r\n\r\n".repeat(2),
        3000,
      );
      await new Promise((r) => setTimeout(r, 50));
      await s.close();
      got.push({ ...(await client), ran: Object.keys(s.counts).sort() });
    }
    assertEquals(
      got,
      each({
        answers: [[200, null]],
        closed: true,
        ran: ["abort /slow", "completed /slow"],
      }),
    );
  });
});

// ── The deliberate differences ───────────────────────────────────────────────
//
// Each row: what `Deno.serve` does, and what this server does INSTEAD — both
// asserted. A row that goes red means one of the two changed; decide again.

Deno.test("differential EXCEPTION: req.url is a parsed URL — dot segments are resolved, what a URL escapes is escaped; a Host or an absolute target that forms none is refused", async () => {
  await lab(async (servers) => {
    // `Deno.serve` hands over the target as sent; a `Request` built from it
    // holds the URL its parser makes of it. The route reached is the same.
    const rows: [Part, string, string][] = [
      [
        "/a/../seen?q=1",
        "http+unix://localhost/a/../seen?q=1",
        "http+unix://localhost/seen?q=1",
      ],
      [
        '/seen?q=a"b',
        'http+unix://localhost/seen?q=a"b',
        "http+unix://localhost/seen?q=a%22b",
      ],
      [
        // Raw bytes ≥ 0x80 in the target (an unescaped `é`, as UTF-8).
        enc.encode("/seen?q=\u00e9"),
        "http+unix://localhost/seen?q=\u00e9",
        "http+unix://localhost/seen?q=%C3%A9",
      ],
    ];
    for (const [target, deno, over] of rows) {
      const urls: string[] = [];
      for (const s of servers) {
        const a = await send(s.path, [
          "GET ",
          target,
          " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        ]);
        urls.push(JSON.parse(new TextDecoder().decode(a.body)).url);
      }
      assertEquals(urls, ours(deno, over));
    }
    // A Host no URL can be made of: the handler is handed a `req.url` that
    // does not parse (this one's `new URL()` throws → 500); here the request
    // is refused before it.
    const st: number[] = [];
    for (const s of servers) {
      st.push(
        (await send(s.path, [head("GET /seen").replace("localhost", "a b")]))
          .status,
      );
    }
    assertEquals(st, ours(500, 400));
    // …and an absolute-form target no URL can be made of: the same there
    // (a `req.url` that does not parse), refused here.
    const abs: number[] = [];
    for (const s of servers) {
      abs.push(
        (await send(s.path, [head("GET http://localhost:99999/299")])).status,
      );
    }
    assertEquals(abs, ours(500, 400));
  });
});

Deno.test("differential EXCEPTION: request body bytes still on the connection when the answer is written end it; an HTTP/1.0 client is never kept", async () => {
  await lab(async (servers) => {
    const get = "GET /299 HTTP/1.1\r\nHost: localhost\r\n\r\n";
    // `Deno.serve` reads away a SMALL rest of a body nobody read and serves
    // the next request. Here the bytes stay where they are, the answer says
    // `close`, and the client's agent opens a new connection.
    const rows: [string, string][] = [
      [
        "a chunked body the route never read",
        "POST /early HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n" +
        "3\r\nabc\r\n0\r\n\r\n",
      ],
      [
        "a body the route cancelled",
        "POST /cancelled HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\n\r\nabc",
      ],
      [
        "a body on a GET",
        "GET /299 HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\n\r\nabc",
      ],
    ];
    for (const [name, first] of rows) {
      const got = [];
      for (const s of servers) got.push(await talk(s.path, first + get));
      assertEquals(got[0]!.answers.map((a) => a[1]), [null, null], name);
      assertEquals(got[0]!.closed, false, name);
      for (const g of got.slice(1)) {
        assertEquals(g.answers.map((a) => a[1]), ["close"], name);
        assertEquals(g.closed, true, name);
      }
    }
    // Not an exception — the two ends of the same rule, equal on every
    // server: a body that had arrived whole with its head is taken and the
    // connection kept; a LARGE unread rest ends it under `Deno.serve` too.
    const small = [];
    for (const s of servers) {
      const r = await talk(
        s.path,
        "POST /early HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\n\r\nabc" +
          get,
      );
      small.push({ said: r.answers.map((a) => a[1]), closed: r.closed });
    }
    assertEquals(small, each({ said: [null, null], closed: false }));
    const large = [];
    for (const s of servers) {
      const r = await talk(
        s.path,
        "POST /early HTTP/1.1\r\nHost: localhost\r\nContent-Length: 300000\r\n\r\n" +
          "a".repeat(300000) + get,
        1500,
      );
      large.push(r.answers.map((a) => a[1]));
    }
    assertEquals(large, each(["close"]));
    // HTTP/1.0 with `Connection: keep-alive`: kept by `Deno.serve`.
    const old = "GET /299 HTTP/1.0\r\nConnection: keep-alive\r\n\r\n";
    const got = [];
    for (const s of servers) got.push(await talk(s.path, old + old));
    assertEquals(got[0], {
      answers: [[299, "keep-alive"], [299, "keep-alive"]],
      closed: false,
    });
    for (const g of got.slice(1)) {
      assertEquals(g, { answers: [[299, "close"]], closed: true });
    }
  });
});

Deno.test("differential EXCEPTION: no WebSocket upgrade, no HTTP/2; CONNECT/TRACE and a method with a lowercase letter are refused", async () => {
  await lab(async (servers) => {
    const rows: [string, string, number][] = [
      [
        "upgrade",
        "GET /299 HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade, close\r\n\r\n",
        501,
      ],
      [
        "upgrade, among other offers",
        "GET /299 HTTP/1.1\r\nHost: localhost\r\nUpgrade: h2c, WebSocket\r\nConnection: Upgrade, close\r\n\r\n",
        501,
      ],
      [
        "CONNECT",
        "CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\nConnection: close\r\n\r\n",
        501,
      ],
      ["TRACE", head("TRACE /299"), 501],
      ["TRACK", head("TRACK /299"), 501],
      ["lowercase method", head("get /299"), 400],
      ["mixed-case method", head("Patch /299"), 400],
    ];
    for (const [name, raw, over] of rows) {
      const got: number[] = [];
      for (const s of servers) {
        got.push((await send(s.path, [raw], { ms: 3000 })).status);
      }
      // `Deno.serve` hands every one of them to the handler.
      assert(
        got[0] === 299 || got[0] === 404,
        `${name}: Deno.serve said ${got[0]}`,
      );
      assertEquals(got.slice(1), each(over).slice(1), name);
    }
    // HTTP/1.1 only. To a connection that opens with the HTTP/2 preface
    // `Deno.serve` answers in HTTP/2 (its SETTINGS frame); here it is a
    // request line this server does not know.
    const spoke: string[] = [];
    for (const s of servers) {
      const c = await Deno.connect({ transport: "unix", path: s.path });
      await c.write(bytes("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"));
      const b = new Uint8Array(4096);
      const n = (await c.read(b)) ?? 0;
      c.close();
      spoke.push(
        n >= 4 && b[3] === 4 && b[0] === 0
          ? "an HTTP/2 SETTINGS frame"
          : latin1(b.subarray(0, 12)),
      );
    }
    assertEquals(spoke, ours("an HTTP/2 SETTINGS frame", "HTTP/1.1 400"));
  });
});

Deno.test("differential EXCEPTION: a line ended by a bare LF is refused, at once; a head that has begun and never completes is ended", async () => {
  await lab(async (servers) => {
    const kept = "GET /299 HTTP/1.1\r\nHost: localhost\r\n\r\n";
    // `Deno.serve` takes LF alone for a line end. Here it is refused — as
    // soon as it is seen, not at a blank line that such a head never has —
    // as a connection's first request and as a later one.
    const lf = "GET /299 HTTP/1.1\nHost: localhost\n\n";
    const first = [], later = [], mixed = [];
    for (const s of servers) {
      first.push(await talk(s.path, lf, 800));
      later.push(await talk(s.path, kept + lf, 800));
      // One bare LF among proper lines is one too.
      mixed.push(
        await talk(
          s.path,
          "GET /299 HTTP/1.1\r\nHost: localhost\nX: y\r\n\r\n",
          800,
        ),
      );
    }
    type Talk = Awaited<ReturnType<typeof talk>>;
    const served: Talk = { answers: [[299, null]], closed: false };
    const refused: Talk = { answers: [[400, "close"]], closed: true };
    assertEquals(first, ours(served, refused));
    assertEquals(mixed, ours(served, refused));
    assertEquals(
      later,
      ours(
        { answers: [[299, null], [299, null]], closed: false },
        { answers: [[299, null], [400, "close"]], closed: true },
      ),
    );
    // A head that stops halfway: `Deno.serve` waits for the rest for as long
    // as the client stays. Here the head deadline (300 ms in this test)
    // answers it — on a connection's first request, and on a later one from
    // its first byte.
    const stalled = [], stalledLater = [];
    for (const s of servers) {
      stalled.push(await talk(s.path, "GET /299 HTTP/1.1\r\nHost: loc", 1500));
      stalledLater.push(
        await talk(s.path, kept + "GET /299 HTTP/1.1\r\nHost: loc", 1500),
      );
    }
    assertEquals(
      stalled,
      ours({ answers: [], closed: false }, {
        answers: [[408, "close"]],
        closed: true,
      }),
    );
    assertEquals(
      stalledLater,
      ours({ answers: [[299, null]], closed: false }, {
        answers: [[299, null], [408, "close"]],
        closed: true,
      }),
    );
  }, { headDeadlineMs: 300 });
});

Deno.test("differential EXCEPTION: framing — a one-chunk stream or Blob that is already complete carries Content-Length; HTTP/1.1 status line", async () => {
  await lab(async (servers) => {
    const framing = async (s: Srv, raw: string) => {
      const a = await send(s.path, [raw]);
      return [
        a.version,
        a.headers.get("content-length"),
        a.headers.get("transfer-encoding"),
        latin1(a.body),
      ];
    };
    // `Deno.serve` chunks every stream; here one whose whole body is a
    // single chunk, there before anyone reads it, is indistinguishable from a
    // body given as bytes, and is sent as one — the same bytes, with a length.
    for (const p of ["/stream1", "/blob1"]) {
      assertEquals(
        await framing(servers[0]!, head(`GET ${p}`)),
        ["1.1", null, "chunked", "one"],
      );
      assertEquals(
        await framing(servers[0]!, head(`HEAD ${p}`)),
        ["1.1", null, null, ""],
      );
      for (const s of servers.slice(1)) {
        assertEquals(
          await framing(s, head(`GET ${p}`)),
          ["1.1", "3", null, "one"],
          s.kind,
        );
        assertEquals(
          await framing(s, head(`HEAD ${p}`)),
          ["1.1", "3", null, ""],
          s.kind,
        );
      }
    }
    // …whatever length its handler declared for it: a body that is whole
    // carries its real length (as a string body does under both), where
    // `Deno.serve` cuts the stream at a shorter declared length and leaves
    // the client waiting at a longer one.
    const declared = [];
    for (const s of servers) {
      declared.push([
        await framing(s, head("GET /stream1?cl=2")),
        (await framing(s, head("GET /stream1?cl=5"))).slice(0, 3),
      ]);
    }
    assertEquals(
      declared,
      ours(
        [["1.1", "2", null, "on"], ["1.1", "5", null]],
        [["1.1", "3", null, "one"], ["1.1", "3", null]],
      ),
    );
    // An HTTP/1.0 client: answered in its own version by `Deno.serve`; here
    // as 1.1 — and a stream as a close-delimited body it can read (never
    // chunked).
    const old = "GET /299 HTTP/1.0\r\n\r\n";
    assertEquals(await framing(servers[0]!, old), ["1.0", "6", null, "custom"]);
    for (const s of servers.slice(1)) {
      assertEquals(await framing(s, old), ["1.1", "6", null, "custom"], s.kind);
      const a = await send(s.path, ["GET /drip HTTP/1.0\r\n\r\n"]);
      assertEquals(
        [
          a.version,
          a.headers.get("content-length"),
          a.headers.get("transfer-encoding"),
          a.body.length,
        ],
        ["1.1", null, null, 35],
        s.kind,
      );
    }
  });
});

Deno.test("differential EXCEPTION: the handler's header names are written lowercase and sorted", async () => {
  await lab(async (servers) => {
    // What a `Headers` gives when it is iterated is what is written:
    // `Deno.serve` writes the handler's own spelling and order. The server's
    // own headers follow, in the same order under both. A client's `Headers`
    // reads the two alike (the rows above compare that).
    const names: string[][] = [];
    for (const s of servers) {
      names.push((await send(s.path, [head("GET /spelled")])).names);
    }
    const own = ["content-length", "date", "connection"];
    const over = ["content-type", "x-alpha", "x-zebra", ...own];
    assertEquals(
      names,
      ours(["X-Zebra", "Content-Type", "x-alpha", ...own], over),
    );
  });
});

Deno.test("differential EXCEPTION: closing waits for a stream that never ends only for a bound", async () => {
  await lab(async (servers) => {
    // `Deno.serve`'s shutdown waits for an open stream for as long as its
    // caller lets it; this server's `close()` gives it a bound (shortened for
    // this test), then ends it — and tells the route, as for a client leaving.
    const waited: [string, boolean][] = [];
    for (const s of servers) {
      const c = await Deno.connect({ transport: "unix", path: s.path });
      await c.write(enc.encode(head("GET /sse")));
      await c.read(new Uint8Array(4096));
      let closed = false;
      const closing = s.close().then(() => closed = true);
      await new Promise((r) => setTimeout(r, 150));
      const early = closed;
      await new Promise((r) => setTimeout(r, 850));
      waited.push([s.kind, early || closed]);
      c.close(); // what ends the wait under `Deno.serve`
      await closing;
    }
    assertEquals(waited, [
      ["Deno.serve", false],
      ["over", true],
      ["over+peer", true],
      ["over+streams", true],
    ]);
    // Closed by the bound, not at once: the stream was given its time.
    await sameCounts(servers, "a stream cut by close");
    assertEquals(sorted(servers[1]!.counts), {
      "abort /sse": 1,
      "cancel /sse": 1,
      "completed /sse": 1,
    });
  }, { closeDrainMs: 400 });
});

Deno.test("differential EXCEPTION: closing lets a request whose upload is still arriving finish, inside its bound", async () => {
  await lab(async (servers) => {
    // The request is in flight when the closing begins, its body half sent.
    // `Deno.serve` fails the route's read of the rest (a 500 from a route
    // that lets that through); here the rest is taken and the route answers.
    const got: string[] = [];
    for (const s of servers) {
      const c = await Deno.connect({ transport: "unix", path: s.path });
      await c.write(
        enc.encode(head("POST /seen", "Content-Length: 6") + "abc"),
      );
      await new Promise((r) => setTimeout(r, 50));
      const closing = s.close();
      await new Promise((r) => setTimeout(r, 250));
      await c.write(enc.encode("def")).catch(() => 0);
      const b = new Uint8Array(4096);
      const n = (await c.read(b)) ?? 0;
      got.push(latin1(b.subarray(9, Math.min(n, 12))));
      c.close();
      await closing;
    }
    assertEquals(got, ours("500", "200"));
  });
});

Deno.test("differential EXCEPTION: a refusal says why; a repeated Content-Length, a length or chunk size past 2^53 and a malformed chunked body are 400", async () => {
  await lab(async (servers) => {
    // A 400 with a reason, where `Deno.serve` sends an empty one.
    const bad = head("POST /seen", "Content-Length: abc") + "abc";
    const texts: string[] = [];
    for (const s of servers) {
      texts.push(latin1((await send(s.path, [bad])).body));
    }
    assertEquals(texts[0], "");
    for (const t of texts.slice(1)) {
      assert(/malformed content-length/.test(t), t);
    }

    // The same length twice: accepted by `Deno.serve`, refused here — one
    // length, said once.
    const twice = head("POST /seen", "Content-Length: 3", "Content-Length: 3") +
      "abc";
    const st: number[] = [];
    for (const s of servers) st.push((await send(s.path, [twice])).status);
    assertEquals(st, ours(200, 400));

    // A length this runtime cannot count exactly (above 2^53 − 1):
    // `Deno.serve` takes any that fits 64 bits.
    const past = head("POST /early", "Content-Length: 9007199254740992") +
      "abc";
    const huge: number[] = [];
    for (const s of servers) {
      // (`Deno.serve` answers, and waits for the body it was promised.)
      huge.push((await send(s.path, [past], { ms: 1000 })).status);
    }
    assertEquals(huge, ours(401, 400));

    // A chunked body that does not parse: `Deno.serve` drops the connection
    // without a word; here the request is answered 400. Either way what
    // follows on the connection is never served: a request behind a `0` line
    // with no blank line after it is not this body's trailers.
    const next = "GET /299 HTTP/1.1\r\nHost: localhost\r\n\r\n";
    for (
      const body of [
        "zz\r\nabc\r\n0\r\n\r\n",
        "0x3\r\nabc\r\n0\r\n\r\n",
        "3\r\nabcXX0\r\n\r\n",
        // A size, or an extension, with a byte that is not its own.
        "3\t\r\nabc\r\n0\r\n\r\n",
        "3\u00a0\r\nabc\r\n0\r\n\r\n",
        "3;a=\nb\r\nabc\r\n0\r\n\r\n",
        "3;a=\u0001\r\nabc\r\n0\r\n\r\n",
        // Trailers that are not header lines.
        "3\r\nabc\r\n0\r\nNoColon\r\n\r\n",
        "3\r\nabc\r\n0\r\n X-T: 1\r\n\r\n",
        "3\r\nabc\r\n0\r\nX-T : 1\r\n\r\n",
        "3\r\nabc\r\n0\r\n",
      ]
    ) {
      const raw = "POST /seen HTTP/1.1\r\nHost: localhost\r\n" +
        "Transfer-Encoding: chunked\r\n\r\n" + body + next;
      const got = [];
      for (const s of servers) {
        got.push(await talk(s.path, raw, 3000));
      }
      assertEquals(
        got,
        ours({ answers: [], closed: true }, {
          answers: [[400, "close"]],
          closed: true,
        }),
        JSON.stringify(body),
      );
    }
    // A chunk size past 2^53 − 1, like a Content-Length past it, is one this
    // runtime cannot count: refused here; `Deno.serve` waits for the bytes.
    const sized = [];
    for (const s of servers) {
      sized.push(
        await talk(
          s.path,
          "POST /seen HTTP/1.1\r\nHost: localhost\r\n" +
            "Transfer-Encoding: chunked\r\n\r\nffffffffffffffff\r\nabc" + next,
          800,
        ),
      );
    }
    assertEquals(
      sized,
      ours({ answers: [], closed: false }, {
        answers: [[400, "close"]],
        closed: true,
      }),
    );
    assertEquals(
      servers.map((s) => s.counts["completed /299"]),
      each(undefined),
    );
  });
});

Deno.test("differential EXCEPTION: an upload nobody reads is not buffered — so a client that leaves behind one is noticed late", async () => {
  await lab(async (servers) => {
    // `Deno.serve` reads an unread request body into memory without bound,
    // which is also how it sees the client leave. This server reads ahead a
    // bounded amount and leaves the rest in the kernel: the upload costs the
    // SENDER, and a client that leaves behind more unread bytes than that,
    // with a silent response stream, is noticed at the stream's next write.
    const size = 2 * MB;
    const left: number[] = [];
    for (const s of servers) {
      const c = await Deno.connect({ transport: "unix", path: s.path });
      await c.write(enc.encode(
        `POST /sse HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${size}\r\n\r\n`,
      ));
      const body = new Uint8Array(size);
      let off = 0;
      const writing = (async () => {
        try {
          while (off < size) off += await c.write(body.subarray(off));
        } catch { /* closed below, mid-write */ }
      })();
      await c.read(new Uint8Array(4096));
      await new Promise((r) => setTimeout(r, 300));
      c.close();
      await writing;
      await new Promise((r) => setTimeout(r, 300));
      left.push(off);
    }
    assertEquals(left[0], size, "Deno.serve took the whole upload into memory");
    assertEquals(
      left.slice(1).map((n) => n < size),
      each(true).slice(1),
      `the upload was buffered: ${left}`,
    );
    assertEquals(servers[0]!.counts, {
      "abort /sse": 1,
      "cancel /sse": 1,
      "completed /sse": 1,
    });
    assertEquals(servers.slice(1).map((s) => s.counts), each({}).slice(1));
  });
});

Deno.test("differential EXCEPTION: a client that half-closed behind its request and is answered with a stream gets the response head, then the close", async () => {
  await lab(async (servers) => {
    // To an answer that is a stream, a half-close is the client leaving — on
    // every server, and the route is told alike (pinned with the half-close
    // rows). `Deno.serve` then closes without having written anything. Here
    // the head is written as the stream is returned, before the end of input
    // has been read: the client gets a response that does not complete.
    const got: string[] = [];
    for (const s of servers) {
      const a = await send(s.path, [head("GET /sse")], { halfClose: true });
      got.push(
        a.empty ? "nothing" : `${a.status} ${a.headers.get("content-type")}`,
      );
    }
    assertEquals(got, ours("nothing", "200 text/event-stream"));
    await new Promise((r) => setTimeout(r, 100));
    await sameCounts(servers, "half-closed, streamed");
  });
});

// ── The pure parts behind the rows above ─────────────────────────────────────

Deno.test("bodyFraming: only decimal digits are a length; both framings at once is refused", () => {
  const f = (h: Record<string, string>) => bodyFraming(new Headers(h));
  assertEquals(f({}), null);
  assertEquals(f({ "content-length": "0" }), 0);
  assertEquals(f({ "content-length": "42" }), 42);
  assertEquals(f({ "transfer-encoding": "chunked" }), "chunked");
  assertEquals(f({ "transfer-encoding": "gzip, Chunked" }), "chunked");
  for (
    const bad of [
      { "content-length": "+3" },
      { "content-length": "0x3" },
      { "content-length": "3.0" },
      { "content-length": "" },
      { "content-length": "-1" },
      { "content-length": "3, 3" },
      { "content-length": "1e3" },
      { "content-length": "9".repeat(16) },
      { "transfer-encoding": "gzip" },
      { "transfer-encoding": "chunked, gzip" },
      { "transfer-encoding": "chunked", "content-length": "3" },
    ] as Record<string, string>[]
  ) {
    let threw = false;
    try {
      f(bad);
    } catch {
      threw = true;
    }
    assert(threw, `accepted ${JSON.stringify(bad)}`);
  }
});

Deno.test("chunkSize: hex digits only, spaces around them, an extension of visible bytes ignored", () => {
  assertEquals(chunkSize("0"), 0);
  assertEquals(chunkSize("3e8"), 1000);
  assertEquals(chunkSize("FF;name=value"), 255);
  assertEquals(chunkSize(" 3 ;x"), 3);
  assertEquals(chunkSize("0".repeat(20) + "3"), 3);
  assertEquals(chunkSize("1fffffffffffff"), Number.MAX_SAFE_INTEGER);
  for (
    const bad of [
      "",
      "0x3",
      "3zz",
      "-1",
      "+3",
      " ",
      "3 3",
      "20000000000000", // 2^53: not a count this runtime holds exactly
      "f".repeat(17),
      "\t3",
      "3\t",
      "3\u000b",
      "3\u00a0",
      "3;a=\nb",
      "3;a=\tb",
      "3;\u0001",
    ]
  ) {
    let threw = false;
    try {
      chunkSize(bad);
    } catch {
      threw = true;
    }
    assert(threw, `accepted ${JSON.stringify(bad)}`);
  }
});

Deno.test("requestUrl: Deno.serve's unix shape on a socket, http://app on a pipe", () => {
  assertEquals(
    requestUrl("/api/x?q=1", "localhost", "/run/a.sock", true),
    "http+unix://localhost/api/x?q=1",
  );
  assertEquals(
    requestUrl("/x", null, "/run/user/1000/my-app_1.http.sock", true),
    "http+unix://%2Frun%2Fuser%2F1000%2Fmy%2Dapp%5F1%2Ehttp%2Esock/x",
  );
  // An empty Host names no host either.
  assertEquals(requestUrl("/x", "", "/s", true), "http+unix://%2Fs/x");
  assertEquals(requestUrl("*", "h", "/s", true), "http+unix://h/*");
  assertEquals(
    requestUrl("http://other/x", "h", "/s", true),
    "http://other/x",
  );
  // The pipe: what it always was, whatever the Host header says.
  assertEquals(
    requestUrl("/api/x?q=1", "localhost", "\\\\.\\pipe\\aio-a", false),
    "http://app/api/x?q=1",
  );
  assertEquals(
    requestUrl("/x", null, "\\\\.\\pipe\\aio-a", false),
    "http://app/x",
  );
});
