// tests/sync/snapshot-load-client-converges.test.ts — a snapshot load that
// UNDOES acked sync ops must hold on every live client.
//
// `loadSnapshot` replaces a sync cell's state wholesale and reaches the sync
// engine as a server write (aio.ts `_jumpSyncCells`, as a time-travel jump
// does). The question a load raises that an additive write does not: can a
// client's already-acked ops, still in its confirmed history, come back on
// the next op — or be resent and resurrect what the load removed? They must
// not: the load is pushed as the new confirmed base, acked ops are never
// resent, and an op still in flight lands once, ABOVE the loaded state.
import { assertEquals } from "@std/assert";
import { createNet, type State } from "./_net.ts";

const CELL = "board";
const apply = (s: State, action: string, payload: unknown): State =>
  action === "add"
    ? { ...s, notes: [...(s.notes as string[]), payload as string] }
    : s;
const settle = () => new Promise((r) => setTimeout(r, 160));

Deno.test("a snapshot load that undoes acked sync ops holds on every live client — nothing resurrects, an in-flight op lands above it", async () => {
  const net = createNet({ cell: CELL, initial: () => ({ notes: [] }), apply });
  try {
    const tab = net.addClient("tab");
    const peer = net.addClient("peer");
    await tab.engine.requestSync();
    await peer.engine.requestSync();
    await net.pump();
    await tab.engine.handleLocalAction(CELL, "add", "keep");
    await net.pump();
    await peer.engine.handleLocalAction(CELL, "add", "UNDO-ME");
    await net.pump();
    assertEquals(net.live().notes, ["keep", "UNDO-ME"]);

    // In flight when the load lands.
    await tab.engine.handleLocalAction(CELL, "add", "pending");
    // The load: the state the snapshot held, wholesale.
    net.serverWrite(() => ({ notes: ["keep"] }));
    await settle();
    await net.pump();

    await peer.engine.handleLocalAction(CELL, "add", "after");
    await net.pump();
    await tab.engine.requestSync(); // a reconnect-style catch-up
    await net.pump();

    const want = ["keep", "pending", "after"];
    assertEquals(net.live().notes, want, "server truth");
    for (const c of [tab, peer]) {
      assertEquals(c.confirmed().notes, want, `${c.name} confirmed`);
      assertEquals(c.view().notes, want, `${c.name} view`);
      assertEquals((await c.buffer.getUnconfirmed(CELL)).length, 0);
    }
  } finally {
    await net.close();
  }
});
