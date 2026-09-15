// `broadcastRaw` — the path every sync `op` frame and every server-write push
// takes — wrote to a peer that had stopped reading, without limit.
//
// The STATE loop learned the high-water mark in audit a2/W2 (see
// ws-write-backlog.test.ts): a socket holding more than `WS_BUFFER_HIGH_WATER`
// unread bytes is skipped and owed whole state. `broadcastRaw` never asked,
// so a peer that completes the upgrade and never reads made the server hold
// every op broadcast in the runtime's outgoing buffer. Measured by the r3
// chaos hunt on a `sync: true` cell: server RSS 501 MB → 643 MB with one such
// peer, its backlog at 111.9 MB (28× the mark), while `/__aio/health` said
// "Broadcasts to them are skipped until they do".
//
// A raw frame cannot simply be SKIPPED the way a state round can. A state
// round has a repair (`needsFull`: the next round sends the whole state). An
// op stream has none inside the stream: a peer that misses op N and then
// receives op N+1 advances its cursor past N and never asks for it again. The
// repair a raw stream does have is the reconnect — the UI handshake sends
// whole state, the sync catch-up resumes from the peer's own cursor — so a
// peer that would miss a raw frame is CLOSED (1013, "try again later"), and
// nothing more is queued for it.
//
// This runs against a real server and a real TCP peer that upgrades and then
// never reads, and measures what the server queued for it by finally reading
// it all back: every text frame it held, then (with the fix) the close frame.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import { WS_BUFFER_HIGH_WATER } from "../src/server/write-backlog.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const FRAME_BYTES = 200_000;
const FRAMES = 200; // 40 MB offered — 10× the high-water mark

type Drained = {
  textFrames: number;
  textBytes: number;
  close?: { code: number; reason: string };
};

/** Read everything the server queued for this peer, until the close frame or
 *  until the stream stops producing (the server kept it open). Server frames
 *  are unmasked, so the parse is the three length forms and nothing else. */
async function drain(conn: Deno.TcpConn): Promise<Drained> {
  const out: Drained = { textFrames: 0, textBytes: 0 };
  let buf = new Uint8Array(0);
  const chunk = new Uint8Array(1 << 20);
  let headerDone = false;
  const append = (b: Uint8Array) => {
    const n = new Uint8Array(buf.length + b.length);
    n.set(buf);
    n.set(b, buf.length);
    buf = n;
  };
  while (true) {
    // A quiet second means the server has nothing more queued for us.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const n = await Promise.race([
      conn.read(chunk),
      new Promise<"idle">((r) => {
        timer = setTimeout(() => r("idle"), 1000);
      }),
    ]).finally(() => clearTimeout(timer));
    if (n === "idle" || n === null) return out;
    append(chunk.subarray(0, n));
    if (!headerDone) {
      const text = new TextDecoder().decode(buf.subarray(0, 4096));
      const end = text.indexOf("\r\n\r\n");
      if (end < 0) continue;
      assert(text.startsWith("HTTP/1.1 101"), `upgrade refused: ${text}`);
      buf = buf.subarray(end + 4);
      headerDone = true;
    }
    while (buf.length >= 2) {
      const op = buf[0]! & 0x0f;
      let len = buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) break;
        len = (buf[2]! << 8) | buf[3]!;
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) break;
        len = Number(new DataView(buf.buffer, buf.byteOffset + 2, 8)
          .getBigUint64(0));
        off = 10;
      }
      if (buf.length < off + len) break;
      const payload = buf.subarray(off, off + len);
      if (op === 0x1) {
        out.textFrames++;
        out.textBytes += len;
      } else if (op === 0x8) {
        out.close = {
          code: len >= 2 ? (payload[0]! << 8) | payload[1]! : 1005,
          reason: new TextDecoder().decode(payload.subarray(2)),
        };
        return out;
      }
      buf = buf.subarray(off + len);
    }
  }
}

Deno.test({
  name:
    "ws backlog: broadcastRaw stops feeding a peer that never reads, and closes it so it resyncs",
  // The test owns a raw TCP conn the server half-closes; it is closed below.
  fn: async () => {
    const dir = await tempDir("ws-raw-backlog-");
    await Deno.mkdir(join(dir, "dist"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "dist", "app.js"),
      "export function mount(){}",
    );
    const port = freePort();
    const server = createServer({
      port,
      title: "RawBacklog",
      getUIState: () => ({}),
      dispatch: () => {},
      baseDir: dir,
      debug: () => {},
      prod: true,
      distDir: join(dir, "dist"),
    });
    const silent = await Deno.connect({ port, hostname: "127.0.0.1" });
    let healthy: WebSocket | undefined;
    try {
      await silent.write(
        new TextEncoder().encode(
          `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
            `Sec-WebSocket-Version: 13\r\n\r\n`,
        ),
      );
      // A peer that DOES read, beside it — it must not pay for its neighbour.
      healthy = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      let healthyGot = 0;
      healthy.onmessage = (e) => {
        if (String(e.data).includes('"t":"op"')) healthyGot++;
      };
      await new Promise((r) =>
        healthy!.addEventListener("open", r, { once: true })
      );
      await new Promise((r) => setTimeout(r, 200)); // both sockets registered

      const pad = "x".repeat(FRAME_BYTES);
      for (let i = 0; i < FRAMES; i++) {
        server.broadcastRaw(
          `{"v":2,"t":"op","d":{"id":"o-${i}","pad":"${pad}"}}`,
        );
        // Room for the healthy peer's writes to complete, as between real ops.
        await new Promise((r) => setTimeout(r, 2));
      }
      for (let i = 0; i < 300 && healthyGot < FRAMES; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assertEquals(
        healthyGot,
        FRAMES,
        "a peer that reads must receive every raw frame",
      );

      const got = await drain(silent);
      const offered = FRAMES * FRAME_BYTES;
      // What the server held for the silent peer is what it can now read
      // back. Bounded by the mark plus what the two kernels buffer on
      // loopback (≤ 4 MB send side here) and the frame that crossed it — not
      // by how much was offered.
      assert(
        got.textBytes < WS_BUFFER_HIGH_WATER + 12 * 1024 * 1024,
        `the server queued ${
          (got.textBytes / 1048576).toFixed(1)
        } MB (${got.textFrames}/${FRAMES} frames, ${
          (offered / 1048576).toFixed(0)
        } MB offered) for a peer that never read — it must stop at the ` +
          `${WS_BUFFER_HIGH_WATER / 1048576} MB high-water mark`,
      );
      // A skipped raw frame is a GAP the stream cannot repair — the peer is
      // told to reconnect, where the handshake / sync catch-up repairs it.
      assertEquals(
        got.close?.code,
        1013,
        `a peer that missed a raw frame must be closed (1013) so it ` +
          `reconnects and catches up — got ${JSON.stringify(got.close)}`,
      );
      assert(
        /not draining/.test(got.close?.reason ?? ""),
        `the close reason says why: ${got.close?.reason}`,
      );
    } finally {
      try {
        silent.close();
      } catch { /* already closed by the server */ }
      healthy?.close();
      await new Promise((r) => setTimeout(r, 50));
      await server.shutdown();
      await dropTempDir(dir);
    }
  },
});
