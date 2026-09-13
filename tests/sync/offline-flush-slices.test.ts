// tests/sync/offline-flush-slices.test.ts — a reconnect must be able to flush
// an offline queue bigger than one server frame.
//
// The whole queue went out in ONE `sync-req`. The server drops any inbound
// frame over its message limit (1 MB by default) unread, so 400 ops × 4 KB was
// a 1.6 MB frame: dropped, re-sent at the next reconnect, dropped again. No op
// was ever acked, the catch-up never answered, and 400 writes stayed on one
// screen only. (Measured in Chromium: "ws: message too large", twice, and 280
// writes gone from the other tab.)
import { assert, assertEquals } from "@std/assert";
import { createNet, type State } from "./_net.ts";

const CELL = "notes";
/** The server's default inbound frame limit (server-ws.ts WS_MAX_MESSAGE). */
const SERVER_FRAME_LIMIT = 1_000_000;
const apply = (s: State, action: string, payload: unknown): State =>
  action === "add"
    ? {
      ...s,
      items: [...(s.items as string[]), (payload as string).slice(0, 8)],
    }
    : s;

Deno.test("a 1.6 MB offline queue reaches the server in frames it accepts, in order", async () => {
  const net = createNet({ cell: CELL, initial: () => ({ items: [] }), apply });
  try {
    const tab = net.addClient("tab");
    const peer = net.addClient("peer");
    await tab.engine.requestSync();
    await peer.engine.requestSync();
    await net.pump();

    tab.online = false;
    tab.engine.setOnline(false);
    const pad = "x".repeat(4000);
    const want: string[] = [];
    for (let i = 0; i < 400; i++) {
      const id = `n${String(i).padStart(4, "0")}___`.slice(0, 8);
      want.push(id);
      await tab.engine.handleLocalAction(CELL, "add", id + pad);
    }

    tab.online = true;
    tab.engine.setOnline(true);
    // While the older queue is still going out, a new change waits behind it.
    await tab.engine.handleLocalAction(CELL, "add", "late____" + pad);
    want.push("late____");

    for (let i = 0; i < 200; i++) {
      // Drop what the server would drop — the frame never arrives.
      tab.outbox = tab.outbox.filter((f) => f.length <= SERVER_FRAME_LIMIT);
      await net.pump();
      if ((await tab.buffer.getUnconfirmed(CELL)).length === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const biggest = Math.max(...tab.sentLog.map((f) => f.length));
    assert(
      biggest <= SERVER_FRAME_LIMIT,
      `every frame fits the server's limit — the biggest was ${biggest}`,
    );
    assertEquals(net.live().items, want, "server has every write, in order");
    assertEquals(tab.confirmed().items, want, "tab confirmed");
    assertEquals(peer.confirmed().items, want, "peer confirmed");
    assertEquals((await tab.buffer.getUnconfirmed(CELL)).length, 0);
  } finally {
    await net.close();
  }
});
