// logger-rotate.ts — Log file rotation and cleanup on startup

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

/** Wipe all log files — clean slate for new run (default behavior) */
export async function wipeOnStart(
  pathFn: (kind: LogKind) => string,
): Promise<void> {
  for (const kind of KINDS) {
    try {
      await Deno.remove(pathFn(kind));
    } catch { /* absent — fine */ }
  }
}

/** Rotate existing logs to .1, .2, etc. — used with backupLogs: true */
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

    let n = 1;
    while (true) {
      try {
        await Deno.stat(`${base}.${n}`);
        n++;
      } catch {
        break;
      }
    }

    try {
      await Deno.rename(base, `${base}.${n}`);
    } catch { /* best-effort */ }

    if (keep > 0) {
      for (let i = n - keep; i >= 1; i--) {
        try {
          await Deno.remove(`${base}.${i}`);
        } catch { /* already gone */ }
      }
    }
  }
}
