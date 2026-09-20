// tests/sync/twin-tab-own-op.test.ts — two tabs of one app share the offline
// queue (one localStorage document per cell, one persisted client id), so
// either tab can flush the other's op. The tab that MADE the change must
// still end up with it.
//
// Found by the r3 sync hunt (2026-09-19). Tab B's catch-up carried tab A's
// queued op, B got the ack and marked the op confirmed in the shared queue.
// A then found no pending op for its own ack and folded nothing; its
// catch-ups never carry the op back (the server leaves out the requester's
// own session's ops — they come through the ack); and when A's op frame had
// been lost, A did not even re-send it (the queue said it was done). The
// user's edit vanished from the tab they made it in, permanently, while the
// server and the other tab kept it.
import { assertEquals } from "@std/assert";
import { createNet, type State } from "./_net.ts";
import { createLocalStorageOpStorage } from "../../src/sync/browser-storage.ts";

function shimLocalStorage(): void {
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
}

const apply = (s: State, _a: string, p: unknown): State => ({
  items: [...((s.items as string[]) ?? []), p as string],
});

/** Two tabs: one client id, one localStorage queue, two engines. */
async function twoTabs() {
  shimLocalStorage();
  const net = createNet({ cell: "c", initial: () => ({ items: [] }), apply });
  const a = net.addClient("tab", createLocalStorageOpStorage("q"));
  const b = net.addClient("tab", createLocalStorageOpStorage("q"));
  await a.engine.requestSync();
  await b.engine.requestSync();
  await net.pump();
  // Something in the log, and a catch-up after it: both tabs hold a real
  // cursor (a cursorless catch-up is served every op, own ones included).
  await b.engine.handleLocalAction("c", "add", "s0");
  await net.pump();
  await a.engine.requestSync();
  await b.engine.requestSync();
  await net.pump();
  return { net, a, b };
}

Deno.test("twin tabs: the other tab flushing my op first does not take it off my screen", async () => {
  const { net, a, b } = await twoTabs();
  try {
    await a.engine.handleLocalAction("c", "add", "x");
    const onTheWire = a.outbox.splice(0);
    await b.engine.requestSync(); // B's catch-up carries the shared queue
    await net.pump();
    a.outbox.push(...onTheWire); // …and A's own frame lands after it
    await net.pump();
    assertEquals(net.live(), { items: ["s0", "x"] });
    assertEquals(a.confirmed(), net.live(), "author's confirmed state");
    assertEquals(a.view(), net.live(), "author's screen");
    assertEquals(b.view(), net.live());
  } finally {
    await net.close();
  }
});

// The lost-frame half. Before the fix this one was rescued by accident — the
// shared queue document also carries ONE cursor, which the other tab's
// catch-up overwrites, so the author usually came back cursorless and was
// served every op. The fix does not rely on that: the reconnect notices the
// own op that left the queue and asks for the cell.
Deno.test("twin tabs: my op frame lost, the other tab flushed it — I get it back on reconnect", async () => {
  const { net, a, b } = await twoTabs();
  try {
    await a.engine.handleLocalAction("c", "add", "x");
    a.outbox.length = 0; // the frame dies with A's connection
    a.online = false;
    a.engine.setOnline(false);
    await b.engine.requestSync();
    await net.pump();
    assertEquals(net.live(), { items: ["s0", "x"] });
    a.online = true;
    a.engine.setOnline(true);
    await net.pump();
    assertEquals(a.confirmed(), net.live(), "author's confirmed state");
    assertEquals(a.view(), net.live(), "author's screen");
  } finally {
    await net.close();
  }
});
