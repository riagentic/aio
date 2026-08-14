// logger-rotate.ts — Log file rotation and cleanup on startup

import { basename, dirname } from "@std/path";

/** Every log file the on-start policy governs. `client` is `client.log` —
 *  forwarded browser/Electron console output (`src/server/client-log.ts`),
 *  which shares this directory (see `AioLogger.logDir`).
 *
 *  It was NOT in this list, and nothing else rotated it either: `client-log.ts`
 *  shipped a complete, documented `rotateClientLog()` that no code ever called.
 *  So every other log was wiped (or rotated) on start while `client.log` was
 *  appended to forever, across every restart, for the life of the app —
 *  unbounded disk growth on exactly the file a chatty browser console fills
 *  fastest. Listing it here puts it under the ONE policy the others already
 *  obey, instead of giving it a second rotation of its own. */
export type LogKind =
  | "app"
  | "debug"
  | "error"
  | "warning"
  | "perf"
  | "client";

const KINDS: LogKind[] = [
  "app",
  "debug",
  "error",
  "warning",
  "perf",
  "client",
];

/** How many archives `backupLogs` keeps by default. Exported because `am`
 *  rotates `stdout.log` under the SAME policy (it owns that file's fd — see
 *  `rotateFile`'s note), and two different depths for one log directory would
 *  be a second decider. */
export const DEFAULT_BACKUP_KEEP = 7;

/** Default ceiling for the whole log directory, in bytes (200 MB).
 *
 *  Retention is on by default, and nothing rotates a log MID-run: `app.log`,
 *  `debug.log` and (worst) `client.log` grow unbounded until the next boot. So
 *  "keep the last 8 runs" without a byte bound is "keep 8× unbounded" — the
 *  slow disk leak that makes a good default a bad one. `logBudget` is the hard
 *  answer to how much disk logs may take. */
export const DEFAULT_LOG_BUDGET = 200 * 1024 * 1024;

/** Wipe all log files — clean slate for new run (`backupLogs: false`).
 *
 *  Including the `<base>.<n>` archives. Wiping only the live files left every
 *  archive a previous `backupLogs` run had made sitting there forever: turning
 *  the option OFF stopped new ones appearing but never removed the old, so
 *  "clean slate" quietly meant "clean slate plus whatever you accumulated
 *  before". A wipe that leaves files behind is the wrong shape of promise. */
export async function wipeOnStart(
  pathFn: (kind: LogKind) => string,
): Promise<void> {
  for (const kind of KINDS) await wipeFile(pathFn(kind));
}

/** Wipe ONE log base and its archives. */
export async function wipeFile(base: string): Promise<void> {
  try {
    await Deno.remove(base);
  } catch { /* absent — fine */ }
  for (const n of await archiveIndices(base)) {
    try {
      await Deno.remove(`${base}.${n}`);
    } catch { /* raced with another wipe — fine */ }
  }
}

/** Every existing `<base>.<n>` archive index, ascending.
 *
 *  Read from the directory rather than probed by counting upward: the indices
 *  a previous build left behind can have gaps, and a scan that stops at the
 *  first gap silently ignores everything above it — which is how orphans
 *  outlived `backupKeep` forever. */
async function archiveIndices(base: string): Promise<number[]> {
  const dir = dirname(base);
  const name = basename(base);
  const out: number[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile && !e.isSymlink) continue;
      if (!e.name.startsWith(name + ".")) continue;
      const tail = e.name.slice(name.length + 1);
      if (!/^\d+$/.test(tail)) continue;
      out.push(Number(tail));
    }
  } catch { /* directory missing — nothing to rotate */ }
  return out.sort((a, b) => a - b);
}

/** Rotate existing logs on start — used with `backupLogs: true`.
 *
 *  `.1` is ALWAYS the run that just ended, and indices only grow older:
 *  archives shift up (`.n` → `.n+1`) before the live file becomes `.1`, and
 *  anything that would fall past `keep` is removed first. `keep: 0` = unlimited.
 *
 *  It used to pick the target slot by scanning for the first FREE index and
 *  then prune upward from `.1`. That inverts the moment the first prune frees a
 *  low slot: the next run's log lands in `.1` — BELOW every older archive — and
 *  the following prune, which deletes from the bottom, throws away the newest
 *  log while keeping the ones it was meant to age out. With `backupKeep: 2` the
 *  fifth restart deleted the fourth run's log and kept the third's. "Keep
 *  previous logs" must never be the thing that deletes the log you restarted to
 *  capture. */
export async function rotateOnStart(
  pathFn: (kind: LogKind) => string,
  keep: number,
): Promise<LogKind[]> {
  const rotated: LogKind[] = [];
  for (const kind of KINDS) {
    if (await rotateFile(pathFn(kind), keep)) rotated.push(kind);
  }
  return rotated;
}

/** Rotate ONE log base: `<base>` → `<base>.1`, archives shift up, past `keep`
 *  is removed. `keep: 0` = unlimited.
 *
 *  Exported because `stdout.log` cannot be rotated by the logger: the shell
 *  redirect that creates it (`am start`) holds an open fd, and renaming a file
 *  out from under an open fd takes the writer WITH it — every line of the run
 *  would land in `stdout.log.1`. It is rotated by `am`, BEFORE the spawn, by
 *  this same function.
 *
 *  Returns whether anything was actually archived — the caller says so out loud
 *  (`.katana/_aio.md`: a default whose effect is only observable at runtime must
 *  never change silently), and "nothing to rotate" must not produce that line. */
export async function rotateFile(base: string, keep: number): Promise<boolean> {
  try {
    await Deno.stat(base);
  } catch {
    return false;
  }

  const existing = await archiveIndices(base);
  // Survivors are the ones still inside the bound AFTER the shift: `.1` is
  // about to be taken by the current file, so an archive at `.i` may stay
  // only if `i + 1 <= keep`.
  const survives = (i: number) => keep <= 0 || i + 1 <= keep;
  for (const i of existing) {
    if (survives(i)) continue;
    try {
      await Deno.remove(`${base}.${i}`);
    } catch { /* already gone */ }
  }
  // Shift downward-index-first from the top so nothing overwrites a file
  // that has not moved yet.
  for (const i of existing.filter(survives).reverse()) {
    try {
      await Deno.rename(`${base}.${i}`, `${base}.${i + 1}`);
    } catch { /* best-effort */ }
  }
  try {
    await Deno.rename(base, `${base}.1`);
    return true;
  } catch {
    return false; // best-effort — a log that cannot be archived is not a boot error
  }
}

/** What a budget pass did. Reported, never silent: a cap that quietly deletes
 *  the log you came to read is the same failure as a cap that quietly doesn't
 *  exist. */
export type BudgetReport = {
  /** Archive file names removed, oldest run first. */
  removed: string[];
  /** Bytes freed by those removals. */
  freed: number;
  /** Bytes still in the directory afterwards. */
  total: number;
  /** Bytes in files that CANNOT be evicted (the live logs of this run, plus
   *  `checkpoint.json` / `actions.jsonl`, which share the directory). */
  live: number;
  /** True when the live files alone exceed the budget — nothing left to evict
   *  and the directory is still over. The caller warns. */
  over: boolean;
};

/** Enforce a byte ceiling over the whole log directory, evicting archives
 *  oldest-run-first. Returns null when `budget <= 0` (unlimited).
 *
 *  Oldest-first means highest `.n` first, ACROSS kinds: every kind rotates in
 *  the same boot, so `app.log.3` and `client.log.3` are the same run, and a
 *  budget that dropped one and kept the other would leave a run whose logs
 *  half-exist — the worst thing to hand someone debugging it.
 *
 *  Live files are counted but never removed: `stdout.log` is being written
 *  through an fd `am`'s shell still holds (unlinking it does not stop the
 *  writer, it only makes the output unreachable), and the logger's own live
 *  files are this run's evidence. */
export async function enforceBudget(
  dir: string,
  budget: number,
): Promise<BudgetReport | null> {
  if (budget <= 0) return null;
  type Entry = { name: string; size: number; idx: number | null };
  const entries: Entry[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile && !e.isSymlink) continue;
      let size = 0;
      try {
        size = (await Deno.stat(`${dir}/${e.name}`)).size;
      } catch {
        /* vanished mid-scan — treat as gone */ continue;
      }
      const m = e.name.match(/\.(\d+)$/);
      entries.push({ name: e.name, size, idx: m ? Number(m[1]) : null });
    }
  } catch {
    return null; // no directory — nothing to bound
  }

  let total = entries.reduce((n, e) => n + e.size, 0);
  const live = entries.filter((e) => e.idx === null).reduce(
    (n, e) => n + e.size,
    0,
  );
  const archives = entries.filter((e): e is Entry & { idx: number } =>
    e.idx !== null
  ).sort((a, b) => b.idx - a.idx || a.name.localeCompare(b.name));

  const removed: string[] = [];
  let freed = 0;
  for (const a of archives) {
    if (total <= budget) break;
    try {
      await Deno.remove(`${dir}/${a.name}`);
      removed.push(a.name);
      freed += a.size;
      total -= a.size;
    } catch {
      /* already gone — its bytes are gone too, recount is not worth it */
    }
  }
  return { removed, freed, total, live, over: total > budget };
}
