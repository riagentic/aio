// A session that EXPIRES while its socket is in the middle of a burst.
//
// The server asks the session store on every inbound frame, so the frame that
// arrives first after the expiry is the one that finds out — with the rest of
// the burst unread behind it. Closing from inside that frame's handler is the
// case `_closeAfterRead` (server-ws.ts) was written for and did not cover:
// the close handshake fails on unread data, the peer never receives the 1008
// or its reason, and a tab that cannot tell "signed out" from "connection
// lost" says "Reconnecting…" for ever. The server said it at debug level only.
//
// Over a real socket against a real server with the login flows on, and a
// session short enough to die mid-test.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

/** Until `done`, or `ms` at the most — and no timer left behind when `done`
 *  comes first. */
const doneWithin = async (done: Promise<unknown>, ms: number) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([done, new Promise((r) => (t = setTimeout(r, ms)))]);
  clearTimeout(t);
};

/** A WebSocket peer on a bare TCP socket: whole batches in one write, and the
 *  close frame read as the server wrote it (code + reason, or `null` when the
 *  connection just ended). */
async function rawWs(base: URL, path: string) {
  const conn = await Deno.connect({
    hostname: base.hostname,
    port: Number(base.port),
  });
  conn.setNoDelay(true);
  const te = new TextEncoder();
  const td = new TextDecoder();
  await conn.write(te.encode(
    `GET ${path} HTTP/1.1\r\nHost: ${base.host}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n` +
      `Sec-WebSocket-Key: ${btoa("0123456789abcdef")}\r\n\r\n`,
  ));
  let buf = new Uint8Array(0);
  const more = async (): Promise<boolean> => {
    const chunk = new Uint8Array(65536);
    const n = await conn.read(chunk).catch(() => null);
    if (n === null) return false;
    const next = new Uint8Array(buf.length + n);
    next.set(buf);
    next.set(chunk.subarray(0, n), buf.length);
    buf = next;
    return true;
  };
  let head = -1;
  while ((head = td.decode(buf).indexOf("\r\n\r\n")) < 0) {
    if (!await more()) throw new Error("the upgrade was not answered");
  }
  const status = td.decode(buf).split("\r\n")[0];
  if (!status?.includes("101")) throw new Error(`upgrade refused: ${status}`);
  buf = buf.slice(head + 4);

  const peer = {
    texts: [] as string[],
    close: null as { code: number; reason: string } | null,
    done: Promise.resolve(),
    /** One masked text frame per item, all in a single write. */
    async send(items: string[]): Promise<void> {
      const parts = items.map((item) => {
        const data = te.encode(item);
        const ext = data.length < 126 ? 0 : 2;
        const f = new Uint8Array(2 + ext + 4 + data.length);
        f[0] = 0x81;
        f[1] = 0x80 | (ext ? 126 : data.length);
        if (ext) new DataView(f.buffer).setUint16(2, data.length);
        // A zero mask is a valid mask: the payload goes out as it is.
        f.set(data, 2 + ext + 4);
        return f;
      });
      const all = new Uint8Array(parts.reduce((n, f) => n + f.length, 0));
      let at = 0;
      for (const f of parts) {
        all.set(f, at);
        at += f.length;
      }
      for (let w = 0; w < all.length;) w += await conn.write(all.subarray(w));
    },
    end(): void {
      try {
        conn.close();
      } catch { /* already closed */ }
    },
  };
  peer.done = (async () => {
    for (;;) {
      // One whole server frame (never masked), or wait for the rest of it.
      if (buf.length >= 2) {
        const len7 = buf[1]! & 0x7f;
        const ext = len7 === 126 ? 2 : len7 === 127 ? 8 : 0;
        if (buf.length >= 2 + ext) {
          const dv = new DataView(buf.buffer, buf.byteOffset);
          const len = ext === 2
            ? dv.getUint16(2)
            : ext === 8
            ? Number(dv.getBigUint64(2))
            : len7;
          if (buf.length >= 2 + ext + len) {
            const body = buf.subarray(2 + ext, 2 + ext + len);
            const op = buf[0]! & 0x0f;
            if (op === 1) peer.texts.push(td.decode(body));
            if (op === 8) {
              peer.close = {
                code: len >= 2 ? (body[0]! << 8) | body[1]! : 0,
                reason: td.decode(body.subarray(2)),
              };
              return peer.end();
            }
            buf = buf.slice(2 + ext + len);
            continue;
          }
        }
      }
      if (!await more()) return;
    }
  })();
  return peer;
}

Deno.test("session expiry mid-burst: the peer hears 1008 'session revoked', the server says it once, and nothing sent after it runs", async () => {
  _resetAuthFails();
  /** When each call RAN on the server. */
  const ran: number[] = [];
  const c = cell("burst", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
        ran.push(Date.now());
      },
    },
  });
  // deno-lint-ignore no-explicit-any
  const auth = { ttlMs: 900 } as any;
  await using srv = await testServer({ cells: [c], auth });
  const su = await srv.fetch("/__aio/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: srv.url },
    body: JSON.stringify({ id: "alice", password: "correct horse battery" }),
  });
  assertEquals(su.status, 201);
  const token = (await su.json()).token as string;

  // The server's own lines, with when each was said.
  const said: { at: number; msg: string }[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (_lvl: string, _cat: string, msg: string) => {
        // What an operator's log keeps: debug is off outside a debug run.
        if (_lvl !== "debug" && _lvl !== "trace") {
          said.push({ at: Date.now(), msg });
        }
        // deno-lint-ignore no-explicit-any
        (prev as any)?.pub?.(_lvl, _cat, msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );

  // A raw socket, not `WebSocket`: each batch must reach the server as ONE
  // write. Through `WebSocket.send` the frames are separate small writes and
  // Nagle holds all but the first until the server answers — which the frame
  // that finds the session dead never does — so they arrive after the close
  // and the case this test is about (frames ALREADY read behind the deciding
  // one) never happens. Measured: 0 of 39 arrived inside the drain window.
  const peer = await rawWs(new URL(srv.url), `/ws?token=${token}`);
  try {
    await peer.send([enc("proto", protoHello())]);
    // Batches of 40 (under the 100/s budget) until the server closes us; the
    // first batch after the expiry has 39 frames behind the deciding one.
    let sent = 0;
    for (let round = 0; round < 12 && peer.close === null; round++) {
      const batch: string[] = [];
      for (let i = 0; i < 40; i++) {
        batch.push(
          enc("action", { type: "burst:inc", payload: {}, cid: `c${sent++}` }),
        );
      }
      await peer.send(batch).catch(() => {}); // the peer may already be gone
      await doneWithin(peer.done, 450);
    }
    await doneWithin(peer.done, 2_000);
    assertEquals(
      peer.close,
      { code: 1008, reason: "session revoked" },
      `the peer is told WHY — it shows signed out, not reconnecting (${sent})`,
    );
    const okAcks = new Set<string>();
    for (const text of peer.texts) {
      const f = dec(text);
      const d = f?.d as { cid?: string; ok?: boolean } | undefined;
      if (f?.t === "ack" && d?.ok === true && d.cid) okAcks.add(d.cid);
    }

    const lines = said.filter((l) => /session revoked or expired/.test(l.msg));
    assertEquals(
      lines.map((l) => l.msg.replace(/closing \w+/, "closing <id>")),
      ["ws: closing <id> — session revoked or expired (user=alice)"],
      "the server says it, once: " + said.map((l) => l.msg).join(" | "),
    );
    assert(ran.length > 0, "the live session's calls ran");
    assert(ran.length < sent, "…and the dead session's did not");
    const late = ran.filter((t) => t > lines[0]!.at);
    assertEquals(late, [], "no call ran after the session was found dead");
    assertEquals(
      okAcks.size,
      ran.length,
      "every call that ran was acked, and nothing else was",
    );
  } finally {
    setLogger(prev);
    peer.end();
    await peer.done;
  }
});
