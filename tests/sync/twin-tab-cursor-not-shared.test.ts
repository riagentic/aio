// tests/sync/twin-tab-cursor-not-shared.test.ts — a tab moving its catch-up
// cursor must not write the offline queue two tabs share.
//
// The cursor used to live in the shared localStorage document, so every
// cursor move was a read-modify-write of the queue. A second tab moves its
// cursor on every broadcast — at the very moment the writing tab confirms the
// same op on its ack. Tabs are separate processes and localStorage has no lock
// across them, so the passive tab's write, built on a read from before the
// confirm, put the confirmed op back into the queue. The writing tab replayed
// it on top of a state that already held it: with two tabs of one app open,
// 16 of 20 clicks showed their item twice, until a reload (real Chromium, two
// tabs of one profile, one clicking and one only open).
import { assertEquals } from "@std/assert";
import { createLocalStorageOpStorage } from "../../src/sync/browser-storage.ts";
import type { SyncOp } from "../../src/sync/types.ts";

/** One origin's localStorage as two tabs see it: tab B's reads can be frozen
 *  at a moment, as a tab that has not yet received the other's write. */
function twoTabViews() {
  const store = new Map<string, string>();
  let stale: Map<string, string> | null = null;
  let tab: "a" | "b" = "a";
  const view = {
    getItem: (k: string) =>
      (tab === "b" && stale ? stale.get(k) : store.get(k)) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: view,
  });
  return {
    as: <T>(t: "a" | "b", fn: () => T): T => {
      tab = t;
      try {
        return fn();
      } finally {
        tab = "a";
      }
    },
    freezeB: () => void (stale = new Map(store)),
  };
}

const op: SyncOp = {
  id: "x1",
  cell: "board",
  action: "add",
  payload: "x",
  hlc: [Date.now(), 0, "c1"],
  confirmed: false,
  _clientTs: Date.now(),
};

Deno.test("twin tabs: the passive tab's cursor move does not resurrect a confirmed op", async () => {
  const tabs = twoTabViews();
  const a = tabs.as("a", () => createLocalStorageOpStorage("q"));
  const b = tabs.as("b", () => createLocalStorageOpStorage("q"));

  await tabs.as("a", () => a.saveOp(op)); // tab A queues and sends x1
  tabs.freezeB(); // B has seen the queue with x1 unconfirmed…
  await tabs.as("a", () => a.confirmOp("board", "x1")); // …A's ack lands
  await tabs.as("a", () => a.pruneConfirmed("board"));
  // …and B, handling the broadcast of x1 at the same moment, moves its cursor.
  await tabs.as("b", () => b.saveMeta("board", { lastHlc: op.hlc }));

  assertEquals(await tabs.as("a", () => a.loadOps("board")), []);
  // Each tab keeps its own cursor.
  assertEquals(await tabs.as("b", () => b.loadMeta("board")), {
    lastHlc: op.hlc,
  });
  assertEquals(await tabs.as("a", () => a.loadMeta("board")), undefined);
});
