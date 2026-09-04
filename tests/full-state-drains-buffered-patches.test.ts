// A full state sent OUT OF BAND must first drain the patches it already holds.
//
// The coalescer paces background churn: after a leading flush, every patch
// produced in the next `syncIntervalMs` (default 50 ms) is buffered and goes
// out on the trailing edge. `flushAllUrgent()` short-circuits that window for
// CLIENT actions only (`dispatchNetwork`); a server-originated dispatch — a
// timer, an effect, a poller, server code calling `cell.method()` — sits in
// the buffer.
//
// Three paths send a client a whole state OUTSIDE the flush loop: the connect
// handshake, a `subs` reply and a `resync` reply. Each serializes the CURRENT
// state, which already contains every buffered patch's write — and then the
// trailing edge sent those same patches to that client anyway. Immer applies
// an `add` by splicing, so a buffered `push` landed TWICE: the server held
// ["one","two"], the client ["one","two","two"], with no error anywhere (the
// index is in range, so the impossible-op guard cannot see it) and `resync`
// — the client's own repair — re-creating the condition it was meant to fix.
//
// Reachable by any app whose server writes while a window opens, reloads, or
// re-subscribes: a 1 s poller pushing rows into a list is enough.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dec, enc } from "../src/protocol/envelope.ts";
import { applyWirePatches, type WirePatch } from "../src/protocol/patch-ops.ts";
import { freePort } from "../src/testing/server-test.ts";
import { createUDSListener } from "../src/server/uds.ts";
import { createUdsBroadcastController } from "../src/server/aio-run-helpers.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wide enough that a loopback connect lands INSIDE the throttle window. */
const WINDOW_MS = 400;
/** Keeps a one-row `add` well under the patch-vs-full threshold, so the
 *  trailing edge really sends a PATCH — a full frame would be idempotent and
 *  hide the double application. */
const PAD = "p".repeat(2000);

type Frame = { t: string; d?: unknown };

/** What a peer holds after replaying its frames exactly as a client does:
 *  the last `state` is the base, every later `patches` is applied to it. */
function replay(frames: Frame[]): unknown {
  let held: unknown = undefined;
  for (const f of frames) {
    if (f.t === "state") held = f.d;
    else if (f.t === "patches" && held !== undefined) {
      held = applyWirePatches(held, f.d as WirePatch[]);
    }
  }
  return held;
}

async function wsRig() {
  const { aio, cell } = await import("../mod.ts");
  const list = cell("list", {
    state: { items: [] as string[], pad: PAD },
    visible: "all",
    methods: {
      push(s: { items: string[] }, v: string) {
        s.items.push(v);
      },
    },
  });
  const port = freePort();
  const app = await aio.run({
    cells: [list],
    appId: "test-full-drains-buffered",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    syncIntervalMs: WINDOW_MS,
    baseDir: await tempDir("aio-full-state-drains-buffered-patches-"),
  });
  const connect = () =>
    new Promise<{ ws: WebSocket; frames: Frame[] }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const frames: Frame[] = [];
      const t = setTimeout(() => reject(new Error("ws timeout")), 5000);
      ws.onmessage = (e) => {
        const f = dec(String(e.data));
        if (f) frames.push(f);
        if (f?.t === "state") {
          clearTimeout(t);
          resolve({ ws, frames });
        }
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("ws error"));
      };
    });
  return {
    list,
    connect,
    server: () => app.getState().list as { items: string[]; pad: string },
    close: () => app.close(),
  };
}

Deno.test("ws: a client that connects mid-window is not sent the patches its state already holds", async () => {
  const r = await wsRig();
  const a = await r.connect();
  try {
    // A server-side write opens the window (leading flush to A)…
    await r.list.push("one");
    await wait(20);
    // …and a second one lands in the buffer, to go out on the trailing edge.
    await r.list.push("two");
    // B connects INSIDE the window: its state frame already holds both.
    const b = await r.connect();
    await wait(WINDOW_MS + 100);
    assertEquals(r.server().items, ["one", "two"]);
    assertEquals(
      replay(b.frames),
      { list: { items: ["one", "two"], pad: PAD } },
      `B replayed its frames to a state that is not the server's:\n${
        b.frames.map((f) => JSON.stringify(f)).join("\n")
      }`,
    );
    // A, which missed nothing, still receives "two" — as a patch or as state.
    assertEquals(replay(a.frames), {
      list: { items: ["one", "two"], pad: PAD },
    });
    b.ws.close();
  } finally {
    a.ws.close();
    await r.close();
  }
});

Deno.test("ws: a resync mid-window does not re-create the desync it repairs", async () => {
  const r = await wsRig();
  const a = await r.connect();
  try {
    await r.list.push("one");
    await wait(20);
    await r.list.push("two"); // buffered
    a.ws.send(enc("resync"));
    await wait(WINDOW_MS + 100);
    assertEquals(
      replay(a.frames),
      { list: { items: ["one", "two"], pad: PAD } },
      a.frames.map((f) => JSON.stringify(f)).join("\n"),
    );
  } finally {
    a.ws.close();
    await r.close();
  }
});

Deno.test("ws: a subs reply mid-window is not followed by the patches it already holds", async () => {
  const r = await wsRig();
  const a = await r.connect();
  try {
    await r.list.push("one");
    await wait(20);
    await r.list.push("two"); // buffered
    a.ws.send(enc("subs", { subs: ["list"] }));
    await wait(WINDOW_MS + 100);
    assertEquals(
      replay(a.frames),
      { list: { items: ["one", "two"], pad: PAD } },
      a.frames.map((f) => JSON.stringify(f)).join("\n"),
    );
  } finally {
    a.ws.close();
    await r.close();
  }
});

// ── UDS: the desktop transport, same three doors ──────────────────────────

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

function udsRig(socketPath: string) {
  const state = { list: { items: [] as string[], pad: PAD } };
  const uds = createUDSListener(socketPath, () => state, () => {}, () => {});
  const ctrl = createUdsBroadcastController({
    getUdsHandle: () => uds,
    syncIntervalMs: WINDOW_MS,
  });
  const push = (v: string) => {
    const at = state.list.items.length;
    state.list.items = [...state.list.items, v];
    const patch: PatchEntry[] = [{
      cell: "list",
      ops: [{ op: "add", path: ["items", at], value: v }],
    }];
    ctrl.onUdsBroadcast(patch);
  };
  return {
    state,
    push,
    close: () => {
      ctrl.dispose();
      uds.shutdown();
    },
  };
}

Deno.test("uds: a peer that connects mid-window is not sent the patches its state already holds", async () => {
  const socketPath = join(
    await tempDir("aio-full-state-drains-buffered-patches-"),
    "drain-connect.sock",
  );
  const r = udsRig(socketPath);
  await wait(30);
  const a = await udsPeer(socketPath);
  await wait(50);
  try {
    r.push("one");
    await wait(20);
    r.push("two"); // buffered
    const b = await udsPeer(socketPath);
    await wait(WINDOW_MS + 100);
    assertEquals(
      replay(b.frames),
      { list: { items: ["one", "two"], pad: PAD } },
      b.frames.map((f) => JSON.stringify(f)).join("\n"),
    );
    assertEquals(replay(a.frames), {
      list: { items: ["one", "two"], pad: PAD },
    });
    b.conn.close();
  } finally {
    a.conn.close();
    await wait(30);
    r.close();
  }
});

Deno.test("uds: resync and subs mid-window do not re-create the desync they repair", async () => {
  for (const door of ["resync", "subs"] as const) {
    const socketPath = join(
      await tempDir("aio-full-state-drains-buffered-patches-"),
      `drain-${door}.sock`,
    );
    const r = udsRig(socketPath);
    await wait(30);
    const a = await udsPeer(socketPath);
    await wait(50);
    try {
      r.push("one");
      await wait(20);
      r.push("two"); // buffered
      a.send(
        door === "resync" ? enc("resync") : enc("subs", { subs: ["list"] }),
      );
      await wait(WINDOW_MS + 100);
      assertEquals(
        replay(a.frames),
        { list: { items: ["one", "two"], pad: PAD } },
        `${door}:\n${a.frames.map((f) => JSON.stringify(f)).join("\n")}`,
      );
    } finally {
      a.conn.close();
      await wait(30);
      r.close();
    }
  }
});
