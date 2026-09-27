// tests/sync/twin-tab-watermark.test.ts — a tab's repair of the shared offline
// queue never brings back an op another tab took out on purpose, however many.
//
// Each tab puts back its own ops that vanished from the queue without a trace
// (a stale write from another tab dropped them — twin-tab-concurrent-save).
// "On purpose" used to be a list of the last 100 removed ids: tab A queued 150
// ops offline and froze, tab B flushed them and pruned the acked ops, and A's
// wake-up read put the 50 oldest back as unconfirmed — sent again, and shown
// twice (measured with the real engine: 200 items in A's view, 150 on the
// server). It is now a per-tab watermark, and the property test below checks
// both halves of the contract over random twin-tab histories: no op lost, no
// op resurrected.
import { assert, assertEquals } from "@std/assert";
import { fuzzEnvInt } from "../fuzz-seed.ts";
import { createLocalStorageOpStorage } from "../../src/sync/browser-storage.ts";
import type { OpBufferStorage } from "../../src/sync/op-buffer.ts";
import type { SyncOp } from "../../src/sync/types.ts";

/** One origin's localStorage as N tabs see it: each tab reads its own cache,
 *  which holds its own writes at once and the others' only on `deliver`. */
function tabViews(n: number) {
  const store = new Map<string, string>();
  const cache = Array.from({ length: n }, () => new Map<string, string>());
  const refuse = Array.from({ length: n }, () => false);
  let tab = 0;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => cache[tab]!.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (refuse[tab]) throw new DOMException("full", "QuotaExceededError");
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
    tab = t;
    try {
      return fn();
    } finally {
      tab = 0;
    }
  };
  return {
    store,
    refuse,
    as,
    deliver: (t: number) => void (cache[t] = new Map(store)),
    /** A storage whose every call runs as tab `t`. */
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

const op = (id: string): SyncOp => ({
  id,
  cell: "board",
  action: "add",
  payload: id,
  hlc: [1, 0, "c1"],
  confirmed: false,
  _clientTs: 1,
});
const docOps = (store: Map<string, string>): SyncOp[] =>
  JSON.parse(store.get("q:board") ?? '{"ops":[]}').ops;

Deno.test("twin tabs: 150 ops the other tab flushed and pruned stay gone when the frozen tab wakes", async () => {
  const v = tabViews(2);
  const a = v.open(0), b = v.open(1);
  for (let i = 0; i < 150; i++) await a.saveOp(op(`a${i}`));
  v.deliver(1); // A freezes; B sees the queue, flushes it, prunes the acks.
  for (let i = 0; i < 150; i++) await b.confirmOp("board", `a${i}`);
  await b.pruneConfirmed("board");
  v.deliver(0); // A wakes.
  assertEquals(await a.loadOps("board"), []);
  assertEquals(await a.countUnconfirmed("board"), 0);
  assertEquals(docOps(v.store), []);
});

Deno.test("twin tabs: a stale write between a tab's confirm and its prune does not unconfirm its op", async () => {
  const v = tabViews(2);
  const a = v.open(0), b = v.open(1);
  await a.saveOp(op("a1"));
  await a.saveOp(op("a2"));
  v.deliver(1); // B has a1 and a2, both unconfirmed…
  await a.confirmOp("board", "a1"); // …when A's acks land,
  await a.confirmOp("board", "a2");
  await b.saveOp(op("b1")); // and B writes over them from that read.
  v.deliver(0);
  assertEquals(await a.countUnconfirmed("board"), 1); // only b1
  await a.pruneConfirmed("board");
  assertEquals(docOps(v.store).map((o) => o.id), ["b1"]);
});

Deno.test("twin tabs: a stale write that drops a confirmed op of this tab puts it back confirmed", async () => {
  const v = tabViews(2);
  const a = v.open(0), b = v.open(1);
  await a.saveOp(op("a1")); // B never sees it…
  await a.confirmOp("board", "a1");
  await b.saveOp(op("b1")); // …before writing over it.
  v.deliver(0);
  assertEquals(await a.countUnconfirmed("board"), 1); // only b1
  await a.pruneConfirmed("board");
  assertEquals(docOps(v.store).map((o) => o.id), ["b1"]);
});

Deno.test("twin tabs: a tab whose writes keep failing does not grow the document it rebases", async () => {
  /** The queue's size after `rounds` of B flushing while A's writes are
   *  refused, once A's write lands again. */
  const after = async (rounds: number): Promise<number> => {
    const v = tabViews(3);
    const a = v.open(0), b = v.open(1), c = v.open(2);
    await a.saveOp(op("a0"));
    v.refuse[0] = true; // A's quota is full: its copy stays in memory…
    for (let i = 0; i < rounds; i++) {
      v.deliver(2); // C queues, B flushes C's op.
      await c.saveOp(op(`c${i % 10}`));
      v.deliver(1);
      await b.confirmOp("board", `c${i % 10}`);
      await b.pruneConfirmed("board");
      v.deliver(0);
      await a.saveSnapshot("board", { state: "s", hlc: [1, 0, "c1"] });
    } // …and is re-based on each of B's writes.
    v.refuse[0] = false;
    await a.saveSnapshot("board", { state: "s", hlc: [1, 0, "c1"] });
    return v.store.get("q:board")!.length;
  };
  assertEquals(await after(40), await after(10));
});

// ── property: random twin-tab histories ──────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tabs queue, confirm and prune on views that lag each other's writes. The
 *  one staleness left out is a view still holding an op already pruned: a
 *  write from it would put that op back by itself (a lost update no repair
 *  causes), so such a tab gets the latest state first — as a frozen tab's
 *  cache does before its script runs again. */
async function episode(seed: number): Promise<void> {
  const rnd = mulberry32(seed);
  const v = tabViews(2);
  const tabs = [v.open(0), v.open(1)];
  const saved = new Set<string>();
  const removed = new Set<string>();
  const ownConfirmed = new Set<string>();
  const owner = new Map<string, number>();
  let next = 0;
  const steps = 50 + Math.floor(rnd() * 400);
  for (let i = 0; i < steps; i++) {
    const t = rnd() < 0.5 ? 0 : 1;
    const s = tabs[t]!;
    const r = rnd();
    if (r < 0.25) {
      v.deliver(t);
      continue;
    }
    const view = v.as(t, () => localStorage.getItem("q:board"));
    const held: SyncOp[] = view ? JSON.parse(view).ops : [];
    if (held.some((o) => removed.has(o.id))) v.deliver(t);
    if (r < 0.6) {
      const id = `op${next++}`;
      saved.add(id);
      owner.set(id, t);
      await s.saveOp(op(id));
    } else if (r < 0.85) {
      const ops = await s.loadOps("board");
      const o = ops[Math.floor(rnd() * ops.length)];
      if (!o) continue;
      await s.confirmOp("board", o.id);
      if (owner.get(o.id) === t) ownConfirmed.add(o.id);
    } else {
      for (const o of await s.loadOps("board")) {
        if (o.confirmed) removed.add(o.id);
      }
      await s.pruneConfirmed("board");
    }
  }
  // Quiesce: every tab sees the latest state and repairs from it.
  for (let k = 0; k < 2; k++) {
    for (const t of [0, 1]) {
      v.deliver(t);
      await tabs[t]!.loadOps("board");
    }
  }
  const final = docOps(v.store);
  const ids = final.map((o) => o.id);
  const want = [...saved].filter((id) => !removed.has(id));
  const tag = `seed ${seed} (TWIN_WATERMARK_SEED=${seed})`;
  assertEquals(ids.length, new Set(ids).size, `${tag}: duplicate op`);
  for (const id of ids) {
    assert(!removed.has(id), `${tag}: ${id} was pruned and came back`);
  }
  assertEquals(ids.sort(), want.sort(), `${tag}: an op was lost`);
  for (const o of final) {
    if (ownConfirmed.has(o.id)) {
      assert(o.confirmed, `${tag}: ${o.id} lost its owner's confirm`);
    }
  }
}

// aio-ok: episode() asserts no loss, no resurrection, no lost confirm
Deno.test("twin tabs (property): random histories lose no op and resurrect none", async () => {
  const one = Deno.env.get("TWIN_WATERMARK_SEED");
  if (one !== undefined) {
    return await episode(fuzzEnvInt("TWIN_WATERMARK_SEED", 0));
  }
  const n = fuzzEnvInt("TWIN_WATERMARK_EPISODES", 200, 1);
  for (let seed = 1; seed <= n; seed++) await episode(seed);
});
