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
import {
  _callConnectFn,
  _teardownNow,
} from "../src/browser/protocol-subscription.ts";
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
const { cell } = await import("../src/browser/protocol-cell.ts");
const { serverFn } = await import("../src/browser/server-fns-client.ts");
const { _rejectAllPending } = await import("../src/browser/browser-ack.ts");

// A bound cell method — the third path into the same line. Declared before
// the first `ensureConnected()` so the binding pass wires it to the transport.
// deno-lint-ignore no-explicit-any
const ord = cell("ord", {
  state: { n: 0 },
  methods: {
    inc: (s: { n: number }) => void s.n++,
    second: (s: { n: number }) => void s.n++,
  },
}) as any;

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
  _teardownNow(); // the close above scheduled a reconnect — a test owns its client
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
  _teardownNow(); // the close above scheduled a reconnect — a test owns its client
});

addEventListener("unload", () => {
  if (prevWS === undefined) delete g.WebSocket;
  else g.WebSocket = prevWS;
  if (!prevLoc) delete g.location;
});

// `wire.omitTrailingUndefined` is decided where the frame is built. The queue
// replays with a bare `enc`, not through the action door — so the replay is a
// door of its own, on both halves, and it was the one a trim at the door
// alone would have missed: a call made offline sent `null`, the same call
// made online did not.
Deno.test("air offline queue: a replayed call is shaped by wire.omitTrailingUndefined like a live one — both halves", () => {
  const cfg = globalThis as { __aioConfig?: Record<string, unknown> };
  const had = cfg.__aioConfig;
  const argsOf = () =>
    sent.flatMap((frame) => {
      const f = JSON.parse(frame) as {
        t?: string;
        d?: { type?: string; payload?: { args?: unknown[] } };
      };
      return f.t === "action" && f.d?.type?.startsWith("trim:")
        ? [[f.d.type, f.d.payload?.args]]
        : [];
    });
  const queueBoth = () => {
    client.send({ type: "trim:air", payload: { args: ["a", undefined] } });
    coreSend({ type: "trim:core", payload: { args: ["a", undefined] } });
    client.send({ type: "trim:mid", payload: { args: [undefined, "a"] } });
  };
  try {
    for (const on of [true, false]) {
      reset();
      // Called BEFORE the page knows (a shell the build templated learns its
      // config from the first frames of the connection)…
      delete cfg.__aioConfig;
      queueBoth();
      // …and sent after.
      if (on) cfg.__aioConfig = { wire: { omitTrailingUndefined: true } };
      ensureConnected();
      FakeWS.last?.open();
      assertEquals(argsOf(), [
        ["trim:air", on ? ["a"] : ["a", null]],
        ["trim:core", on ? ["a"] : ["a", null]],
        ["trim:mid", [null, "a"]],
      ], `omitTrailingUndefined: ${on}`);
    }
  } finally {
    if (had === undefined) delete cfg.__aioConfig;
    else cfg.__aioConfig = had;
    reset();
  }
});

// A bound cell method used to send one microtask late (`_registerAndSend`
// deferred `sendFn` with queueMicrotask), so its seq — online pacer and offline
// queue alike — was taken AFTER any `serverFn` call or core `send` made later
// in the same turn. `ord.inc(); serverFn("api").list(); coreSend(x)` went out
// sfn, x, inc; offline, `ord.inc(); coreSend(second)` replayed second, inc.
// A call holds its place in line from the moment it is made.
Deno.test("call order: a bound cell method keeps its place ahead of a later core send — offline replay", () => {
  reset();
  ord.inc();
  coreSend({ type: "ord:second" });
  ensureConnected();
  FakeWS.last?.open();
  assertEquals(
    actionTypes().filter((t) => t.startsWith("ord:")),
    ["ord:inc", "ord:second"],
    "offline replay put the core send ahead of the earlier cell method call",
  );
  FakeWS.last?.onclose?.();
  coreSetTransport(null);
  _rejectAllPending(new Error("test teardown"));
  _teardownNow();
});

Deno.test("call order: a bound cell method goes out before a later serverFn call and core send — online", () => {
  reset();
  // A genuinely live socket: tear the old client down and connect afresh, so
  // `_ws` is the socket that opens (the pacer path), not a stale handle.
  _teardownNow();
  const before = FakeWS.last;
  _callConnectFn();
  assert(FakeWS.last && FakeWS.last !== before, "a fresh socket was opened");
  FakeWS.last.open();
  sent.length = 0;
  ord.inc();
  const sfn = serverFn<{ list: () => Promise<unknown> }>("api").list();
  sfn.catch(() => {});
  coreSend({ type: "ord:inc" });
  const order = sent.flatMap((frame) => {
    try {
      const f = JSON.parse(frame) as { t?: string; d?: { type?: string } };
      if (f.t === "sfn") return ["sfn"];
      if (f.t === "action" && f.d?.type) return [`action:${f.d.type}`];
    } catch { /* not JSON */ }
    return [];
  });
  assertEquals(
    order,
    ["action:ord:inc", "sfn", "action:ord:inc"],
    "a later serverFn / core send overtook the cell method call on the wire",
  );
  FakeWS.last?.onclose?.(); // settles the serverFn call (connection lost)
  coreSetTransport(null);
  _rejectAllPending(new Error("test teardown"));
  _teardownNow();
});
