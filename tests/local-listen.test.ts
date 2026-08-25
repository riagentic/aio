// src/server/local-listen.ts — the seam. The unix branch is a 1:1 wrap of
// Deno.listen/Deno.connect (bytes both ways, EOF, idempotent close, the unix
// peer address); a pipe path on a non-windows OS is refused by name.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  connectLocal,
  isPipePath,
  listenLocal,
} from "../src/server/local-listen.ts";

Deno.test("unix: listen → connect → bytes both ways → EOF on close", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-ll-" });
  const path = join(dir, "s.sock");
  const l = listenLocal(path);
  assertEquals(l.path, path);
  const accepted = (async () => {
    for await (const c of l) return c;
    return null;
  })();
  const client = await connectLocal(path);
  const server = await accepted;
  assert(server);
  assertEquals(server.remoteAddr.transport, "unix");
  assertEquals(client.remoteAddr.transport, "unix");

  const w = client.writable.getWriter();
  await w.write(new TextEncoder().encode("ping\n"));
  w.releaseLock();
  const r = server.readable.getReader();
  const { value } = await r.read();
  assertEquals(new TextDecoder().decode(value), "ping\n");

  const sw = server.writable.getWriter();
  await sw.write(new TextEncoder().encode("pong\n"));
  sw.releaseLock();
  const cr = client.readable.getReader();
  assertEquals(new TextDecoder().decode((await cr.read()).value), "pong\n");

  server.close();
  server.close(); // idempotent
  const eof = await cr.read();
  assert(eof.done, "peer close is EOF");
  client.close();
  l.close();
  l.close();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("unix: listener.close() stops accepting; open conns unaffected", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-ll-" });
  const path = join(dir, "s.sock");
  const l = listenLocal(path);
  const conns: Promise<unknown> = (async () => {
    const got = [];
    for await (const c of l) got.push(c);
    return got;
  })();
  const client = await connectLocal(path);
  const w = client.writable.getWriter();
  l.close();
  const got = (await conns) as { readable: ReadableStream<Uint8Array> }[];
  assertEquals(got.length, 1);
  await w.write(new Uint8Array([1, 2, 3])); // still open
  const { value } = await got[0]!.readable.getReader().read();
  assertEquals([...value!], [1, 2, 3]);
  await assertRejects(() => connectLocal(path));
  client.close();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("connect to nothing: NotFound, as the unix primitive reports it", async () => {
  await assertRejects(
    () => connectLocal("/nonexistent/aio/x.sock"),
    Deno.errors.NotFound,
  );
});

Deno.test("a pipe path on a non-windows OS is refused by name, not tried", async () => {
  if (Deno.build.os === "windows") return;
  const p = "\\\\.\\pipe\\aio-x";
  assert(isPipePath(p));
  assertThrows(() => listenLocal(p), Error, "named-pipe path");
  await assertRejects(() => connectLocal(p), Error, "named-pipe path");
});
