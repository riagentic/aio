// A stored offline-queue document that is valid JSON but not a cell document
// (`null`, `{}`, `[]`) is corrupt exactly like unparseable JSON is. parseDoc's
// own contract (src/sync/browser-storage.ts): "A corrupt document is NOT the
// same as no document" — keep the bytes at `<key>.corrupt`, say so loudly,
// and go on with an empty queue. Only a JSON.parse THROW is treated that way;
// a well-formed-but-wrong-shape document is returned as-is and every storage
// call on that cell then dies with a TypeError ("reading 'push'" / "'filter'"),
// forever, with no forensic copy and no data-loss report.
import { assertEquals } from "@std/assert";
import { createLocalStorageOpStorage } from "../src/sync/browser-storage.ts";
import type { SyncOp } from "../src/sync/types.ts";

function shimLocalStorage(): Map<string, string> {
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
  return store;
}

function op(id: string): SyncOp {
  return {
    id,
    cell: "board",
    action: "add",
    payload: { args: [id] },
    hlc: [1, 0, "c1"],
    confirmed: false,
    _clientTs: 1,
  };
}

for (
  const raw of [
    "null",
    "{}",
    "[]",
    "42",
    '"x"',
    '{"ops":"x"}',
    '{"ops":[null]}',
    '{"ops":[1]}',
  ]
) {
  Deno.test(`browser-storage: a wrong-shape document (${raw}) is treated as corrupt, not crashed on`, async () => {
    const store = shimLocalStorage();
    store.set("__aio_sync:board", raw);
    const s = createLocalStorageOpStorage();

    let loadErr: unknown = null;
    let ops: unknown = undefined;
    try {
      ops = await s.loadOps("board");
    } catch (e) {
      loadErr = e;
    }
    assertEquals(
      loadErr,
      null,
      `loadOps must not throw on a corrupt document: ${loadErr}`,
    );
    assertEquals(ops, [], "a corrupt document reads as an empty queue");

    let saveErr: unknown = null;
    try {
      await s.saveOp(op("a"));
    } catch (e) {
      saveErr = e;
    }
    assertEquals(
      saveErr,
      null,
      `saveOp must not throw on a corrupt document: ${saveErr}`,
    );
    assertEquals(await s.countUnconfirmed("board"), 1, "the new op is queued");
    assertEquals(
      store.get("__aio_sync:board.corrupt"),
      raw,
      "the corrupt bytes are kept for forensics, as for unparseable JSON",
    );
  });
}
