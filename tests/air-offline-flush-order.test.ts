// The offline queue's two halves must replay in ONE order, and a flush that
// fails part-way must lose nothing.
//
// There are two queues for a structural reason (cell-method dispatch in
// browser/browser-air-transport.ts, `useCell().send` in the isomorphic core,
// which cannot import it). They used to be replayed one whole queue after the
// other on reconnect — so `send(a)` typed BEFORE a cell method `b` went out
// AFTER it, and for two writes to the same field the loser was whichever the
// user meant to win. Reconnect silently reordered intent.
//
// And the flush itself drained first and sent second: a throw mid-flush lost
// every action after it AND left their callers pending forever — both lost and
// unanswered, the one outcome the queue contract exists to forbid.
//
// Driven through the live module with a fake WebSocket, not a source grep.
import { assert, assertEquals } from "@std/assert";

const sent: string[] = [];
let failFrom = -1;

class FakeWS {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static last: FakeWS | null = null;
  constructor(public url: string) {
    FakeWS.last = this;
  }
  send(d: string) {
    if (failFrom >= 0 && sent.length >= failFrom) {
      throw new Error("socket wedged mid-flush");
    }
    sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

/** Action types, in the order they left the socket. */
function actionTypes(): string[] {
  const out: string[] = [];
  for (const frame of sent) {
    try {
      const f = JSON.parse(frame) as { t?: string; d?: { type?: string } };
      if (f.t === "action" && f.d?.type) out.push(f.d.type);
    } catch { /* non-action frame (proto/type hello) */ }
  }
  return out;
}

const g = globalThis as Record<string, unknown>;
const prevWS = g.WebSocket;
const prevLoc = g.location;
g.WebSocket = FakeWS;
if (!prevLoc) {
  g.location = {
    protocol: "http:",
    host: "localhost:1234",
    search: "",
    origin: "http://localhost:1234",
  };
}

await import("../src/browser/browser-air-transport.ts");
const { client, ensureConnected } = await import(
  "../src/browser/browser-protocol.ts"
);
const { send: coreSend, setTransport: coreSetTransport } = await import(
  "../src/state-core.ts"
);

/** Open a socket, let everything already queued drain into the bin, and close
 *  again — so each case starts from an empty, offline transport regardless of
 *  what other tests in this process left behind. */
function reset(): void {
  sent.length = 0;
  failFrom = -1;
  ensureConnected();
  FakeWS.last?.open();
  FakeWS.last?.onclose?.();
  coreSetTransport(null);
  sent.length = 0;
}

Deno.test("air offline queue: both halves replay in the order the user acted", () => {
  reset();
  // Interleave the two paths while offline. Cell-method dispatch goes through
  // the transport's queue; `useCell().send` goes through the core's.
  client.send({ type: "ord:air1" });
  coreSend({ type: "ord:core1" });
  client.send({ type: "ord:air2" });
  coreSend({ type: "ord:core2" });

  ensureConnected();
  FakeWS.last?.open();

  assertEquals(
    actionTypes().filter((t) => t.startsWith("ord:")),
    ["ord:air1", "ord:core1", "ord:air2", "ord:core2"],
    "reconnect replayed one whole queue after the other, reordering intent",
  );
  FakeWS.last?.onclose?.();
  coreSetTransport(null);
});

Deno.test("air offline queue: a flush that throws part-way re-queues the rest, in order", () => {
  reset();
  for (let i = 0; i < 6; i++) client.send({ type: `frag:${i}` });

  // The socket accepts the protocol hellos and the first two actions, then
  // refuses everything.
  ensureConnected();
  failFrom = 4; // 2 hello frames + 2 actions
  FakeWS.last?.open();
  const first = actionTypes().filter((t) => t.startsWith("frag:"));
  assertEquals(first, ["frag:0", "frag:1"]);
  FakeWS.last?.onclose?.();
  coreSetTransport(null);

  // Nothing was lost: the remainder is back in the queue, in order, and goes
  // out on the next open. It used to be dropped on the floor with its callers
  // left waiting on a frame that was never coming.
  sent.length = 0;
  failFrom = -1;
  ensureConnected();
  FakeWS.last?.open();
  assertEquals(
    actionTypes().filter((t) => t.startsWith("frag:")),
    ["frag:2", "frag:3", "frag:4", "frag:5"],
  );
  FakeWS.last?.onclose?.();
  coreSetTransport(null);
});

addEventListener("unload", () => {
  if (prevWS === undefined) delete g.WebSocket;
  else g.WebSocket = prevWS;
  if (!prevLoc) delete g.location;
});
