// tests/sync/server-write-push.test.ts — a write to a sync cell that is not a
// sync op must reach every LIVE client and stay there.
//
// A client's confirmed state is folded from ops. `am dispatch`, an effect,
// cron, a serverFn and every ASYNC method on a sync cell (the browser sends
// those as plain actions) change the server's state without producing one, so
// the engine never heard of the change: the next sync op rebased the view onto
// confirmed state without it, and the write vanished from every tab while the
// server kept it (measured in Chromium: `am dispatch board:add from-cli`, then
// Add in the tab → the tab showed only "from-tab", the server both).
import { assertEquals } from "@std/assert";
import { createNet, type State } from "./_net.ts";

const CELL = "board";
const apply = (s: State, action: string, payload: unknown): State =>
  action === "add"
    ? { ...s, notes: [...(s.notes as string[]), payload as string] }
    : s;

async function settleServerWrite(): Promise<void> {
  // The server folds a burst of writes on a short debounce.
  await new Promise((r) => setTimeout(r, 160));
}

Deno.test("a server-side write survives the next sync op on every live client", async () => {
  const net = createNet({ cell: CELL, initial: () => ({ notes: [] }), apply });
  try {
    const tab = net.addClient("tab");
    const peer = net.addClient("peer");
    await tab.engine.requestSync();
    await peer.engine.requestSync();
    await net.pump();

    net.serverWrite((s) => apply(s, "add", "from-cli"));
    await settleServerWrite();
    await net.pump();

    await tab.engine.handleLocalAction(CELL, "add", "from-tab");
    await net.pump();

    const want = ["from-cli", "from-tab"];
    assertEquals(net.live().notes, want, "server truth");
    for (const c of [tab, peer]) {
      assertEquals(c.confirmed().notes, want, `${c.name} confirmed`);
      assertEquals(c.view().notes, want, `${c.name} view`);
    }
  } finally {
    await net.close();
  }
});

Deno.test("a server-side write racing a pending op: the op lands once, above it", async () => {
  const net = createNet({ cell: CELL, initial: () => ({ notes: [] }), apply });
  try {
    const tab = net.addClient("tab");
    await tab.engine.requestSync();
    await net.pump();

    // The op is issued and still in flight when the server write is pushed.
    await tab.engine.handleLocalAction(CELL, "add", "pending");
    net.serverWrite((s) => apply(s, "add", "from-effect"));
    await settleServerWrite();
    await net.pump();

    assertEquals(net.live().notes, ["from-effect", "pending"], "server truth");
    assertEquals(tab.confirmed().notes, net.live().notes, "confirmed");
    assertEquals(tab.view().notes, net.live().notes, "view");
    assertEquals((await tab.buffer.getUnconfirmed(CELL)).length, 0);
  } finally {
    await net.close();
  }
});

Deno.test("a server-side write pushed while a catch-up is outstanding folds in position", async () => {
  const net = createNet({ cell: CELL, initial: () => ({ notes: [] }), apply });
  try {
    const tab = net.addClient("tab");
    const peer = net.addClient("peer");
    await tab.engine.requestSync();
    await peer.engine.requestSync();
    await net.pump();

    // The tab asks for a catch-up; before its request is served, a peer op and
    // a server write both land and are pushed/broadcast ahead of the answer.
    await tab.engine.requestSync();
    const req = tab.outbox.splice(0);
    await peer.engine.handleLocalAction(CELL, "add", "peer-op");
    await net.pump();
    net.serverWrite((s) => apply(s, "add", "from-cron"));
    await settleServerWrite();
    tab.outbox.push(...req);
    await net.pump();

    await tab.engine.handleLocalAction(CELL, "add", "after");
    await net.pump();
    const want = ["peer-op", "from-cron", "after"];
    assertEquals(net.live().notes, want, "server truth");
    for (const c of [tab, peer]) {
      assertEquals(c.confirmed().notes, want, `${c.name} confirmed`);
      assertEquals(c.view().notes, want, `${c.name} view`);
    }
  } finally {
    await net.close();
  }
});

Deno.test("a pushed write is not a catch-up: onSync stays quiet and the cursor stays put", async () => {
  let syncs = 0;
  const net = createNet({
    cell: CELL,
    initial: () => ({ notes: [] }),
    apply,
    sync: { onSync: () => void syncs++ },
  });
  try {
    const tab = net.addClient("tab");
    await tab.engine.requestSync();
    await net.pump();
    const before = {
      syncs,
      cursor: (await tab.buffer.getMeta(CELL))?.lastServerTs,
    };

    net.serverWrite((s) => apply(s, "add", "from-serverfn"));
    await settleServerWrite();
    await net.pump();

    assertEquals(tab.view().notes, ["from-serverfn"], "the write arrived");
    assertEquals(
      syncs,
      before.syncs,
      "onSync is for catch-ups this client asked for",
    );
    assertEquals(
      (await tab.buffer.getMeta(CELL))?.lastServerTs,
      before.cursor,
      "only a catch-up response moves the cursor",
    );
  } finally {
    await net.close();
  }
});
