// A per-client frame the CRDT relay could not deliver is NEVER silent.
//
// Every reply in `sync/server-handler.ts` used to be
// `try { socket.send(enc(…)) } catch {}` with the comment "client
// disconnected". That comment was a guess, and it was the only record of the
// failure. `send` throws for one uninteresting reason — the peer went away —
// and for several interesting ones the same empty catch ate: a socket the
// server itself closed, a frame that could not be encoded. On a sync relay the
// consequence is not cosmetic: an undelivered `sync-ack` is an op the client
// resends forever, rebasing it on confirmed state that already contains it.
//
// So `sendTo` decides from the socket's OWN `readyState` which failure this
// was: a peer already gone is a debug line, anything else is a warning that
// names the frame that was lost.
import { assert, assertEquals } from "@std/assert";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { createTestDb, until } from "./_test-db.ts";

type Logs = { debug: string[]; warn: string[]; error: string[] };

function harness() {
  const { db, close } = createTestDb();
  const logs: Logs = { debug: [], warn: [], error: [] };
  let state: Record<string, unknown> = { items: [] as string[] };
  const handler = createServerSyncHandler({
    dispatch: (a) => {
      if (a.type === "notes:add") {
        state = {
          ...state,
          items: [...(state.items as string[]), a.payload as string],
        };
      }
    },
    db,
    syncCellIds: ["notes"],
    getCellState: () => state,
    getClientCellState: () => state,
    broadcastRaw: { fn: () => {} },
    log: {
      debug: (m) => logs.debug.push(m),
      warn: (m) => logs.warn.push(m),
      error: (m) => logs.error.push(m),
    },
  });
  return { handler, logs, close };
}

/** A socket that refuses every write, in a chosen readyState. */
function brokenSocket(readyState: number, why = "kaboom"): WebSocket {
  return {
    readyState,
    send: () => {
      throw new Error(why);
    },
  } as unknown as WebSocket;
}

Deno.test("a sync-res that fails on an OPEN socket is warned, naming the frame", async () => {
  const { handler, logs, close } = harness();
  try {
    handler.handleSync(
      { clientId: "c1", reqId: 1, cells: { notes: { lastHlc: null } } },
      { id: "c1" },
      brokenSocket(WebSocket.OPEN, "kaboom"),
    );
    await until(
      () => logs.warn.some((w) => w.includes("sync-res")),
      "a warning about the undelivered sync-res",
    );
    const w = logs.warn.find((w) => w.includes("sync-res"))!;
    assert(w.includes("kaboom"), `the cause is in the message: ${w}`);
    assert(
      w.includes("open socket"),
      `it says the socket was open, so this is not a disconnect: ${w}`,
    );
  } finally {
    close();
  }
});

Deno.test("a sync-res that fails on a CLOSED socket is a debug line, not a warning", async () => {
  const { handler, logs, close } = harness();
  try {
    handler.handleSync(
      { clientId: "c1", reqId: 1, cells: { notes: { lastHlc: null } } },
      { id: "c1" },
      brokenSocket(WebSocket.CLOSED),
    );
    await until(
      () => logs.debug.some((d) => d.includes("sync-res not delivered")),
      "a debug line about the client already being gone",
    );
    assertEquals(
      logs.warn.filter((w) => w.includes("sync-res")),
      [],
      "a peer that already went away is not a warning",
    );
  } finally {
    close();
  }
});

Deno.test("an undeliverable sync-ack names the op — the client will resend it forever", async () => {
  const { handler, logs, close } = harness();
  try {
    await handler.handleOp(
      {
        id: "op-1",
        hlc: [Date.now(), 0, "c1"],
        cell: "notes",
        action: "add",
        payload: "hello",
      },
      { id: "c1" },
      brokenSocket(WebSocket.OPEN, "socket wedged"),
    );
    await until(
      () => logs.warn.some((w) => w.includes("sync-ack for op-1")),
      "a warning naming the op whose ack never went out",
    );
    const w = logs.warn.find((w) => w.includes("sync-ack for op-1"))!;
    assert(w.includes("socket wedged"), `the cause is in the message: ${w}`);
    assertEquals(
      logs.debug.filter((d) => d.includes("sync-ack")),
      [],
      "an OPEN socket that refused the ack is not filed as a disconnect",
    );
  } finally {
    close();
  }
});
