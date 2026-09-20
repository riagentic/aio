// tests/sync/twin-tab-peer-op.test.ts — two tabs of one app share the offline
// queue (one localStorage document per cell, one persisted client id). The
// tab that did NOT make a change must still end up with it.
//
// Found by the r4 sync hunt (2026-09-19), a randomized twin-tab model (tabs
// sharing a queue, a peer profile, method refusals, reordered and duplicated
// frames): 33 of 200 episodes ended with a tab whose state the server never
// had. Tab A makes an op; the server broadcasts it to tab B. B found the op in
// the shared queue, still unconfirmed, and dropped the broadcast as "my own
// op, awaiting its ack" — but B never sent it, so no ack ever comes to B. A
// then confirmed it, the op left the queue, and B's next catch-up moved its
// cursor past it (the catch-up had skipped it the same way, or served it
// after ops B already folded). B's screen lost the edit, or showed it in the
// wrong place, until a reload — while the server and A kept it. The r3 fix
// (twin-tab-own-op.test.ts) covered only the tab that made the change.
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

async function twoTabsAndAPeer() {
  shimLocalStorage();
  const net = createNet({ cell: "c", initial: () => ({ items: [] }), apply });
  const a = net.addClient("tab", createLocalStorageOpStorage("q"));
  const b = net.addClient("tab", createLocalStorageOpStorage("q"));
  const peer = net.addClient("peer");
  for (const c of [a, b, peer]) await c.engine.requestSync();
  await net.pump();
  return { net, a, b, peer };
}

Deno.test("twin tabs: the other tab's op broadcast to me before its ack lands stays on my screen", async () => {
  const { net, a, b, peer } = await twoTabsAndAPeer();
  try {
    await a.engine.handleLocalAction("c", "add", "x");
    // B handles the broadcast before A handles its ack (two tabs, two event
    // loops — either can go first).
    net.clients.splice(0, net.clients.length, b, a, peer);
    await net.pump();
    await peer.engine.handleLocalAction("c", "add", "y");
    await net.pump();
    assertEquals(net.live(), { items: ["x", "y"] });
    assertEquals(b.confirmed(), net.live(), "the other tab's confirmed state");
    assertEquals(b.view(), net.live(), "the other tab's screen");
    assertEquals(a.view(), net.live());
    // …and a reconnect does not put it anywhere else.
    b.online = false;
    b.engine.setOnline(false);
    b.online = true;
    b.engine.setOnline(true);
    await net.pump();
    assertEquals(b.confirmed(), net.live(), "after B's catch-up");
    assertEquals(b.view(), net.live());
  } finally {
    await net.close();
  }
});

Deno.test("twin tabs: the other tab's op in my catch-up is folded where the server has it", async () => {
  const { net, a, b, peer } = await twoTabsAndAPeer();
  try {
    // B asks for a catch-up; A's op is made after B's request left and
    // reaches the server before it. B's response carries A's op while B's
    // queue still holds it unconfirmed — and nobody will ever ack it to B.
    await b.engine.requestSync();
    await a.engine.handleLocalAction("c", "add", "x");
    for (const f of a.outbox.splice(0)) {
      await net.handler.handleOp(JSON.parse(f).d, { id: "tab" }, a.socket);
    }
    // B's request, the broadcast and B's response — before A's ack is read.
    net.clients.splice(0, net.clients.length, b, peer);
    await net.pump();
    net.clients.splice(0, net.clients.length, a, b, peer);
    await net.pump();
    await peer.engine.handleLocalAction("c", "add", "y");
    await net.pump();
    assertEquals(net.live(), { items: ["x", "y"] });
    assertEquals(b.confirmed(), net.live(), "the other tab's confirmed state");
    assertEquals(b.view(), net.live(), "the other tab's screen");
    assertEquals(a.confirmed(), net.live());
  } finally {
    await net.close();
  }
});

Deno.test("twin tabs: an op I folded from its broadcast is not folded again by its ack", async () => {
  const { net, a, b } = await twoTabsAndAPeer();
  try {
    await a.engine.handleLocalAction("c", "add", "x");
    net.clients.splice(0, net.clients.length, b, a);
    // B takes the broadcast, then flushes the shared queue itself while x is
    // still unconfirmed — the server re-acks x to B.
    const aInbox: string[] = [];
    await net.pump(1);
    aInbox.push(...a.inbox.splice(0));
    await b.engine.requestSync();
    await net.pump();
    a.inbox.push(...aInbox);
    await net.pump();
    assertEquals(net.live(), { items: ["x"] });
    assertEquals(b.confirmed(), net.live(), "one application, not two");
    assertEquals(b.view(), net.live());
    assertEquals(a.confirmed(), net.live());
    assertEquals(a.view(), net.live());
  } finally {
    await net.close();
  }
});
