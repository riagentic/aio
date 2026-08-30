// tests/sync/sync-replay-versions.test.ts — a field report, §3.1: a sync
// cell whose shape changed must MIGRATE or REFUSE, never replay blind.
//
// The incident: a field was added to a sync cell, the next boot replayed the
// op-log against the new shape, every op threw, the cell came up at its
// defaults, and the next compaction wrote that emptiness into sync_snapshots
// while DELETING the ops — the vault was gone. Four times in a day.
//
// What must hold now:
//   - dev: a failed replay REFUSES to boot (nothing written, data intact);
//   - prod: the cell is QUARANTINED at its last snapshot, and compaction does
//     not touch it — the log and the snapshot survive for a fixed build;
//   - every op row / snapshot carries the cell `version` it was written under;
//   - older ops go through `onMigrate` or are skipped loudly;
//   - a persisted log with no declared `version` warns;
//   - `sync` + any `persist` filter is refused at `cell()`.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { cell } from "../../src/state/cell-create.ts";
import { AioError } from "../../src/diagnostics/error.ts";
import { replaySyncOps } from "../../src/server/aio-boot.ts";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import {
  _resetServerTsForTest,
  loadOpsSince,
  loadSnapshot,
  persistOp,
  seedSyncSnapshot,
} from "../../src/sync/server-store.ts";
import { compactSyncOps, SYNC_MIGRATIONS } from "../../src/sync/compact.ts";
import type { HLC } from "../../src/sync/types.ts";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";

const CELL = "vault";
const hlc = (phys: number, cnt = 0, node = "n1"): HLC => [phys, cnt, node];

type Log = {
  info: string[];
  warn: string[];
  error: string[];
  debug: string[];
  log: {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
    debug: (m: string) => void;
  };
};
const capture = (): Log => {
  const l: Log = {
    info: [],
    warn: [],
    error: [],
    debug: [],
    log: {
      info: (m) => l.info.push(m),
      warn: (m) => l.warn.push(m),
      error: (m) => l.error.push(m),
      debug: (m) => l.debug.push(m),
    },
  };
  return l;
};

// ── the app, before and after the shape change ─────────────────────────
// v1: `entries: string[]`. v2: `entries: { text: string }[]` + `cols`.
type S = { vault: Record<string, unknown> };
const initialV2: S = { vault: { entries: [], cols: 2 } };

/** The v2 reducer: `add` expects an object payload — a v1 op (a string) throws
 *  exactly like the field report's "Cannot read properties of undefined". */
function reduceV2(s: S, a: { type: string; payload?: unknown }): S {
  if (a.type !== "vault:add") return s;
  const p = a.payload as { text: string };
  if (typeof p !== "object" || p === null) {
    throw new TypeError(
      `Cannot read properties of undefined (reading 'text')`,
    );
  }
  return {
    vault: {
      ...s.vault,
      entries: [...(s.vault.entries as unknown[]), { text: p.text }],
    },
  };
}
const onMigrateV2 = (
  state: Record<string, unknown>,
  from: number,
): Record<string, unknown> =>
  from < 2
    ? {
      ...state,
      entries: (state.entries as string[]).map((text) => ({ text })),
      cols: 2,
    }
    : state;

const migrationsV2 = (hook = true) =>
  new Map([[CELL, {
    version: 2,
    initialState: initialV2.vault,
    ...(hook ? { onMigrate: onMigrateV2 } : {}),
  }]]);

/** Write the v1 world: a compaction snapshot + two ops, all stamped v1. */
async function writeV1Log(db: ReturnType<typeof createTestDb>["db"]) {
  await seedSyncSnapshot(db, CELL, { entries: ["seed"] }, 1);
  await persistOp(
    db,
    { id: "o1", hlc: hlc(1000), cell: CELL, action: "add", payload: "a" },
    1,
  );
  await persistOp(
    db,
    { id: "o2", hlc: hlc(1001), cell: CELL, action: "add", payload: "b" },
    1,
  );
}

Deno.test("field report §3.1 — dev: a replay the reducer refuses REFUSES to boot, naming the fix", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    await writeV1Log(db);
    const l = capture();
    // No onMigrate and the build declares no version at all — the op is
    // "current" by default and the v2 reducer throws on it.
    const err = await assertRejects(
      () =>
        replaySyncOps(db, [CELL], reduceV2, structuredClone(initialV2), l.log, {
          dev: true,
          versions: { [CELL]: 1 }, // same version the ops carry → applied → throws
        }),
      AioError,
    );
    assert(err.message.includes(`"${CELL}"`), err.message);
    assert(/2\/2 ops/.test(err.message), err.message);
    assert(/Cannot read properties/.test(err.message), err.message);
    assert(/onMigrate/.test(err.message), "names the fix");
    assert(/NOTHING was written/.test(err.message), err.message);
    // Nothing was written: the log and the snapshot are intact.
    assertEquals((await loadOpsSince(db, CELL, null, null)).length, 2);
    assertEquals((await loadSnapshot(db, CELL))?.state, { entries: ["seed"] });
  } finally {
    close();
  }
});

Deno.test("field report §3.1 — prod: the cell is quarantined at its snapshot, and compaction does NOT write the defaults", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    await writeV1Log(db);
    const l = capture();
    const quarantined = new Set<string>();
    const state = await replaySyncOps(
      db,
      [CELL],
      reduceV2,
      structuredClone(initialV2),
      l.log,
      {
        dev: false,
        versions: { [CELL]: 1 },
        quarantined,
        initialState: initialV2,
      },
    );
    // Held at the LAST SNAPSHOT (defaults filled in), not at initialState.
    assertEquals(state.vault, { entries: ["seed"], cols: 2 });
    assertEquals([...quarantined], [CELL]);
    assertEquals(l.error.length, 1, "log.error exactly once");
    assert(/QUARANTINED/.test(l.error[0]!), l.error[0]);

    // The live server runs on; every compaction path must skip the cell.
    let live: Record<string, unknown> = state.vault;
    const handler = createServerSyncHandler({
      dispatch: (a) => {
        live = reduceV2({ vault: live }, a as { type: string }).vault;
      },
      db,
      syncCellIds: [CELL],
      getCellState: () => live,
      getClientCellState: () => live,
      isQuarantined: (c) => quarantined.has(c),
      cellVersion: () => 1,
      broadcastRaw: { fn: () => {} },
      log: l.log,
    });
    // (1) server-write flush must not compact the quarantined cell…
    handler.noteServerWrite(CELL);
    await handler.flushServerWrites();
    await until(() =>
      l.warn.some((m) => /compaction of "vault" skipped/.test(m))
    );
    // …and (2) a client write must be REFUSED, not accepted. Accepting it
    // acked a write the server cannot make durable: the op goes into a log
    // that already fails to fold, so the next boot re-quarantines and the
    // change is gone — while the client was told it landed (H2).
    const { socket, frames } = recordingSocket();
    await handler.handleOp(
      {
        id: "o3",
        hlc: hlc(2000),
        cell: CELL,
        action: "add",
        payload: { text: "new" },
      },
      { id: "c1" },
      socket,
    );
    assert(
      !frames.some((f) => f.t === "sync-ack"),
      "a quarantined cell must not ack — the ack is a durability promise",
    );
    assert(
      frames.some((f) =>
        f.t === "op-rejected" && /quarantine/.test(String(f.d.reason))
      ),
      `the client must be told why — got ${JSON.stringify(frames)}`,
    );

    // Snapshot untouched, log intact and UNGROWN — nothing on disk moved.
    assertEquals((await loadSnapshot(db, CELL))?.state, { entries: ["seed"] });
    assertEquals(
      (await loadOpsSince(db, CELL, null, null)).map((o) => o.id),
      ["o1", "o2"],
    );
  } finally {
    close();
  }
});

Deno.test("version stamp: ops and snapshots round-trip the cell version they were written under", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    let live: Record<string, unknown> = { entries: [], cols: 2 };
    const l = capture();
    const handler = createServerSyncHandler({
      dispatch: (a) => {
        live = reduceV2({ vault: live }, a as { type: string }).vault;
      },
      db,
      syncCellIds: [CELL],
      getCellState: () => live,
      getClientCellState: () => live,
      cellVersion: () => 7,
      broadcastRaw: { fn: () => {} },
      log: l.log,
    });
    const { socket } = recordingSocket();
    await handler.handleOp(
      {
        id: "x",
        hlc: hlc(1),
        cell: CELL,
        action: "add",
        payload: { text: "t" },
      },
      { id: "c" },
      socket,
    );
    assertEquals((await loadOpsSince(db, CELL, null, null))[0]?.version, 7);
    await compactSyncOps({
      db,
      cell: CELL,
      getState: () => live,
      serverHlc: hlc(5),
      compactOps: 0,
      cellVersion: 7,
      log: l.log,
    });
    assertEquals((await loadSnapshot(db, CELL))?.cellVersion, 7);
    await seedSyncSnapshot(db, "other", { a: 1 }, 3);
    assertEquals((await loadSnapshot(db, "other"))?.cellVersion, 3);
  } finally {
    close();
  }
});

Deno.test("schema: an older database gains the columns with UNKNOWN (-1), and a fresh one already has them", async () => {
  const { db, close } = createTestDb();
  try {
    // Fresh schema: the ALTERs are the already-applied case.
    for (const sql of SYNC_MIGRATIONS) {
      let r = "applied";
      try {
        await db.execute(sql);
      } catch (e) {
        r = String(e);
      }
      assert(
        /duplicate column/i.test(r),
        `expected duplicate column, got ${r}`,
      );
    }
    assert(
      SYNC_MIGRATIONS.some((m) =>
        /sync_ops ADD COLUMN version .*DEFAULT -1/.test(m)
      ),
      "a pre-stamp op row is UNKNOWN, never 0 (0 would re-run onMigrate over current data)",
    );
    assert(
      SYNC_MIGRATIONS.some((m) =>
        /sync_snapshots ADD COLUMN cell_version .*DEFAULT -1/.test(m)
      ),
    );
  } finally {
    close();
  }
});

Deno.test("older ops + onMigrate: v1 ops fold in v1, the hook runs at the boundary, v2 ops fold on top", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    await writeV1Log(db);
    await persistOp(
      db,
      {
        id: "o3",
        hlc: hlc(3000),
        cell: CELL,
        action: "add",
        payload: { text: "c" },
      },
      2,
    );
    const l = capture();
    const quarantined = new Set<string>();
    // The v1 ops must be applied by a v1-capable reducer — the composed reducer
    // is the CURRENT build's; what makes this work is that v1 ops reach it
    // BEFORE the boundary and the hook converts the result. Model that: a
    // reducer that accepts both payload shapes (the app's own v2 `add` would
    // usually do so too, or the migration is refused loudly — see below).
    const reduceBoth = (s: S, a: { type: string; payload?: unknown }): S =>
      typeof a.payload === "string"
        ? {
          vault: {
            ...s.vault,
            entries: [...(s.vault.entries as unknown[]), a.payload],
          },
        }
        : reduceV2(s, a);
    const state = await replaySyncOps(
      db,
      [CELL],
      reduceBoth,
      structuredClone(initialV2),
      l.log,
      {
        dev: true,
        versions: { [CELL]: 2 },
        migrations: migrationsV2(),
        quarantined,
        initialState: initialV2,
      },
    );
    assertEquals(state.vault, {
      entries: [{ text: "seed" }, { text: "a" }, { text: "b" }, { text: "c" }],
      cols: 2,
    });
    assertEquals(quarantined.size, 0);
    assert(
      l.info.some((m) => /migrated cell "vault" v1 → v2/.test(m)),
      l.info.join("\n"),
    );
  } finally {
    close();
  }
});

Deno.test("older ops WITHOUT onMigrate are skipped, never applied blind — and the cell is quarantined", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    await writeV1Log(db);
    const l = capture();
    const quarantined = new Set<string>();
    let reduced = 0;
    const state = await replaySyncOps(
      db,
      [CELL],
      (s: S, a) => {
        reduced++;
        return reduceV2(s, a);
      },
      structuredClone(initialV2),
      l.log,
      {
        dev: false,
        versions: { [CELL]: 2 },
        migrations: migrationsV2(false),
        quarantined,
        initialState: initialV2,
      },
    );
    assertEquals(reduced, 0, "no v1 op reached the v2 reducer");
    assertEquals([...quarantined], [CELL]);
    assertEquals(
      state.vault,
      { entries: ["seed"], cols: 2 },
      "held at the snapshot",
    );
    assert(
      l.error.some((m) => /2 older-shape skipped/.test(m)),
      l.error.join("\n"),
    );
    assert(l.error.some((m) => /has no onMigrate/.test(m)));
    // The snapshot without a hook is the KV "stale" outcome — said, not hidden.
    assert(l.warn.some((m) => /snapshot v1 → v2 but no onMigrate/.test(m)));
    // dev: the same log REFUSES.
    await assertRejects(
      () =>
        replaySyncOps(db, [CELL], reduceV2, structuredClone(initialV2), l.log, {
          dev: true,
          versions: { [CELL]: 2 },
          migrations: migrationsV2(false),
        }),
      AioError,
      "older-shape skipped",
    );
  } finally {
    close();
  }
});

Deno.test("downgrade: ops written by a NEWER build are skipped and the cell quarantined", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    await persistOp(
      db,
      {
        id: "n1",
        hlc: hlc(1),
        cell: CELL,
        action: "add",
        payload: { text: "x" },
      },
      5,
    );
    const l = capture();
    const quarantined = new Set<string>();
    await replaySyncOps(
      db,
      [CELL],
      reduceV2,
      structuredClone(initialV2),
      l.log,
      {
        dev: false,
        versions: { [CELL]: 2 },
        quarantined,
      },
    );
    assertEquals([...quarantined], [CELL]);
    assert(
      l.error.some((m) =>
        /1 newer-shape skipped/.test(m) && /downgrade/.test(m)
      ),
    );
  } finally {
    close();
  }
});

Deno.test("a pre-stamp row (-1) resolves to the last persisted version stamp, not to 0", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    // A row an older aio wrote: after the ALTER it carries -1.
    await persistOp(
      db,
      {
        id: "old",
        hlc: hlc(1),
        cell: CELL,
        action: "add",
        payload: { text: "x" },
      },
      -1,
    );
    const l = capture();
    let migrated = false;
    const state = await replaySyncOps(
      db,
      [CELL],
      reduceV2,
      structuredClone(initialV2),
      l.log,
      {
        dev: true,
        versions: { [CELL]: 2 },
        stampedVersions: { [CELL]: 2 }, // the build that last persisted was v2
        migrations: new Map([[CELL, {
          version: 2,
          initialState: initialV2.vault,
          onMigrate: (s: Record<string, unknown>) => {
            migrated = true;
            return s;
          },
        }]]),
      },
    );
    assertEquals(migrated, false, "current-shape data must not be re-migrated");
    assertEquals(state.vault.entries, [{ text: "x" }]);
  } finally {
    close();
  }
});

Deno.test("no `version` + a persisted op-log warns once per cell and reports it", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    await persistOp(db, {
      id: "a",
      hlc: hlc(1),
      cell: CELL,
      action: "add",
      payload: { text: "x" },
    });
    const l = capture();
    const report: {
      cell: string;
      from: number;
      to: number;
      outcome: string;
    }[] = [];
    await replaySyncOps(
      db,
      [CELL, "empty"],
      reduceV2,
      {
        ...structuredClone(initialV2),
        empty: {},
      } as S,
      l.log,
      { dev: true, report: report as never },
    );
    const warns = l.warn.filter((m) => /no `version`/.test(m));
    assertEquals(warns.length, 1, l.warn.join("\n"));
    assert(
      warns[0]!.includes(`"${CELL}"`) && /declare version: 1/.test(warns[0]!),
    );
    assertEquals(report, [{
      cell: CELL,
      from: 0,
      to: 0,
      outcome: "sync-unversioned",
    }]);
  } finally {
    close();
  }
});

Deno.test("sync: true + a persist filter is REFUSED at cell(), naming the cell, the fields and the three ways out", () => {
  // The op-log is the durable home of a sync cell and an op is the method
  // call's payload, raw — so a persist filter is a promise the framework
  // cannot keep. It used to be honoured on the compaction snapshot only and
  // warned about; now it is impossible. Every filter shape, one wording.
  const shapes: [string, unknown, string][] = [
    ["exclude", { exclude: ["cache", "scratch"] }, "exclude: cache, scratch"],
    ["include", { include: ["entries"] }, "include: entries"],
    ["none", "none", "every field"],
  ];
  for (const [label, persist, names] of shapes) {
    const name = `refuse-persist-${label}`;
    const err = assertThrows(
      () =>
        cell(name, {
          sync: true,
          persist,
          state: { entries: [] as string[], cache: "", scratch: 0 },
          methods: {},
          // deno-lint-ignore no-explicit-any
        } as any),
      Error,
      `[cell:${name}]`,
    );
    assert(
      err.message.includes(names),
      `${label}: names the fields — ${err.message}`,
    );
    assert(err.message.includes("op-log is the durable home"), "says why");
    assert(err.message.includes('persist: "all"'), "fix 1: drop the filter");
    assert(err.message.includes("turn sync off"), "fix 2: drop sync");
    assert(err.message.includes("non-sync cell"), "fix 3: a separate cell");
  }
  // The allowed spellings still define.
  cell("refuse-persist-all", {
    sync: true,
    persist: "all",
    state: { entries: [] as string[] },
    methods: {},
  });
  cell("refuse-persist-nonsync", {
    persist: { exclude: ["cache"] },
    state: { entries: [] as string[], cache: "" },
    methods: {},
  });
});
