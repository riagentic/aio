// Two properties of the server's snapshot folds (server-handler.ts):
//
//  1. `flushServerWrites()` — what a clean shutdown awaits before closing the
//     database — waits for a fold ALREADY IN FLIGHT (its debounce timer
//     fired), not only for the ones still pending. It returned without it,
//     and the shutdown closed the database under the fold (review rev9).
//  2. An op waiting under its cell's lock for a save its commit owes
//     (`durableFor`, the ack-after-durable rule) cannot deadlock with an op
//     on ANOTHER cell waiting the same way for a fold of the first: a fold
//     asked for a cell whose lock holder is parked runs under the holder's
//     lock (`_parked`).
import { assert, assertEquals } from "@std/assert";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import {
  _resetServerTsForTest,
  loadSnapshot,
} from "../../src/sync/server-store.ts";
import type { DB } from "../../src/db/types.ts";
import type { HLC } from "../../src/sync/types.ts";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";

const silentLog = { debug: () => {}, warn: () => {}, error: () => {} };

/** `db` whose snapshot transaction takes `ms` — a fold with real weight. */
function slowFolds(db: DB, ms: number): DB {
  return {
    ...db,
    transaction: (async (a: unknown) => {
      await new Promise((r) => setTimeout(r, ms));
      return await (db.transaction as (x: unknown) => Promise<unknown>)(a);
    }) as DB["transaction"],
  };
}

Deno.test("flushServerWrites waits for a fold already in flight", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const live = { n: 1 };
    const handler = createServerSyncHandler({
      dispatch: () => {},
      db: slowFolds(db, 300),
      syncCellIds: ["c"],
      getCellState: () => live,
      getClientCellState: () => live,
      broadcastRaw: { fn: () => {} },
      log: silentLog,
    });
    handler.noteServerWrite("c");
    // Past the 100 ms debounce: the timer has fired, the fold is writing.
    await new Promise((r) => setTimeout(r, 180));
    assertEquals(await loadSnapshot(db, "c"), null, "still in flight");
    await handler.flushServerWrites();
    assertEquals(
      (await loadSnapshot(db, "c"))?.state,
      live,
      "the flush returned before the fold it had to wait for",
    );
  } finally {
    close();
  }
});

for (const when of ["before", "after"] as const) {
  Deno.test(`two ops each owing a fold of the other's cell both ack — no deadlock (fold asked ${when} the wait)`, async () => {
    _resetServerTsForTest();
    const { db, close } = createTestDb();
    try {
      const live: Record<string, Record<string, unknown>> = {
        a: { n: 0 },
        b: { n: 0 },
      };
      const other = (c: string) => (c === "a" ? "b" : "a");
      const owed = new WeakMap<object, Promise<string | undefined>>();
      let arrived = 0;
      let bothIn: () => void;
      const together = new Promise<void>((r) => (bothIn = r));
      const handler: ReturnType<typeof createServerSyncHandler> =
        createServerSyncHandler({
          dispatch: async (act) => {
            const cell = act.type.slice(0, act.type.indexOf(":"));
            live[cell] = { n: (live[cell]!.n as number) + 1 };
            // The reaction lands on the OTHER cell, and its stand-in save is a
            // fold of that cell — owed before this op may be acked.
            const o = other(cell);
            live[o] = { ...live[o], [`from_${cell}`]: true };
            handler.noteServerWrite(o);
            // Both ops hold their own lock before either asks for the other's.
            if (++arrived === 2) bothIn();
            await together;
            owed.set(
              act,
              when === "before"
                ? handler.flushServerWrites([o])
                // Asked once both holders are already parked.
                : new Promise((r) => setTimeout(r, 20)).then(() =>
                  handler.flushServerWrites([o])
                ),
            );
          },
          durableFor: (act) => owed.get(act),
          db,
          syncCellIds: ["a", "b"],
          getCellState: (c) => live[c]!,
          getClientCellState: (c) => live[c]!,
          broadcastRaw: { fn: () => {} },
          log: silentLog,
        });
      const { socket, frames } = recordingSocket();
      const send = (cell: string) =>
        handler.handleOp(
          {
            id: `op-${cell}`,
            hlc: [Date.now(), 0, "c1"] as HLC,
            cell,
            action: "inc",
            payload: {},
          },
          { id: "c1" },
          socket,
        );
      await Promise.all([send("a"), send("b")]);
      await until(
        () => frames.filter((f) => f.t === "sync-ack").length === 2,
        "both ops acked",
      );
      for (const c of ["a", "b"]) {
        const snap = await loadSnapshot(db, c);
        assert(snap, `${c} was folded before its reaction's cause was acked`);
        assertEquals(snap.state, live[c]);
      }
    } finally {
      close();
    }
  });
}

// A fold of the op's OWN cell that runs under its parked holder (the stand-in
// save of a reaction is often exactly that) used to PUSH the state — which
// already holds the op — before the op's `sync-ack`. The origin folded the
// push and rebased its still-pending op on top: applied twice until the ack.
// Folded at once; pushed after the ack (review rev10).
Deno.test("a fold under a parked holder pushes AFTER the holder's ack", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const order: string[] = [];
    let live: Record<string, unknown> = { items: [] as string[] };
    const owed = new WeakMap<object, Promise<undefined>>();
    const handler: ReturnType<typeof createServerSyncHandler> =
      createServerSyncHandler({
        dispatch: (act) => {
          live = { items: [...(live.items as string[]), "X"] };
          // The op's commit owes a fold of its own cell.
          owed.set(
            act,
            handler.flushServerWrites(["a"]).then(() => undefined),
          );
        },
        durableFor: (a) => owed.get(a),
        db,
        syncCellIds: ["a"],
        getCellState: () => live,
        getClientCellState: () => live,
        broadcastRaw: {
          fn: (f: string) => {
            const d = JSON.parse(f);
            order.push(`all:${d.t}${d.d?.push ? ":push" : ""}`);
          },
        },
        log: silentLog,
      });
    const { socket, frames } = recordingSocket();
    const send = socket.send.bind(socket);
    (socket as { send: (d: string) => void }).send = (d: string) => {
      const f = JSON.parse(String(d));
      order.push(`origin:${f.t}${f.d?.push ? ":push" : ""}`);
      send(d);
    };
    // Registered as a sync peer (pushes reach it), then a write is pending.
    await handler.handleSync(
      { clientId: "c1", cells: { a: { lastHlc: null } }, pendingOps: [] },
      { id: "c1" },
      socket,
    );
    await until(() => frames.some((f) => f.t === "sync-res"), "caught up");
    handler.noteServerWrite("a");
    await handler.handleOp(
      {
        id: "X",
        hlc: [Date.now(), 0, "c1"] as HLC,
        cell: "a",
        action: "add",
        payload: {},
      },
      { id: "c1" },
      socket,
    );
    await until(() => frames.some((f) => f.t === "sync-ack"), "acked");
    const ack = order.indexOf("origin:sync-ack");
    const push = order.findIndex((o) => o.endsWith(":push"));
    assert(
      push !== -1,
      `the fold's push went out at all:\n${order.join("\n")}`,
    );
    assert(push > ack, `pushed before the ack:\n${order.join("\n")}`);
  } finally {
    close();
  }
});
