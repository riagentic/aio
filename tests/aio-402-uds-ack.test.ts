// AIO-402: the UDS server dispatched actions but never sent an `__ack:<cid>:1`
// back (unlike the WS server). Every awaited `cell.method()` over the UDS+IPC
// transport (electron dev/prod) hung until the 15s ack timeout — calculations,
// imports and progress appeared frozen. The UDS server must ack, mirroring WS.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createUDSListener } from "../src/aio.ts";
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
    enc.encode('{"type":"doc:add","payload":{},"cid":"abc-123"}\n'),
  );

  // read the server's reply
  const reader = conn.readable.getReader();
  let got = "";
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !got.includes("__ack:")) {
    const { value, done } = await reader.read();
    if (done) break;
    got += dec.decode(value);
  }
  assertStringIncludes(got, "__ack:abc-123:1");

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
  await writer.write(enc.encode('{"type":"doc:add","payload":{}}\n'));

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
  assertEquals(got.includes("__ack:"), false);

  reader.releaseLock();
  writer.releaseLock();
  conn.close();
  uds.shutdown();
});
