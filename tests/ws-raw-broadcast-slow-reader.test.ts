// `broadcastRaw` closed a peer that WAS reading, just slowly.
//
// Its rule was a byte level: over `WS_BUFFER_HIGH_WATER` unread bytes → close
// 1013 "not draining". A sync client on a slow link with a cell state over
// the mark is over it for as long as the handshake's whole-state frame takes
// to drain — so the first raw frame any peer caused in that time closed it.
// Measured: a 6 MB sync cell read at 1 MB/s, a peer writing every 500 ms —
// closed every ~6 s, 3/3 rounds; it never kept a live connection and
// re-downloaded the whole state each time. The rule is now "not draining":
// the backlog has not reached a new low for a while, or has grown a whole
// mark above it. A peer that reads nothing must still be closed, in bounded
// time — the second test.
//
// Real server, real TCP peers that upgrade, send the engine's on-open
// `sync-req`, and then read at a chosen rate.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

const ITEM = "z".repeat(1_000_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function connect(port: number): Promise<Deno.TcpConn> {
  const conn = await Deno.connect({ port, hostname: "127.0.0.1" });
  await conn.write(
    new TextEncoder().encode(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
    ),
  );
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
  return conn;
}

/** Read at `rate` bytes/s for `slowMs`, then at full speed until `ms` — the
 *  close code if the server sent one. Frames arrive in order, so a close the
 *  server sent behind megabytes of backlog is only seen once that is read. */
async function readFor(
  conn: Deno.TcpConn,
  rate: number,
  ms: number,
  slowMs = ms,
): Promise<{ close?: number; at?: number; read: number }> {
  const t0 = Date.now();
  const chunk = new Uint8Array(64 * 1024);
  let buf = new Uint8Array(0);
  let header = false;
  let read = 0;
  while (Date.now() - t0 < ms) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const n = await Promise.race([
      conn.read(chunk).catch(() => null),
      new Promise<"idle">((r) => (timer = setTimeout(() => r("idle"), 500))),
    ]).finally(() => clearTimeout(timer));
    if (n === null) return { read, at: Date.now() - t0 };
    if (n === "idle") continue;
    read += n;
    const nb = new Uint8Array(buf.length + n);
    nb.set(buf);
    nb.set(chunk.subarray(0, n), buf.length);
    buf = nb;
    const due = t0 + (read / rate) * 1000;
    if (Date.now() - t0 < slowMs && due > Date.now()) {
      await sleep(due - Date.now());
    }
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
      if (op === 8) {
        const p = buf.subarray(off, off + len);
        return { close: (p[0]! << 8) | p[1]!, at: Date.now() - t0, read };
      }
      buf = buf.subarray(off + len);
    }
  }
  return { read };
}

async function setup(writeBytes: number) {
  const notes = cell("notes", {
    sync: true,
    state: { items: [] as string[] },
    methods: {
      add(s: { items: string[] }, t: string) {
        s.items.push(t);
      },
    },
  });
  const srv = await testServer({
    cells: [notes],
    budgets: { cellState: "16MB", payload: "16MB" },
  });
  for (let i = 0; i < 6; i++) await notes.add(ITEM + i);
  await sleep(800); // past the server-write fold
  // Another peer writing every 500 ms — each write a raw sync frame.
  let n = 0;
  const pad = "w".repeat(writeBytes);
  const writer = setInterval(() => void notes.add(pad + n++), 500);
  return { srv, stop: () => clearInterval(writer) };
}

Deno.test("ws backlog: a slow-but-reading peer stays connected through a 6 MB state while another peer writes", async () => {
  const { srv, stop } = await setup(10);
  const conn = await connect(srv.port);
  try {
    // 1 MB/s through the 6 MB state and the 6 MB snapshot `sync-res` behind
    // it: ~12 s over the mark, and the runtime's `bufferedAmount` only drops
    // as each whole frame completes. Then the writer stops and the rest is
    // read back at full speed — so a close queued behind the backlog is seen.
    const halt = setTimeout(stop, 14_000);
    const got = await readFor(conn, 1_000_000, 18_000, 14_000)
      .finally(() => clearTimeout(halt));
    assertEquals(
      got.close,
      undefined,
      `a peer that keeps reading must not be closed as "not draining" ` +
        `(closed ${got.close} after ${got.at} ms, ${got.read} B read)`,
    );
    assert(got.read > 12_000_000, `it read state + sync-res: ${got.read} B`);
  } finally {
    stop();
    try {
      conn.close();
    } catch { /* closed by the server */ }
    await srv.close();
  }
});

Deno.test("ws backlog: a peer that reads nothing is still closed 1013 within a bounded time", async () => {
  // 400 KB per write: its backlog grows a whole mark above its low in ~5 s.
  const { srv, stop } = await setup(400_000);
  const conn = await connect(srv.port);
  const t0 = Date.now();
  try {
    await sleep(7_000); // reads nothing
    // …then read it all back, up to the close. 4 s missed it with five
    // suites on the machine: the backlog in front of the close is megabytes.
    // The read ends AT the close, so a longer window costs a fast box nothing.
    const got = await readFor(conn, 1e12, 15_000);
    assertEquals(
      got.close,
      1013,
      `a peer that never reads must be closed (got ${got.close})`,
    );
    assert(Date.now() - t0 < 25_000, `closed after ${Date.now() - t0}ms`);
  } finally {
    stop();
    try {
      conn.close();
    } catch { /* closed by the server */ }
    await srv.close();
  }
});
