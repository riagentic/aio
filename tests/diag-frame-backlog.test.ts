// Dev `diag` frames respect the WebSocket high-water mark — skip, never close.
//
// Every broadcast loop skips a peer holding more than `WS_BUFFER_HIGH_WATER`
// unread bytes (write-backlog.ts). The dev `diag` relay had two loops and
// neither was right: under per-user auth it wrote every diagnostic to an admin
// socket that had stopped reading, without limit, on the server's heap; in
// shared mode it went through `broadcastRaw`, which CLOSES a non-draining peer
// — the policy for a sync op, which cannot be skipped without a gap. A diag
// frame is observe-only and can be: the peer is skipped for that frame and
// stays connected.
//
// A real server, a raw TCP peer that upgrades and never reads, and what the
// server queued for it measured by finally reading it all back.
import { assert } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { diagEmit } from "../src/diagnostics/diagnostic-bus.ts";
import { WS_BUFFER_HIGH_WATER } from "../src/server/write-backlog.ts";

const FRAME_BYTES = 200_000;
const FRAMES = 150; // 30 MB offered — 7× the high-water mark

type Drained = { textFrames: number; textBytes: number; closed: boolean };

/** Read everything queued for this peer until the stream goes quiet. */
async function drain(conn: Deno.TcpConn): Promise<Drained> {
  const out: Drained = { textFrames: 0, textBytes: 0, closed: false };
  let buf = new Uint8Array(0);
  const chunk = new Uint8Array(1 << 20);
  let headerDone = false;
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const n = await Promise.race([
      conn.read(chunk),
      new Promise<"idle">((r) => {
        timer = setTimeout(() => r("idle"), 1000);
      }),
    ]).finally(() => clearTimeout(timer));
    if (n === "idle") return out;
    if (n === null) return { ...out, closed: true };
    const next = new Uint8Array(buf.length + n);
    next.set(buf);
    next.set(chunk.subarray(0, n), buf.length);
    buf = next;
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
        len = Number(
          new DataView(buf.buffer, buf.byteOffset + 2, 8).getBigUint64(0),
        );
        off = 10;
      }
      if (buf.length < off + len) break;
      if (op === 0x1) {
        out.textFrames++;
        out.textBytes += len;
      } else if (op === 0x8) return { ...out, closed: true };
      buf = buf.subarray(off + len);
    }
  }
}

const c = cell("diagbacklog", { state: { n: 0 }, methods: {} });

/** Flood a raw peer that never reads with diag frames; what it was sent. */
async function flood(
  users?: Record<string, { id: string; role: string }>,
): Promise<Drained> {
  await using srv = await testServer({ cells: [c], users } as never);
  const silent = await Deno.connect({ port: srv.port, hostname: "127.0.0.1" });
  try {
    await silent.write(
      new TextEncoder().encode(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          (users ? `Authorization: Bearer tok-admin\r\n` : "") +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`,
      ),
    );
    await new Promise((r) => setTimeout(r, 300)); // registered
    const pad = "x".repeat(FRAME_BYTES);
    for (let i = 0; i < FRAMES; i++) {
      // Unique type per event: the bus dedups by type within a window.
      diagEmit({
        type: `test:backlog-${i}-${crypto.randomUUID()}`,
        severity: "info",
        source: "test",
        message: pad,
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    return await drain(silent);
  } finally {
    try {
      silent.close();
    } catch { /* already closed */ }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Bounded by the mark plus what the two kernels buffer on loopback and the
 *  frame that crossed it — not by how much was offered — and still open. */
function assertSkippedNotClosed(got: Drained): void {
  assert(
    got.textBytes < WS_BUFFER_HIGH_WATER + 12 * 1024 * 1024,
    `the server queued ${
      (got.textBytes / 1048576).toFixed(1)
    } MB (${got.textFrames}/${FRAMES} ` +
      `diag frames) for a peer that never read — it must stop at the ` +
      `${WS_BUFFER_HIGH_WATER / 1048576} MB high-water mark`,
  );
  assert(
    !got.closed,
    "a skipped diag frame leaves no gap to repair — the peer is not closed",
  );
}

Deno.test("diag backlog: per-user admin socket that never reads is skipped past the high-water mark", async () => {
  const got = await flood({ "tok-admin": { id: "root", role: "admin" } });
  assert(got.textFrames > 0, "positive control: the peer received diag frames");
  assertSkippedNotClosed(got);
});

Deno.test("diag backlog: shared-mode socket that never reads is skipped, not closed", async () => {
  const got = await flood();
  assert(got.textFrames > 0, "positive control: the peer received diag frames");
  assertSkippedNotClosed(got);
});
