// tests/sync/twin-tab-concurrent-save.test.ts — two tabs queueing at the same
// moment never lose an op.
//
// Tabs are separate processes; each reads localStorage from its own cache,
// which the other tab's write reaches a moment later. Two tabs of one app
// queueing offline at once each appended to the queue document they had read:
// the second write, built on a read from before the first, dropped the first
// tab's op — an unsent change gone (measured in real Chromium: 1 of 120).
import { assertEquals } from "@std/assert";
import { createLocalStorageOpStorage } from "../../src/sync/browser-storage.ts";
import type { SyncOp } from "../../src/sync/types.ts";

/** One origin's localStorage as two tabs see it: tab B's reads can be frozen
 *  at a moment, as a tab that has not yet received the other's write. */
function twoTabViews() {
  const store = new Map<string, string>();
  let stale: Map<string, string> | null = null;
  let tab: "a" | "b" = "a";
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) =>
        (tab === "b" && stale ? stale.get(k) : store.get(k)) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
  return {
    store,
    as: <T>(t: "a" | "b", fn: () => T): T => {
      tab = t;
      try {
        return fn();
      } finally {
        tab = "a";
      }
    },
    freezeB: (on: boolean) => void (stale = on ? new Map(store) : null),
  };
}

const op = (id: string): SyncOp => ({
  id,
  cell: "board",
  action: "add",
  payload: id,
  hlc: [Date.now(), 0, "c1"],
  confirmed: false,
  _clientTs: Date.now(),
});
const ids = (ops: SyncOp[]) => ops.map((o) => o.id).sort();

Deno.test("twin tabs: a save built on a stale read does not lose the other tab's op", async () => {
  const tabs = twoTabViews();
  const a = tabs.as("a", () => createLocalStorageOpStorage("q"));
  const b = tabs.as("b", () => createLocalStorageOpStorage("q"));

  tabs.freezeB(true); // B has not yet seen…
  await a.saveOp(op("a1")); // …A's op when it queues its own.
  await tabs.as("b", () => b.saveOp(op("b1")));
  tabs.freezeB(false);

  assertEquals(ids(await a.loadOps("board")), ["a1", "b1"]);
  assertEquals(ids(await tabs.as("b", () => b.loadOps("board"))), [
    "a1",
    "b1",
  ]);
});

Deno.test("twin tabs: the other tab's write arriving puts the lost op back at once", async () => {
  const tabs = twoTabViews();
  const a = createLocalStorageOpStorage("q");
  const b = tabs.as("b", () => createLocalStorageOpStorage("q"));

  tabs.freezeB(true);
  await a.saveOp(op("a1"));
  await tabs.as("b", () => b.saveOp(op("b1")));
  tabs.freezeB(false);
  // A reads nothing of its own accord — B's write reaching A is the event.
  globalThis.dispatchEvent(
    Object.assign(new Event("storage"), { key: "q:board" }),
  );
  const doc = JSON.parse(tabs.store.get("q:board")!) as { ops: SyncOp[] };
  assertEquals(ids(doc.ops), ["a1", "b1"]);
});

Deno.test("twin tabs: an op the other tab confirmed and pruned stays gone", async () => {
  twoTabViews();
  const a = createLocalStorageOpStorage("q");
  const b = createLocalStorageOpStorage("q");

  await a.saveOp(op("a1"));
  await b.confirmOp("board", "a1"); // B flushed the shared queue; its ack
  await b.pruneConfirmed("board");
  assertEquals(await a.loadOps("board"), []);
  await a.saveOp(op("a2"));
  await a.pruneStale("board", "a2"); // A's own removal
  assertEquals(await a.loadOps("board"), []);
});
