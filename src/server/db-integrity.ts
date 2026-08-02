// db-integrity.ts — boot-time integrity check, quarantine, and snapshot restore.
//
// An app that stores anything a user would miss eventually meets a corrupt
// SQLite file: a power cut mid-write, a full disk, a filesystem that lied about
// fsync, a USB drive pulled. SQLite itself is careful, but "careful" is not
// "never", and the failure mode is the worst one — the app boots, the file is
// unreadable in places, and it either crashes on a query nobody expected to
// fail or quietly serves half the data.
//
// Every app that persists user data eventually writes this ~150 lines by hand
// (one field report did, and rated it their strongest remaining ask). It
// belongs in the framework that owns the file.
//
// The policy is deliberately conservative — a recovery step that loses data is
// worse than the corruption it answers:
//
// 1. `PRAGMA quick_check` on boot. Sound file → nothing happens, nothing logged.
// 2. Damaged → the file is QUARANTINED, never deleted. It is renamed beside
// itself with a timestamp, so a human (or a real recovery tool) still has
// every byte.
// 3. If a snapshot sits beside it, it is restored and the app boots on it.
// Otherwise the app starts empty — and says so, loudly, both times.
//
// Nothing here is automatic-and-silent: each branch reports what it did to the
// user's data and where the old bytes went.

import type { DB } from "../db/types.ts";

/** What the boot check did. `action: "none"` is the overwhelmingly common case. */
export interface IntegrityOutcome {
  action: "none" | "restored" | "quarantined" | "unavailable";
  /** Where the damaged file was moved, when it was. */
  quarantinedTo?: string;
  /** The snapshot restored from, when one was. */
  restoredFrom?: string;
  problems?: string[];
}

/** The conventional snapshot path for a database file. */
export function snapshotPathFor(dbPath: string): string {
  return `${dbPath}.snapshot`;
}

/** Timestamped quarantine path — never overwrites an earlier casualty. */
export function quarantinePathFor(dbPath: string, now = new Date()): string {
  return `${dbPath}.corrupt-${now.toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Check the open database and, if it is damaged, quarantine it and restore
 * from a snapshot when one exists.
 *
 * The caller must CLOSE the returned-on database and reopen it when the action
 * is anything but `"none"` — the file underneath has been replaced.
 */
export async function checkAndRecover(opts: {
  db: DB;
  dbPath: string;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  /** Injectable for tests. */
  fs?: {
    rename: (from: string, to: string) => Promise<void>;
    copyFile: (from: string, to: string) => Promise<void>;
    stat: (path: string) => Promise<{ size: number }>;
    remove: (path: string) => Promise<void>;
  };
  now?: Date;
}): Promise<IntegrityOutcome> {
  const fs = opts.fs ?? {
    rename: Deno.rename,
    copyFile: Deno.copyFile,
    stat: async (p: string) => ({ size: (await Deno.stat(p)).size }),
    remove: (p: string) => Deno.remove(p),
  };

  // No such member: a custom `DB` implementation that cannot be checked. There
  // is nothing to conclude, so nothing is done.
  if (!opts.db.checkIntegrity) return { action: "unavailable" };

  let result: { ok: boolean; problems: string[] };
  try {
    result = await opts.db.checkIntegrity();
  } catch (e) {
    // The check itself THREW: SQLite could not even scan the file (the classic
    // "database disk image is malformed"). That is not "inconclusive" — it is
    // corruption too severe to describe, and booting on it is the worst of the
    // available outcomes. Treat it exactly as a failed check.
    result = {
      ok: false,
      problems: [
        `integrity check could not run: ${
          e instanceof Error ? e.message : String(e)
        }`,
      ],
    };
  }
  if (result.ok) return { action: "none" };

  const problems = result.problems;
  opts.log.error(
    `db: INTEGRITY CHECK FAILED for ${opts.dbPath} — ${
      problems.slice(0, 3).join("; ")
    }${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}`,
  );

  // The damaged file is closed before it is moved: an open handle on a renamed
  // file keeps writing into the quarantined copy on POSIX, and blocks the
  // rename outright on Windows.
  await opts.db.close().catch(() => {});

  const quarantine = quarantinePathFor(opts.dbPath, opts.now);
  try {
    await fs.rename(opts.dbPath, quarantine);
  } catch (e) {
    opts.log.error(
      `db: could not quarantine the damaged file (${
        e instanceof Error ? e.message : String(e)
      }) — refusing to touch it further; move ${opts.dbPath} aside by hand`,
    );
    return { action: "unavailable", problems };
  }
  opts.log.error(`db: damaged file kept at ${quarantine} — nothing deleted`);

  const snapshot = snapshotPathFor(opts.dbPath);
  try {
    const st = await fs.stat(snapshot);
    if (st.size > 0) {
      await fs.copyFile(snapshot, opts.dbPath);
      opts.log.error(
        `db: restored from ${snapshot} — changes made AFTER that snapshot are ` +
          `not in it; the damaged original is at ${quarantine}`,
      );
      return {
        action: "restored",
        quarantinedTo: quarantine,
        restoredFrom: snapshot,
        problems,
      };
    }
  } catch { /* no snapshot — fall through to the empty-start branch */ }

  opts.log.error(
    `db: no snapshot at ${snapshot} — starting EMPTY. Take rolling snapshots ` +
      `with db.snapshot(path) so the next time this happens there is ` +
      `something to come back to.`,
  );
  return { action: "quarantined", quarantinedTo: quarantine, problems };
}
