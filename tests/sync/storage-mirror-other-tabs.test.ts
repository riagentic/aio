// tests/sync/storage-mirror-other-tabs.test.ts — a tab whose offline-queue
// write was refused once must not lose, or erase, another tab's queued ops.
//
// When localStorage refuses a write (quota, private mode) the tab keeps the
// cell's document in memory so it still sees its own ops. That copy was read
// INSTEAD of localStorage from then on: the tab never saw another tab's
// writes to the shared queue again, and its next write that localStorage DID
// take wrote the stale copy over the shared document — the other tab's unsent
// op was gone from the queue both tabs read. Measured: tab A refused `a1`,
// tab B queued `b1`, tab A queued `a2` → the queue held `a1, a2`.
import { assertEquals } from "@std/assert";
import { createLocalStorageOpStorage } from "../../src/sync/browser-storage.ts";
import type { SyncOp } from "../../src/sync/types.ts";

/** One origin's localStorage, shared by every "tab" created on it, whose
 *  writes can be refused on demand. */
function sharedStorage(): { refuse: (on: boolean) => void } {
  const store = new Map<string, string>();
  let refusing = false;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (refusing) {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
  return { refuse: (on) => void (refusing = on) };
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

const ids = async (s: ReturnType<typeof createLocalStorageOpStorage>) =>
  (await s.loadOps("board")).map((o) => `${o.id}${o.confirmed ? "✓" : ""}`)
    .sort();

async function quietly(fn: () => Promise<void>): Promise<void> {
  const e = console.error;
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.error = e;
  }
}

Deno.test("after a refused write, a tab still sees the ops another tab queues", async () => {
  const ls = sharedStorage();
  await quietly(async () => {
    const a = createLocalStorageOpStorage("app");
    const b = createLocalStorageOpStorage("app");
    ls.refuse(true);
    await a.saveOp(op("a1"));
    ls.refuse(false);
    await b.saveOp(op("b1"));
    assertEquals(await ids(a), ["a1", "b1"], "tab A: its own op and B's");
  });
});

Deno.test("a tab's next successful write does not erase another tab's queued op", async () => {
  const ls = sharedStorage();
  await quietly(async () => {
    const a = createLocalStorageOpStorage("app");
    const b = createLocalStorageOpStorage("app");
    await b.saveOp(op("b0"));
    ls.refuse(true);
    await a.saveOp(op("a1"));
    await a.confirmOp("board", "b0");
    ls.refuse(false);
    await b.saveOp(op("b1"));
    await a.saveOp(op("a2"));
    // A's unwritten changes (a1 queued, b0 confirmed) replayed onto what B
    // wrote meanwhile — nothing of either tab lost.
    assertEquals(await ids(b), ["a1", "a2", "b0✓", "b1"]);
    assertEquals(await ids(a), ["a1", "a2", "b0✓", "b1"]);
  });
});

Deno.test("a tab's own removal and cursor survive the re-base", async () => {
  const ls = sharedStorage();
  await quietly(async () => {
    const a = createLocalStorageOpStorage("app");
    const b = createLocalStorageOpStorage("app");
    await a.saveOp(op("a1"));
    await a.saveOp(op("a2"));
    ls.refuse(true);
    await a.pruneStale("board", "a1");
    await a.saveMeta("board", { lastHlc: null, lastServerTs: 42 });
    ls.refuse(false);
    await b.saveOp(op("b1"));
    assertEquals(await ids(a), ["a2", "b1"]);
    assertEquals((await a.loadMeta("board"))?.lastServerTs, 42);
  });
});
