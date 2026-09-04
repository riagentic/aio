// A round whose SNAPSHOT could not be built is a lost round, and a lost round
// is owed a whole state — not a patch that assumes it landed.
//
// Both broadcasters carry `needsFull` for exactly this: a skipped round (a
// frozen peer, a backlogged socket, a throttled one) and a thrown round each
// set it, so the next round the client is eligible for sends whole state.
// The full-state fallback had one more way to lose a round — the snapshot
// builder answering `undefined` (a view that threw, a value JSON refuses) —
// and that path did `continue` and nothing else. A "full"-strategy cell's
// change is expressible ONLY by that snapshot, so when the failure was
// transient the client kept receiving patches on top of a state that never
// saw it: diverged with health green, until the next unrelated force round.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import { createUDSListener } from "../src/server/uds.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAD = "p".repeat(400); // keeps the one-field patch under the threshold
const kind = (frame: string) => JSON.parse(frame).t as string;

function fakeClient() {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(msg: string) {
      sent.push(msg);
    },
  } as unknown as WebSocket;
  const meta = {
    id: "c1",
    index: 0,
    clientType: "browser",
    isElectron: false,
    msgCount: 0,
    bytesThisSec: 0,
    bpMultiplier: 1,
    bpConsecutiveLow: 0,
    bpLastSentAt: 0,
    subscriptions: null,
    disconnected: false,
    consecutiveDrops: 0,
  } as unknown as ClientMeta;
  return { ws, meta, sent };
}

const smallPatch: PatchEntry[] = [
  { cell: "c", ops: [{ op: "replace", path: ["v"], value: 2 }] },
  // deno-lint-ignore no-explicit-any
] as any;

Deno.test("ws: a force round whose snapshot fails owes the client whole state", async () => {
  // `f` is the "full"-strategy cell: its changes never travel as patches.
  const state = { c: { v: 1, pad: PAD }, f: { x: 1 } };
  let broken = false;
  const { ws, meta, sent } = fakeClient();
  const connections = new Map<WebSocket, ClientMeta>([[ws, meta]]);
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => {
      if (broken) throw new Error("transient: view threw");
      return state;
    },
    debug: () => {},
    syncIntervalMs: 1,
  });
  try {
    meta.lastFullJson = JSON.stringify(state); // the connect frame
    meta.lastFullJsonStale = false;

    // The full cell changes; its force round cannot be built.
    state.f.x = 2;
    broken = true;
    broadcaster.broadcast();
    await wait(15);
    assertEquals(sent.length, 0, "nothing could go out");

    // The view heals. The next round is an ordinary small patch on `c`.
    broken = false;
    state.c.v = 2;
    broadcaster.broadcast(smallPatch);
    await wait(15);
    assertEquals(sent.length, 1);
    assertEquals(
      kind(sent[0]!),
      "state",
      "a patch here leaves the client holding f.x=1 against a server at 2",
    );
    assert(sent[0]!.includes(`"x":2`), sent[0]);
  } finally {
    broadcaster.shutdown();
  }
});

Deno.test("uds: a force round whose snapshot fails owes the peer whole state", async () => {
  const socketPath = join(
    await tempDir("aio-broadcast-failed-snapshot-owes-full-"),
    "owes-full.sock",
  );
  const state = { c: { v: 1, pad: PAD }, f: { x: 1 } };
  let broken = false;
  const uds = createUDSListener(
    socketPath,
    () => {
      if (broken) throw new Error("transient: view threw");
      return state;
    },
    () => {},
    () => {},
  );
  await wait(30);
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const lines: string[] = [];
  const reader = conn.readable.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop()!;
        for (const p of parts) if (p) lines.push(p);
      }
    } catch { /* closed */ }
  })();
  await wait(80);
  lines.length = 0;
  try {
    state.f.x = 2;
    broken = true;
    uds.broadcastState(true);
    await wait(40);
    assertEquals(lines.length, 0, "nothing could go out");

    broken = false;
    state.c.v = 2;
    uds.broadcastState(smallPatch);
    await wait(40);
    assertEquals(lines.length, 1, lines.join("\n"));
    assertEquals(
      kind(lines[0]!),
      "state",
      "a patch here leaves the window holding f.x=1 against a server at 2",
    );
    assert(lines[0]!.includes(`"x":2`), lines[0]);
  } finally {
    conn.close();
    await wait(30);
    uds.shutdown();
  }
});
