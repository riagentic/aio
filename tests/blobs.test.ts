// app.blobs — the binary-tier primitive (src/server/blobs.ts).
//
// Content-addressed store under `appDirs(appId).files/blobs/`: put/stream
// roundtrips (bytes + stream input), dedup by content hash (one file), the
// streaming tmp-file+rename put path on a 100MB synthetic stream, HTTP
// serving at /__aio/blobs/<id> (Content-Length, immutable caching, single
// Range → 206/416), and the auth gate: blob bytes never bypass auth on a
// per-user app.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  _resetBlobStores,
  BLOB_URL_PREFIX,
  openBlobStore,
} from "../src/server/blobs.ts";
import { parseByteRange } from "../src/server/server-static.ts";
import { testServer } from "../src/testing/server-test.ts";
import { cell } from "../mod.ts";
import { createHash } from "node:crypto";

const enc_ = new TextEncoder();

/** Random bytes of any length (getRandomValues caps one call at 64KiB). */
function randBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) {
    crypto.getRandomValues(out.subarray(off, Math.min(off + 65536, n)));
  }
  return out;
}

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer as ArrayBuffer,
  );
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function withStore(
  fn: (
    store: ReturnType<typeof openBlobStore>,
    home: string,
  ) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "aio-blobs-" });
  _resetBlobStores();
  try {
    await fn(
      openBlobStore(`blobtest-${crypto.randomUUID().slice(0, 8)}`, home),
      home,
    );
  } finally {
    _resetBlobStores();
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
}

async function drain(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of s) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

Deno.test("blobs: put(bytes) → content-addressed id, stream roundtrips", async () => {
  await withStore(async (store) => {
    const bytes = enc_.encode("hello, binary tier");
    const info = await store.put(bytes, { name: "hello.txt" });
    assertEquals(info.id, await sha256hex(bytes), "id IS the sha256");
    assertEquals(info.size, bytes.byteLength);
    assertEquals(info.name, "hello.txt");
    assertEquals(await drain(await store.stream(info.id)), bytes);
    assertEquals(await store.info(info.id), info);
    assertEquals(store.url(info.id), `/__aio/blobs/${info.id}`);
  });
});

Deno.test("blobs: put(stream) roundtrips and hashes identically to put(bytes)", async () => {
  await withStore(async (store) => {
    const bytes = randBytes(300_000);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        // Uneven chunking on purpose — hashing must be chunk-agnostic.
        c.enqueue(bytes.slice(0, 7));
        c.enqueue(bytes.slice(7, 65536));
        c.enqueue(bytes.slice(65536));
        c.close();
      },
    });
    const info = await store.put(stream);
    assertEquals(info.id, await sha256hex(bytes));
    assertEquals(info.size, bytes.byteLength);
    assertEquals(await drain(await store.stream(info.id)), bytes);
  });
});

Deno.test("blobs: same bytes → same id, ONE file; first name wins", async () => {
  await withStore(async (store) => {
    const bytes = enc_.encode("dedup me");
    const a = await store.put(bytes, { name: "first.bin" });
    const b = await store.put(bytes, { name: "second.bin" });
    assertEquals(a.id, b.id);
    assertEquals(b.name, "first.bin", "content identity keeps the first name");
    const files: string[] = [];
    for await (const e of Deno.readDir(store.dir)) {
      if (e.isFile && !e.name.endsWith(".json")) files.push(e.name);
    }
    assertEquals(files, [a.id], "one data file for one content");
    assertEquals((await store.list()).length, 1);
  });
});

Deno.test("blobs: delete removes bytes + metadata; list reflects it", async () => {
  await withStore(async (store) => {
    const a = await store.put(enc_.encode("aaa"), { name: "a" });
    const b = await store.put(enc_.encode("bbb"));
    assertEquals((await store.list()).length, 2);
    assertEquals(await store.delete(a.id), true);
    assertEquals(
      await store.delete(a.id),
      false,
      "second delete: nothing left",
    );
    assertEquals(await store.info(a.id), null);
    assertEquals((await store.list()).map((i) => i.id), [b.id]);
    // The metadata sidecar went with it.
    for await (const e of Deno.readDir(store.dir)) {
      assert(!e.name.startsWith(a.id), `leftover ${e.name}`);
    }
  });
});

Deno.test("blobs: byte-window stream (the Range seam) slices exactly", async () => {
  await withStore(async (store) => {
    const bytes = enc_.encode("0123456789");
    const { id } = await store.put(bytes);
    assertEquals(
      await drain(await store.stream(id, { start: 2, end: 5 })),
      enc_.encode("234"),
    );
    assertEquals(
      await drain(await store.stream(id, { start: 8 })),
      enc_.encode("89"),
    );
  });
});

Deno.test("blobs: invalid ids are refused loudly, missing blobs throw named", async () => {
  await withStore(async (store) => {
    await assertRejects(
      () => store.stream("../../etc/passwd"),
      Error,
      "invalid blob id",
    );
    await assertRejects(() => store.info("nope"), Error, "invalid blob id");
    const absent = "0".repeat(64);
    assertEquals(await store.info(absent), null);
    await assertRejects(() => store.stream(absent), Error, absent);
  });
});

Deno.test("blobs: 100MB synthetic stream — tmp+rename path, correct hash, no O(n) buffering artifacts", async () => {
  await withStore(async (store) => {
    // 100 × 1MB deterministic chunks. The hash is computed independently in
    // the test as the chunks are generated, so the store's answer is checked
    // against a second pass, not against itself.
    const CHUNK = 1024 * 1024;
    const CHUNKS = 100;
    const expected = createHash("sha256");
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (produced >= CHUNKS) {
          c.close();
          return;
        }
        const buf = new Uint8Array(CHUNK);
        // Cheap deterministic fill, distinct per chunk.
        for (let i = 0; i < CHUNK; i += 4096) buf[i] = produced & 0xff;
        buf[0] = 0xa5;
        expected.update(buf);
        produced++;
        c.enqueue(buf);
      },
    });
    const info = await store.put(stream, { name: "big.bin" });
    assertEquals(info.size, CHUNK * CHUNKS);
    assertEquals(info.id, expected.digest("hex"), "streamed hash is correct");
    // The commit is a rename: the bytes sit under their hash and NO tmp
    // spool remains (the whole blob was never buffered — it was spooled to
    // this tmp file and renamed).
    const names: string[] = [];
    for await (const e of Deno.readDir(store.dir)) names.push(e.name);
    assert(names.includes(info.id), "data file named by its hash");
    assertEquals(
      names.filter((n) => n.startsWith(".tmp-")),
      [],
      "no tmp spool left behind",
    );
    assertEquals((await Deno.stat(join(store.dir, info.id))).size, info.size);
  });
});

Deno.test("blobs: parseByteRange — single-range grammar, 206/416/ignore tiers", () => {
  assertEquals(parseByteRange(null, 100), null);
  assertEquals(parseByteRange("bytes=0-49", 100), { start: 0, end: 50 });
  assertEquals(parseByteRange("bytes=50-", 100), { start: 50, end: 100 });
  assertEquals(parseByteRange("bytes=-10", 100), { start: 90, end: 100 });
  // End clamped to size (RFC 7233: last-byte-pos beyond EOF is fine).
  assertEquals(parseByteRange("bytes=90-500", 100), { start: 90, end: 100 });
  // Unsatisfiable → 416.
  assertEquals(parseByteRange("bytes=100-", 100), "unsatisfiable");
  assertEquals(parseByteRange("bytes=-0", 100), "unsatisfiable");
  // Malformed / multi-range → ignored (full 200), never guessed.
  assertEquals(parseByteRange("bytes=5-2", 100), null);
  assertEquals(parseByteRange("bytes=0-4,10-14", 100), null);
  assertEquals(parseByteRange("chunks=0-4", 100), null);
});

// ── HTTP: /__aio/blobs/<id> ──────────────────────────────────────────────

Deno.test("blobs over HTTP: 200, Content-Length, immutable caching, Range 206/416, HEAD, 404/405", async () => {
  const c = cell(`blobhttp-${crypto.randomUUID().slice(0, 6)}`, {
    state: { n: 0 },
    methods: {},
  });
  await using srv = await testServer({ cells: [c] });
  const bytes = enc_.encode("The quick brown fox jumps over the lazy dog");
  const info = await srv.app.blobs!.put(bytes, { name: "fox.txt" });
  const url = srv.app.blobs!.url(info.id);
  assert(url.startsWith(BLOB_URL_PREFIX));

  // Full fetch.
  const full = await srv.fetch(url);
  assertEquals(full.status, 200);
  assertEquals(full.headers.get("content-length"), String(bytes.byteLength));
  assert(full.headers.get("cache-control")!.includes("immutable"));
  assertEquals(full.headers.get("etag"), `"${info.id}"`);
  assertEquals(full.headers.get("accept-ranges"), "bytes");
  assertEquals(full.headers.get("content-type"), "text/plain");
  assertEquals(new Uint8Array(await full.arrayBuffer()), bytes);

  // Single range → 206 with the exact slice.
  const part = await srv.fetch(url, { headers: { Range: "bytes=4-8" } });
  assertEquals(part.status, 206);
  assertEquals(
    part.headers.get("content-range"),
    `bytes 4-8/${bytes.byteLength}`,
  );
  assertEquals(part.headers.get("content-length"), "5");
  assertEquals(await part.text(), "quick");

  // Suffix range.
  const tail = await srv.fetch(url, { headers: { Range: "bytes=-3" } });
  assertEquals(tail.status, 206);
  assertEquals(await tail.text(), "dog");

  // Unsatisfiable → 416 naming the size.
  const bad = await srv.fetch(url, {
    headers: { Range: `bytes=${bytes.byteLength}-` },
  });
  assertEquals(bad.status, 416);
  assertEquals(bad.headers.get("content-range"), `bytes */${bytes.byteLength}`);
  await bad.body?.cancel();

  // HEAD: headers, no body.
  const head = await srv.fetch(url, { method: "HEAD" });
  assertEquals(head.status, 200);
  assertEquals(head.headers.get("content-length"), String(bytes.byteLength));
  assertEquals(await head.text(), "");

  // Conditional: the id can never change, so a matching ETag is 304.
  const cond = await srv.fetch(url, {
    headers: { "If-None-Match": `"${info.id}"` },
  });
  assertEquals(cond.status, 304);
  await cond.body?.cancel();

  // Unknown + malformed ids: same 404 (no probe surface).
  assertEquals((await srv.fetch(BLOB_URL_PREFIX + "0".repeat(64))).status, 404);
  assertEquals((await srv.fetch(BLOB_URL_PREFIX + "not-an-id")).status, 404);

  // Bytes are read-only over HTTP.
  const post = await srv.fetch(url, { method: "POST", body: "x" });
  assertEquals(post.status, 405);
  await post.body?.cancel();
});

Deno.test("blobs over HTTP: streaming upload route (request.body → blobs.put)", async () => {
  const c = cell(`blobup-${crypto.randomUUID().slice(0, 6)}`, {
    state: { n: 0 },
    methods: {},
  });
  let blobsRef: import("../src/server/blobs.ts").BlobStore | null = null;
  await using srv = await testServer({
    cells: [c],
    routes: {
      // The documented upload shape: the request body IS a stream; it pipes
      // straight into the store — hashed and spooled chunk by chunk.
      "/upload": async (req: Request) => {
        if (!req.body) return new Response("empty", { status: 400 });
        const info = await blobsRef!.put(req.body);
        return Response.json(info);
      },
    },
  });
  blobsRef = srv.app.blobs!;
  const payload = randBytes(500_000);
  const res = await srv.fetch("/upload", {
    method: "POST",
    body: new Blob([payload.buffer as ArrayBuffer]),
  });
  assertEquals(res.status, 200);
  const info = await res.json() as { id: string; size: number };
  assertEquals(info.size, payload.byteLength);
  assertEquals(info.id, await sha256hex(payload));
  // And the bytes come back over the blob route.
  const back = await srv.fetch(BLOB_URL_PREFIX + info.id);
  assertEquals(new Uint8Array(await back.arrayBuffer()), payload);
});

Deno.test("blobs over HTTP: gated by per-user auth (401 without a credential)", async () => {
  const c = cell(`blobauth-${crypto.randomUUID().slice(0, 6)}`, {
    state: { n: 0 },
    methods: {},
  });
  await using srv = await testServer({
    cells: [c],
    users: { "tok-alice": { id: "alice", role: "user" } },
  });
  const info = await srv.app.blobs!.put(enc_.encode("private bytes"));
  const url = srv.app.blobs!.url(info.id);

  const anon = await srv.fetch(url);
  assertEquals(anon.status, 401, "no token, no bytes");
  await anon.body?.cancel();

  const authed = await srv.fetch(url, {
    headers: { Authorization: "Bearer tok-alice" },
  });
  assertEquals(authed.status, 200);
  assertEquals(await authed.text(), "private bytes");
});

Deno.test("blobs over HTTP: auth flows make the SHELL public — blob bytes stay 401 for anonymous", async () => {
  const c = cell(`blobflow-${crypto.randomUUID().slice(0, 6)}`, {
    state: { n: 0 },
    methods: {},
  });
  await using srv = await testServer({ cells: [c], auth: true });
  const info = await srv.app.blobs!.put(enc_.encode("secret media"));
  const url = srv.app.blobs!.url(info.id);

  // The login flows deliberately serve the SHELL anonymously (SignIn must
  // render before a session exists)…
  const shell = await srv.fetch("/");
  assertEquals(shell.status, 200);
  await shell.body?.cancel();

  // …but stored binaries are app DATA, not app shell.
  const anon = await srv.fetch(url);
  assertEquals(anon.status, 401, "anonymous blob read on an auth: app");
  await anon.body?.cancel();
});
