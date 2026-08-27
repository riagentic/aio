// browser-storage — the localStorage OpBufferStorage that gives the client
// sync engine offline durability. Verifies the OpBufferStorage contract and
// that ops survive a "reload" (a fresh storage instance over the same store).
import { assert, assertEquals } from "@std/assert";
import { createLocalStorageOpStorage } from "../../src/sync/browser-storage.ts";
import type { SyncOp } from "../../src/sync/types.ts";

function shimLocalStorage(
  opts: { refuseWrites?: boolean } = {},
): Map<string, string> {
  const store = new Map<string, string>();
  // Deno ships a native, disk-persisted localStorage — a plain assignment is
  // ignored, so define over it (configurable so each test gets a fresh store).
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (opts.refuseWrites) {
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

  await s.confirmOp("board", "a");
  assertEquals(await s.countUnconfirmed("board"), 1);

  await s.pruneConfirmed("board");
  const left = await s.loadOps("board");
  assertEquals(left.length, 1);
  assertEquals(left[0]!.id, "b");
});

// This test used to assert that the CURSOR survived a reload too — encoding
// the bug as the contract. The cursor describes the client's confirmed state,
// and that state does not survive a reload (browser-sync re-seeds the engine
// from the cell's initialState on every boot). A surviving cursor makes the
// server answer "nothing new" to a client that has nothing; see
// tests/sync/reload-cursor.test.ts for what that looks like to a user.
Deno.test("browser-storage: ops survive a reload, the cursor does not", async () => {
  shimLocalStorage();
  const before = createLocalStorageOpStorage();
  await before.saveOp(op("x"));
  await before.saveMeta("board", { lastHlc: [5, 0, "c1"], lastServerTs: 42 });
  assertEquals(
    (await before.loadMeta("board"))?.lastHlc,
    [5, 0, "c1"],
    "within the session the cursor is a real cursor",
  );

  // simulate a page reload: brand-new storage object over the same
  // localStorage backing
  const after = createLocalStorageOpStorage();
  const ops = await after.loadOps("board");
  assertEquals(
    ops.length,
    1,
    "the offline op queue survives — that is the point",
  );
  assertEquals(ops[0]!.id, "x");
  assertEquals(
    await after.loadMeta("board"),
    undefined,
    "the cursor must not outlive the confirmed state it describes",
  );
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

// The double-apply flake (~2% of runs), root-caused 2026-08-14: confirmOp used
// to SCAN every `__aio_sync:*` key as a cell document. The clientId key shares
// that prefix; when its 8-hex-char value happened to be all digits it PARSED
// as a JSON number, `doc.ops.find` threw, and the catch silently ate the
// confirm — the op then rebased on top of every snapshot forever. These pin
// the class: confirm touches ONLY its own cell's document, and non-document
// keys are never read as queues (no false "corrupt" alarms, no
// `.corrupt.corrupt…` key chains).
Deno.test("browser-storage: confirm reads only its cell — sibling non-doc keys are never parsed as queues", async () => {
  const store = shimLocalStorage();
  store.set("__aio_sync:clientId", "12345678"); // valid JSON — the killer case
  store.set("__aio_sync:board.corrupt", "{broken"); // forensic copy, not a doc
  const s = createLocalStorageOpStorage();
  await s.saveOp(op("a"));
  await s.confirmOp("board", "a");
  assertEquals(await s.countUnconfirmed("board"), 0, "the confirm must land");
  assertEquals(store.get("__aio_sync:clientId"), "12345678", "identity intact");
  assertEquals(
    [...store.keys()].filter((k) => k.endsWith(".corrupt.corrupt")),
    [],
    "no corrupt-chain keys sprout from non-doc keys",
  );
});

Deno.test("browser-storage: boot sweeps the corrupt-chain garbage the old scan left, keeps real forensic copies", async () => {
  const store = shimLocalStorage();
  store.set("__aio_sync:board.corrupt", "{broken"); // deliberate forensic copy
  store.set("__aio_sync:board.corrupt.corrupt", "{broken"); // scan garbage
  store.set("__aio_sync:board.corrupt.corrupt.corrupt", "{broken"); // ditto
  store.set("__aio_sync:clientId.corrupt", "a1b2c3d4"); // false alarm on the id
  createLocalStorageOpStorage();
  assertEquals(store.get("__aio_sync:board.corrupt"), "{broken", "kept");
  assertEquals(store.get("__aio_sync:board.corrupt.corrupt"), undefined);
  assertEquals(
    store.get("__aio_sync:board.corrupt.corrupt.corrupt"),
    undefined,
  );
  assertEquals(store.get("__aio_sync:clientId.corrupt"), undefined);
});

// The offline queue's ONLY job is to survive a reload, and `read` goes back to
// localStorage on every call — nothing is held in memory. So a refused
// `setItem` (quota full, or storage disabled in a private/blocked context)
// loses every unsent change at the next reload while `saveOp` resolves and the
// engine goes on believing the op is queued. That was a bare `catch {}`
// annotated "degrade to memory-only semantics", which is not what happens.
Deno.test("browser-storage: a refused write is LOUD, once per cell", async () => {
  shimLocalStorage({ refuseWrites: true });
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    const s = createLocalStorageOpStorage();
    await s.saveOp(op("a"));
    await s.saveOp(op("b"));
    await s.saveOp(op("c"));
    await s.saveOp(op("x", "other"));
  } finally {
    console.error = origError;
  }
  const board = errors.filter((e) => e.includes('"board"'));
  const other = errors.filter((e) => e.includes('"other"'));
  assertEquals(board.length, 1, `once per cell, got ${board.length}`);
  assertEquals(other.length, 1, `once per cell, got ${other.length}`);
  assert(
    /reload/i.test(board[0]!) && /quota|storage/i.test(board[0]!),
    `the message must name the consequence and the cause — got ${board[0]}`,
  );
});

Deno.test("browser-storage: the report re-arms after a write succeeds again", async () => {
  const store = new Map<string, string>();
  let refuse = true;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (refuse) throw new Error("quota exceeded");
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    const s = createLocalStorageOpStorage();
    await s.saveOp(op("a"));
    refuse = false;
    await s.saveOp(op("b")); // succeeds — the episode is over
    refuse = true;
    await s.saveOp(op("c")); // a NEW episode must be reported
  } finally {
    console.error = origError;
  }
  assertEquals(
    errors.filter((e) => e.includes('"board"')).length,
    2,
    "a fresh loss after a recovery is a fresh report, not a swallowed repeat",
  );
});
