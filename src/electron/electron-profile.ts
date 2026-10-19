/**
 * @module
 * Where a window's Chromium profile lives: `~/.<appId>/electron/`.
 *
 * The profile is what Electron writes for the app — cookies, Local Storage,
 * IndexedDB, the window's size and position, Chromium's caches. It is not
 * vital like `data/`, but nothing recreates it (a sign-in, a stored setting),
 * so it lives in the app's own home beside `data/` and `logs/`:
 *
 *   - it goes with the app: `am remove --data` removes it, nothing is left in
 *     `~/.config` with the app's cookies in it;
 *   - two apps never share one, even with the same title (the old folder was
 *     named after the title);
 *   - a `--profile` home, or an `--instance` apps root, has its own by being
 *     a different home;
 *   - on Windows it is no longer in the ROAMING profile (`%APPDATA%`).
 *
 * Chromium's caches stay in it: Electron ignores `--disk-cache-dir`
 * (measured, Electron 44), and they are ~2 MB for an aio app.
 *
 * An app whose profile is still at Electron's old per-OS place moves it once,
 * at the window's start, before Electron opens it.
 */
import { join } from "@std/path";

/** The profile directory inside an app's home. Pure. */
export function appProfileDir(home: string): string {
  return join(home, "electron");
}

/** What happened to the profile at Electron's old per-OS place. */
export type ProfileMove =
  | { kind: "none" } // nothing there: a new app, or moved before
  | { kind: "moved"; from: string }
  | { kind: "kept-both"; from: string } // both exist: the home's wins
  | { kind: "failed"; from: string; why: string };

/** Move the profile at `old` (Electron's per-OS default for this window) to
 *  `dir` (the app's home), once. Never deletes anything: a profile that is in
 *  both places stays in both, and a move that fails leaves the old one where
 *  it was — the caller then keeps starting from it. */
export async function moveOldProfile(
  old: string | null,
  dir: string,
  deps: { rename?: typeof Deno.rename } = {},
): Promise<ProfileMove> {
  if (!old || old === dir) return { kind: "none" };
  const isDir = (p: string) =>
    Deno.stat(p).then((s) => s.isDirectory, () => false);
  if (!(await isDir(old))) return { kind: "none" };
  if (await isDir(dir)) return { kind: "kept-both", from: old };
  try {
    await Deno.mkdir(join(dir, ".."), { recursive: true });
    // A directory move within one volume (the home and `~/.config` or
    // `%APPDATA%` are one, normally): atomic, nothing copied. Across volumes
    // it fails, and the old place stays in use.
    await (deps.rename ?? Deno.rename)(old, dir);
    return { kind: "moved", from: old };
  } catch (e) {
    return {
      kind: "failed",
      from: old,
      why: e instanceof Error ? e.message : String(e),
    };
  }
}
