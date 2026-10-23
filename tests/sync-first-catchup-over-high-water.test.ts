// A sync client on a slow link whose cell state is over the WS high-water mark
// was closed before its catch-up was ever written — on every reconnect.
//
// The browser sends its `sync-req` the moment the socket opens, while the
// handshake's whole-state frame is still draining. With that state over the
// 4 MB mark, `sendTo` saw the socket "not draining" and closed it 1013 instead
// of writing the `sync-res`; the client reconnected, took the same state, sent
// the same request, and was closed again — forever. Measured: a 6 MB sync cell
// read at 1 MB/s was closed every 6 s and never received one `sync-res`.
//
// Real server, real TCP peer: it upgrades, sends its `sync-req` at once, and
// reads nothing until the server has answered — then reads it all back.
import { assert } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

const ITEM = "z".repeat(1_000_000);

function masked(text: string): Uint8Array {
  const p = new TextEncoder().encode(text);
  const hdr = p.length < 126
    ? [0x81, 0x80 | p.length]
    : [0x81, 0x80 | 126, p.length >> 8, p.length & 255];
  const out = new Uint8Array(hdr.length + 4 + p.length); // zero mask key
  out.set(hdr);
  out.set(p, hdr.length + 4);
  return out;
}

/** Every frame the server queued for this peer, until its close frame or a
 *  quiet second. */
async function drain(conn: Deno.TcpConn) {
  const texts: string[] = [];
  let close: number | undefined;
  let buf = new Uint8Array(0);
  let header = false;
  const chunk = new Uint8Array(1 << 20);
  while (close === undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const n = await Promise.race([
      conn.read(chunk).catch(() => null),
      new Promise<"idle">((r) => (timer = setTimeout(() => r("idle"), 1000))),
    ]).finally(() => clearTimeout(timer));
    if (n === "idle" || n === null) break;
    const nb = new Uint8Array(buf.length + n);
    nb.set(buf);
    nb.set(chunk.subarray(0, n), buf.length);
    buf = nb;
    if (!header) {
      const end = new TextDecoder().decode(buf.subarray(0, 4096))
        .indexOf("\r\n\r\n");
      if (end < 0) continue;
      buf = buf.subarray(end + 4);
      header = true;
    }
    while (buf.length >= 2) {
      const op = buf[0]! & 15;
      let len = buf[1]! & 127;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) break;
        len = (buf[2]! << 8) | buf[3]!;
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) break;
        len = Number(
          new DataView(buf.buffer, buf.byteOffset + 2, 8).getBigUint64(0),
        );
        off = 10;
      }
      if (buf.length < off + len) break;
      const payload = buf.subarray(off, off + len);
      if (op === 1) {
        texts.push(new TextDecoder().decode(payload.subarray(0, 64)));
      }
      if (op === 8) close = (payload[0]! << 8) | payload[1]!;
      buf = buf.subarray(off + len);
    }
  }
  return { texts, close };
}

Deno.test("sync: the first catch-up is written even while the handshake state holds the socket over the high-water mark", async () => {
  const notes = cell("notes", {
    sync: true,
    state: { items: [] as string[] },
    methods: {
      add(s: { items: string[] }, t: string) {
        s.items.push(t);
      },
    },
  });
  await using srv = await testServer({
    cells: [notes],
    budgets: { cellState: "16MB", payload: "16MB" },
  });
  for (let i = 0; i < 6; i++) await notes.add(ITEM + i);
  // Past the server-write fold (≤ 500 ms), so its push is not what we meet.
  await new Promise((r) => setTimeout(r, 800));

  const conn = await Deno.connect({ port: srv.port, hostname: "127.0.0.1" });
  try {
    await conn.write(
      new TextEncoder().encode(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`,
      ),
    );
    // What the engine sends on open — before it has read anything.
    await conn.write(masked(JSON.stringify({
      v: 2,
      t: "sync-req",
      d: {
        clientId: "slow",
        session: "s",
        reqId: 1,
        cells: { notes: { lastHlc: null } },
        pendingOps: [],
        pushPatch: true,
      },
    })));
    await new Promise((r) => setTimeout(r, 1500)); // a slow link: nothing read yet
    const got = await drain(conn);
    assert(
      got.texts.some((t) => t.includes('"t":"state"')),
      `the handshake state arrived: ${JSON.stringify(got.texts)}`,
    );
    assert(
      got.texts.some((t) => t.includes('"t":"sync-res"')),
      `the catch-up must be written, not the peer closed (close ${got.close}): ` +
        JSON.stringify(got.texts),
    );
  } finally {
    try {
      conn.close();
    } catch { /* closed by the server */ }
  }
});
