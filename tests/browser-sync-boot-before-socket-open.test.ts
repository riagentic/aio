// The sync engine boots from `ensureConnected()` — BEFORE the socket that
// `ensureConnected()` itself opens has finished its handshake (in a production
// bundle the "lazy" import is inlined, so it resolves in microtasks; the
// socket needs a network round trip). Its boot `requestSync()` — the catch-up,
// and the replay of the offline queue a previous page load left in
// localStorage — went to `_sendRaw`, which answers "no channel" for a
// CONNECTING socket and drops the frame. The engine still believed it was
// online, so when the socket opened `setSyncOnline(true)` was no transition
// (`wasOffline` false) and NO sync-req was ever sent on the connection: the
// previous session's unsent ops sat in the buffer, unsent.
//
// The transport now hands the engine its real state when it wires it, so
// "engine online" means "transport up". Pinned both ways: booted before the
// open → exactly one sync-req once it opens; booted after → exactly one (the
// boot request), never a second from the wiring.
import { assert, assertEquals } from "@std/assert";
import { _teardownNow } from "../src/browser/protocol-subscription.ts";
import {
  _resetBrowserSync,
  getBrowserSyncEngine,
} from "../src/browser/browser-sync.ts";
import {
  _resetCellRegistry,
  getRegisteredCells,
} from "../src/state/cell-reactive.ts";
import { _resetSignals } from "../src/state/state-signals.ts";
import { _rejectAllPending } from "../src/browser/browser-ack.ts";
import { createSyncEngine } from "../src/sync/sync-engine.ts";
import { createMemoryStorage, createOpBuffer } from "../src/sync/op-buffer.ts";
import { normalizeSyncConfig } from "../src/sync/types.ts";

class FakeWS {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWS[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

function shimLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
  return store;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const syncReqsOn = (ws: FakeWS) =>
  ws.sent.filter((f) => f.includes('"t":"sync-req"'));

/** Boots a sync cell with an op a previous page load left queued, runs
 *  `drive(ensureConnected)`, and hands back the one socket it opened. */
async function withLeftoverOp(
  drive: (ensureConnected: () => void) => Promise<FakeWS>,
): Promise<{ ws: FakeWS; opId: string }> {
  const g = globalThis as Record<string, unknown>;
  const prevWS = g.WebSocket;
  const prevLoc = g.location;
  g.WebSocket = FakeWS;
  FakeWS.instances = [];
  if (!prevLoc) {
    g.location = {
      protocol: "http:",
      host: "localhost:1234",
      search: "",
      origin: "http://localhost:1234",
      href: "http://localhost:1234/",
      pathname: "/",
    };
  }
  const store = shimLocalStorage();
  // The previous page load queued this op offline and was closed before it
  // could send it — exactly what the localStorage queue exists for.
  const leftover = {
    id: "prev-session-op-1",
    cell: "hboard",
    action: "add",
    payload: { args: ["written offline"] },
    hlc: [Date.now() - 1000, 0, "c0ffee00"],
    confirmed: false,
    _clientTs: Date.now() - 1000,
  };
  store.set("__aio_sync:hboard", JSON.stringify({ ops: [leftover] }));

  try {
    await import("../src/browser/browser-air-transport.ts");
    const { ensureConnected, _resetEnsured } = await import(
      "../src/browser/browser-protocol.ts"
    );
    const { cell } = await import("../src/browser/protocol-cell.ts");
    _resetEnsured();
    cell("hboard", {
      state: { notes: [] as string[] },
      sync: true,
      methods: {
        add(s: { notes: string[] }, text: string) {
          s.notes.push(text);
        },
      },
    });
    assert(getRegisteredCells().has("hboard"));
    const ws = await drive(ensureConnected);
    return { ws, opId: leftover.id };
  } finally {
    _teardownNow();
    _resetBrowserSync();
    _rejectAllPending(new Error("test teardown"));
    _resetCellRegistry();
    _resetSignals();
    if (prevWS === undefined) delete g.WebSocket;
    else g.WebSocket = prevWS;
    if (!prevLoc) delete g.location;
  }
}

Deno.test({
  name:
    "sync: an offline op left by the previous page load is replayed once the socket opens",
  async fn() {
    const { ws, opId } = await withLeftoverOp(async (ensureConnected) => {
      ensureConnected(); // boots the engine AND opens the socket
      assertEquals(FakeWS.instances.length, 1, "one socket, still CONNECTING");
      const ws = FakeWS.instances[0]!;
      // The engine's import resolves and it boots while the handshake runs.
      await sleep(30);
      assert(
        getBrowserSyncEngine() !== null,
        "the engine booted before the handshake completed",
      );
      assertEquals(ws.readyState, 0, "…and the socket is still CONNECTING");
      ws.open(); // the handshake completes
      await sleep(50);
      return ws;
    });
    const reqs = syncReqsOn(ws);
    assertEquals(
      reqs.length,
      1,
      `the connection carries exactly one sync-req (the catch-up + the ` +
        `replay of the offline queue); the socket saw: ${
          JSON.stringify(ws.sent.map((f) => JSON.parse(f).t))
        }`,
    );
    assert(
      reqs[0]!.includes(opId),
      "the previous session's queued op is replayed on the connection",
    );
  },
});

Deno.test({
  name:
    "sync: an engine booting on an ALREADY-open socket sends one sync-req, not two",
  async fn() {
    const { ws, opId } = await withLeftoverOp(async (ensureConnected) => {
      ensureConnected();
      const ws = FakeWS.instances[0]!;
      ws.open(); // open before the engine's import has resolved
      await sleep(50);
      assert(getBrowserSyncEngine() !== null, "the engine booted");
      return ws;
    });
    const reqs = syncReqsOn(ws);
    assertEquals(reqs.length, 1, "the boot request, and no second one");
    assert(reqs[0]!.includes(opId), "…carrying the queued op");
  },
});

Deno.test("sync-engine: a catch-up that goes offline while reading the buffer is not sent", async () => {
  const sent: string[] = [];
  const engine = createSyncEngine({
    clientId: "c1",
    cells: { notes: normalizeSyncConfig(true) },
    buffer: createOpBuffer(createMemoryStorage()),
    send: (m) => sent.push(m),
    reducer: (s) => s,
    getConfirmedState: () => ({ notes: {} }),
    setConfirmedState: () => {},
    onStateUpdate: () => {},
  });
  try {
    const req = engine.requestSync(); // suspended on the buffer read
    engine.setOnline(false); // the transport drops meanwhile
    await req;
    assertEquals(sent, [], "no frame into a transport known to be down");
    assertEquals(engine.getStatus("notes").status, "offline");
    engine.setOnline(true); // the transition asks again
    await sleep(10);
    assertEquals(sent.filter((f) => f.includes("sync-req")).length, 1);
  } finally {
    engine.dispose();
  }
});
