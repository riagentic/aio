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

/** Wipe all log files — clean slate for new run (default behavior).
 *
 *  Including the `<base>.<n>` archives. Wiping only the live files left every
 *  archive a previous `backupLogs` run had made sitting there forever: turning
 *  the option OFF stopped new ones appearing but never removed the old, so
 *  "clean slate" quietly meant "clean slate plus whatever you accumulated
 *  before". A wipe that leaves files behind is the wrong shape of promise. */
export async function wipeOnStart(
  pathFn: (kind: LogKind) => string,
): Promise<void> {
  for (const kind of KINDS) {
    const base = pathFn(kind);
    try {
      await Deno.remove(base);
    } catch { /* absent — fine */ }
    for (const n of await archiveIndices(base)) {
      try {
        await Deno.remove(`${base}.${n}`);
      } catch { /* raced with another wipe — fine */ }
    }
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
): Promise<void> {
  for (const kind of KINDS) {
    const base = pathFn(kind);
    try {
      await Deno.stat(base);
    } catch {
      continue;
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
    } catch { /* best-effort */ }
  }
}
