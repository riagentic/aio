// A fresh client receives its initial full state exactly ONCE.
//
// Both transports send the whole state at connect (the Electron relay
// re-seeds documents from the connection's frames in accept order — proto,
// cfg, …, state — so that frame stays). The client then declares its
// subscriptions, and the `subs` reply sent the whole state AGAIN: for the
// usual wildcard or all-cells subscription it serializes to the same bytes
// the peer already holds. Measured on real Electron 44 over UDS: the first
// document of every window got two identical `state` frames — the biggest
// frame the transport ever sends, twice, before the app rendered once — and
// every per-frame meter (cost meter, `am timeline`, the transport probe)
// counted it twice. Idempotent, so it was never wrong; only wasteful.
//
// A `subs` that NARROWS the view still gets its filtered state, and a
// `resync` is never deduplicated: the client is saying its state is wrong,
// and the server's memo of what it holds is exactly what is in question.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { createWsManager } from "../src/server/server-ws.ts";
import { createUDSListener } from "../src/server/uds.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Frame = { t: string; d?: unknown };
const kinds = (frames: Frame[]) => frames.map((f) => f.t);
const states = (frames: Frame[]) => frames.filter((f) => f.t === "state");

// ── WS ────────────────────────────────────────────────────────────────────

async function wsRig() {
  const state = { a: { n: 1 }, b: { n: 2 } };
  const mgr = createWsManager({
    dispatch: () => {},
    getUIState: () => state,
    debug: () => {},
    prod: false,
    clientCounter: { value: 0 },
    bootId: "b",
  });
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => mgr.handleWs(req),
  );
  const connect = () =>
    new Promise<{ ws: WebSocket; frames: Frame[] }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const frames: Frame[] = [];
      ws.onmessage = (e) => {
        const f = dec(String(e.data));
        if (f) frames.push(f);
        if (f?.t === "state") resolve({ ws, frames });
      };
      ws.onerror = () => reject(new Error("ws error"));
    });
  return {
    state,
    connect,
    close: async () => {
      mgr.shutdown();
      await server.shutdown();
    },
  };
}

Deno.test("ws: the connect-time state is not re-sent by a subs reply that changes nothing", async () => {
  const r = await wsRig();
  try {
    for (const subs of [["*"], ["a", "b"], ["a.n", "b"]]) {
      const c = await r.connect();
      c.ws.send(enc("subs", { subs }));
      await wait(150);
      assertEquals(
        states(c.frames).length,
        1,
        `subs ${JSON.stringify(subs)}: ${kinds(c.frames).join(", ")}`,
      );
      c.ws.close();
    }
  } finally {
    await r.close();
  }
});

Deno.test("ws: a subs that narrows the view, and a resync, still get their state", async () => {
  const r = await wsRig();
  try {
    const c = await r.connect();
    c.ws.send(enc("subs", { subs: ["a"] }));
    await wait(150);
    assertEquals(states(c.frames).length, 2, kinds(c.frames).join(", "));
    assertEquals(states(c.frames)[1]!.d, { a: { n: 1 } }, "the filtered view");
    c.ws.send(enc("resync"));
    await wait(150);
    assertEquals(
      states(c.frames).length,
      3,
      "a resync is answered even when the memo says the client is current",
    );
    c.ws.close();
  } finally {
    await r.close();
  }
});

// ── UDS ───────────────────────────────────────────────────────────────────

async function udsPeer(socketPath: string) {
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const frames: Frame[] = [];
  const decoder = new TextDecoder();
  let buf = "";
  const reader = conn.readable.getReader();
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop()!;
        for (const p of parts) {
          const f = p ? dec(p) : null;
          if (f) frames.push(f);
        }
      }
    } catch { /* closed */ }
  })();
  const send = (msg: string) => {
    const w = conn.writable.getWriter();
    w.write(new TextEncoder().encode(msg + "\n")).catch(() => {});
    w.releaseLock();
  };
  return { conn, frames, send };
}

Deno.test("uds: the accept-time state is not re-sent by a subs reply that changes nothing", async () => {
  const socketPath = join(
    await tempDir("aio-initial-state-sent-once-"),
    "once.sock",
  );
  const uds = createUDSListener(
    socketPath,
    () => ({ a: { n: 1 }, b: { n: 2 } }),
    () => {},
    () => {},
  );
  await wait(30);
  try {
    for (const subs of [["*"], ["a", "b"], ["a.n", "b"]]) {
      const p = await udsPeer(socketPath);
      // The relay's own timing: subscriptions go out at once, before the
      // accept-time state has necessarily been read.
      p.send(enc("subs", { subs }));
      await wait(150);
      // Accept order is untouched: the relay re-seeds documents from it.
      assertEquals(kinds(p.frames).slice(0, 2), ["proto", "state"]);
      assertEquals(
        states(p.frames).length,
        1,
        `subs ${JSON.stringify(subs)}: ${kinds(p.frames).join(", ")}`,
      );
      p.conn.close();
      await wait(20);
    }
  } finally {
    uds.shutdown();
  }
});

Deno.test("uds: a subs that narrows the view, and a resync, still get their state", async () => {
  const socketPath = join(
    await tempDir("aio-initial-state-sent-once-"),
    "narrow.sock",
  );
  const uds = createUDSListener(
    socketPath,
    () => ({ a: { n: 1 }, b: { n: 2 } }),
    () => {},
    () => {},
  );
  await wait(30);
  const p = await udsPeer(socketPath);
  try {
    await wait(50);
    p.send(enc("subs", { subs: ["a"] }));
    await wait(150);
    assertEquals(states(p.frames).length, 2, kinds(p.frames).join(", "));
    assertEquals(states(p.frames)[1]!.d, { a: { n: 1 } }, "the filtered view");
    p.send(enc("resync"));
    await wait(150);
    assertEquals(states(p.frames).length, 3, "a resync is always answered");
  } finally {
    p.conn.close();
    await wait(20);
    uds.shutdown();
  }
});
