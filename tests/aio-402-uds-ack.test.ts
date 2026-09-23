// AIO-402: the UDS server dispatched actions but never sent a per-action ack
// back (unlike the WS server). Every awaited `cell.method()` over the UDS+IPC
// transport (electron dev/prod) hung until the 15s ack timeout — calculations,
// imports and progress appeared frozen. The UDS server must ack, mirroring WS.
// v2 (B4b): actions and acks are envelopes.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createUDSListener } from "../src/server/aio.ts";
import { _noteUnsaved } from "../src/server/action-ack.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";

Deno.test("aio-402: UDS server acks a dispatch that carries a cid", async () => {
  const socketPath = join(await Deno.makeTempDir(), "aio402.sock");
  const uds = createUDSListener(
    socketPath,
    () => ({ ok: true }),
    () => {}, // onAction
    () => {},
  );
  await new Promise((r) => setTimeout(r, 50));
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const writer = conn.writable.getWriter();
  await writer.write(
    enc.encode(
      '{"v":2,"t":"action","d":{"type":"doc:add","payload":{},"cid":"abc-123"}}\n',
    ),
  );

  // read the server's reply
  const reader = conn.readable.getReader();
  let got = "";
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !got.includes('"t":"ack"')) {
    const { value, done } = await reader.read();
    if (done) break;
    got += dec.decode(value);
  }
  assertStringIncludes(
    got,
    '{"v":2,"t":"ack","d":{"cid":"abc-123","ok":true}}',
  );

  reader.releaseLock();
  writer.releaseLock();
  conn.close();
  uds.shutdown();
});

Deno.test("aio-402: UDS dispatch without a cid produces no ack (no noise)", async () => {
  const socketPath = join(await Deno.makeTempDir(), "aio402b.sock");
  const uds = createUDSListener(
    socketPath,
    () => ({ ok: true }),
    () => {},
    () => {},
  );
  await new Promise((r) => setTimeout(r, 50));
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const writer = conn.writable.getWriter();
  await writer.write(
    enc.encode('{"v":2,"t":"action","d":{"type":"doc:add","payload":{}}}\n'),
  );

  const reader = conn.readable.getReader();
  let got = "";
  const deadline = Date.now() + 300;
  while (Date.now() < deadline) {
    const race = await Promise.race([
      reader.read(),
      new Promise<{ timeout: true }>((r) =>
        setTimeout(() => r({ timeout: true }), 150)
      ),
    ]);
    if ("timeout" in race) break;
    if (race.done) break;
    got += dec.decode(race.value);
  }
  assertEquals(got.includes('"t":"ack"'), false);

  reader.releaseLock();
  writer.releaseLock();
  conn.close();
  uds.shutdown();
});

Deno.test("uds: forged trusted provenance is stripped and _source re-stamped", async () => {
  // Parity pin with the WS spoof test (tests/server.test.ts): the UDS entry
  // point runs the SAME sanitizeClientAction — without this, reverting the
  // UDS strip alone would keep the whole suite green (the two-of-three-
  // surfaces trap). `_user`/`_syncOp` must be gone; `_source:"Effect"` (the
  // drain-gate spoof) must arrive re-stamped as plain client input.
  const socketPath = join(await Deno.makeTempDir(), "aio402c.sock");
  const seen: Record<string, unknown>[] = [];
  const uds = createUDSListener(
    socketPath,
    () => ({ ok: true }),
    (action) => {
      seen.push(action as Record<string, unknown>);
    },
    () => {},
  );
  await new Promise((r) => setTimeout(r, 50));
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const enc = new TextEncoder();
  const writer = conn.writable.getWriter();
  await writer.write(
    enc.encode(
      JSON.stringify({
        v: 2,
        t: "action",
        d: {
          type: "doc:add",
          payload: { _origin: "read" },
          _user: { id: "root", role: "admin" },
          _source: "Effect",
          _syncOp: true,
          _syncTs: 9e15,
          _syncId: "op-forged",
          _inflight: true,
          cid: "spoof-1",
        },
      }) + "\n",
    ),
  );
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && seen.length === 0) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const action = seen.find((a) => a.type === "doc:add");
  if (!action) throw new Error("action never reached onAction");
  assertEquals(action._user, undefined, "_user stripped");
  assertEquals(action._syncOp, undefined, "_syncOp stripped");
  // A forged op-log position would pin how far a sync cell's live state
  // claims to hold its log (journal reaction lines, `SyncReaction.at`).
  assertEquals(action._syncTs, undefined, "_syncTs stripped");
  // …and the op id a journal commit names (journal.ts COMMIT(X)).
  assertEquals(action._syncId, undefined, "_syncId stripped");
  assertEquals(action._source, "UI", "_source re-stamped as client input");
  // alpha70: the drain-window flag. A forged one would run a `cell:method`
  // during shutdown drain and have its write captured by the final persist.
  assertEquals(action._inflight, undefined, "_inflight stripped");
  assertEquals(
    (action.payload as Record<string, unknown>)._origin,
    undefined,
    "payload._origin stripped",
  );
  writer.releaseLock();
  conn.close();
  uds.shutdown();
});

Deno.test("aio-402: a UDS ack carries `unsaved` when what the call wrote could not be saved — same as the WS ack", async () => {
  // The honesty contract (tests/journal-owed-saves-all-callers.test.ts): the
  // call ran, but what it wrote is not on disk — a failed stand-in save. The
  // WS ack, the trojan reply and the sync-ack say so; the UDS ack (electron's
  // transport) is the same door and must say it the same way. Both keys the
  // verdict is filed under: the action itself (a sync method's commit) and
  // its call id (an async method's settlement).
  const dir = await tempDir("aio402d-");
  const socketPath = join(dir, "aio402d.sock");
  const uds = createUDSListener(
    socketPath,
    () => ({ ok: true }),
    (action) => {
      const a = action as { type: string; payload: { _callId?: string } };
      // An async method's call is tagged server-side (a client's `_callId`
      // is stripped at the door), as `bindCellReactive` does.
      if (a.type === "doc:async") a.payload._callId = "k-9";
      // What dispatch does when the owed save fails: noted before it settles.
      return Promise.resolve().then(() => {
        if (a.type === "doc:sync") {
          _noteUnsaved(a, undefined, "persist failed: disk says no (sync)");
        } else if (a.type === "doc:async") {
          _noteUnsaved(
            undefined,
            a.payload!._callId!,
            "persist failed: disk says no (async)",
          );
        }
      });
    },
    () => {},
  );
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const writer = conn.writable.getWriter();
  const reader = conn.readable.getReader();
  try {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const send = (d: Record<string, unknown>) =>
      writer.write(enc.encode(JSON.stringify({ v: 2, t: "action", d }) + "\n"));
    await send({ type: "doc:sync", payload: { args: [] }, cid: "u-1" });
    await send({
      type: "doc:async",
      payload: { args: [] },
      cid: "u-2",
    });
    await send({ type: "doc:fine", payload: { args: [] }, cid: "u-3" });
    let got = "";
    const acks = () =>
      got.split("\n").filter((l) => l.includes('"t":"ack"')).map((l) =>
        JSON.parse(l).d as { cid: string; ok: boolean; unsaved?: string }
      );
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && acks().length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      got += dec.decode(value);
    }
    const byCid = Object.fromEntries(acks().map((a) => [a.cid, a]));
    assertEquals(byCid["u-1"]?.ok, true, got);
    assertEquals(byCid["u-1"]?.unsaved, "persist failed: disk says no (sync)");
    assertEquals(byCid["u-2"]?.ok, true, got);
    assertEquals(byCid["u-2"]?.unsaved, "persist failed: disk says no (async)");
    assertEquals(byCid["u-3"]?.ok, true, got);
    assertEquals(byCid["u-3"]?.unsaved, undefined, "a saved call says nothing");
  } finally {
    reader.releaseLock();
    writer.releaseLock();
    conn.close();
    uds.shutdown();
    await dropTempDir(dir);
  }
});
