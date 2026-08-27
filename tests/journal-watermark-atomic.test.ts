// Audit 2026-08-27 (HIGH, journal apps): the journal watermark was neither
// atomic with the commit nor loud when it failed.
//
// `onPersisted(seq)` ran AFTER the snapshot transaction committed and wrote a
// `<journal>.wm` side file, with `catch {}` around it. Two failures, both
// reproduced:
//
//  1. a kill between COMMIT and `onPersisted` replayed actions that are already
//     in the snapshot. Replay RE-REDUCES — it is not idempotent — so a
//     `deposit` applied twice: a snapshot of 200 came back as 400.
//  2. a `.wm` write that could never succeed said nothing, so every later boot
//     replayed a growing already-applied tail, silently, forever.
//
// The watermark is now a row in the same SQLite file, written inside the same
// transaction as the snapshot it describes.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/mod.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import { createPersistenceManager } from "../src/server/persistence.ts";
import {
  createJournal,
  journalWatermarkKey,
  replayJournal,
} from "../src/server/journal.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const APP = "bank";
const reduce = (
  s: { bal: number },
  a: { type: string; payload?: unknown },
) => ({
  state: { bal: s.bal + (a.type === "acct:deposit" ? Number(a.payload) : 0) },
});

function makeLog(entries: string[]): Log {
  const push = (lvl: string) => (...args: unknown[]) =>
    entries.push(`${lvl} ${args.map(String).join(" ")}`);
  return {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  } as unknown as Log;
}

Deno.test("journal: the watermark commits in the SAME transaction as the snapshot", async () => {
  const dir = await Deno.makeTempDir({ prefix: "journal-wm-" });
  const db = createDB(join(dir, "state.db"));
  try {
    await db.execute(SKV_SCHEMA);
    const kv = sqliteKv(db);
    const batches: string[][] = [];
    const inner = db.transaction.bind(db);
    // deno-lint-ignore no-explicit-any
    (db as any).transaction = (arg: any) => {
      if (Array.isArray(arg)) {
        batches.push(
          arg.map((st: { sql: string; params?: unknown[] }) =>
            String(st.params?.[0] ?? st.sql.slice(0, 20))
          ),
        );
      }
      return inner(arg);
    };
    const jPath = join(dir, "app.journal");
    const journal = createJournal(jPath, {
      storedWatermark: await kv.get<number>(journalWatermarkKey(APP)) ?? 0,
    });
    const state = { acct: { bal: 0 } };
    const mgr = createPersistenceManager({
      kvDb: kv,
      asyncDb: db,
      dbSchema: undefined,
      persistKey: "state",
      persistMode: "single",
      persistMs: 1,
      getState: () => state as unknown as Record<string, unknown>,
      getDBState: (s) => s,
      log: makeLog([]),
      getReportOpts: () => ({}),
      appId: APP,
      getJournalSeq: () => journal.currentSeq(),
      onPersisted: (seq) => journal.setWatermark(seq),
      planPersisted: (seq) => kv.planSet!(journalWatermarkKey(APP), seq),
    });

    // Two deposits, then the snapshot that includes them.
    journal.append({ type: "acct:deposit", payload: 100 }, Date.now());
    state.acct.bal = 100;
    journal.append({ type: "acct:deposit", payload: 100 }, Date.now());
    state.acct.bal = 200;
    await mgr.flushPersist();

    assertEquals(batches.length, 1, "one transaction");
    assert(
      batches[0]!.includes(journalWatermarkKey(APP)),
      `the watermark rides with the snapshot — ${batches[0]}`,
    );
    assertEquals(await kv.get<number>(journalWatermarkKey(APP)), 2);

    // THE restart. Whatever happens after the commit, the next boot resumes
    // from what the transaction recorded — the two deposits are not replayed.
    const next = createJournal(jPath, {
      storedWatermark: await kv.get<number>(journalWatermarkKey(APP)) ?? 0,
    });
    assertEquals(next.watermark(), 2);
    const replayed = replayJournal(
      { bal: 200 },
      next.readSince(next.watermark()),
      reduce,
    );
    assertEquals(replayed.replayed, 0);
    assertEquals(replayed.state.bal, 200, "not 400 — nothing applied twice");
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("journal: a refused snapshot never advances the watermark", async () => {
  const dir = await Deno.makeTempDir({ prefix: "journal-wm-fail-" });
  const db = createDB(join(dir, "state.db"));
  try {
    await db.execute(SKV_SCHEMA);
    const kv = sqliteKv(db);
    let refuse = true;
    const inner = db.transaction.bind(db);
    // deno-lint-ignore no-explicit-any
    (db as any).transaction = (arg: any) => {
      if (Array.isArray(arg) && refuse) {
        refuse = false;
        return Promise.reject(new Error("disk I/O error"));
      }
      return inner(arg);
    };
    const journal = createJournal(join(dir, "app.journal"), {
      storedWatermark: 0,
    });
    const state = { acct: { bal: 0 } };
    const mgr = createPersistenceManager({
      kvDb: kv,
      asyncDb: db,
      dbSchema: undefined,
      persistKey: "state",
      persistMode: "single",
      persistMs: 1,
      getState: () => state as unknown as Record<string, unknown>,
      getDBState: (s) => s,
      log: makeLog([]),
      getReportOpts: () => ({}),
      appId: APP,
      getJournalSeq: () => journal.currentSeq(),
      onPersisted: (seq) => journal.setWatermark(seq),
      planPersisted: (seq) => kv.planSet!(journalWatermarkKey(APP), seq),
    });
    journal.append({ type: "acct:deposit", payload: 100 }, Date.now());
    state.acct.bal = 100;
    await mgr.flushPersist();
    assertEquals(
      await kv.get<number>(journalWatermarkKey(APP)),
      null,
      "a watermark without the snapshot it describes is the corruption",
    );
    assertEquals(journal.watermark(), 0);
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("journal: a watermark that cannot be written is never swallowed", async () => {
  // The legacy side-file path (a journal used outside an app). It used to be
  // `catch {}`: every later boot replayed a growing already-applied tail with
  // nothing said.
  const dir = await Deno.makeTempDir({ prefix: "journal-wm-loud-" });
  try {
    const path = join(dir, "app.journal");
    await Deno.mkdir(path + ".wm"); // every write to it fails
    const j = createJournal(path);
    j.append({ type: "acct:deposit", payload: 100 }, Date.now());

    const seen: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => seen.push(a.map(String).join(" "));
    try {
      j.setWatermark(1);
    } finally {
      console.error = origError;
    }
    const msg = seen.join("\n");
    assert(msg.includes("watermark"), msg);
    assert(msg.includes("REPLAYS") || msg.includes("replay"), msg);
    assert(msg.includes("fix:"), msg);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
