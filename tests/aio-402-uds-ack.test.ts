// AIO-402: the UDS server dispatched actions but never sent a per-action ack
// back (unlike the WS server). Every awaited `cell.method()` over the UDS+IPC
// transport (electron dev/prod) hung until the 15s ack timeout — calculations,
// imports and progress appeared frozen. The UDS server must ack, mirroring WS.
// v2 (B4b): actions and acks are envelopes.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createUDSListener } from "../src/server/aio.ts";
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
