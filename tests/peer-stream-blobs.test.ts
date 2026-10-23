// peer().stream / emitChunk — a result in pieces, each call's pieces to its
// own caller only — and peer().blob / upload — bytes through the blob store,
// never through a frame. Real apps, real sockets.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testApps } from "../src/testing/apps-test.ts";
import { peer } from "../src/server/peer.ts";
import { emitChunk } from "../src/server/call-stream.ts";
import { AppLock } from "../src/server/single-instance-lock.ts";
import { mintControlKey, removeControlKey } from "../src/server/app-key.ts";
import type { AioApp } from "../src/server/aio-types.ts";
import { createUDSListener } from "../src/server/aio.ts";
import { _connectCliUDS } from "../src/server/cli-client.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";
import { join } from "@std/path";

const tick = () => new Promise((r) => setTimeout(r, 2));
let n = 0;
const talker = () =>
  cell(`talk${n++}`, {
    state: { calls: 0 },
    methods: {
      async say(_s: { calls: number }, tag: string, count: number) {
        const sent: boolean[] = [];
        for (let i = 0; i < count; i++) {
          sent.push(emitChunk(`${tag}${i}`));
          await tick(); // let the other call interleave
        }
        return { tag, sent };
      },
      async silent(_s: { calls: number }) {
        await tick();
        return "only a result";
      },
      async late(_s: { calls: number }) {
        setTimeout(() => emitChunk("after the answer"), 20);
        await tick();
        return "done";
      },
      async huge(_s: { calls: number }) {
        await tick();
        return emitChunk("x".repeat(2 * 1024 * 1024));
      },
      async broken(_s: { calls: number }) {
        emitChunk("before");
        await tick();
        throw new Error("broke mid-stream");
      },
    },
  });

const drain = async <C>(it: AsyncIterable<C>) => {
  const got: C[] = [];
  for await (const c of it) got.push(c);
  return got;
};

Deno.test("stream: chunks in order, then the result; a plain call() gets only the result and emitChunk says false", async () => {
  const t = talker();
  await using world = await testApps({ svc: { cells: [t] } });
  using p = (await peer(world.get("svc").url))!;
  const s = p.stream<string, { tag: string; sent: boolean[] }>(
    t.__aio.id,
    "say",
    "a",
    3,
  );
  assertEquals(await drain(s), ["a0", "a1", "a2"]);
  assertEquals((await s.result).sent, [true, true, true]);
  const plain = await p.call<{ sent: boolean[] }>(t.__aio.id, "say", "b", 2);
  assertEquals(plain.sent, [false, false], "nobody streams a plain call");
});

Deno.test("stream: two streamed calls on ONE connection never see each other's chunks", async () => {
  const t = talker();
  await using world = await testApps({ svc: { cells: [t] } });
  using p = (await peer(world.get("svc").url))!;
  const [x, y] = await Promise.all([
    drain(p.stream<string>(t.__aio.id, "say", "x", 8)),
    drain(p.stream<string>(t.__aio.id, "say", "y", 8)),
  ]);
  assertEquals(x, [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `x${i}`));
  assertEquals(y, [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `y${i}`));
});

Deno.test("stream: no chunks is fine; a chunk after the answer is never sent; a failure ends the iteration with its error", async () => {
  const t = talker();
  await using world = await testApps({ svc: { cells: [t] } });
  using p = (await peer(world.get("svc").url))!;
  const quiet = p.stream<string, string>(t.__aio.id, "silent");
  assertEquals(await drain(quiet), []);
  assertEquals(await quiet.result, "only a result");

  const got: string[] = [];
  const late = p.stream<string, string>(t.__aio.id, "late");
  for await (const c of late) got.push(c);
  await new Promise((r) => setTimeout(r, 60));
  assertEquals(got, []);

  const seen: string[] = [];
  const broken = p.stream<string>(t.__aio.id, "broken");
  await assertRejects(
    async () => {
      for await (const c of broken) seen.push(c);
    },
    Error,
    "broke mid-stream",
  );
  assertEquals(seen, ["before"]);
  await assertRejects(() => broken.result, Error, "broke mid-stream");

  // Over the chunk cap: the METHOD throws, loudly — never a silent drop.
  await assertRejects(
    () => drain(p.stream(t.__aio.id, "huge")),
    Error,
    "limit",
  );
  await assertRejects(
    () => p.call(t.__aio.id, "huge"),
    Error,
    "limit",
    "the same limit for a plain call",
  );
});

Deno.test("blobs: a proven peer uploads and downloads bytes (ranges too); an anonymous caller cannot upload", async () => {
  const t = talker();
  let app: AioApp | undefined;
  await using world = await testApps({
    svc: {
      cells: [t],
      resolvePeer: (pp) => ({ id: pp.app, role: "app" }),
    },
  });
  app = world.get("svc").app as AioApp;
  assert(app.blobs, "the test app has a blob store");
  const svc = world.get("svc");
  const svcId = ((await (await fetch(`${svc.url}/__aio/health`)).json()) as {
    appId: string;
  }).appId;
  const caller = `pblob${Deno.pid}x${n}`;
  const me = new AppLock(caller);
  const listed = new AppLock(svcId);
  try {
    assertEquals((await me.acquire(1)).ok, true);
    me.update({ status: "started" });
    assert(mintControlKey(caller).error === undefined);
    assertEquals((await listed.acquire(svc.port)).ok, true);
    listed.update({ status: "started" });

    using p = (await peer(svcId))!;
    const bytes = new TextEncoder().encode("hello, blob store");
    const info = await p.upload(bytes, { name: "greeting.txt" });
    assertEquals(info.size, bytes.length);
    assertEquals(info.name, "greeting.txt");
    const back = await new Response(await p.blob(info.id)).text();
    assertEquals(back, "hello, blob store");
    const part = await new Response(
      await p.blob(info.id, { start: 7, end: 11 }),
    ).text();
    assertEquals(part, "blob");
    const text = (r: { start: number; end?: number }) =>
      p.blob(info.id, r).then((b) => new Response(b).text());
    assertEquals(await text({ start: 7, end: 7 }), "", "empty range: nothing");
    assertEquals(await text({ start: 0, end: 999 }), "hello, blob store");
    assertEquals(await text({ start: 13 }), "tore");
    for (const bad of [{ start: 5, end: 4 }, { start: -1 }, { start: 1.5 }]) {
      await assertRejects(() => text(bad), RangeError, "not a byte range");
    }
    await assertRejects(() => text({ start: 99 }), Error, "416");

    // Empty uploads are refused — and never take the app's own empty blob.
    const own = await app.blobs.put(new Uint8Array());
    await assertRejects(() => p.upload(new Uint8Array()), Error, "400");
    await assertRejects(
      () => p.upload(new ReadableStream({ start: (c) => c.close() })),
      Error,
      "400",
    );
    assert(await app.blobs.info(own.id), "the app's empty blob survived");

    using anon = (await peer(svc.url))!;
    await assertRejects(() => anon.upload(bytes), Error, "POST");
    await assertRejects(() => anon.blob("nope"), Error, "not a blob id");
  } finally {
    removeControlKey(caller);
    me.release();
    listed.release();
  }
});

Deno.test("stream over the local socket: chunks then result, and the stream flag never reaches the action", async () => {
  const dir = await tempDir("peer-stream-uds-");
  const socketPath = localEndpoint(join(dir, "s.sock"));
  const seen: Record<string, unknown>[] = [];
  const uds = createUDSListener(
    socketPath,
    () => ({}),
    async (action) => {
      seen.push(action as Record<string, unknown>);
      emitChunk("one");
      await tick();
      emitChunk("two");
      return "uds done";
    },
    () => {},
  );
  const link = _connectCliUDS(socketPath, { readyTimeoutMs: 3_000 });
  try {
    await link.ready;
    const got: unknown[] = [];
    const r = await link.stream("svc", "talk", [1], (c) => got.push(c));
    assertEquals(got, ["one", "two"]);
    assertEquals(r, "uds done");
    assertEquals(seen.length, 1);
    assert(
      !("stream" in seen[0]!),
      "the transport flag leaked into the action",
    );
  } finally {
    link.close();
    uds.shutdown();
    await localIdle();
    await dropTempDir(dir);
  }
});
