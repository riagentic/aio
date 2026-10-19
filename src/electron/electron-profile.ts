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
 * at the window's start, before Electron opens it. A rollback to a build that
 * reads the old place moves it back (`moveProfileBack`).
 */
import { dirname, join } from "@std/path";

/** The profile directory inside an app's home. Pure. */
export function appProfileDir(home: string): string {
  return join(home, "electron");
}

/** What happened to the profile at Electron's old per-OS place. */
export type ProfileMove =
  | { kind: "none" } // nothing there: a new app, or moved before
  | { kind: "moved"; from: string }
  // Both exist (a build that read the old place ran after the move): the one
  // written last is the profile, the other is set aside in the home as
  // `backup` — once, never deleted.
  | { kind: "both"; from: string; kept: "home" | "old"; backup: string }
  // Both exist and the other could not be set aside: the home's wins.
  | { kind: "kept-both"; from: string; why: string }
  | { kind: "failed"; from: string; why: string };

/** The newest modification time in the tree at `dir` (links not followed) —
 *  which of two profiles was written last. */
async function newestIn(dir: string): Promise<number> {
  let newest = (await Deno.lstat(dir)).mtime?.getTime() ?? 0;
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    newest = Math.max(
      newest,
      e.isDirectory
        ? await newestIn(p)
        : (await Deno.lstat(p)).mtime?.getTime() ?? 0,
    );
  }
  return newest;
}

const exists = (p: string) => Deno.lstat(p).then(() => true, () => false);

/** Where the profile that is not kept goes: `<home>/electron.previous-<date>`
 *  (a second one that day carries the time too). */
async function backupPath(dir: string, now: Date): Promise<string> {
  const base = join(
    dirname(dir),
    `electron.previous-${now.toISOString().slice(0, 10)}`,
  );
  return await exists(base) ? `${base}-${now.getTime()}` : base;
}

/** Move the profile at `old` (Electron's per-OS default for this window) to
 *  `dir` (the app's home), once. Never deletes anything: a profile in both
 *  places keeps the one written last at `dir` and sets the other aside in the
 *  home; a move that fails leaves the old one where it was — the caller then
 *  keeps starting from it. */
export async function moveOldProfile(
  old: string | null,
  dir: string,
  deps: { rename?: typeof Deno.rename; now?: Date } = {},
): Promise<ProfileMove> {
  if (!old || old === dir) return { kind: "none" };
  const rename = deps.rename ?? Deno.rename;
  const isDir = (p: string) =>
    Deno.stat(p).then((s) => s.isDirectory, () => false);
  if (!(await isDir(old))) return { kind: "none" };
  if (await isDir(dir)) {
    try {
      const kept = await newestIn(old) > await newestIn(dir) ? "old" : "home";
      const backup = await backupPath(dir, deps.now ?? new Date());
      if (kept === "home") await rename(old, backup);
      else {
        await rename(dir, backup);
        try {
          await rename(old, dir);
        } catch (e) {
          await rename(backup, dir); // the home's again, as it was
          throw e;
        }
      }
      return { kind: "both", from: old, kept, backup };
    } catch (e) {
      return {
        kind: "kept-both",
        from: old,
        why: e instanceof Error ? e.message : String(e),
      };
    }
  }
  try {
    await Deno.mkdir(join(dir, ".."), { recursive: true });
    // A directory move within one volume (the home and `~/.config` or
    // `%APPDATA%` are one, normally): atomic, nothing copied. Across volumes
    // it fails, and the old place stays in use.
    await rename(old, dir);
    return { kind: "moved", from: old };
  } catch (e) {
    return {
      kind: "failed",
      from: old,
      why: e instanceof Error ? e.message : String(e),
    };
  }
}

/** A rollback to a build that reads the profile at Electron's old per-OS
 *  place: the profile the update moved into the home (`to`) goes back to
 *  `from`. Never over one there. "moved", "none" (nothing at `to`), or why
 *  it could not be. */
export async function moveProfileBack(
  moved: { from: string; to: string },
  rename: typeof Deno.rename = Deno.rename,
): Promise<string> {
  if (!(await exists(moved.to))) return "none";
  if (await exists(moved.from)) return `${moved.from} is in use`;
  try {
    await Deno.mkdir(dirname(moved.from), { recursive: true });
    await rename(moved.to, moved.from);
    return "moved";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
