// browser-storage — the localStorage OpBufferStorage that gives the client
// sync engine offline durability. Verifies the OpBufferStorage contract and
// that ops survive a "reload" (a fresh storage instance over the same store).
import { assertEquals } from "@std/assert";
import { createLocalStorageOpStorage } from "../../src/sync/browser-storage.ts";
import type { SyncOp } from "../../src/sync/types.ts";

function shimLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  // Deno ships a native, disk-persisted localStorage — a plain assignment is
  // ignored, so define over it (configurable so each test gets a fresh store).
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
  return store;
}

function op(id: string, cell = "board"): SyncOp {
  return {
    id,
    cell,
    action: "add",
    payload: { args: [id] },
    hlc: [1, 0, "c1"],
    confirmed: false,
    _clientTs: 1,
  };
}

Deno.test("browser-storage: save/load/confirm/prune round-trip", async () => {
  shimLocalStorage();
  const s = createLocalStorageOpStorage();
  await s.saveOp(op("a"));
  await s.saveOp(op("b"));
  assertEquals((await s.loadOps("board")).length, 2);
  assertEquals(await s.countUnconfirmed("board"), 2);

  await s.confirmOp("a");
  assertEquals(await s.countUnconfirmed("board"), 1);

  await s.pruneConfirmed("board");
  const left = await s.loadOps("board");
  assertEquals(left.length, 1);
  assertEquals(left[0]!.id, "b");
});

Deno.test("browser-storage: ops survive a reload (fresh instance, same store)", async () => {
  shimLocalStorage();
  const before = createLocalStorageOpStorage();
  await before.saveOp(op("x"));
  await before.saveMeta("board", { lastHlc: [5, 0, "c1"] });

  // simulate a page reload: brand-new storage object over the same
  // localStorage backing
  const after = createLocalStorageOpStorage();
  const ops = await after.loadOps("board");
  assertEquals(ops.length, 1);
  assertEquals(ops[0]!.id, "x");
  assertEquals((await after.loadMeta("board"))?.lastHlc, [5, 0, "c1"]);
});

Deno.test("browser-storage: per-cell isolation + snapshot + clear", async () => {
  shimLocalStorage();
  const s = createLocalStorageOpStorage();
  await s.saveOp(op("a", "cellA"));
  await s.saveOp(op("b", "cellB"));
  assertEquals((await s.loadOps("cellA")).length, 1);
  assertEquals((await s.loadOps("cellB")).length, 1);

  await s.saveSnapshot("cellA", { state: { n: 3 }, hlc: [9, 0, "c1"] });
  assertEquals((await s.loadSnapshot("cellA"))?.state, { n: 3 });

  await s.clear("cellA");
  assertEquals((await s.loadOps("cellA")).length, 0);
  assertEquals((await s.loadOps("cellB")).length, 1); // untouched
});
