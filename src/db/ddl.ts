// ddl.ts — THE DDL decider, and the schema-version ladder.
//
// Every schema-evolution seam routes its DDL through here so there is ONE
// answer to "what happens when SQLite refuses a statement":
//   • "duplicate column name" → tolerated ("already-applied" — the steady
//     state of an idempotent migration re-run on every boot);
//   • ANYTHING else → FATAL, naming the subject, the statement and the call
//     site. Continuing would run the app against a schema it does not have —
//     every later query on the missing column fails at a random moment
//     instead of at the boot that knew.
// Callers: `applySyncMigrations` (src/sync/compact.ts) and `reconcileTable`
// (src/db/state-sync.ts). Warning-and-continuing was each site's historical
// bug, fixed twice — one decider so it cannot regress one seam at a time.
//
// VERSIONING: aio tracks its own schema era in the private `aio_schema`
// table — deliberately NOT in `PRAGMA user_version`. `user_version` is the
// standard SQLite idiom for an APP's own "have I run this" migration marker,
// and aio once stamping it on open silently defeated exactly that in the
// field (a fresh file read 1, so every `at >= version` app correction
// skipped). One integer cannot serve two owners; the app owns the idiom —
// aio reads and writes user_version NOWHERE (documented at `createDB` and in
// docs/persistence/sqlite.md, with the ≤alpha51 "may read 1" caveat).
//
// A file with no `aio_schema` table reads version 0 — "pre-versioned/
// legacy": the idempotent reconcilers above run (as they always have) and
// `runDdlSteps` stamps the epoch (1). A FUTURE breaking schema move
// registers a `DdlStep` with version ≥ 2 in `AIO_DDL_STEPS`; `runDdlSteps`
// applies steps strictly above the file's stamped version, in order,
// stamping after each — so a move runs exactly once per database file, ever.

import type { DB } from "./types.ts";

/** aio's private schema-version table — one row, invisible to state and to
 *  the app's own migration bookkeeping. */
export const AIO_SCHEMA_TABLE = "aio_schema";

/** The version stamped for a fresh (or pre-versioned "legacy") database
 *  file by `runDdlSteps` — the baseline of the versioned ladder. */
export const DB_VERSION_EPOCH = 1;

/** The schema version THIS build of aio writes. Bump it together with the
 *  `AIO_DDL_STEPS` entry that moves a file to it. */
export const DB_SCHEMA_VERSION = 1;

/** One future schema move: every statement runs through the one decider,
 *  then the file is stamped `version`. */
export type DdlStep = {
  version: number;
  /** Statements applied in order. Each may be idempotent-tolerant
   *  (duplicate-column) but any other refusal is fatal. */
  statements: readonly string[];
};

/** The registered version ladder. Empty today — the v1 epoch's reconcilers
 *  (SYNC_MIGRATIONS, reconcileTable) are idempotent and run every boot by
 *  design (app `db:` tables evolve with the APP, not with aio's schema
 *  version). Append `{ version: 2, statements: [...] }` for the first
 *  run-exactly-once move, and bump DB_SCHEMA_VERSION with it. */
export const AIO_DDL_STEPS: readonly DdlStep[] = [];

export type DdlOutcome = "applied" | "already-applied";

/** What a DDL failure message needs to say, and who is saying it. */
export type DdlContext = {
  /** Error prefix — "db" or "sync", matching the caller's namespace. */
  ns: string;
  /** What was being migrated, e.g. `table "sync_meta"`. */
  subject: string;
  /** Call site, e.g. `applySyncMigrations, src/sync/compact.ts` — so the
   *  boot failure points at the seam, not at this decider. */
  source: string;
  /** Optional extra guidance appended to the error. */
  remedy?: string;
};

/** Execute ONE DDL statement with the unified tolerance rule.
 *
 *  "duplicate column name" → `"already-applied"` (goal state reached — a
 *  raced boot, an out-of-band add, or an idempotent migration re-run).
 *  Any other refusal throws, fatally, with the statement and the site. */
export async function applyDdl(
  db: DB,
  sql: string,
  ctx: DdlContext,
): Promise<DdlOutcome> {
  try {
    await db.execute(sql);
    return "applied";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate column name/i.test(msg)) return "already-applied";
    throw new Error(
      `${ctx.ns}: schema migration failed on ${ctx.subject} — ${msg}\n` +
        `  statement: ${sql}\n` +
        `  (${ctx.source}) ` +
        (ctx.remedy ??
          `Continuing would run the app against a schema it does not have — ` +
            `every later query on the missing column fails at a random ` +
            `moment instead of here.`),
      { cause: e },
    );
  }
}

/** Read aio's schema version from its private table — 0 means
 *  "pre-versioned/legacy file" (the table does not exist yet). Never touches
 *  `PRAGMA user_version`, which belongs to the app. */
export async function getAioSchemaVersion(db: DB): Promise<number> {
  try {
    const { rows } = await db.query<{ version: number }>(
      `SELECT version FROM ${AIO_SCHEMA_TABLE} WHERE id = 1`,
    );
    return Number(rows[0]?.version ?? 0);
  } catch {
    return 0; // no aio_schema table — a fresh or pre-versioned file
  }
}

/** Stamp aio's schema version (creates the private table on first stamp).
 *  Validated as a non-negative safe integer — loudly, never truncated. */
export async function stampAioSchemaVersion(db: DB, v: number): Promise<void> {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new Error(
      `db: invalid aio_schema version ${v} — a non-negative integer`,
    );
  }
  // CHECK (id = 1) pins the table to ONE row by construction.
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${AIO_SCHEMA_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`,
  );
  await db.execute(
    `INSERT INTO ${AIO_SCHEMA_TABLE} (id, version) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET version = excluded.version`,
    [v],
  );
}

/** Apply every registered step strictly ABOVE the file's stamped version
 *  (`aio_schema` — NEVER `PRAGMA user_version`, which is the app's), in
 *  ascending order, stamping after each — a step runs exactly once per file.
 *  A file left below the epoch (fresh, or legacy pre-versioned) is stamped
 *  {@linkcode DB_VERSION_EPOCH} at the end. Returns the version walked
 *  from/to. Fatal on any refused statement (see {@linkcode applyDdl}) and on
 *  a malformed ladder (duplicate versions, or a step above
 *  {@linkcode DB_SCHEMA_VERSION} — someone forgot to bump the constant). */
export async function runDdlSteps(
  db: DB,
  steps: readonly DdlStep[] = AIO_DDL_STEPS,
  ctx: Pick<DdlContext, "ns" | "source"> & {
    /** Test seam: the ceiling a step may claim. Production callers leave it
     *  at DB_SCHEMA_VERSION — the guard exists precisely so a step and the
     *  constant cannot ship disagreeing. */
    maxVersion?: number;
  } = {
    ns: "db",
    source: "runDdlSteps, src/db/ddl.ts",
  },
): Promise<{ from: number; to: number }> {
  const max = ctx.maxVersion ?? DB_SCHEMA_VERSION;
  const ordered = [...steps].sort((a, b) => a.version - b.version);
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i]!;
    if (!Number.isSafeInteger(s.version) || s.version < 2) {
      throw new Error(
        `db: DDL step version ${s.version} is invalid — versioned steps ` +
          `start at 2 (1 is the epoch; epoch-1 reconcilers run every boot ` +
          `and do not belong on the ladder)`,
      );
    }
    if (i > 0 && ordered[i - 1]!.version === s.version) {
      throw new Error(
        `db: two DDL steps claim version ${s.version} — a version stamps ` +
          `exactly one move; merge the statements or renumber`,
      );
    }
    if (s.version > max) {
      throw new Error(
        `db: DDL step version ${s.version} exceeds DB_SCHEMA_VERSION ` +
          `(${max}) — bump the constant together with the step ` +
          `so the two cannot disagree about what "current" means`,
      );
    }
  }
  const from = await getAioSchemaVersion(db);
  let v = from;
  for (const step of ordered) {
    if (step.version <= v) continue; // already ran on this file
    for (const sql of step.statements) {
      await applyDdl(db, sql, {
        ...ctx,
        subject: `versioned step v${step.version}`,
      });
    }
    await stampAioSchemaVersion(db, step.version);
    v = step.version;
  }
  if (v < DB_VERSION_EPOCH) {
    await stampAioSchemaVersion(db, DB_VERSION_EPOCH);
    v = DB_VERSION_EPOCH;
  }
  return { from, to: v };
}
