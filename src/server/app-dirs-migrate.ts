// app-dirs-migrate.ts — the one-time move from the scattered layout to
// `~/.<appId>/`.
//
// This is the only code in the framework that relocates files a user cannot
// recreate, so every rule here exists to make a partial failure survivable:
//
//   • never move onto an existing target — a populated target means the new
//     layout is already live; a "merge" could only produce a franken-state
//   • move a SQLite database with its -wal/-shm sidecars as one set, and only
//     while nothing has opened it (this runs before storage boot)
//   • rename when possible; across filesystems copy → verify size → unlink, so
//     an interruption leaves the ORIGINAL intact rather than a truncated copy
//   • record a database move (`<to>.moving`) before its first rename, and
//     finish a WAL it stranded only under that record — never a WAL of
//     another database
//   • refuse entirely while another instance is running — it holds the database
//     open and would write to a file we just moved
//   • say what moved, per file, once
//
// Legacy layout (see docs/specs/2026-07-26-data-dir-and-updates.md):
//   ./data.db (+ -wal/-shm/.journal/.journal.wm) → <data>/state.db (+ sidecars)
//   ~/.local/share/<appId>/auth.db (+ sidecars) → <data>/auth.db
//   ./.aio-tls/*                              → <data>/tls/
//   ./.aio/log/*                              → <logs>/

import { basename, join } from "@std/path";
import type { AppDirs } from "./app-dirs.ts";
import { ensureAppDirs } from "./app-dirs.ts";
import { isProcessAlive, readLock } from "./single-instance-lock.ts";

export type MoveOutcome = "moved" | "skipped-exists" | "failed";

export type Move = {
  from: string;
  to: string;
  outcome: MoveOutcome;
  error?: string;
};

const exists = (p: string): boolean => {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Move one file. Rename first (atomic, same filesystem); across devices copy →
 *  verify → unlink, which fails safe: the original is only removed once the copy
 *  is byte-count identical. */
function moveFile(from: string, to: string): Move {
  if (!exists(from)) return { from, to, outcome: "skipped-exists" };
  if (exists(to)) return { from, to, outcome: "skipped-exists" };
  // An earlier death's torn copy (see the copy below): never valid.
  const partial = `${to}.partial`;
  if (exists(partial)) {
    try {
      Deno.removeSync(partial);
    } catch (e) {
      return {
        from,
        to,
        outcome: "failed",
        error: `could not clear an interrupted copy at ${partial} (${
          e instanceof Error ? e.message : String(e)
        }) — original left in place`,
      };
    }
  }
  try {
    Deno.renameSync(from, to);
    return { from, to, outcome: "moved" };
  } catch {
    // Cross-device (EXDEV) or a platform that refuses the rename.
    // The copy is written under a temporary name and takes `to` with ONE
    // rename, once whole and durable. Copied straight onto `to`, a death
    // mid-copy left a torn target beside the intact original — and the next
    // boot, finding `to` there, KEPT the original and opened the torn copy.
    try {
      const src = Deno.statSync(from);
      const size = src.size;
      Deno.copyFileSync(from, partial);
      // The copy keeps the source's times, as a rename would. With a NEW
      // mtime, a `-wal` stranded by a death after this copy was always read
      // as belonging to a database "written since" (`finishDatabaseMove`) —
      // refused, with a reason that was not true.
      if (src.mtime) {
        try {
          Deno.utimeSync(partial, src.atime ?? src.mtime, src.mtime);
        } catch {
          // aio-ok: the copy itself is whole (checked below); only a WAL
          // stranded after it loses its proof of age, and that is refused
          // and reported as FAILED by `finishDatabaseMove`, never applied.
        }
      }
      if (Deno.statSync(partial).size !== size) {
        // Copy is short — remove it, keep the original.
        try {
          Deno.removeSync(partial);
        } catch { /* aio-ok: never installed; the next move clears it */ }
        return {
          from,
          to,
          outcome: "failed",
          error: "copy size mismatch — original left in place",
        };
      }
      const f = Deno.openSync(partial, { read: true, write: true });
      try {
        f.syncDataSync(); // durable before the name makes it the database
      } finally {
        f.close();
      }
      Deno.renameSync(partial, to);
      Deno.removeSync(from);
      return { from, to, outcome: "moved" };
    } catch (e) {
      return {
        from,
        to,
        outcome: "failed",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

/** The record of a database move in progress: which file `to` is being moved
 *  FROM. It is the only proof that a WAL left behind at `<from>-wal` belongs
 *  to `to` — see {@linkcode finishDatabaseMove}. */
export const movingRecordFor = (to: string): string => `${to}.moving`;

/** The `from` a move record names, or null (absent, or torn — a torn record
 *  proves nothing, which is the safe direction). */
function readMovingRecord(to: string): string | null {
  try {
    const from = (JSON.parse(Deno.readTextFileSync(movingRecordFor(to))) as {
      from?: unknown;
    }).from;
    return typeof from === "string" ? from : null;
  } catch {
    // aio-ok: absent or torn — no proof; a stranded WAL is then refused, said.
    return null;
  }
}

/** Remove the move record; a record that cannot be removed is reported as a
 *  failed move of its own (it would keep vouching for a WAL at `from`). */
function dropMovingRecord(to: string): Move[] {
  const record = movingRecordFor(to);
  try {
    Deno.removeSync(record);
    return [];
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    return [{
      from: record,
      to: record,
      outcome: "failed",
      error: `could not remove the finished move's record (${
        e instanceof Error ? e.message : String(e)
      }) — delete it by hand`,
    }];
  }
}

/** A SQLite file plus the WAL sidecars it cannot be separated from. */
function moveDatabase(from: string, to: string): Move[] {
  if (!exists(from) || exists(to)) return [moveFile(from, to)];
  // Recorded BEFORE the first rename, and durable: a death between the
  // database and its WAL is finished by the next boot only under it.
  try {
    const f = Deno.openSync(movingRecordFor(to), {
      write: true,
      create: true,
      truncate: true,
      mode: 0o600,
    });
    try {
      f.writeSync(new TextEncoder().encode(JSON.stringify({ from })));
      f.syncDataSync();
    } finally {
      f.close();
    }
  } catch (e) {
    return [{
      from,
      to,
      outcome: "failed",
      error: `could not record the move at ${movingRecordFor(to)} (${
        e instanceof Error ? e.message : String(e)
      }) — nothing was moved`,
    }];
  }
  const out: Move[] = [moveFile(from, to)];
  if (out[0]!.outcome !== "moved") {
    return [...out, ...dropMovingRecord(to)]; // don't strand sidecars
  }
  for (const suffix of ["-wal", "-shm"]) {
    if (exists(from + suffix)) out.push(moveFile(from + suffix, to + suffix));
  }
  // A sidecar that did not move keeps the record: the next boot retries it.
  return out.every((m) => m.outcome === "moved")
    ? [...out, ...dropMovingRecord(to)]
    : out;
}

/** Modification time, or NaN where the platform has none — every comparison
 *  with NaN is false, so "provably older" can never be concluded from it. */
const mtimeOf = (p: string): number => Deno.statSync(p).mtime?.getTime() ?? NaN;

/** Finish a `moveDatabase` that died between the database and its WAL.
 *
 *  The database is renamed first, its `-wal` second. A death between the two
 *  left the WAL — the committed frames of a crash-left database — in the old
 *  directory, and nothing ever looked again: the legacy database was gone, so
 *  there was "nothing legacy left", and the moved database opened WITHOUT its
 *  WAL. Every write since its last checkpoint was lost, silently.
 *
 *  The WAL is carried over only while the moved database is provably the one
 *  it belongs to: the move's own record ({@linkcode movingRecordFor}) says
 *  `to` was moved from `from`, it has no WAL of its own, and it was not
 *  modified after the stranded WAL was last written (a database opened and
 *  checkpointed since is newer, and a foreign WAL replayed over it would
 *  corrupt it). Without the record, a `<from>-wal` with no `from` beside it
 *  proves nothing — a legacy database KEPT because the new layout was
 *  already live, then deleted by hand, leaves exactly that, and it belongs to
 *  another database. Anything else is reported as FAILED, loudly, and left
 *  exactly where it is. */
function finishDatabaseMove(from: string, to: string): Move[] {
  if (exists(from) || !exists(to)) return [];
  const recorded = readMovingRecord(to) === from;
  if (!exists(from + "-wal")) {
    // The move finished and died before dropping its record: drop it now (a
    // leftover -shm is an index SQLite rebuilds — it goes with the move).
    if (!recorded) return [];
    const out = exists(from + "-shm") && !exists(to + "-shm")
      ? [moveFile(from + "-shm", to + "-shm")]
      : [];
    return [...out, ...dropMovingRecord(to)];
  }
  const wal = { from: from + "-wal", to: to + "-wal" };
  if (!recorded) {
    return [{
      ...wal,
      outcome: "failed",
      error: `a WAL is left at ${wal.from} with no database beside it, and ` +
        `nothing records that ${to} was moved from ${from} — it may belong ` +
        `to another database (a kept ${basename(from)} deleted by hand), so ` +
        `it was NOT applied to ${to}. Keep it for a recovery tool, or delete ` +
        `it if that database is gone for good`,
    }];
  }
  if (exists(wal.to) || !(mtimeOf(to) <= mtimeOf(wal.from))) {
    return [{
      ...wal,
      outcome: "failed",
      error: `a WAL was left behind by an interrupted move, but ${to} has ` +
        `been written since — it was NOT applied (it could corrupt the ` +
        `database). It may hold writes missing from ${to}; keep it for a ` +
        `recovery tool`,
    }];
  }
  const out = [moveFile(wal.from, wal.to)];
  if (out[0]!.outcome === "moved" && exists(from + "-shm")) {
    out.push(moveFile(from + "-shm", to + "-shm"));
  }
  return out.every((m) => m.outcome === "moved")
    ? [...out, ...dropMovingRecord(to)]
    : out;
}

/** The journal plus its `.wm` watermark side file (written by builds from
 *  before the watermark moved into the store). Leaving the `.wm` behind made
 *  the moved journal look entirely unapplied, so every action already in the
 *  snapshot was replayed a second time — a deposit counted twice. The
 *  watermark moves FIRST: a watermark without its journal replays nothing,
 *  while a journal without its watermark replays everything. */
function moveJournal(from: string, to: string): Move[] {
  if (!exists(from)) return [];
  const out: Move[] = [];
  if (exists(from + ".wm")) {
    const wm = moveFile(from + ".wm", to + ".wm");
    out.push(wm);
    if (wm.outcome === "failed") return out; // keep the pair together
  }
  out.push(moveFile(from, to));
  return out;
}

/** Move every entry of a directory, then remove the directory if it emptied. */
function moveDirContents(fromDir: string, toDir: string): Move[] {
  const out: Move[] = [];
  if (!exists(fromDir)) return out;
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(fromDir)];
  } catch {
    return out;
  }
  Deno.mkdirSync(toDir, { recursive: true });
  for (const e of entries) {
    if (!e.isFile) continue; // nested dirs aren't part of any legacy layout
    out.push(moveFile(join(fromDir, e.name), join(toDir, e.name)));
  }
  if (out.every((m) => m.outcome === "moved")) {
    try {
      Deno.removeSync(fromDir);
    } catch { /* not empty (nested dirs) — harmless to leave */ }
  }
  return out;
}

export type MigrateResult = {
  /** Empty when there was nothing to do. */
  moves: Move[];
  /** Set when migration was refused outright (app running). */
  refused?: string;
};

/** Relocate a legacy layout into `dirs`. Idempotent: with nothing legacy left
 *  (or a target already populated) it does nothing and returns no moves. */
export function migrateLegacyLayout(opts: {
  appId: string;
  dirs: AppDirs;
  /** Where the legacy relative paths were rooted (normally `Deno.cwd()`). */
  cwd: string;
  /** Legacy XDG dir that held auth.db (`~/.local/share/<appId>`). */
  legacyXdgDir: string;
}): MigrateResult {
  const { appId, dirs, cwd, legacyXdgDir } = opts;

  const legacyDb = join(cwd, "data.db");
  const legacyJournal = legacyDb + ".journal";
  const legacyAuth = join(legacyXdgDir, "auth.db");
  const legacyTls = join(cwd, ".aio-tls");
  const legacyLogs = join(cwd, ".aio", "log");

  const anything = [
    legacyDb,
    legacyDb + "-wal", // stranded by an interrupted move (finishDatabaseMove)
    legacyJournal,
    legacyAuth,
    legacyAuth + "-wal",
    legacyTls,
    legacyLogs,
    // A move that died after its last rename leaves only its record.
    movingRecordFor(dirs.stateDb),
    movingRecordFor(dirs.authDb),
  ].some(exists);
  if (!anything) return { moves: [] };

  // A live instance holds these databases open — moving them under a running
  // writer is how you get a half-written state file and a very confused app.
  const lock = readLock(appId);
  if (lock && isProcessAlive(lock.pid)) {
    return {
      moves: [],
      refused:
        `app "${appId}" is running (pid ${lock.pid}) — stop it and start again ` +
        `to move its data into ${dirs.home}`,
    };
  }

  ensureAppDirs(dirs);
  const moves: Move[] = [
    ...finishDatabaseMove(legacyDb, dirs.stateDb),
    ...finishDatabaseMove(legacyAuth, dirs.authDb),
    ...moveDatabase(legacyDb, dirs.stateDb),
    ...moveJournal(legacyJournal, dirs.journal),
    ...moveDatabase(legacyAuth, dirs.authDb),
    ...moveDirContents(legacyTls, dirs.tls),
    ...moveDirContents(legacyLogs, dirs.logs),
  ].filter((m) => m.outcome !== "skipped-exists" || exists(m.from));

  return { moves };
}

/** One line per move, plus a heading — the developer must be able to see exactly
 *  where their data went, once, without turning on verbose logging. */
export function describeMigration(
  result: MigrateResult,
  dirs: AppDirs,
): string[] {
  if (result.refused) return [`data: migration skipped — ${result.refused}`];
  const moved = result.moves.filter((m) => m.outcome === "moved");
  const failed = result.moves.filter((m) => m.outcome === "failed");
  const kept = result.moves.filter((m) => m.outcome === "skipped-exists");
  const lines: string[] = [];
  if (moved.length > 0) {
    lines.push(`data: moved into ${dirs.home} (one dir = one backup):`);
    for (const m of moved) lines.push(`data:   ${m.from} → ${m.to}`);
  }
  for (const m of kept) {
    lines.push(
      `data: kept ${m.from} — ${m.to} already exists (nothing was overwritten)`,
    );
  }
  for (const m of failed) {
    lines.push(`data: FAILED ${basename(m.from)} — ${m.error}`);
  }
  if (moved.length > 0) {
    lines.push(
      `data: back up ${dirs.data} — everything outside it is disposable`,
    );
  }
  return lines;
}
