// Server-only module — Deno APIs, filesystem, subprocesses.
//
// The `.server.ts` suffix + a DYNAMIC import from the cell is the whole
// boundary: the build marks these imports external, so none of this reaches the
// browser bundle (docs/build/imports.md §2). Cell methods run on the server, so
// the import only ever executes there.
import { basename, join } from "@std/path";

export type Entry = { name: string; path: string; bytes: number };

/** What ONE scan is allowed to cost.
 *
 *  `long: ["open"]` in the cell removes the method timeout — the framework will
 *  wait for this walk as long as it takes. That makes an UNBOUNDED walk a real
 *  hazard rather than a slow one: the app used to kick a full recursive scan of
 *  `$HOME` from `onStart`, and aio's own boot gate boots this example on every
 *  `deno task test`. Measured on a developer's real home directory: a core
 *  saturated for 40 s of a 40 s run, and still going when the process was
 *  killed. "It runs as long as it needs" is a statement about the METHOD's
 *  deadline, never a licence to spend the machine.
 *
 *  So the walk carries its own budget and says when it hit it. A partial answer
 *  the user can see (and re-run) beats a complete one that never arrives. */
export type ScanLimits = {
  /** Stop after this many immediate children. */
  maxEntries: number;
  /** Stop after this much wall time, whole scan. */
  budgetMs: number;
  /** How deep a subtree is summed before it is treated as opaque. */
  maxDepth: number;
};

export const DEFAULT_LIMITS: ScanLimits = {
  maxEntries: 200,
  budgetMs: 3_000,
  maxDepth: 12,
};

/** A scan's answer, plus whether it is the WHOLE answer. `partial` is not a
 *  detail: showing capped numbers as if they were final is the kind of quiet
 *  lie this example exists to teach against. */
export type ScanResult = { entries: Entry[]; partial: boolean };

/** Size of one directory subtree, in bytes.
 *
 *  `signal` is threaded all the way down — cancellation is cooperative, and a
 *  scan that ignores the signal is a scan the user cannot stop. `deadline` is
 *  the same idea for time. Unreadable entries are skipped rather than fatal: a
 *  disk tool that dies on the first permission-denied is useless on a real
 *  machine.
 *
 *  Returns the bytes counted AND whether it stopped early, so the caller can
 *  say so instead of presenting a truncated number as a total. */
async function subtreeSize(
  path: string,
  signal: AbortSignal,
  deadline: number,
  limits: ScanLimits,
  depth = 0,
): Promise<{ bytes: number; partial: boolean }> {
  if (signal.aborted) return { bytes: 0, partial: true };
  if (depth > limits.maxDepth || Date.now() >= deadline) {
    return { bytes: 0, partial: true };
  }
  let total = 0;
  let partial = false;
  try {
    for await (const e of Deno.readDir(path)) {
      if (signal.aborted || Date.now() >= deadline) {
        return { bytes: total, partial: true };
      }
      const child = join(path, e.name);
      if (e.isSymlink) continue; // never follow — a loop is not a size
      if (e.isDirectory) {
        const r = await subtreeSize(child, signal, deadline, limits, depth + 1);
        total += r.bytes;
        partial ||= r.partial;
      } else if (e.isFile) {
        try {
          total += (await Deno.stat(child)).size;
        } catch { /* vanished or unreadable mid-walk */ }
      }
    }
  } catch { /* unreadable directory — report it as 0, keep going */ }
  return { bytes: total, partial };
}

/** Immediate children of `path`, largest first, within `limits`.
 *
 *  Long-running by nature — which is why the cell gives it a cancel path and a
 *  "scanning" flag — but never unbounded: see {@link ScanLimits}. */
export async function scanFolders(
  path: string,
  signal: AbortSignal,
  limits: ScanLimits = DEFAULT_LIMITS,
): Promise<ScanResult> {
  const deadline = Date.now() + limits.budgetMs;
  const out: Entry[] = [];
  let partial = false;
  for await (const e of Deno.readDir(path)) {
    if (signal.aborted) return { entries: sorted(out), partial: true };
    if (!e.isDirectory || e.isSymlink) continue;
    if (out.length >= limits.maxEntries || Date.now() >= deadline) {
      partial = true;
      break;
    }
    const child = join(path, e.name);
    const r = await subtreeSize(child, signal, deadline, limits);
    partial ||= r.partial;
    out.push({ name: e.name, path: child, bytes: r.bytes });
  }
  return { entries: sorted(out), partial };
}

const sorted = (e: Entry[]): Entry[] =>
  [...e].sort((a, b) => b.bytes - a.bytes);

/** Open a folder in the desktop file manager. The per-OS launcher is the
 *  framework's — `openExternal` covers files, folders and URLs, and rejects
 *  loudly when the desktop refuses. */
export async function reveal(path: string): Promise<void> {
  const { openExternal } = await import("aio/server");
  await openExternal(path);
}

/** The starting point: the user's home directory, or `/` if that is unknown. */
export function homeDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  return home && home.length > 0 ? home : "/";
}

export const label = (path: string): string => basename(path) || path;
