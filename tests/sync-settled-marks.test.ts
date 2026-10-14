// The `settled` mark of a sync op's row (server-store.ts `settleOp`), at the
// seams the kill tests (tests/sync-op-killed-before-settle.test.ts) cannot
// reach: the ORDER mark → ack → broadcast in each door, a mark that cannot
// be written, a mark that finds no row, the column added lazily, and what
// the boot replay does with a row per mark when the cell does not fold.
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { createServerSyncHandler } from "../src/sync/server-handler.ts";
import { _resetServerTsForTest, persistOp } from "../src/sync/server-store.ts";
import { replaySyncOps } from "../src/server/aio-boot.ts";
import { opKey } from "../src/server/op-placement.ts";
import { recordRejection } from "../src/state/rejection-tracker.ts";
import type { DB } from "../src/db/types.ts";
import type { HLC } from "../src/sync/types.ts";
import { createTestDb, recordingSocket, until } from "./sync/_test-db.ts";

const MARK = /^UPDATE sync_ops SET settled = 1/;
type Lines = { warn: string[]; error: string[] };
const logOf = (l: Lines) => ({
  debug: () => {},
  info: () => {},
  // (but the unversioned-log hint: the replay tests' cells declare none)
  warn: (m: string) => void (/and no `version`/.test(m) || l.warn.push(m)),
  error: (m: string) => void l.error.push(m),
});
const op = (id: string, cell = "notes", n = 0) => ({
  id,
  hlc: [Date.now(), n, "c1"] as HLC,
  cell,
  action: "add",
  payload: { args: [id] },
});
const marks = async (db: DB) =>
  (await db.query<{ id: string; settled: number | null }>(
    "SELECT id, settled FROM sync_ops ORDER BY server_ts",
  )).rows.map((r) => `${r.id}:${r.settled}`);

/** `db` whose every `execute` matching `re` runs `before` first. */
function seam(
  db: DB,
  re: RegExp,
  before: (sql: string, params?: unknown[]) => Promise<void> | void,
): DB {
  return {
    ...db,
    execute: async (sql: string, params?: unknown[]) => {
      if (re.test(sql)) await before(sql, params);
      return await db.execute(sql, params);
    },
  };
}

/** A handler over `db`, with every frame, broadcast and mark in `events`. */
function harness(db: DB, lines: Lines = { warn: [], error: [] }) {
  const events: string[] = [];
  const handler = createServerSyncHandler({
    dispatch: () => {},
    // The mark lands a macrotask after it is asked for — as a worker-thread
    // database answers: an un-awaited mark is then visibly late.
    db: {
      ...db,
      execute: async (sql: string, params?: unknown[]) => {
        if (/^INSERT OR IGNORE INTO sync_ops/.test(sql)) {
          const r = await db.execute(sql, params);
          events.push(`insert:${params![0]}`);
          return r;
        }
        if (!MARK.test(sql)) return await db.execute(sql, params);
        await new Promise((r) => setTimeout(r, 5));
        const r = await db.execute(sql, params);
        events.push(`mark:${params!.join("+")}`);
        return r;
      },
    },
    syncCellIds: ["notes", "c1", "c2", "c3", "c4"],
    getCellState: () => ({}),
    getClientCellState: () => ({}),
    broadcastRaw: {
      fn: (m: string) => {
        const f = JSON.parse(m);
        if (f.t === "op") events.push(`broadcast:${f.d.id}`);
      },
    },
    log: logOf(lines),
  });
  const socket = {
    send: (m: string) => {
      const f = JSON.parse(m);
      if (f.t === "sync-ack") events.push(`ack:${f.d.opId}`);
      else events.push(f.t);
    },
  } as unknown as WebSocket;
  return { handler, events, socket };
}

Deno.test("the `op` door marks the row settled BEFORE the ack and the broadcast", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const { handler, events, socket } = harness(db);
    await handler.handleOp(op("a"), { id: "c1" }, socket);
    assertEquals(events, ["insert:a", "mark:a", "ack:a", "broadcast:a"]);
    assertEquals(await marks(db), ["a:1"]);
  } finally {
    close();
  }
});

Deno.test("the pending-list door marks each row settled BEFORE its broadcast and its ack", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const { handler, events, socket } = harness(db);
    handler.handleSync(
      {
        clientId: "c1",
        cells: {},
        pendingOps: [op("a", "notes", 0), op("b", "notes", 1)],
      },
      { id: "c1" },
      socket,
    );
    await until(() => events.includes("sync-res"), "the sync response");
    assertEquals(events.filter((e) => e !== "sync-res"), [
      "insert:a",
      "mark:a",
      "broadcast:a",
      "ack:a",
      "insert:b",
      "mark:b",
      "broadcast:b",
      "ack:b",
    ]);
  } finally {
    close();
  }
});

// Ops in flight on DIFFERENT cells: the marks asked for while one is being
// written go out together, in one statement — and still no ack leaves
// before the statement that holds its own mark is committed.
Deno.test("marks of ops in flight on different cells are written together — each ack still after the write that holds its mark", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const { handler, events, socket } = harness(db);
    const ids = ["c1", "c2", "c3", "c4"];
    await Promise.all(
      ids.map((c) => handler.handleOp(op(`o-${c}`, c), { id: "n" }, socket)),
    );
    const written = events.filter((e) => e.startsWith("mark:"));
    assert(
      written.length < ids.length && written.some((e) => e.includes("+")),
      `premise: some marks rode one statement: ${written}`,
    );
    for (const c of ids) {
      const mark = events.findIndex((e) =>
        e.startsWith("mark:") && e.slice(5).split("+").includes(`o-${c}`)
      );
      assert(mark >= 0, `o-${c} was never marked: ${events}`);
      for (const told of [`ack:o-${c}`, `broadcast:o-${c}`]) {
        assert(
          mark < events.indexOf(told),
          `${told} before its mark: ${events}`,
        );
      }
    }
    assertEquals(await marks(db), ids.map((c) => `o-${c}:1`));
  } finally {
    close();
  }
});

Deno.test("a joint write of marks that fails: each op retries alone, is marked and acknowledged — nothing owed, nothing said", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const lines: Lines = { warn: [], error: [] };
    let failed = 0;
    const flaky = seam(db, MARK, (_sql, params) => {
      if (params!.length > 1 && failed++ === 0) throw new Error("disk I/O");
    });
    const { handler, events, socket } = harness(flaky, lines);
    const ids = ["c1", "c2", "c3", "c4"];
    await Promise.all(
      ids.map((c) => handler.handleOp(op(`o-${c}`, c), { id: "n" }, socket)),
    );
    assertEquals(failed > 0, true, "premise: a joint write failed");
    assertEquals(await marks(db), ids.map((c) => `o-${c}:1`));
    assertEquals(events.filter((e) => e.startsWith("ack:")).length, 4);
    assertEquals(lines.error, []);
  } finally {
    close();
  }
});

/** `db` whose mark fails `n` times. */
function failingMarks(db: DB, n: { left: number }): DB {
  return seam(db, MARK, () => {
    if (n.left-- > 0) throw new Error("database is locked");
  });
}

for (
  const [name, next] of [
    ["the cell's next op", "next"],
    ["a resend of the op", "resend"],
    ["the shutdown flush", "flush"],
  ] as const
) {
  Deno.test(`a mark that could not be written is owed, said truthfully, and written at ${name}`, async () => {
    _resetServerTsForTest();
    const { db, close } = createTestDb();
    try {
      const lines: Lines = { warn: [], error: [] };
      const left = { left: 2 }; // the try and its one retry
      const { handler, events, socket } = harness(
        failingMarks(db, left),
        lines,
      );
      await handler.handleOp(op("a"), { id: "c1" }, socket);
      // Acknowledged all the same: the row IS saved — and the line says so.
      assertEquals(events, ["insert:a", "ack:a", "broadcast:a"]);
      assertEquals(await marks(db), ["a:0"]);
      assertEquals(lines.error.length, 1, lines.error.join("\n"));
      assertMatch(
        lines.error[0]!,
        /op a IS saved — applied, in the op-log, and acknowledged; only its `settled` mark could not be written/,
      );
      events.length = 0;
      if (next === "next") {
        // Before the next op's row exists: an unmarked row is never followed.
        await handler.handleOp(op("b", "notes", 1), { id: "c1" }, socket);
        assertEquals(events, [
          "mark:a",
          "insert:b",
          "mark:b",
          "ack:b",
          "broadcast:b",
        ]);
        assertEquals(await marks(db), ["a:1", "b:1"]);
      } else if (next === "resend") {
        await handler.handleOp(op("a"), { id: "c1" }, socket);
        assertEquals(events, ["mark:a", "ack:a"]);
        assertEquals(await marks(db), ["a:1"]);
      } else {
        await handler.flushServerWrites();
        assertEquals(events, ["mark:a"]);
        assertEquals(await marks(db), ["a:1"]);
      }
      assertEquals(lines.error.length, 1, "said once");
    } finally {
      close();
    }
  });
}

Deno.test("a mark the database never takes: the shutdown flush says the op is saved and its mark is not — once more, by name", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const lines: Lines = { warn: [], error: [] };
    const { handler, socket } = harness(
      failingMarks(db, { left: Infinity }),
      lines,
    );
    await handler.handleOp(op("a"), { id: "c1" }, socket);
    await handler.flushServerWrites();
    assertEquals(await marks(db), ["a:0"]);
    assertEquals(lines.error.length, 2, lines.error.join("\n"));
    assertMatch(
      lines.error[1]!,
      /op a \("notes"\) is saved but its settled mark is still not written/,
    );
  } finally {
    close();
  }
});

// The op's commit owes a fold of its own cell (`durableFor`), which runs
// under the op's lock while it is parked — a compaction that folds the op
// into the snapshot and deletes its row before the mark is written.
Deno.test("a mark that finds no row — a parked compaction folded the op first — is harmless: acked, nothing owed, nothing said", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const lines: Lines = { warn: [], error: [] };
    const live = { items: [] as string[] };
    let rowsAtMark = -1;
    const owed = new WeakMap<object, Promise<string | undefined>>();
    const handler: ReturnType<typeof createServerSyncHandler> =
      createServerSyncHandler({
        dispatch: (a) => {
          live.items = [...live.items, "x"];
          handler.noteServerWrite("notes");
          owed.set(a, handler.flushServerWrites(["notes"]));
        },
        durableFor: (a) => owed.get(a),
        db: seam(db, MARK, async () => {
          rowsAtMark = (await marks(db)).length;
        }),
        syncCellIds: ["notes"],
        getCellState: () => live,
        getClientCellState: () => live,
        broadcastRaw: { fn: () => {} },
        log: logOf(lines),
      });
    const { socket, frames } = recordingSocket();
    await handler.handleOp(op("a"), { id: "c1" }, socket);
    assertEquals(rowsAtMark, 0, "premise: the fold deleted the row first");
    assertEquals(frames.map((f) => f.t), ["sync-ack"]);
    assertEquals(frames[0]!.d.unsaved, undefined);
    await handler.flushServerWrites();
    assertEquals(lines.error, []);
  } finally {
    close();
  }
});

Deno.test("persistOp over a table an older build created: two first inserts at once both add the column and both land", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    await db.execute("ALTER TABLE sync_ops DROP COLUMN settled");
    let alters = 0;
    const counted = seam(db, /^ALTER TABLE sync_ops ADD COLUMN settled/, () => {
      alters++;
    });
    const got = await Promise.all([
      persistOp(counted, op("a", "notes", 0)),
      persistOp(counted, op("b", "notes", 1)),
    ]);
    assertEquals(alters, 2, "premise: both inserts met the missing column");
    assert(got.every((ts) => typeof ts === "number"), String(got));
    assertEquals(await marks(db), ["a:0", "b:0"]);
  } finally {
    close();
  }
});

Deno.test("persistOp on a read-only database rejects (old table or new) — and the door answers sync-err, never an ack", async () => {
  for (const old of [false, true]) {
    _resetServerTsForTest();
    const { db, close } = createTestDb();
    try {
      if (old) await db.execute("ALTER TABLE sync_ops DROP COLUMN settled");
      await db.execute("PRAGMA query_only = ON");
      await assertRejects(
        () => persistOp(db, op("a")),
        Error,
        "readonly",
      );
      const lines: Lines = { warn: [], error: [] };
      const { handler, events, socket } = harness(db, lines);
      await handler.handleOp(op("b"), { id: "c1" }, socket);
      assertEquals(events, ["sync-err"]);
      assertMatch(lines.error[0]!, /failed to persist op b/);
      assertEquals(await marks(db).catch(() => []), []);
    } finally {
      close();
    }
  }
});

// ── The boot replay ─────────────────────────────────────────────────────

type Root = Record<string, { items: string[] }>;
/** `add` refuses a duplicate by throwing, and "bad" without one (validate);
 *  `strict` cells throw on everything — a method a later deploy changed. */
const reducer = (strict: string[] = []) =>
(
  s: Root,
  a: { type: string; payload?: unknown },
): Root => {
  const cell = a.type.slice(0, a.type.indexOf(":"));
  const t = (a.payload as { args: string[] }).args[0]!;
  if (strict.includes(cell)) throw new Error(`strict ${t}`);
  if (t === "bad") {
    recordRejection(a, { cell, reason: "no bad" });
    return s;
  }
  if (s[cell]!.items.includes(t)) throw new Error(`dup ${t}`);
  return { ...s, [cell]: { items: [...s[cell]!.items, t] } };
};
async function store(
  db: DB,
  cell: string,
  rows: [id: string, text: string, settled: number | null][],
): Promise<Map<string, number>> {
  const ts = new Map<string, number>();
  for (const [id, text, settled] of rows) {
    const at = await persistOp(db, {
      ...op(id, cell),
      payload: { args: [text] },
    });
    ts.set(id, at!);
    await db.execute("UPDATE sync_ops SET settled = ? WHERE id = ?", [
      settled,
      id,
    ]);
  }
  return ts;
}
const replay = (
  db: DB,
  cells: string[],
  lines: Lines,
  o: { dev?: boolean; strict?: string[]; committed?: Set<string> } = {},
) => {
  const quarantined = new Set<string>();
  const state = Object.fromEntries(cells.map((c) => [c, { items: [] }]));
  return replaySyncOps<Root>(
    db,
    cells,
    reducer(o.strict),
    state,
    logOf(lines),
    { dev: o.dev ?? false, quarantined, initialState: state },
    { committed: o.committed },
  ).then((s) => ({ state: s, quarantined }));
};

Deno.test("several cells each left with an unsettled last row: each is decided on its own — removed, folded and marked, removed without a throw", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    await store(db, "a", [["a1", "x", 1], ["a2", "x", 0]]); // refused: dup
    await store(db, "b", [["b1", "x", 1], ["b2", "y", 0]]); // accepted
    await store(db, "c", [["c1", "x", 1], ["c2", "bad", 0]]); // refused: validate
    const lines: Lines = { warn: [], error: [] };
    const { state, quarantined } = await replay(db, ["a", "b", "c"], lines);
    assertEquals(state, {
      a: { items: ["x"] },
      b: { items: ["x", "y"] },
      c: { items: ["x"] },
    });
    assertEquals(await marks(db), ["a1:1", "b1:1", "b2:1", "c1:1"]);
    assertEquals(quarantined.size, 0);
    assertEquals(lines.warn.length, 2, lines.warn.join("\n"));
    assertMatch(
      lines.warn[0]!,
      /"a"'s op a2 was persisted but not yet settled/,
    );
    assertMatch(lines.warn[1]!, /"c"'s op c2 [^\n]*no bad/);
  } finally {
    close();
  }
});

Deno.test("the boot cannot remove the unsettled refused row (database busy): the boot FAILS, loudly — the row is not left to fold as accepted", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    await store(db, "a", [["a1", "x", 1], ["a2", "x", 0]]);
    const busy = seam(db, /^DELETE FROM sync_ops/, () => {
      throw new Error("database is locked");
    });
    for (const dev of [true, false]) {
      await assertRejects(
        () => replay(busy, ["a"], { warn: [], error: [] }, { dev }),
        Error,
        "database is locked",
      );
    }
    assertEquals(await marks(db), ["a1:1", "a2:0"]);
  } finally {
    close();
  }
});

Deno.test("an unsettled last row the journal holds the commit of is MARKED by the boot that reads it — folding or not, dev or prod", async () => {
  for (const dev of [true, false]) {
    _resetServerTsForTest();
    const { db, close } = createTestDb();
    try {
      const ts = await store(db, "a", [["a1", "x", 0]]);
      const committed = new Set([opKey("a1", ts.get("a1")!)]);
      const lines: Lines = { warn: [], error: [] };
      const boot = () =>
        replay(db, ["a"], lines, { dev, strict: ["a"], committed });
      if (dev) await assertRejects(boot, Error, "refusing to boot");
      else assert((await boot()).quarantined.has("a"));
      assertEquals(await marks(db), ["a1:1"]);
      // The commit line gone (a journal moved aside, cut, compacted): the
      // row is still an accepted one — kept, and the cell still quarantined.
      const again = await replay(db, ["a"], lines, { strict: ["a"] });
      assert(again.quarantined.has("a"));
      assertEquals(await marks(db), ["a1:1"]);
      assert(!lines.warn.some((w) => /removed from the op-log/.test(w)));
    } finally {
      close();
    }
  }
});

// Kept on purpose: a refusal decided on a state an earlier op did not fold
// into is not the live server's decision, and a quarantined cell takes no
// op — the row is still last, still unsettled, at the boot that folds.
Deno.test("a cell quarantined for ANOTHER reason keeps its unsettled last row untouched — and the boot that folds decides it", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    // a1 no longer folds (it is a duplicate of nothing — the reducer below
    // throws on "boom"); a2 is the row a kill left.
    await store(db, "a", [["a1", "boom", 1], ["a2", "x", 0]]);
    const lines: Lines = { warn: [], error: [] };
    const quarantined = new Set<string>();
    const state: Root = { a: { items: [] } };
    const reduce = (boom: boolean) =>
    (
      s: Root,
      a: { type: string; payload?: unknown },
    ): Root => {
      const t = (a.payload as { args: string[] }).args[0]!;
      if (t === "boom" && boom) throw new Error("boom");
      // Refuses a2 only because a1 did not fold before it.
      if (t === "x" && !s.a!.items.includes("boom")) throw new Error("no a1");
      return { a: { items: [...s.a!.items, t] } };
    };
    const ctx = { dev: false, quarantined, initialState: state };
    await replaySyncOps<Root>(
      db,
      ["a"],
      reduce(true),
      state,
      logOf(lines),
      ctx,
    );
    assert(quarantined.has("a"));
    assertEquals(await marks(db), ["a1:1", "a2:0"], "nothing written");
    assert(!lines.warn.some((w) => /removed from the op-log/.test(w)));
    // Fixed: a1 folds, and a2 — decided on the right state — is accepted.
    quarantined.clear();
    const fixed = await replaySyncOps<Root>(
      db,
      ["a"],
      reduce(false),
      state,
      logOf(lines),
      ctx,
    );
    assertEquals(fixed, { a: { items: ["boom", "x"] } });
    assertEquals(await marks(db), ["a1:1", "a2:1"]);
  } finally {
    close();
  }
});

Deno.test("a SETTLED op this build refuses without a throw folds as a no-op, as before — and is no longer silent: one warning per cell, by op id", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    await store(db, "a", [["a1", "x", 1], ["a2", "bad", 1], ["a3", "bad", 1], [
      "a4",
      "y",
      1,
    ]]);
    await store(db, "b", [["b1", "x", 1]]);
    const lines: Lines = { warn: [], error: [] };
    const { state, quarantined } = await replay(db, ["a", "b"], lines);
    // Unchanged behaviour: not quarantined, the ops kept, the rest folded.
    assertEquals(state, { a: { items: ["x", "y"] }, b: { items: ["x"] } });
    assertEquals(quarantined.size, 0);
    assertEquals(await marks(db), ["a1:1", "a2:1", "a3:1", "a4:1", "b1:1"]);
    assertEquals(lines.warn.length, 1, lines.warn.join("\n"));
    assertMatch(
      lines.warn[0]!,
      /"a": 2 ops in the op-log that the server ACCEPTED are refused by this build[^\n]*first: op a2 \(a:add\): no bad\. Each is folded as a NO-OP/,
    );
  } finally {
    close();
  }
});
