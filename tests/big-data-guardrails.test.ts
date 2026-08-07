// Big-data guardrails — wrong-tier data fails loudly at WRITE time, naming
// the right tier (docs/persistence/big-data.md), and the persist/broadcast
// paths stop paying for cells that did not change.
//
//  - persist: a cell over PERSIST_CELL_WARN_BYTES warns ONCE per cell; over
//    PERSIST_CELL_HARD_BYTES it errors on EVERY flush — and the data is still
//    persisted (never dropped: loud + written beats quiet + lost).
//  - persist: an unchanged cell (same committed reference — frozen state, so
//    identity implies equality) is neither re-serialized nor re-written.
//  - broadcast: a full-state frame over BROADCAST_FULL_WARN_BYTES warns once,
//    naming the cell(s); patch rounds no longer serialize the full state when
//    the patch is clearly below the patch-vs-full threshold.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  BIG_DATA_DOC,
  createPersistenceManager,
  PERSIST_CELL_HARD_BYTES,
  PERSIST_CELL_WARN_BYTES,
} from "../src/server/persistence.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import type { SkvInstance } from "../src/server/skv.ts";
import { createDB } from "../src/db/mod.ts";
import type { DB } from "../src/db/types.ts";
import {
  BROADCAST_FULL_WARN_BYTES,
  createBroadcaster,
} from "../src/server/server-broadcast.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import type { Log } from "../src/diagnostics/logger.ts";

type LogEntry = { level: string; msg: string };
function makeLog(entries: LogEntry[]): Log {
  const push = (level: string) => (msg: string) => entries.push({ level, msg });
  return {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  } as unknown as Log;
}

async function withStore(
  fn: (db: DB, kv: SkvInstance) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const db = createDB(join(dir, "kv.db"));
  try {
    await db.execute(SKV_SCHEMA);
    await fn(db, sqliteKv(db));
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
}

function makeMgr(
  db: DB,
  kv: SkvInstance,
  state: () => Record<string, unknown>,
  logs: LogEntry[],
) {
  return createPersistenceManager({
    kvDb: kv,
    asyncDb: db,
    dbSchema: undefined,
    persistKey: "app-state",
    persistMode: "multi",
    persistMs: 1,
    getState: state,
    getDBState: (s) => s,
    log: makeLog(logs),
    getReportOpts: () => ({}),
    appId: "guard-test",
  });
}

Deno.test("persist guard: >1MB cell warns ONCE, naming cell + tier doc; data persists", async () => {
  await withStore(async (db, kv) => {
    const logs: LogEntry[] = [];
    const state: Record<string, unknown> = {
      big: { blob: "x".repeat(PERSIST_CELL_WARN_BYTES + 1024) },
      small: { n: 0 },
    };
    const mgr = makeMgr(db, kv, () => state, logs);
    await mgr.flushPersist();

    const warns = logs.filter((l) =>
      l.level === "warn" && l.msg.includes(`cell "big"`)
    );
    assertEquals(warns.length, 1, "exactly one warning");
    assert(warns[0]!.msg.includes("db: tables"), "names the bulk-rows tier");
    assert(warns[0]!.msg.includes(BIG_DATA_DOC), "points at the tier doc");

    // Still persisted in full — a guardrail must never drop a write.
    const stored = await kv.getMulti<Record<string, unknown>>("app-state");
    assertEquals(
      (stored?.big as { blob: string }).blob.length,
      PERSIST_CELL_WARN_BYTES + 1024,
    );

    // Another flush (a different cell changed) → NO second warning.
    state.small = { n: 1 };
    await mgr.flushPersist();
    assertEquals(
      logs.filter((l) => l.level === "warn" && l.msg.includes(`cell "big"`))
        .length,
      1,
      "warning is one-time per cell",
    );
  });
});

Deno.test("persist guard: >16MB cell errors on EVERY flush — and is still persisted", async () => {
  await withStore(async (db, kv) => {
    const logs: LogEntry[] = [];
    const state: Record<string, unknown> = {
      huge: { blob: "x".repeat(PERSIST_CELL_HARD_BYTES + 4096) },
      small: { n: 0 },
    };
    const mgr = makeMgr(db, kv, () => state, logs);
    await mgr.flushPersist();
    const errs = () =>
      logs.filter((l) => l.level === "error" && l.msg.includes(`cell "huge"`));
    assertEquals(errs().length, 1, "hard overrun reported");
    assert(errs()[0]!.msg.includes("NOT dropped"), "says the write survives");
    assert(errs()[0]!.msg.includes(BIG_DATA_DOC), "points at the tier doc");

    // Loud does not mean lost: the row is there, in full.
    const stored = await kv.getMulti<Record<string, unknown>>("app-state");
    assertEquals(
      (stored?.huge as { blob: string }).blob.length,
      PERSIST_CELL_HARD_BYTES + 4096,
    );

    // Every flush stays loud — this is a fail-loud regime, not a one-time note.
    state.small = { n: 1 };
    await mgr.flushPersist();
    assertEquals(errs().length, 2, "hard overrun reported again on next flush");
  });
});

Deno.test("persist skip: an unchanged cell is not re-written; removed cells still delete", async () => {
  await withStore(async (db, kv) => {
    const written: string[][] = [];
    // Spy on the plan the atomic path uses — records which cells each flush
    // actually rewrites.
    const spyKv: SkvInstance = {
      ...kv,
      planSetMulti: (prefix, obj, prevKeys) => {
        written.push(Object.keys(obj));
        return kv.planSetMulti!(prefix, obj, prevKeys);
      },
    };
    const logs: LogEntry[] = [];
    const state: Record<string, unknown> = {
      big: { rows: Array.from({ length: 100 }, (_, id) => ({ id })) },
      small: { n: 0 },
    };
    const mgr = makeMgr(db, spyKv, () => state, logs);

    await mgr.flushPersist(); // cold: everything
    assertEquals(written[0]!.sort(), ["big", "small"]);

    state.small = { n: 1 }; // big untouched — same reference
    await mgr.flushPersist();
    assertEquals(written[1], ["small"], "unchanged cell skipped");

    // The skipped cell's row is still intact (skip ≠ delete).
    let stored = await kv.getMulti<Record<string, unknown>>("app-state");
    assertEquals((stored?.big as { rows: unknown[] }).rows.length, 100);
    assertEquals((stored?.small as { n: number }).n, 1);

    // A cell REMOVED from state is deleted from the store — the narrowed
    // write must not break delete tracking.
    delete state.big;
    state.small = { n: 2 };
    await mgr.flushPersist();
    stored = await kv.getMulti<Record<string, unknown>>("app-state");
    assertEquals(stored?.big, undefined, "removed cell's row deleted");
    assertEquals((stored?.small as { n: number }).n, 2);
  });
});

// ── broadcast seam ───────────────────────────────────────────────────

function fakeClient(id: string): {
  ws: WebSocket;
  meta: ClientMeta;
  sent: string[];
} {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    send(msg: string) {
      sent.push(msg);
    },
  } as unknown as WebSocket;
  const meta = {
    id,
    index: 0,
    clientType: "browser",
    isElectron: false,
    msgCount: 0,
    bytesThisSec: 0,
    bpMultiplier: 1,
    bpConsecutiveLow: 0,
    bpLastSentAt: 0,
    subscriptions: null,
    disconnected: false,
    consecutiveDrops: 0,
  } as unknown as ClientMeta;
  return { ws, meta, sent };
}

Deno.test("broadcast guard: >1MB full-state frame warns once, naming the cell + tier doc", () => {
  const uiState = {
    big: { blob: "x".repeat(BROADCAST_FULL_WARN_BYTES + 4096) },
    small: { n: 0 },
  };
  const a = fakeClient("c1");
  const connections = new Map<WebSocket, ClientMeta>([[a.ws, a.meta]]);
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.join(" "));
  const b = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => uiState,
    debug: () => {},
    syncIntervalMs: 1,
  });
  try {
    b.broadcast(); // full-state send
    b.flushUrgent();
    const hits = warns.filter((w) =>
      w.includes(`"big"`) && w.includes("docs/persistence/big-data.md")
    );
    assertEquals(hits.length, 1, `one warning naming the cell: ${warns}`);
    assertEquals(a.sent.length, 1, "the frame still went out — warn, not drop");

    // Same-sized frame again → no repeat.
    uiState.small = { n: 1 };
    b.broadcast();
    b.flushUrgent();
    assertEquals(
      warns.filter((w) => w.includes(`"big"`)).length,
      1,
      "one-time per cell",
    );
  } finally {
    console.warn = origWarn;
    b.shutdown();
  }
});

Deno.test("broadcast perf: small patch rounds skip full-state serialization; big patches still flip to full", () => {
  let uiState: Record<string, unknown> = {
    big: { blob: "x".repeat(200_000) },
    small: { n: 0 },
  };
  let uiStateReads = 0;
  const a = fakeClient("c1");
  const connections = new Map<WebSocket, ClientMeta>([[a.ws, a.meta]]);
  const b = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => {
      uiStateReads++;
      return uiState;
    },
    debug: () => {},
    syncIntervalMs: 1,
  });
  try {
    b.broadcast(); // initial full send — establishes the known full length
    b.flushUrgent();
    const readsAfterFull = uiStateReads;
    assertEquals(a.sent.length, 1);

    const patch = (value: unknown): PatchEntry[] => [{
      cell: "small",
      // deno-lint-ignore no-explicit-any
      ops: [{ op: "replace", path: ["n"], value } as any],
    }];

    // 10 small patch rounds: the full state must NOT be re-serialized —
    // getUIState is untouched — and every round ships as a patch frame.
    for (let i = 1; i <= 10; i++) {
      uiState = { ...uiState, small: { n: i } };
      b.broadcast(patch(i));
      b.flushUrgent();
    }
    assertEquals(
      uiStateReads,
      readsAfterFull,
      "small patch rounds must not serialize the full state",
    );
    assertEquals(a.sent.length, 11);
    assert(
      a.sent.slice(1).every((s) => s.includes('"patches"')),
      "all ten rounds went out as patches",
    );

    // A patch bigger than threshold × known-full-length recomputes the real
    // size and flips to a full-state frame.
    const hugeValue = "y".repeat(400_000); // > 50% of the ~200KB full state
    uiState = { ...uiState, small: { n: hugeValue } };
    b.broadcast(patch(hugeValue));
    b.flushUrgent();
    assert(uiStateReads > readsAfterFull, "the near-threshold case measured");
    assert(
      a.sent[11]!.includes('"state"'),
      "an oversized patch still becomes a full-state frame",
    );
  } finally {
    b.shutdown();
  }
});
