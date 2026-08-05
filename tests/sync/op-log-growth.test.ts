// tests/sync/op-log-growth.test.ts — the client's offline op log must SHRINK.
//
// Every mutation on a sync cell is appended to `localStorage` as a whole-cell
// JSON document that is re-read and re-written on every subsequent op. An op
// stops being needed the moment the server acks it: it is filtered out of
// `getUnconfirmed`, never re-sent, never replayed. But nothing dropped it —
// `pruneConfirmed` ran only under backpressure, i.e. when 500 UNCONFIRMED ops
// had piled up, which for a healthy online client never happens.
//
// So the document grew for the lifetime of the app, and two things followed,
// both silent: every op paid a parse+stringify of the whole history (an app
// that got slower the longer it was used), and once the origin's quota was
// reached `setItem` threw — swallowed by design, "degrade to memory-only
// semantics". From that point the offline queue is not persisted at all: the
// user's next offline edits are gone when the tab closes, with nothing said.
import { assert, assertEquals } from "@std/assert";
import { createOpBuffer } from "../../src/sync/op-buffer.ts";
import { createLocalStorageOpStorage } from "../../src/sync/browser-storage.ts";
import type { SyncOp } from "../../src/sync/types.ts";

const CELL = "todos";

function shimLocalStorage(): { size: () => number } {
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
  return {
    size: () => [...store.values()].reduce((n, v) => n + v.length, 0),
  };
}

const mkOp = (id: string): SyncOp => ({
  id,
  cell: CELL,
  action: "add",
  payload: { text: `a reasonably sized note body for op ${id}` },
  hlc: [Date.now(), 0, "c1"],
  confirmed: false,
  _clientTs: Date.now(),
});

Deno.test("a confirmed op leaves the client's op log — sustained churn does not grow it", async () => {
  const ls = shimLocalStorage();
  const buf = createOpBuffer(createLocalStorageOpStorage());

  // The healthy steady state: mutate, get acked, repeat. Never near the
  // pending cap, so the backpressure prune never fires.
  for (let i = 0; i < 50; i++) {
    await buf.add(mkOp(`op-${i}`));
    await buf.confirm(CELL, `op-${i}`, [2000 + i, 0, "s"]);
  }
  const after50 = ls.size();

  for (let i = 50; i < 500; i++) {
    await buf.add(mkOp(`op-${i}`));
    await buf.confirm(CELL, `op-${i}`, [2000 + i, 0, "s"]);
  }
  const after500 = ls.size();

  assertEquals(
    await buf.getUnconfirmed(CELL),
    [],
    "nothing is pending — every op was acked",
  );
  assert(
    after500 <= after50,
    `the op log must not grow with acked ops: ${after50}B after 50 ops, ` +
      `${after500}B after 500. At this rate the origin's storage quota ends ` +
      `the offline queue outright, silently.`,
  );

  // …and an UNCONFIRMED op is still kept, which is the entire point.
  await buf.add(mkOp("still-pending"));
  assertEquals(
    (await buf.getUnconfirmed(CELL)).map((o) => o.id),
    ["still-pending"],
    "the offline queue must survive — only acked ops are dropped",
  );
});
