/**
 * @module
 * What of the SHARED Electron store (shared-runtime.ts) may go — the plan
 * `am prune` prints — and the part of it an online app's own start removes.
 *
 * End users have no `am`: an app deleted by its user (the AppImage removed,
 * the .app trashed, the Windows folder gone) left its ~280 MB runtime in the
 * store for good. So every shared-runtime app's start, once its window has
 * loaded and at most once a day per user, removes the runtimes that plan
 * offers which also have sat unstarted for {@linkcode AUTO_PRUNE_MIN_AGE_DAYS}
 * days — never one an installed app names, one being downloaded (its lock),
 * or the one the app runs from.
 */
import { basename, join } from "@std/path";
import {
  _withRuntimeLock,
  runtimeLastUsed,
  stageTag,
} from "./electron-runtime-fetch.ts";
import { readSharedUses, sharedElectronRoot } from "./shared-runtime.ts";

/** Bytes under `path`, following no symlinks. A missing tree is 0 rather than
 *  a throw: the cache is shared, and another process may be clearing the very
 *  entry we are measuring. */
export async function treeBytes(path: string): Promise<number> {
  let total = 0;
  const visit = async (p: string) => {
    let st: Deno.FileInfo;
    try {
      st = await Deno.lstat(p);
    } catch {
      return;
    }
    if (st.isDirectory) {
      let entries: Deno.DirEntry[];
      try {
        entries = await Array.fromAsync(Deno.readDir(p));
      } catch {
        return;
      }
      for (const e of entries) await visit(join(p, e.name));
    } else {
      total += st.size;
    }
  };
  await visit(path);
  return total;
}

/** One entry of the SHARED runtime store (electron/shared-runtime.ts) and
 *  what prune decided about it. */
export type SharedPruneDecision = {
  name: string;
  path: string;
  kind: "runtime" | "window" | "record" | "other";
  bytes: number;
  keep: boolean;
  why: string;
};

/** How long a shared runtime an app just started from is kept even with no
 *  record naming it: the record may be on its way. */
export const SHARED_PRUNE_GRACE_MS = 10 * 60_000;

/** What of the shared store may go. Unlike the cache, AGE decides nothing
 *  here: a shared-runtime app starts from nothing else, so a runtime an
 *  installed app still names is kept however long it sat unused (an app
 *  opened once a year must still open offline). What goes is what no
 *  installed app names — a runtime, a macOS window bundle — and the records
 *  of apps that are no longer there. One record that cannot be read keeps
 *  every runtime and window: prune cannot tell what it protected. */
export async function planSharedPrune(
  root: string = sharedElectronRoot(),
  now: Date = new Date(),
): Promise<{ root: string; decisions: SharedPruneDecision[] }> {
  const decisions: SharedPruneDecision[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(root));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return { root, decisions };
    throw e;
  }
  const uses = await readSharedUses(root);
  const unreadable = uses.filter((u) => u.use === null).map((u) =>
    basename(u.file)
  );
  const runtimes = new Map<string, string>(); // name → the app that needs it
  const windows = new Map<string, string>(); // path → the app that needs it
  for (const u of uses) {
    if (!u.use || !u.live) continue;
    const v = u.use.version.replace(/^v/, "");
    runtimes.set(`${v}-${u.use.slug}`, u.use.exe);
    if (u.use.window) windows.set(u.use.window, u.use.exe);
  }
  const blanket = unreadable.length > 0
    ? `kept: app record(s) ${
      unreadable.map((n) => `apps/${n}`).join(", ")
    } cannot be read, so what they protect is unknown — fix or delete ` +
      `them to prune`
    : null;
  for (const e of entries) {
    const path = join(root, e.name);
    if (e.name === "apps" || e.name === "windows") continue;
    if (!e.isDirectory) continue; // locks, stray files: never touched here
    if (e.name.includes(".incoming.")) continue; // a download in flight
    const bytes = await treeBytes(path);
    const by = runtimes.get(e.name);
    // A start that found it a moment ago may not have written its record
    // when the records above were read: recent use keeps it.
    const used = await runtimeLastUsed(path);
    const fresh = used !== null &&
      now.getTime() - used.at.getTime() < SHARED_PRUNE_GRACE_MS;
    decisions.push({
      name: e.name,
      path,
      kind: "runtime",
      bytes,
      keep: !!by || fresh || !!blanket,
      why: by
        ? `an installed app starts from it (${by})`
        : fresh
        ? `an app started from it in the last ${
          SHARED_PRUNE_GRACE_MS / 60_000
        } minutes`
        : blanket ?? "no installed app names it",
    });
  }
  for (
    const w of await Array.fromAsync(Deno.readDir(join(root, "windows")))
      .catch(() => [] as Deno.DirEntry[])
  ) {
    if (!w.isDirectory) continue;
    const path = join(root, "windows", w.name);
    const by = windows.get(path);
    // A start is making this window right now (a fresh stage is there): its
    // record follows once the window is ready. A stage left by a start that
    // was killed goes stale, and stops protecting anything.
    let making = false;
    for (
      const x of await Array.fromAsync(Deno.readDir(path)).catch(() =>
        [] as Deno.DirEntry[]
      )
    ) {
      if (!x.name.startsWith(".stage-")) continue;
      const m = (await Deno.stat(join(path, x.name)).catch(() => null))?.mtime;
      if (m && now.getTime() - m.getTime() < SHARED_PRUNE_GRACE_MS) {
        making = true;
      }
    }
    decisions.push({
      name: `windows/${w.name}`,
      path,
      kind: "window",
      bytes: await treeBytes(path),
      keep: !!by || making || !!blanket,
      why: by
        ? `the window of ${by}`
        : making
        ? "an app is making this window right now"
        // What is known is only that no record names it: an app removed, or
        // one still installed whose window was never finished (a start that
        // crashed). That one makes it again at its next start.
        : blanket ??
          "no installed app's record names this window (an installed app makes it again at its next start)",
    });
  }
  for (const u of uses) {
    if (u.use === null || u.live) continue;
    decisions.push({
      name: `apps/${basename(u.file)}`,
      path: u.file,
      kind: "record",
      bytes: (await Deno.stat(u.file).catch(() => ({ size: 0 }))).size,
      keep: false,
      why: `the record of ${u.use.exe}, which is no longer there`,
    });
  }
  return { root, decisions };
}

/** How long nothing may have started from a runtime no installed app names
 *  before an app's own start removes it. Long, on purpose: a record names the
 *  install's PATH, so an app the user moved (Downloads → Applications) and has
 *  not opened since names nothing until its next start — and on an offline
 *  machine that start could not download the runtime again. 30 days is the
 *  age floor `am prune` already applies to the tool cache: "nothing on this
 *  machine opened it in a month". */
export const AUTO_PRUNE_MIN_AGE_DAYS = 30;

/** In the store's root: when an app's start last ran the auto-prune. */
export const AUTO_PRUNE_STAMP = ".aio-auto-prune";

const DAY_MS = 24 * 60 * 60_000;

/** How long the auto-prune waits on a runtime's lock: held means a download
 *  or an install is in flight, and that runtime is skipped. */
const LOCK_TRY_MS = 1_000;

/** The auto-prune an online app's start runs once its window has loaded:
 *  {@linkcode planSharedPrune}'s runtimes no installed app names, minus
 *  `running` (the runtime this app starts from), minus any started from in
 *  the last {@linkcode AUTO_PRUNE_MIN_AGE_DAYS} days, each re-checked and
 *  removed under its lock (skipped while another process holds it). At most
 *  once a day per store ({@linkcode AUTO_PRUNE_STAMP}). One info line per
 *  removed runtime; a failure is logged, never thrown. Returns the removed
 *  paths. */
export async function autoPruneSharedStore(opts: {
  /** The store directory this app's runtime is in — never removed. */
  running: string;
  log: { info: (m: string) => void; error: (m: string) => void };
  root?: string;
  now?: Date;
}): Promise<string[]> {
  const root = opts.root ?? sharedElectronRoot();
  const now = opts.now ?? new Date();
  const minAgeMs = AUTO_PRUNE_MIN_AGE_DAYS * DAY_MS;
  const removed: string[] = [];
  const oldEnough = async (path: string) => {
    const used = await runtimeLastUsed(path);
    return used !== null && now.getTime() - used.at.getTime() >= minAgeMs;
  };
  try {
    const stamp = join(root, AUTO_PRUNE_STAMP);
    const last = await Deno.readTextFile(stamp).then(
      (t) => new Date(t.trim()).getTime(),
      () => NaN,
    );
    // A stamp in the future (a clock set back) is as good as none.
    const since = now.getTime() - last;
    if (since >= 0 && since < DAY_MS) return removed;
    await Deno.writeTextFile(stamp, `${now.toISOString()}\n`);
    const { decisions } = await planSharedPrune(root, now);
    for (const d of decisions) {
      if (d.kind !== "runtime" || d.keep || d.path === opts.running) continue;
      if (!await oldEnough(d.path)) continue;
      try {
        await _withRuntimeLock(`${d.path}.lock`, async (held) => {
          if (!held) return; // being downloaded or installed right now
          // Re-checked under the lock: a start may have used or named it
          // since the plan was read.
          if (!await oldEnough(d.path)) return;
          const named = (await readSharedUses(root)).some((u) =>
            u.use === null ||
            (u.live && `${u.use.version.replace(/^v/, "")}-${u.use.slug}` ===
                d.name)
          );
          if (named) return;
          // Out of its name first, in one step: a start never sees half a
          // runtime, and a crash mid-delete leaves a stage the next install
          // clears as dead.
          const stage = `${d.path}.incoming.${stageTag()}`;
          await Deno.rename(d.path, stage);
          await Deno.remove(stage, { recursive: true });
          removed.push(d.path);
          opts.log.info(
            `electron: removed Electron ${d.name} from the shared store ` +
              `(${Math.round(d.bytes / 1e6)} MB, ${d.path}) — no installed ` +
              `app names it, and nothing started from it in ` +
              `${AUTO_PRUNE_MIN_AGE_DAYS} days`,
          );
        }, LOCK_TRY_MS);
      } catch (e) {
        opts.log.error(
          `electron: could not remove the unused Electron ${d.path} from ` +
            `the shared store (${e instanceof Error ? e.message : e}) — ` +
            `the next day's start tries again`,
        );
      }
    }
  } catch (e) {
    opts.log.error(
      `electron: the shared store's clean-up failed (${
        e instanceof Error ? e.message : e
      }) — nothing more was removed; \`am prune\` shows the store`,
    );
  }
  return removed;
}
