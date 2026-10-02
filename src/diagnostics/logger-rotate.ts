// logger-rotate.ts — Log file rotation and cleanup on startup

import { basename, dirname } from "@std/path";
import { log } from "./logger-api.ts";
import { moveFile } from "./rename-over.ts";

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

/** Exported so the ONE list of log files has one decider: the mid-run budget
 *  pass (`logger-core`) needs to weigh exactly the files this policy governs,
 *  and a second hand-kept copy of the list is how `client.log` was forgotten
 *  by rotation in the first place. */
export const KINDS: LogKind[] = [
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

/** The file two starts meet on before either touches the previous run's logs:
 *  OS-locked for the length of one on-start pass, and holding the pid of the
 *  process that last made one. */
export const START_CLAIM = ".rotate";

/** How long after one process's on-start pass another process's is skipped.
 *  The window to cover is the first start's way from its logger to its
 *  single-instance lock — measured at 70 ms on a desktop machine — after
 *  which a later start sees the lock and does not rotate at all. Wide enough
 *  for a slow, cold machine; short enough that a restart a few seconds later
 *  still archives the run before it. */
export const START_ONCE_MS = 3_000;

/** What {@linkcode oncePerStart} does with its claim file. */
export type ClaimFile = Pick<
  Deno.FsFile,
  "lock" | "read" | "stat" | "truncate" | "seek" | "write" | "close"
>;

const openClaim = (path: string): Promise<ClaimFile> =>
  Deno.open(path, { read: true, write: true, create: true, mode: 0o600 });

/** Run the on-start pass (`run`: rotate or wipe) ONCE for starts that overlap.
 *
 *  The logger starts before the single-instance lock is taken, so two launches
 *  at the same moment — a double double-click — both believed they were the
 *  only one and both rotated. Interleaved, one saw the live file, then the
 *  other's fresh `.1`, shifted that to `.2` and found the live file gone:
 *  `debug.log.2` with no `.1`. One after the other, the second archived the
 *  first's seconds-old files as "the previous run".
 *
 *  So the pass is serialised by an OS lock on {@linkcode START_CLAIM} (held
 *  only while it runs; a process that dies in it releases it), and a pass that
 *  ANOTHER process finished less than {@linkcode START_ONCE_MS} ago is not
 *  repeated: `skipped` is returned and this start appends to the live files,
 *  exactly as a start refused by the lock does. The same process starting
 *  again (a restart in place, a test's next run) always runs its pass.
 *
 *  A file system that cannot lock, or a directory the claim cannot be created
 *  in, runs the pass unserialised — what every start did before. */
export async function oncePerStart<T>(
  dir: string,
  run: () => Promise<T>,
  skipped: T,
  who: {
    pid?: number;
    now?: () => number;
    /** The claim file's opener — a test's seam for a file that fails. */
    open?: (path: string) => Promise<ClaimFile>;
  } = {},
): Promise<T> {
  const me = String(who.pid ?? Deno.pid);
  let f: ClaimFile;
  try {
    f = await (who.open ?? openClaim)(`${dir}/${START_CLAIM}`);
  } catch {
    return await run(); // aio-ok: no claim possible here — the pass still runs
  }
  try {
    try {
      await f.lock(true);
    } catch {
      // aio-ok: no OS locks on this file system — unserialised, as before.
    }
    // Through `f`: on Windows the lock keeps every other handle out.
    let last = "";
    let at: number | undefined;
    try {
      const buf = new Uint8Array(32);
      last = new TextDecoder().decode(buf.subarray(0, await f.read(buf) ?? 0));
      at = (await f.stat()).mtime?.getTime();
    } catch {
      // aio-ok: an unreadable claim is no claim — the pass runs, as before.
    }
    // A claim "from the future" (a clock that stepped back) is not recent.
    const age = at === undefined ? Infinity : (who.now?.() ?? Date.now()) - at;
    if (last !== "" && last !== me && age >= 0 && age < START_ONCE_MS) {
      return skipped;
    }
    const out = await run();
    try {
      await f.truncate(0);
      await f.seek(0, Deno.SeekMode.Start);
      await f.write(new TextEncoder().encode(me));
    } catch {
      // aio-ok: the pass ran; unrecorded, an overlapping start repeats it —
      // what every start did before. Never a reason for the logger to fail.
    }
    return out;
  } finally {
    f.close();
  }
}

/** Rotate existing logs on start — used with `backupLogs: true`.
 *
 *  `.1` is the file that was live when this start rotated, and indices only
 *  grow older: archives shift up (`.n` → `.n+1`) before the live file becomes
 *  `.1`, and anything that would fall past `keep` is removed first. `keep: 0` =
 *  unlimited. One file is usually one run — not always: a start less than
 *  {@linkcode START_ONCE_MS} after another process rotated does not rotate
 *  again (see {@linkcode oncePerStart}), so runs started that close together
 *  share a file, each line carrying its own time.
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
  warn?: (msg: string) => void,
): Promise<LogKind[]> {
  const rotated: LogKind[] = [];
  for (const kind of KINDS) {
    if (await rotateFile(pathFn(kind), keep, warn)) rotated.push(kind);
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
export async function rotateFile(
  base: string,
  keep: number,
  /** Told when an archive could not be moved (never for one that is simply
   *  not there): the run still starts, and appends to the file left behind. */
  warn: (msg: string) => void = (m) => log.warn("logger", m),
): Promise<boolean> {
  const notMoved = (from: string, e: unknown) => {
    if (e instanceof Deno.errors.NotFound) return;
    warn(
      `${from} was not archived (${
        e instanceof Error ? e.message : String(e)
      }) — this run's lines are appended to it`,
    );
  };
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
      await moveFile(`${base}.${i}`, `${base}.${i + 1}`);
    } catch (e) {
      notMoved(`${base}.${i}`, e); // never a boot error — but said
    }
  }
  try {
    await moveFile(base, `${base}.1`);
    return true;
  } catch (e) {
    notMoved(base, e);
    return false;
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
      if (e.name === START_CLAIM) continue; // a few bytes, and not a log
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
