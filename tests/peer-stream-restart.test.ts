// peer(): a streamed call that is still delivering is never timed out, a
// callee that restarts on a NEW port is followed, and the blob door's
// failures say what happened. Real apps, real sockets.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../src/state/cell-create.ts";
import { testApps } from "../src/testing/apps-test.ts";
import { testServer } from "../src/testing/server-test.ts";
import { peer } from "../src/server/peer.ts";
import { emitChunk } from "../src/server/call-stream.ts";
import { AppLock } from "../src/server/single-instance-lock.ts";
import { mintControlKey, removeControlKey } from "../src/server/app-key.ts";
import { createUDSListener } from "../src/server/aio.ts";
import { _connectCliUDS } from "../src/server/cli-client.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const dripper = (name = `drip${n++}`) =>
  cell(name, {
    state: { calls: 0 },
    methods: {
      async drip(_s: { calls: number }, count: number, every: number) {
        for (let i = 0; i < count; i++) {
          emitChunk(i);
          await sleep(every);
        }
        return count;
      },
      async quiet(_s: { calls: number }, ms: number) {
        await sleep(ms);
        return ms;
      },
      bump(s: { calls: number }) {
        return ++s.calls;
      },
    },
  });

Deno.test("stream: chunks keep a call alive past ackTimeoutMs; silence still times out", async () => {
  const d = dripper();
  await using world = await testApps({ svc: { cells: [d] } });
  using p = (await peer(world.get("svc").url, { ackTimeoutMs: 150 }))!;
  // 8 chunks 60 ms apart: 480 ms in all, never 150 ms without a word.
  const s = p.stream<number, number>(d.__aio.id, "drip", 8, 60);
  const got: number[] = [];
  for await (const c of s) got.push(c);
  assertEquals(got, [0, 1, 2, 3, 4, 5, 6, 7]);
  assertEquals(await s.result, 8);
  const q = p.stream(d.__aio.id, "quiet", 600);
  await assertRejects(() => q.result, Error, "no response");
});

Deno.test("stream over the local socket: chunks keep the call alive past ackTimeoutMs", async () => {
  const dir = await tempDir("peer-stream-alive-uds-");
  const socketPath = localEndpoint(join(dir, "s.sock"));
  const uds = createUDSListener(
    socketPath,
    () => ({}),
    async () => {
      for (let i = 0; i < 6; i++) {
        emitChunk(i);
        await sleep(60);
      }
      return "uds done";
    },
    () => {},
  );
  const link = _connectCliUDS(socketPath, {
    readyTimeoutMs: 3_000,
    ackTimeoutMs: 150,
  });
  try {
    await link.ready;
    const got: unknown[] = [];
    assertEquals(
      await link.stream("svc", "drip", [], (c) => got.push(c)),
      "uds done",
    );
    assertEquals(got, [0, 1, 2, 3, 4, 5]);
  } finally {
    link.close();
    uds.shutdown();
    await localIdle();
    await dropTempDir(dir);
  }
});

Deno.test("peer(appId): a callee that restarts on a NEW port is followed — calls, onStatus, the proof", async () => {
  const appId = `prestart${Deno.pid}x${n++}`;
  const caller = `pcaller${Deno.pid}x${n++}`;
  const name = `rs${n++}`;
  const resolvePeer = (pp: { app: string }) => ({ id: pp.app, role: "app" });
  const a = await testServer({ appId, cells: [dripper(name)], resolvePeer });
  const lock = new AppLock(appId);
  const me = new AppLock(caller);
  let b: Awaited<ReturnType<typeof testServer>> | undefined;
  try {
    assertEquals((await me.acquire(1)).ok, true);
    me.update({ status: "started" });
    assert(mintControlKey(caller).error === undefined);
    assertEquals((await lock.acquire(a.port)).ok, true);
    lock.update({ status: "started" });
    using p = (await peer(appId))!;
    assertEquals(await p.call(name, "bump"), 1);
    const ups: boolean[] = [];
    p.onStatus((up) => ups.push(up));
    await a.close();
    b = await testServer({ appId, cells: [dripper(name)], resolvePeer });
    assert(b.port !== a.port, "the next boot took another port");
    lock.update({ port: b.port });
    const end = Date.now() + 10_000;
    while (!p.connected && Date.now() < end) await sleep(20);
    assert(p.connected, "the peer followed the restarted app to its new port");
    assertEquals(await p.call(name, "bump"), 1, "answered by the new boot");
    assertEquals(ups, [false, true]);
    // The proof is signed for the port the callee holds NOW.
    assertEquals((await p.upload(new Uint8Array([7]))).size, 1);
  } finally {
    removeControlKey(caller);
    me.release();
    lock.release();
    await b?.close();
  }
});

Deno.test("upload: a caller with no proven identity is told WHY (403), not a bare 404", async () => {
  const d = dripper();
  await using world = await testApps({
    open: { cells: [d] },
    gated: {
      cells: [dripper()],
      resolvePeer: (pp) => ({ id: pp.app, role: "app" }),
    },
  });
  using anon = (await peer(world.get("gated").url))!;
  await assertRejects(
    () => anon.upload(new Uint8Array([1])),
    Error,
    '403 {"error":"no peer identity sent',
  );
  using plain = (await peer(world.get("open").url))!;
  await assertRejects(
    () => plain.upload(new Uint8Array([1])),
    Error,
    "sets no resolvePeer",
  );
});

Deno.test("blob door: an unreachable app is named with the door, not a bare 'fetch failed'", async () => {
  const d = dripper();
  await using world = await testApps({ svc: { cells: [d] } });
  using p = (await peer(world.get("svc").url))!;
  await world.get("svc").close();
  const end = Date.now() + 5_000;
  while (p.connected && Date.now() < end) await sleep(10);
  const e = await assertRejects(() => p.blob("a".repeat(64)), Error);
  assert(
    e.message.startsWith(`peer("${world.get("svc").url}") GET /__aio/blobs/`),
    e.message,
  );
  assert(e.message.includes("not connected to it now"), e.message);
});

Deno.test("stream: two readers of one stream share its chunks — neither waits for ever; a reader that breaks leaves the rest to the next", async () => {
  const d = dripper();
  await using world = await testApps({ svc: { cells: [d] } });
  using p = (await peer(world.get("svc").url))!;
  const s = p.stream<number, number>(d.__aio.id, "drip", 6, 5);
  const read = async (it: AsyncIterator<number>) => {
    const got: number[] = [];
    for (let r = await it.next(); !r.done; r = await it.next()) {
      got.push(r.value);
    }
    return got;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const both = await Promise.race([
    Promise.all([
      read(s[Symbol.asyncIterator]()),
      read(s[Symbol.asyncIterator]()),
    ]),
    new Promise<"hung">((r) => timer = setTimeout(() => r("hung"), 10_000)),
  ]).finally(() => clearTimeout(timer));
  assert(both !== "hung", "a second reader's wait replaced the first's");
  assertEquals(both.flat().sort(), [0, 1, 2, 3, 4, 5]);

  const t = p.stream<number, number>(d.__aio.id, "drip", 6, 5);
  for await (const c of t) if (c === 1) break;
  const after: number[] = [];
  for await (const c of t) after.push(c);
  assertEquals(after, [2, 3, 4, 5], "a new reader resumes where the last left");
  assertEquals(await t.result, 6);
});
