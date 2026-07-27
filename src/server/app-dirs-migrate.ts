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
//   • refuse entirely while another instance is running — it holds the database
//     open and would write to a file we just moved
//   • say what moved, per file, once
//
// Legacy layout (see docs/specs/2026-07-26-data-dir-and-updates.md):
//   ./data.db (+ -wal/-shm/.journal)          → <data>/state.db (+ sidecars)
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
  try {
    Deno.renameSync(from, to);
    return { from, to, outcome: "moved" };
  } catch {
    // Cross-device (EXDEV) or a platform that refuses the rename.
    try {
      const size = Deno.statSync(from).size;
      Deno.copyFileSync(from, to);
      if (Deno.statSync(to).size !== size) {
        // Copy is short — remove the partial target, keep the original.
        try {
          Deno.removeSync(to);
        } catch { /* leave it; the original is what matters */ }
        return {
          from,
          to,
          outcome: "failed",
          error: "copy size mismatch — original left in place",
        };
      }
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

/** A SQLite file plus the WAL sidecars it cannot be separated from. */
function moveDatabase(from: string, to: string): Move[] {
  const out: Move[] = [moveFile(from, to)];
  if (out[0]!.outcome !== "moved") return out; // don't strand sidecars
  for (const suffix of ["-wal", "-shm"]) {
    if (exists(from + suffix)) out.push(moveFile(from + suffix, to + suffix));
  }
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

  const anything = [legacyDb, legacyJournal, legacyAuth, legacyTls, legacyLogs]
    .some(exists);
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
    ...moveDatabase(legacyDb, dirs.stateDb),
    ...(exists(legacyJournal) ? [moveFile(legacyJournal, dirs.journal)] : []),
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
