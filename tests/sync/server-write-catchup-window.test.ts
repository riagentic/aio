// A server-origin write pushed EARLY — carried out by another client's
// catch-up snapshot, before its debounced fold — must still reach a client
// that was offline for that push and reconnects before the fold.
//
// Found by the `offline replay` property (tests/sync/properties/
// offline-replay.test.ts). The write is in live
// state but in no op and not yet in the snapshot, so the op-log cannot serve
// it: the reconnecting client took the INCREMENTAL branch (its cursor was
// above the last compaction) and got ops only. The fold then found the write
// already pushed (`_dirty` cleared by the other client's catch-up) and pushed
// nothing — the client stayed without the write, connected and "synced",
// until some later push or reconnect happened to repair it.
import { assertEquals } from "@std/assert";
import { createNet, type NetClient, type State } from "./_net.ts";
import { getCompactedTs } from "../../src/sync/server-store.ts";
import type { HLC } from "../../src/sync/types.ts";

type S = { items: string[] };
const apply = (s: State, action: string, p: unknown): State =>
  action === "add" ? { items: [...(s as S).items, p as string] } : s;

/** Deliver every frame both ways with no idle waiting — `pump` idles ~40ms
 *  per call, and the whole window under test is the 100ms fold debounce. */
async function drain(net: ReturnType<typeof createNet>): Promise<void> {
  for (let idle = 0; idle < 3;) {
    let moved = false;
    for (const c of net.clients) {
      while (c.outbox.length) {
        moved = true;
        const f = JSON.parse(c.outbox.shift()!);
        if (f.t === "op") {
          await net.handler.handleOp(f.d, { id: c.name }, c.socket);
        } else if (f.t === "sync-req") {
          net.handler.handleSync(f.d, { id: c.name }, c.socket);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 0));
    for (const c of net.clients) {
      while (c.inbox.length) {
        moved = true;
        const f = JSON.parse(c.inbox.shift()!);
        if (f.t === "sync-ack") {
          await c.engine.handleAck(
            f.d.cell,
            f.d.opId,
            f.d.serverHlc as HLC,
            f.d.serverTs,
          );
        } else if (f.t === "op") await c.engine.handleRemoteOp(f.d);
        else if (f.t === "sync-res") await c.engine.handleSyncResponse(f.d);
      }
    }
    await new Promise((r) => setTimeout(r, 0));
    idle = moved ? 0 : idle + 1;
  }
}

const offline = (c: NetClient) => {
  c.online = false;
  c.engine.setOnline(false);
  c.inbox.length = 0;
  c.outbox.length = 0;
};
const online = (c: NetClient) => {
  c.online = true;
  c.engine.setOnline(true);
};

Deno.test("sync: a client reconnecting between an early push and the fold is not served a log that lacks the write", async () => {
  const net = createNet({
    cell: "board",
    initial: () => ({ items: [] }),
    apply,
  });
  try {
    const a = net.addClient("a");
    const b = net.addClient("b");
    await b.engine.handleLocalAction("board", "add", "b-1");
    await net.pump();
    // A compaction, so a cursorless client is served a snapshot.
    net.serverWrite((s) => ({ items: [...(s as S).items, "srv-1"] }));
    await net.handler.flushServerWrites();
    await net.pump();
    // Both hold a cursor at/after that compaction — the log serves them.
    await a.engine.requestSync();
    await b.engine.requestSync();
    await net.pump();
    assertEquals(b.confirmed(), net.live());

    offline(b);
    // The write: committed and noted, its fold still ahead (debounced).
    net.serverWrite((s) => ({ items: [...(s as S).items, "srv-2"] }));
    const folded = await getCompactedTs(net.db, "board");
    // A fresh client's catch-up snapshot carries the write out as a push —
    // to the clients online NOW (a, c). b is not one of them.
    const c = net.addClient("c");
    await c.engine.requestSync();
    await drain(net);
    // b comes back before the fold.
    online(b);
    await drain(net);
    assertEquals(
      await getCompactedTs(net.db, "board"),
      folded,
      "precondition: the fold has not run yet (the window under test)",
    );
    await net.handler.flushServerWrites();
    await net.pump();

    const live = net.live();
    assertEquals(a.confirmed(), live, "a");
    assertEquals(c.confirmed(), live, "c");
    assertEquals(b.confirmed(), live, "b missed the early-pushed write");
    assertEquals(b.view(), live, "b view");
  } finally {
    await net.close();
  }
});

// Suspected by review: `settleServerWrite` clears `_unfolded` after the fold's
// transaction, and a write can commit DURING that await — so the flag is
// cleared while the snapshot lacks the write. It is cleared, and it is safe:
// that write's `noteServerWrite` also set `_dirty`, so the same settle pushes
// it (at a position Y) before releasing the cell lock. Every position a client
// can hold is issued under that lock, so no client can hold a cursor between
// the fold's X and the push's Y: it got the push, or it holds a cursor below X
// and is served a snapshot. Pinned with the transaction paused mid-fold.
Deno.test("sync: a write committing during a fold's transaction still reaches every client", async () => {
  const net = createNet({
    cell: "board",
    initial: () => ({ items: [] }),
    apply,
  });
  try {
    const a = net.addClient("a");
    const b = net.addClient("b");
    await a.engine.requestSync();
    await b.engine.requestSync();
    await net.pump();

    const db = net.db as { transaction: (arg: unknown) => Promise<unknown> };
    const real = db.transaction.bind(db);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let paused = false;
    db.transaction = async (arg: unknown) => {
      if (!paused) {
        paused = true;
        await gate;
      }
      return await real(arg);
    };

    net.serverWrite((s) => ({ items: [...(s as S).items, "w1"] }));
    const settling = net.handler.flushServerWrites();
    while (!paused) await new Promise((r) => setTimeout(r, 0));
    // Inside the fold: its state is captured (w1), its transaction is not
    // committed. w2 commits now, and b drops off before the push.
    net.serverWrite((s) => ({ items: [...(s as S).items, "w2"] }));
    offline(b);
    release();
    await settling;
    await drain(net);
    assertEquals(a.confirmed(), net.live(), "a got w2 in the settle's push");

    // b comes back while w2 is in no snapshot — its fold is still pending.
    online(b);
    await drain(net);
    assertEquals(b.confirmed(), net.live(), "b is served a state with w2");
    await net.handler.flushServerWrites();
    await net.pump();
    assertEquals(b.confirmed(), net.live());
    assertEquals(a.confirmed(), net.live());
  } finally {
    await net.close();
  }
});
