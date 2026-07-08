// logger-rotate.ts — Log file rotation and cleanup on startup

type LogKind = "app" | "debug" | "error" | "warning" | "perf";

const KINDS: LogKind[] = ["app", "debug", "error", "warning", "perf"];

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
