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

import { basename, dirname } from "@std/path";
import type { DB } from "../db/types.ts";
import { createDB } from "../db/async-db.ts";
import { syncDir, syncFile } from "../db/durable.ts";

/** How many `.corrupt-<timestamp>` copies are kept beside a database.
 *
 *  Quarantine never deletes the damaged file, which is right — but nothing
 *  pruned the copies either, so a disk that produces corruption repeatedly grew
 *  a full-size copy per boot, and `am backup` archived every one of them. The
 *  newest few are the ones a recovery tool can still use; older ones are copies
 *  of a database that has since been recovered past. */
export const QUARANTINE_KEEP = 3;

/** What the boot check did. `action: "none"` is the overwhelmingly common case. */
export interface IntegrityOutcome {
  action: "none" | "restored" | "quarantined" | "unavailable";
  /** Where the damaged file was moved, when it was. */
  quarantinedTo?: string;
  /** The snapshot restored from, when one was. */
  restoredFrom?: string;
  problems?: string[];
  /** Set when the check found the file DAMAGED and CLOSED the handle, but the
   *  damaged file could not be moved aside: the caller must not use the
   *  handle it passed in (closed), nor reopen the file (damaged) — it says
   *  why, for the refusal. */
  stuck?: string;
}

/** What this process's integrity checks did, by database path — only the
 *  recoveries (`restored` / `quarantined`).
 *
 *  The journal replay runs later in boot and must know that the database it
 *  replays onto is not the one the journal was written against: a restored
 *  snapshot is OLDER than the journal's tail, and replaying across that hole
 *  invents history (see `JournalGap` in journal.ts). The replay detects the
 *  hole from the watermarks alone; this is how its refusal can name the
 *  damaged copy it belongs with instead of a bare "the database went back in
 *  time". */
const _recoveries = new Map<string, IntegrityOutcome>();

/** Every recovery made in this process, keyed by database path. */
export function integrityRecoveries(): ReadonlyMap<string, IntegrityOutcome> {
  return _recoveries;
}

/** The conventional snapshot path for a database file. */
export function snapshotPathFor(dbPath: string): string {
  return `${dbPath}.snapshot`;
}

/** Where a verified copy of the snapshot waits to be installed over a
 *  quarantined database — present on disk only between the quarantine and the
 *  one rename that installs it. */
export function restoringPathFor(dbPath: string): string {
  return `${dbPath}.restoring`;
}

/** Where the copy is WRITTEN before it may take the {@linkcode restoringPathFor}
 *  name. `.restoring` is installed with no further check, so it must never be
 *  seen half-written: a death mid-copy leaves only this name, which nothing
 *  ever installs. */
function partialPathFor(dbPath: string): string {
  return `${restoringPathFor(dbPath)}.partial`;
}

/** Where a quarantine in progress records its target — present on disk only
 *  between the decision to quarantine and the last of its renames.
 *
 *  The damaged database and its `-wal`/`-shm` move in three renames, and a
 *  process can die between any two. Without a record the next boot saw half a
 *  set: a database at the live path whose WAL was already parked beside a
 *  quarantine copy that did not exist (every frame since the last checkpoint
 *  gone from it), or a WAL at the live path with no database — which SQLite
 *  replays over the next file opened there. With it,
 *  {@linkcode finishInterruptedRestore} finishes the move before anything
 *  opens the database, so every crash point ends with the set whole in ONE
 *  place. */
export function quarantiningPathFor(dbPath: string): string {
  return `${dbPath}.quarantining`;
}

/** The lock file that serializes recovery of one database across processes. */
export function recoveryLockPathFor(dbPath: string): string {
  return `${dbPath}.recovery-lock`;
}

/** Is a recovery artifact on disk — a staged copy, a torn one, or a
 *  quarantine in progress? Then even a boot that does not check integrity
 *  must take the lock before it finishes (or drops) one. */
export function recoveryPending(dbPath: string): boolean {
  return [
    restoringPathFor(dbPath),
    partialPathFor(dbPath),
    quarantiningPathFor(dbPath),
  ].some((p) => {
    try {
      Deno.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  });
}

/** Run `fn` holding an exclusive, cross-process lock on `dbPath`'s recovery.
 *
 *  `singleton: false` lets two instances share a data directory, and each
 *  runs the pre-open recovery (`finishInterruptedRestore`, then
 *  `checkAndRecover`) on the same files: B cleared the copy A was staging,
 *  dropped A's staged copy as "stale" beside the live database, and raced A's
 *  quarantine — one of them failed its install or started EMPTY. With the lock
 *  B waits, and then finds the database A already recovered.
 *
 *  An OS file lock (`flock` / `LockFileEx`): released when the holder closes
 *  it or dies, so a crash never leaves it stuck. A directory this process may
 *  not write to cannot be recovered either (the recovery's own writes fail,
 *  loudly), so there the lock is skipped rather than failing the boot. */
export async function withRecoveryLock<T>(
  dbPath: string,
  fn: () => Promise<T>,
  /** Said once when the lock is still held by another process after
   *  `waitNoticeMs` — a boot waiting on it must not look like a hang. */
  onWait?: (lockPath: string) => void,
  waitNoticeMs = 3_000,
): Promise<T> {
  let f: Deno.FsFile;
  try {
    f = await Deno.open(recoveryLockPathFor(dbPath), {
      read: true,
      write: true,
      create: true,
      mode: 0o600,
    });
  } catch (e) {
    if (
      e instanceof Deno.errors.PermissionDenied ||
      e instanceof Deno.errors.NotCapable ||
      (e as { code?: string }).code === "EROFS"
    ) return await fn();
    throw e;
  }
  try {
    const notice = onWait
      ? setTimeout(() => onWait(recoveryLockPathFor(dbPath)), waitNoticeMs)
      : undefined;
    try {
      await f.lock(true);
    } finally {
      clearTimeout(notice);
    }
    return await fn();
  } finally {
    f.close(); // releases the lock
  }
}

/** Write a small file so that it is on disk, whole, under its name: tmp →
 *  fsync → rename → fsync the directory. */
async function writeDurable(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, text, { mode: 0o600 });
  await syncFile(tmp);
  await Deno.rename(tmp, path);
  await syncDir(dirname(path));
}

type RecoverFs = {
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
};

/** Remove `-wal`/`-shm` left at the live path of a database that is no longer
 *  there: SQLite would replay them over whatever is installed next. */
async function removeLiveSidecars(dbPath: string, fs: RecoverFs) {
  for (const suffix of ["-wal", "-shm"]) {
    await fs.remove(dbPath + suffix).catch(() => {
      // aio-ok: it is normally already gone (moved, or never existed);
      // failing to remove it is reported by the snapshot check that follows.
    });
  }
}

/**
 * Finish a snapshot restore that a previous boot started and did not live to
 * complete. MUST run before the database is opened: opening creates an empty
 * file at the live path, which is exactly the outcome this exists to prevent.
 *
 * `checkAndRecover` stages a VERIFIED copy of the snapshot at
 * {@linkcode restoringPathFor} before it moves the damaged file, then installs
 * it with one rename. So on disk:
 *
 * - staged copy, no database → the previous boot died between the quarantine
 *   and the install: install it now, loudly.
 * - staged copy AND a database → it died before quarantining anything: drop
 *   the copy; the integrity check that follows finds the damage again and
 *   redoes the whole recovery.
 * - `.restoring.partial` → it died mid-copy: never installable, dropped.
 */
export async function finishInterruptedRestore(opts: {
  dbPath: string;
  log: { error: (msg: string) => void; warn: (msg: string) => void };
  fs?: RecoverFs;
}): Promise<IntegrityOutcome | null> {
  const fs = opts.fs ?? { rename: Deno.rename, remove: (p) => Deno.remove(p) };
  const staged = restoringPathFor(opts.dbPath);
  const present = (p: string) =>
    Deno.lstat(p).then(() => true, (e) => {
      // Not visible to this process ⇒ not staged by it either: staging needs
      // write access beside the database. A narrow `--allow-read` that names
      // only the database file must not turn this probe into a boot failure.
      if (
        e instanceof Deno.errors.NotFound ||
        e instanceof Deno.errors.PermissionDenied ||
        e instanceof Deno.errors.NotCapable
      ) return false;
      throw e;
    });
  // A copy that died before it was complete: never installable, and the
  // integrity check that follows redoes the recovery from the snapshot.
  const partial = partialPathFor(opts.dbPath);
  if (await present(partial)) {
    await fs.remove(partial);
    opts.log.warn(
      `db: removed ${partial} — a snapshot restore died while copying the ` +
        `snapshot; the integrity check redoes it`,
    );
  }
  // A quarantine the previous boot decided on and did not live to finish:
  // finish it — the set moves whole, or a WAL is split from its database.
  const quarantined = await finishInterruptedQuarantine(
    opts.dbPath,
    fs,
    opts.log,
    present,
  );
  if (!(await present(staged))) {
    if (!quarantined) return null;
    opts.log.error(
      `db: no verified snapshot copy was staged — starting EMPTY. The ` +
        `damaged database is kept at ${quarantined}.`,
    );
    const emptied: IntegrityOutcome = {
      action: "quarantined",
      quarantinedTo: quarantined,
    };
    _recoveries.set(opts.dbPath, emptied);
    return emptied;
  }
  if (await present(opts.dbPath)) {
    await fs.remove(staged);
    opts.log.warn(
      `db: removed ${staged} — a snapshot restore was interrupted before the ` +
        `damaged database was moved aside; the integrity check redoes it`,
    );
    return null;
  }
  await removeLiveSidecars(opts.dbPath, fs);
  await fs.rename(staged, opts.dbPath);
  const snapshot = snapshotPathFor(opts.dbPath);
  opts.log.error(
    `db: FINISHED an interrupted restore — the previous boot quarantined the ` +
      `damaged ${opts.dbPath} and stopped before installing the verified copy ` +
      `of ${snapshot}; it is installed now. Changes made AFTER that snapshot ` +
      `are not in it; the damaged original is beside it as ` +
      `${basename(opts.dbPath)}.corrupt-<time>.`,
  );
  const restored: IntegrityOutcome = {
    action: "restored",
    restoredFrom: snapshot,
    ...(quarantined ? { quarantinedTo: quarantined } : {}),
  };
  _recoveries.set(opts.dbPath, restored);
  return restored;
}

/** Finish the moves a {@linkcode quarantiningPathFor} record names: whatever
 *  of the damaged database, `-wal` and `-shm` is still at the live path joins
 *  what already moved. Returns the quarantine path, or null when no
 *  quarantine was in progress. Throws — refusing the boot — when the set
 *  cannot be made whole: opening the live path then could replay a WAL over
 *  the wrong file. */
async function finishInterruptedQuarantine(
  dbPath: string,
  fs: RecoverFs,
  log: { error: (msg: string) => void; warn: (msg: string) => void },
  present: (p: string) => Promise<boolean>,
): Promise<string | null> {
  const marker = quarantiningPathFor(dbPath);
  if (!(await present(marker))) {
    // A record torn before its rename: never valid, and nothing moved yet.
    if (await present(`${marker}.tmp`)) await fs.remove(`${marker}.tmp`);
    return null;
  }
  // The record names its target; one that does not name a quarantine copy
  // of THIS database (torn, or not ours) is replaced by a fresh name, said.
  let to: string | null = null;
  try {
    const t = (JSON.parse(await Deno.readTextFile(marker)) as { to?: unknown })
      .to;
    if (
      typeof t === "string" && dirname(t) === dirname(dbPath) &&
      basename(t).startsWith(`${basename(dbPath)}.corrupt-`)
    ) to = t;
  } catch {
    // aio-ok: an unreadable record is replaced below, and said.
  }
  if (to === null) {
    to = quarantinePathFor(dbPath);
    log.warn(
      `db: the quarantine record ${marker} is unreadable — moving what is ` +
        `left of the damaged database to ${to} instead`,
    );
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    if (!(await present(dbPath + suffix))) continue;
    if (await present(to + suffix)) {
      throw new Error(
        `db: an interrupted quarantine left ${dbPath + suffix} AND ` +
          `${to + suffix} — refusing to open the database, which would ` +
          `apply whichever WAL sits beside it. Keep both; move one aside by ` +
          `hand (the ${to} set is the damaged database).`,
      );
    }
    await fs.rename(dbPath + suffix, to + suffix);
  }
  await fs.remove(marker);
  log.error(
    `db: FINISHED an interrupted quarantine — the previous boot found ` +
      `${dbPath} damaged and stopped while moving it aside; it is kept, with ` +
      `its -wal/-shm, at ${to}.`,
  );
  return to;
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
  /** Injectable for tests: the problems with a snapshot file, or null when it
   *  is sound. Defaults to opening it readonly and running `quick_check`. */
  checkSnapshot?: (path: string) => Promise<string[] | null>;
  /** Injectable for tests. */
  fs?: {
    rename: (from: string, to: string) => Promise<void>;
    copyFile: (from: string, to: string) => Promise<void>;
    stat: (path: string) => Promise<{ size: number }>;
    remove: (path: string) => Promise<void>;
    /** fsync a file's data. Defaults to {@linkcode syncFile}. */
    sync?: (path: string) => Promise<void>;
  };
  now?: Date;
  /** How long a check refused with "database is locked" is retried before
   *  it is skipped (never read as damage). Default 5 s. */
  busyWaitMs?: number;
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
  // SQLITE_BUSY / SQLITE_LOCKED is ANOTHER CONNECTION'S write lock, not
  // damage: a second instance (`singleton: false`) booting while the first
  // writes a sound file got "could not run: database is locked" — read as
  // corruption, it quarantined the live database under the other instance
  // and restored an older snapshot over it. Waited for; a database that
  // stays locked is left alone, and said.
  const busyUntil = Date.now() + (opts.busyWaitMs ?? 5_000);
  const isBusy = (e: unknown) =>
    /database (?:table )?is locked|SQLITE_(?:BUSY|LOCKED)/i.test(
      e instanceof Error ? e.message : String(e),
    );
  let busy: unknown = null;
  let threw: unknown = null;
  let checked: { ok: boolean; problems: string[] } | null = null;
  for (;;) {
    try {
      checked = await opts.db.checkIntegrity();
      busy = null;
      break;
    } catch (e) {
      if (!isBusy(e)) {
        threw = e;
        busy = null;
        break;
      }
      busy = e;
      if (Date.now() >= busyUntil) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (busy !== null) {
    opts.log.warn(
      `db: could not check ${opts.dbPath} — it stayed locked by another ` +
        `connection (${
          busy instanceof Error ? busy.message : String(busy)
        }). A lock is not damage, so nothing was moved; this boot's ` +
        `integrity check is skipped.`,
    );
    return { action: "unavailable" };
  }
  if (checked) result = checked;
  else {
    // The check itself THREW: SQLite could not even scan the file (the classic
    // "database disk image is malformed"). That is not "inconclusive" — it is
    // corruption too severe to describe, and booting on it is the worst of the
    // available outcomes. Treat it exactly as a failed check.
    result = {
      ok: false,
      problems: [
        `integrity check could not run: ${
          threw instanceof Error ? threw.message : String(threw)
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
  const snapshot = snapshotPathFor(opts.dbPath);
  const staged = restoringPathFor(opts.dbPath);
  const partial = partialPathFor(opts.dbPath);
  const sync = opts.fs?.sync ?? syncFile;

  // THE RESTORE IS STAGED BEFORE THE DAMAGED FILE MOVES, and installed by ONE
  // rename.
  //
  // It used to quarantine first, then check the snapshot (a full
  // `quick_check`, seconds on a large file), then `copyFile` it onto the live
  // path. A process that died anywhere in that stretch — a SIGKILL, a power
  // cut, or simply a SIGTERM during boot, which exits at once because no
  // runtime is registered yet — left NO file at the live path. The next boot
  // opened a fresh empty database over it, passed its own integrity check,
  // and served an EMPTY app with a verified snapshot sitting beside it,
  // saying nothing (measured: `{n:42}` in the snapshot, `{n:0}` after the
  // reboot). The app's next rolling `db.snapshot()` then overwrote that
  // snapshot with the empty state, and the recovery was gone for good.
  //
  // Now the slow, fallible part (check + copy) happens while the damaged file
  // is still at the live path — a death there re-runs this whole recovery on
  // the next boot. What is left between the quarantine and the install is a
  // verified copy at `<db>.restoring`, which the next boot installs before it
  // opens anything (`finishInterruptedRestore`).
  //
  // The copy is written under a SECOND name, made durable, and only then
  // renamed to `.restoring`: that name is installed with no further check, so
  // a death mid-copy must never leave a torn file under it (and a power cut
  // after the renames must not leave a zero-length one at the live path).
  for (const p of [staged, partial]) {
    await fs.remove(p).catch(() => {
      // aio-ok: normally absent. A stale copy from an earlier death is what
      // this clears; failing to clear it fails the copy below, loudly.
    });
  }
  let stagedOk = false;
  let snapshotVerdict: string | null = null;
  /** Set when a verified snapshot could not be staged — see below. */
  let refusal: Error | undefined;
  try {
    const st = await fs.stat(snapshot);
    if (st.size > 0) {
      // The snapshot is CHECKED before it is installed. It was restored
      // unconditionally, so an app whose disk damaged both files booted on the
      // second corrupt one — and then quarantined THAT on the next boot, with
      // nothing left to come back to. A snapshot that does not pass
      // `quick_check` is not a recovery, and saying so is the whole point.
      const bad = opts.checkSnapshot
        ? await opts.checkSnapshot(snapshot)
        : await defaultCheckSnapshot(snapshot);
      if (bad) {
        snapshotVerdict =
          `db: the snapshot at ${snapshot} is ALSO damaged (${
            bad.slice(0, 3).join("; ")
          }) — it was NOT restored, and nothing was deleted. The damaged ` +
          `database is at ${quarantine} and the damaged snapshot is still ` +
          `at ${snapshot}; both are yours to try a recovery tool on. ` +
          `Starting EMPTY.`;
      } else {
        try {
          await fs.copyFile(snapshot, partial);
          await sync(partial);
          await fs.rename(partial, staged);
        } catch (e) {
          // A VERIFIED snapshot that cannot be staged (a full disk, most
          // often) is not "no snapshot": falling through started the app
          // EMPTY beside it, with the damaged database moved aside — and its
          // first rolling `db.snapshot()` then wrote that empty state over the
          // good one. Nothing has moved yet, so the boot is refused instead;
          // the next one redoes the whole recovery.
          for (const p of [partial, staged]) {
            await fs.remove(p).catch(() => {
              // aio-ok: a leftover partial is dropped by the next boot
              // (`finishInterruptedRestore`); never installable.
            });
          }
          throw refusal = new Error(
            `db: ${opts.dbPath} is damaged and its snapshot ${snapshot} ` +
              `passed the check, but the snapshot could not be copied into ` +
              `place (${e instanceof Error ? e.message : String(e)}) — ` +
              `refusing to boot. NOTHING was moved: the damaged database is ` +
              `still at ${opts.dbPath} and the snapshot at ${snapshot}. ` +
              `Free disk space (the copy needs the snapshot's size again) ` +
              `and restart; the recovery is redone from the start.`,
            { cause: e },
          );
        }
        stagedOk = true;
      }
    }
  } catch (e) {
    if (e === refusal) throw e;
    // Fall through to the empty start — but SAY why the snapshot was unusable.
    // "no usable snapshot" covered a missing file and an unreadable one with
    // the same sentence, and only one of those is the operator's fault.
    if (!(e instanceof Deno.errors.NotFound)) {
      snapshotVerdict = `db: snapshot ${snapshot} could not be restored — ${e}`;
    }
    for (const p of [partial, staged]) {
      await fs.remove(p).catch(() => {
        // aio-ok: normally never written; a leftover is dropped by the next
        // boot.
      });
    }
  }

  // The SIDECARS travel with it, and any leftover is removed after.
  //
  // Two problems, one cause: this moved `state.db` and left `-wal`/`-shm`
  // where they were. So the module's promise — "the damaged file kept at …,
  // nothing deleted", "a human still has every byte" — was not kept (a
  // crash-left WAL of committed frames was 8 KB before boot and 0 after,
  // because a failed open deletes it), and an orphaned WAL that DOES survive
  // is replayed by SQLite onto the restored snapshot: same lineage, quick
  // check ok, and the corrupt database's rows come back over the recovery.
  //
  // The three renames are one move: a RECORD of it is made durable first
  // (`quarantiningPathFor`), so a death between any two of them is finished by
  // the next boot before it opens anything — the set ends whole in one place.
  // The database moves first: the one rename that must succeed.
  const marker = quarantiningPathFor(opts.dbPath);
  const unavailable = async (what: string, e: unknown) => {
    // Nothing was installed, so the staged copy must not outlive this boot:
    // the next one would read it as a restore interrupted mid-install.
    await fs.remove(staged).catch(() => {
      // aio-ok: normally never written; a leftover is dropped by the next boot.
    });
    const stuck =
      `db: ${opts.dbPath} failed its integrity check (${
        problems.slice(0, 3).join("; ")
      }) and could not be moved aside — could not ${what}: ${
        e instanceof Error ? e.message : String(e)
      }. Nothing was moved; move ${opts.dbPath} (with its -wal/-shm) aside by ` +
      `hand, or fix what refused the move, and restart.`;
    opts.log.error(stuck);
    return { action: "unavailable", problems, stuck } as IntegrityOutcome;
  };
  try {
    await writeDurable(marker, JSON.stringify({ to: quarantine }));
  } catch (e) {
    await fs.remove(marker).catch(() => {
      // aio-ok: never written; a torn `.tmp` is dropped by the next boot.
    });
    return await unavailable("record the quarantine of the damaged file", e);
  }
  try {
    await fs.rename(opts.dbPath, quarantine);
  } catch (e) {
    await fs.remove(marker).catch(() => {
      // aio-ok: nothing moved; a record left behind finishes nothing.
    });
    return await unavailable("quarantine the damaged file", e);
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await fs.rename(opts.dbPath + suffix, quarantine + suffix);
    } catch (e) {
      // A sidecar that is not there is the ordinary case (a clean shutdown
      // checkpoints and removes them). Any other refusal leaves the record in
      // place — the next boot retries the move before it opens anything —
      // and refuses this one: the WAL left at the live path would otherwise
      // be removed below, or replayed over whatever is installed next.
      if (!(e instanceof Deno.errors.NotFound)) {
        throw new Error(
          `db: moved the damaged ${opts.dbPath} to ${quarantine} but could ` +
            `not move its ${suffix} (${e}) — refusing to boot; the next boot ` +
            `finishes the move before opening the database.`,
          { cause: e },
        );
      }
    }
  }
  // …and NOTHING of the old database is left at the live path. A `-wal` that
  // outlived the move is not a leftover, it is a replay: SQLite would apply it
  // over whatever is installed next.
  await removeLiveSidecars(opts.dbPath, fs);
  // The move is complete; the record goes BEFORE the install — left behind,
  // the next boot would move the INSTALLED copy aside as the damaged one.
  try {
    await fs.remove(marker);
  } catch (e) {
    throw new Error(
      `db: could not remove the quarantine record ${marker} (${e}) — ` +
        `refusing to boot before installing anything over ${opts.dbPath}.`,
      { cause: e },
    );
  }
  opts.log.error(
    `db: damaged file kept at ${quarantine} (with its -wal/-shm, if any) — ` +
      `nothing deleted`,
  );
  if (snapshotVerdict) opts.log.error(snapshotVerdict);

  if (stagedOk) {
    try {
      await fs.rename(staged, opts.dbPath); // the install: one atomic step
      opts.log.error(
        `db: restored from ${snapshot} — changes made AFTER that snapshot are ` +
          `not in it; the damaged original is at ${quarantine}`,
      );
      await pruneQuarantine(opts.dbPath, opts.log, fs);
      const restored: IntegrityOutcome = {
        action: "restored",
        quarantinedTo: quarantine,
        restoredFrom: snapshot,
        problems,
      };
      _recoveries.set(opts.dbPath, restored);
      return restored;
    } catch (e) {
      // Never fall through to the empty start from here: the caller would
      // open a fresh database at the live path, and the next boot would read
      // the staged copy as stale and drop it. Refuse the boot; the next one
      // installs the verified copy before it opens anything.
      throw new Error(
        `db: could not install the verified copy of ${snapshot} (${e}) — ` +
          `it is at ${staged}, and the next boot installs it before opening ` +
          `the database. The damaged original is at ${quarantine}.`,
        { cause: e },
      );
    }
  }

  opts.log.error(
    `db: no usable snapshot at ${snapshot} — starting EMPTY. Take rolling ` +
      `snapshots with db.snapshot(path) so the next time this happens there ` +
      `is something to come back to.`,
  );
  await pruneQuarantine(opts.dbPath, opts.log, fs);
  const emptied: IntegrityOutcome = {
    action: "quarantined",
    quarantinedTo: quarantine,
    problems,
  };
  _recoveries.set(opts.dbPath, emptied);
  return emptied;
}

/** `quick_check` a snapshot file without disturbing anything: opened readonly,
 *  closed again, and every failure to even open it counts as damage. Returns
 *  the problems, or null when the file is sound. */
async function defaultCheckSnapshot(path: string): Promise<string[] | null> {
  let db: DB | null = null;
  try {
    db = createDB(path, { readonly: true });
    const r = await db.checkIntegrity!();
    return r.ok ? null : r.problems;
  } catch (e) {
    return [
      `could not be opened: ${e instanceof Error ? e.message : String(e)}`,
    ];
  } finally {
    await db?.close().catch(() => {});
  }
}

/** Keep the {@linkcode QUARANTINE_KEEP} newest `.corrupt-<ts>` copies beside
 *  `dbPath` and remove the rest, saying which. Failure here is never fatal —
 *  a quarantine that could not be pruned is a full disk, not lost data. */
async function pruneQuarantine(
  dbPath: string,
  log: { warn: (m: string) => void; error: (m: string) => void },
  fs: { remove: (p: string) => Promise<void> },
): Promise<void> {
  try {
    // `dirname`/`basename`, not a split on "/": a Windows path has no "/", so
    // the split named the CWD as the db's folder and pruned the wrong files.
    const dir = dirname(dbPath);
    const base = basename(dbPath) + ".corrupt-";
    // Group by COPY, not by file. `moveSidecars` deliberately parks the
    // crash-left `-wal`/`-shm` beside each quarantined database, and all three
    // start with the same prefix — so counting files counted one copy as up to
    // three and `slice(0, n - 3)` kept the newest three FILES. Measured over
    // four successive corruptions: exactly ONE database copy survived, and the
    // log line said by name that three generations were kept. The copies it
    // deleted were the older ones, which are the ones a recovery tool wants,
    // and this module's header promises the file is "QUARANTINED, never
    // deleted … so a human (or a real recovery tool) still has every byte".
    const byCopy = new Map<string, string[]>();
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.startsWith(base)) continue;
      const rest = e.name.slice(base.length);
      // `<ts>`, `<ts>-wal`, `<ts>-shm` — the stamp is the copy's identity. A
      // journal the boot replay refused to run across the restore is parked
      // beside the copy it belongs with (`<ts>.journal`, `<ts>.journal.base`),
      // and goes with it.
      const stamp = rest.replace(/(?:-wal|-shm|\.journal(?:\.base)?)$/, "");
      const files = byCopy.get(stamp);
      if (files) files.push(e.name);
      else byCopy.set(stamp, [e.name]);
    }
    // The suffix is an ISO timestamp, so lexical order IS chronological order.
    const stamps = [...byCopy.keys()].sort();
    const stale = stamps.slice(0, Math.max(0, stamps.length - QUARANTINE_KEEP));
    for (const stamp of stale) {
      for (const name of byCopy.get(stamp)!) {
        await fs.remove(`${dir}/${name}`);
      }
      log.warn(
        `db: removed an old quarantined copy ${base}${stamp} — the ` +
          `${QUARANTINE_KEEP} most recent are kept. Copy one aside if you ` +
          `still want it.`,
      );
    }
  } catch (e) {
    log.warn(`db: could not prune old quarantined copies — ${e}`);
  }
}
