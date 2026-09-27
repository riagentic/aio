// tests/sync/twin-tab-stale-resurrect.test.ts — an op a tab already folded,
// written back into the shared queue by a twin tab working from a stale copy,
// is never applied twice.
//
// Tabs read localStorage from their own cache. Tab A's op x was acked, folded
// and pruned; tab B, still holding the queue from before that, queued y and
// wrote x back with it, unconfirmed. A replayed x on top of the confirmed
// state that already held it, and folded it a second time at the re-ack its
// resend got: A showed x twice, for good (the server and B held it once).
import { assertEquals } from "@std/assert";
import { createNet, type State } from "./_net.ts";
import { createLocalStorageOpStorage } from "../../src/sync/browser-storage.ts";
import type { OpBufferStorage } from "../../src/sync/op-buffer.ts";

/** One origin's localStorage as two tabs see it: each reads its own cache,
 *  which gets the other's writes only on `deliver`. */
function tabViews() {
  const store = new Map<string, string>();
  const cache = [new Map<string, string>(), new Map<string, string>()];
  let tab = 0;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => cache[tab]!.get(k) ?? null,
      setItem: (k: string, v: string) => {
        cache[tab]!.set(k, v);
        store.set(k, v);
      },
      removeItem: (k: string) => {
        cache[tab]!.delete(k);
        store.delete(k);
      },
      key: (i: number) => [...cache[tab]!.keys()][i] ?? null,
      get length() {
        return cache[tab]!.size;
      },
    },
  });
  const as = <T>(t: number, fn: () => T): T => {
    const prev = tab;
    tab = t;
    try {
      return fn();
    } finally {
      tab = prev;
    }
  };
  return {
    deliver: (t: number) => void (cache[t] = new Map(store)),
    open: (t: number): OpBufferStorage => {
      const s = as(t, () => createLocalStorageOpStorage("q"));
      return Object.fromEntries(
        Object.entries(s).map(([k, f]) => [
          k,
          (...a: unknown[]) =>
            as(t, () => (f as (...a: unknown[]) => unknown)(...a)),
        ]),
      ) as unknown as OpBufferStorage;
    },
  };
}

const apply = (s: State, _a: string, p: unknown): State => ({
  items: [...((s.items as string[]) ?? []), p as string],
});

Deno.test("twin tabs: an op a stale tab writes back after it was pruned is not shown twice", async () => {
  const v = tabViews();
  const net = createNet({ cell: "c", initial: () => ({ items: [] }), apply });
  const a = net.addClient("tab", v.open(0));
  const b = net.addClient("tab", v.open(1));
  try {
    await a.engine.requestSync();
    await b.engine.requestSync();
    await net.pump();
    await a.engine.handleLocalAction("c", "add", "x");
    v.deliver(1); // B's cache holds x, unconfirmed…
    await net.pump(); // …while A's ack folds, confirms and prunes it.
    b.online = false;
    await b.engine.handleLocalAction("c", "add", "y"); // B writes x back.
    v.deliver(0);
    v.deliver(1);
    b.online = true;
    await b.engine.requestSync();
    await a.engine.requestSync();
    await net.pump();
    assertEquals(net.live(), { items: ["x", "y"] });
    assertEquals(a.confirmed(), net.live(), "A's confirmed state");
    assertEquals(a.view(), net.live(), "A's screen");
    assertEquals(b.view(), net.live(), "B's screen");
  } finally {
    await net.close();
  }
});

Deno.test("twin tabs: a written-back op this tab resends and gets re-acked is not folded twice", async () => {
  const v = tabViews();
  const net = createNet({ cell: "c", initial: () => ({ items: [] }), apply });
  const a = net.addClient("tab", v.open(0));
  const b = net.addClient("tab", v.open(1));
  try {
    await a.engine.requestSync();
    await b.engine.requestSync();
    await net.pump();
    await a.engine.handleLocalAction("c", "add", "x");
    v.deliver(1);
    await net.pump();
    b.online = false;
    await b.engine.handleLocalAction("c", "add", "y");
    v.deliver(0);
    // A flushes the written-back x itself: the server re-acks, not re-applies.
    await a.engine.requestSync();
    await net.pump();
    assertEquals(net.live(), { items: ["x", "y"] });
    assertEquals(a.confirmed(), net.live(), "A's confirmed state");
    assertEquals(a.view(), net.live(), "A's screen");
  } finally {
    await net.close();
  }
});

// A refused op written back the same way: the re-refusal it earns is a repeat
// (already reported), and it was skipped whole — the op stayed queued, was
// re-sent on every reconnect and re-refused, forever (and a server restart,
// which forgets its refusals, could apply a change its author was told was
// refused).
Deno.test("twin tabs: a refused op a stale tab writes back leaves the queue at its re-refusal", async () => {
  const v = tabViews();
  const net = createNet({
    cell: "c",
    initial: () => ({ items: [] }),
    apply: (s, a, p) => {
      if (p === "bad") throw new Error("refused by the server");
      return apply(s, a, p);
    },
    reducer: apply,
  });
  const a = net.addClient("tab", v.open(0));
  const b = net.addClient("tab", v.open(1));
  try {
    await a.engine.requestSync();
    await b.engine.requestSync();
    await net.pump();
    await a.engine.handleLocalAction("c", "add", "bad");
    v.deliver(1); // B's cache holds the op…
    await net.pump(); // …while A's refusal drops it.
    b.online = false;
    await b.engine.handleLocalAction("c", "add", "y"); // B writes it back.
    v.deliver(0);
    v.deliver(1);
    b.online = true;
    await a.engine.requestSync(); // A re-sends it: refused again.
    await net.pump();
    v.deliver(0);
    v.deliver(1);
    await b.engine.requestSync();
    await net.pump();
    v.deliver(0);
    assertEquals(net.live(), { items: ["y"] });
    assertEquals(
      (await a.buffer.getUnconfirmed("c")).map((o) => o.payload),
      [],
      "the refused op is gone from the shared queue",
    );
    assertEquals(a.view(), net.live(), "A's screen");
  } finally {
    await net.close();
  }
});
