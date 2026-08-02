// Server-only module — Deno APIs, filesystem, subprocesses.
//
// The `.server.ts` suffix + a DYNAMIC import from the cell is the whole
// boundary: the build marks these imports external, so none of this reaches the
// browser bundle (docs/build/imports.md §2). Cell methods run on the server, so
// the import only ever executes there.
import { basename, join } from "@std/path";

export type Entry = { name: string; path: string; bytes: number };

/** Size of one directory subtree, in bytes.
 *
 *  `signal` is threaded all the way down — cancellation is cooperative, and a
 *  scan that ignores the signal is a scan the user cannot stop. Unreadable
 *  entries are skipped rather than fatal: a disk tool that dies on the first
 *  permission-denied is useless on a real machine. */
async function subtreeSize(
  path: string,
  signal: AbortSignal,
  depth = 0,
): Promise<number> {
  if (signal.aborted || depth > 12) return 0;
  let total = 0;
  try {
    for await (const e of Deno.readDir(path)) {
      if (signal.aborted) return total;
      const child = join(path, e.name);
      if (e.isSymlink) continue; // never follow — a loop is not a size
      if (e.isDirectory) total += await subtreeSize(child, signal, depth + 1);
      else if (e.isFile) {
        try {
          total += (await Deno.stat(child)).size;
        } catch { /* vanished or unreadable mid-walk */ }
      }
    }
  } catch { /* unreadable directory — report it as 0, keep going */ }
  return total;
}

/** Immediate children of `path`, largest first. Long-running by nature: on a
 *  real tree this is seconds to minutes, which is exactly why the cell gives it
 *  a cancel path and a "scanning" flag. */
export async function scanFolders(
  path: string,
  signal: AbortSignal,
): Promise<Entry[]> {
  const out: Entry[] = [];
  for await (const e of Deno.readDir(path)) {
    if (signal.aborted) return out;
    if (!e.isDirectory || e.isSymlink) continue;
    const child = join(path, e.name);
    out.push({
      name: e.name,
      path: child,
      bytes: await subtreeSize(child, signal),
    });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** Open a folder in the desktop file manager — a subprocess spawned from a cell
 *  method. The command differs per platform; the shape does not. */
export async function reveal(path: string): Promise<void> {
  const cmd = Deno.build.os === "darwin"
    ? "open"
    : Deno.build.os === "windows"
    ? "explorer"
    : "xdg-open";
  // Detached and unawaited output: the file manager outlives this call.
  const child = new Deno.Command(cmd, {
    args: [path],
    stdout: "null",
    stderr: "null",
  }).spawn();
  await child.status;
}

/** The starting point: the user's home directory, or `/` if that is unknown. */
export function homeDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  return home && home.length > 0 ? home : "/";
}

export const label = (path: string): string => basename(path) || path;
