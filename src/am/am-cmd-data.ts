/**
 * @module
 * Data commands for am — `data`, `backup`, `restore`.
 *
 * These exist because of the one-directory layout
 * (docs/specs/2026-07-26-data-dir-and-updates.md): an app's whole durable state
 * is `~/.<appId>/data/`, so a backup is a directory copy and a restore is the
 * same copy in reverse. That is deliberately dull — the value is in the two
 * checks around it that a hand-rolled `cp -r` doesn't do:
 *
 *   • never copy a database out from under a running writer (WAL means the
 *     `.db` alone is a torn read) — refuse while the app is alive
 *   • never restore an archive from a DIFFERENT app over live data — meta.json
 *     records the appId precisely so this is checkable
 *
 * `am snapshot` is a different thing and stays: it asks the RUNNING app for its
 * cell state as JSON. This is the files — including auth.db, the app key and the
 * TLS material, none of which are cell state.
 */

import { basename, isAbsolute, join, relative, resolve } from "@std/path";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, fail, out, outError, sayErr } from "./am-output.ts";
import {
  liveLock,
  maintenanceMark,
  maintenanceMessage,
  maintenanceOp,
  resolveAmAppId,
} from "./am-utils.ts";
import {
  type AppDirs,
  appDirs,
  ensureAppDirs,
  registeredProfile,
} from "../server/app-dirs.ts";
import type { AppMeta } from "../server/app-dirs.ts";
import {
  AppLock,
  claimHome,
  isLockOwnerAlive,
  lockDir,
  STARTUP_GRACE_MS,
} from "../server/single-instance-lock.ts";

// ── Shared helpers ─────────────────────────────────────────

/** The running pid, or null when the app isn't up. */
function livePid(appId: string): number | null {
  const lock = liveLock(appId); // honours --home; else the one live instance
  return lock && isLockOwnerAlive(lock) ? lock.pid : null;
}

/** Total bytes under a path (0 when missing) — for the size column. */
function dirSize(path: string): number {
  let total = 0;
  const walk = (p: string): void => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(p)];
    } catch {
      return;
    }
    for (const e of entries) {
      const child = join(p, e.name);
      if (e.isDirectory) walk(child);
      else if (e.isFile) {
        try {
          total += Deno.statSync(child).size;
        } catch { /* vanished mid-walk */ }
      }
    }
  };
  try {
    const st = Deno.statSync(path);
    if (st.isFile) return st.size;
  } catch {
    return 0;
  }
  walk(path);
  return total;
}

function human(bytes: number): string {
  const units = ["B", "K", "M", "G"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)}${units[i]}`;
}

/** `child` is `parent` itself or lies under it (both already resolved). */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Recursive copy that refuses to overwrite, so a mistyped destination can
 *  never eat an existing backup. Files carry their mode across (the app key and
 *  the TLS key are 0600 and must stay that way in the copy). */
/** Thrown by {@linkcode copyTree} when the user interrupts (Ctrl-C/SIGTERM)
 *  — handled like any failure of the copy, and said as an interruption. */
class Interrupted extends Error {
  constructor(readonly signal: string) {
    super(`interrupted (${signal})`);
  }
}

async function copyTree(
  from: string,
  to: string,
  interrupted: () => string | null = () => null,
  /** Rejects on a SECOND signal: the file in flight is abandoned there and
   *  then, instead of after however long it takes to copy. */
  abandon?: Promise<never>,
): Promise<number> {
  // Overlapping trees are never a sane copy — and a destination INSIDE the
  // source is a runaway: mkdir creates it, readDir then finds it, and the copy
  // recurses into its own output until the path length or the stack gives out,
  // spraying nested duplicates into the source on the way down. The commands
  // refuse these up front with a friendlier message; this is the invariant.
  if (within(from, to) || within(to, from)) {
    throw new Error(
      `copyTree: "${from}" and "${to}" overlap — refusing to copy a tree into itself`,
    );
  }
  let files = 0;
  await Deno.mkdir(to, { recursive: true });
  for await (const e of Deno.readDir(from)) {
    // ASYNC on purpose: a signal is delivered between awaits, so Ctrl-C stops
    // the copy at the next file instead of after the whole tree.
    const sig = interrupted();
    if (sig) throw new Interrupted(sig);
    const src = join(from, e.name);
    const dst = join(to, e.name);
    if (e.isDirectory) {
      files += await copyTree(src, dst, interrupted, abandon);
    } else if (e.isFile) {
      // preserves mode. One file can take minutes (a multi-GB state.db) and
      // a copy cannot be cancelled mid-file — so a second Ctrl-C/SIGTERM
      // stops WAITING for it: the caller removes the partial tree and exits,
      // and the process exit ends the copy.
      const copy = Deno.copyFile(src, dst);
      if (abandon) await Promise.race([copy, abandon]);
      else await copy;
      files++;
    }
    // Symlinks are not part of any layout aio creates; skipped deliberately
    // rather than followed, so a link to /etc can't be pulled into an archive.
  }
  return files;
}

const stamp = (): string =>
  new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace(
    "T",
    "-",
  );

// ── am data ────────────────────────────────────────────────

/** `am data [--json]` — every path this app uses, and which of them a backup
 *  needs. Answers "where is my stuff" without the user reading any docs. */
export function cmdData(args: string[], flags: GlobalFlags): void {
  const mode = detectMode(flags);
  if (args.some((a) => !a.startsWith("--"))) {
    outError(
      `am data takes no arguments (did you mean "am backup" / "am restore"?)`,
      mode,
    );
    Deno.exit(1);
  }
  const appId = resolveAmAppId(flags.app);
  const d = appDirs(appId);
  const pid = livePid(appId);
  const info: DataInfo = {
    appId,
    running: pid !== null,
    pid: pid ?? undefined,
    home: d.home,
    data: d.data,
    logs: d.logs,
    cache: d.cache,
    app: d.app,
    launch: d.launch,
    runtime: lockDir(),
    backup: d.data,
    sizes: {
      data: dirSize(d.data),
      logs: dirSize(d.logs),
      cache: dirSize(d.cache),
      app: dirSize(d.app),
    },
  };
  out(mode === "pretty" ? renderData(info) : info, mode);
}

export type DataInfo = {
  appId: string;
  running: boolean;
  pid?: number;
  home: string;
  data: string;
  logs: string;
  cache: string;
  /** ②b where a packaged app unpacks itself — regenerable, but not while it
   *  runs (see AppDirs.app). Listed because it EXISTS on disk: a directory this
   *  command does not name is a directory nobody knows to look in. */
  app: string;
  launch: string;
  runtime: string;
  backup: string;
  sizes: { data: number; logs: number; cache: number; app: number };
};

/** The pretty rendering, pure so it is testable without a terminal (`am` falls
 *  back to JSON whenever stdout isn't a tty, which includes every test). */
export function renderData(info: DataInfo): string {
  const rows = [
    ["home", info.home, ""],
    ["data ①", info.data, human(info.sizes.data)],
    ["logs ②", info.logs, human(info.sizes.logs)],
    ["cache ②", info.cache, human(info.sizes.cache)],
    ["app ②b", info.app, human(info.sizes.app)],
    ["launch ②", info.launch, ""],
    ["runtime ③", info.runtime, ""],
  ];
  const w = Math.max(...rows.map((r) => r[0]!.length));
  return [
    `${info.appId}${info.running ? `  (running, pid ${info.pid})` : ""}`,
    ...rows.map(([k, v, s]) => `  ${k!.padEnd(w)}  ${v}${s ? `  ${s}` : ""}`),
    "",
    `  ① back this up — everything the app cannot recreate`,
    `  ② regenerable — delete any time`,
    `  ②b the unpacked app — regenerable, but not while it is running`,
    `  ③ must not survive a reboot (socket, pid, lock)`,
    "",
    `  am backup            → copy ① somewhere safe`,
  ].join("\n");
}

// ── am backup ──────────────────────────────────────────────

/** Where a backup goes when the user names no destination:
 *  `<home>/backups/<appId>-backup-<stamp>` — inside the app's OWN home, beside
 *  the data it copies.
 *
 *  It used to be `<cwd>/<appId>-backup-<stamp>`. The cwd of `am backup` is the
 *  app's git checkout by definition, so the default dropped a full copy of the
 *  app's data — auth.db, the app key, the TLS key — into the working tree,
 *  where the scaffold's .gitignore does not cover it and `git status` shows it
 *  as untracked the moment the command returns. A default must be somewhere it
 *  is safe to forget about; a named destination still goes exactly where the
 *  user says.
 *  @internal exported for the test */
export function defaultBackupDest(appId: string, at = stamp()): string {
  return join(appDirs(appId).home, "backups", `${appId}-backup-${at}`);
}

/** `am backup [dest] [--force]` — copy `<data>/` to `dest`
 *  (default {@linkcode defaultBackupDest}). */
export async function cmdBackup(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const d = appDirs(appId);
  const force = args.includes("--force") || flags.force === true;
  const destArg = args.find((a) => !a.startsWith("--"));
  const dest = resolve(destArg ?? defaultBackupDest(appId));

  try {
    Deno.statSync(d.data);
  } catch {
    outError(
      `no data at ${d.data} — has "${appId}" ever run? (am data shows its paths)`,
      mode,
    );
    Deno.exit(1);
  }
  // WAL: the -wal file holds committed pages the .db doesn't have yet, so a
  // copy taken mid-write can be missing the newest transactions or be
  // internally inconsistent. Stopping the app checkpoints and closes cleanly.
  const pid = livePid(appId);
  if (pid !== null && !force) {
    outError(
      `"${appId}" is running (pid ${pid}) — copying a live SQLite database can ` +
        `capture a torn write. Run "am stop --app=${appId}" first, or ` +
        `"am backup --force" to accept the risk.`,
      mode,
    );
    Deno.exit(1);
  }
  if (within(d.data, dest)) {
    outError(
      `${dest} is inside ${d.data} — a backup cannot be written into the very ` +
        `data it copies (the copy would recurse into its own output). Pick a ` +
        `destination outside the app's data directory.`,
      mode,
    );
    Deno.exit(1);
  }
  try {
    Deno.statSync(dest);
    outError(`${dest} already exists — pick another destination`, mode);
    Deno.exit(1);
  } catch { /* free */ }

  // Copy to `<dest>.partial`, then rename into place: a backup that dies
  // half-way (a disk filling up, an unreadable file) used to leave `<dest>`
  // with a `meta.json` and half the rest — which passes `am restore`'s
  // "is this a backup" check and restores as a truncated app. A `.partial`
  // directory never does: the name is only ever given to a finished copy.
  // HOLD the app's lock for the whole copy (unless --force already accepted a
  // live writer): "stopped" was checked once, and an app started during a
  // seconds-long copy wrote into data/ under it — a torn backup reported as
  // fine. Holding the lock makes that start refuse instead.
  const hold = pid === null
    ? await holdForMaintenance(appId, d.home, "backup", mode)
    : null;
  try {
    await copyBackup();
  } finally {
    hold?.release();
  }
  async function copyBackup(): Promise<void> {
    const partial = `${dest}.partial`;
    hold?.leaves(partial);
    try {
      Deno.statSync(partial);
      fail(
        `${partial} already exists — an earlier backup did not finish. ` +
          `Remove it (it is incomplete) or pick another destination.`,
        mode,
      );
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    let files: number;
    try {
      files = await copyTree(d.data, partial, hold?.interrupted, hold?.abandon);
      // A signal during the LAST file is seen here, before the name is given:
      // an interrupted backup never leaves a `<dest>` (exit 130/143).
      const sig = hold?.interrupted() ?? null;
      if (sig) throw new Interrupted(sig);
      Deno.renameSync(partial, dest);
    } catch (e) {
      removeTracked(partial);
      failCopy(
        e,
        `backup of ${appId} failed — nothing was written to ${dest}: ` +
          (e instanceof Error ? e.message : String(e)),
        mode,
      );
    }
    const bytes = dirSize(dest);
    out(
      mode === "pretty"
        ? `backed up ${appId}: ${files} files, ${human(bytes)} → ${dest}\n` +
          `  restore with: am restore ${dest} --app=${appId}` +
          (pid === null ? "" : `\n  NOTE: taken while the app was running`)
        : { appId, dest, files, bytes, tornRisk: pid !== null },
      mode,
    );
  }
}

/** `am`'s hold on an app while its data is copied or swapped. */
type Hold = {
  /** The signal that interrupted the op, or null. */
  interrupted: () => string | null;
  /** Rejects with the interruption on a SECOND signal — see `copyTree`. */
  abandon: Promise<never>;
  /** Record in the hold what the op will leave if it is killed — named by
   *  whoever later finds the dead holder. */
  leaves(path: string): void;
  release(): void;
};

/** Take `appId`'s app lock so it cannot START while data/ is copied or
 *  swapped, and mark it a MAINTENANCE hold (`maintenanceMark`) so status,
 *  stop and start name `am <op>` instead of mistaking it for a booting app.
 *  Refuses, by name, when someone already holds it.
 *
 *  Ctrl-C / SIGTERM: `AppLock`'s own listeners (installed for APPS) only mark
 *  the lock `stopping`, so the op ignored them and exited 0. Ours records the
 *  signal; the copy checks it between files and fails like any failure —
 *  cleaning up, data untouched — and exits with the signal's code. */
async function holdForMaintenance(
  appId: string,
  home: string,
  op: "backup" | "restore",
  mode: ReturnType<typeof detectMode>,
  /** The heartbeat period — injected by its test only. */
  beatMs: number = STARTUP_GRACE_MS,
): Promise<Hold> {
  const lock = new AppLock(appId, home, registeredProfile(appId));
  const r = await lock.acquire(0);
  if (!r.ok) {
    fail(
      maintenanceOp(r.existing)
        ? maintenanceMessage(appId, r.existing)
        : `"${appId}" is running (pid ${r.existing.pid}) — run ` +
          `"am stop --app=${appId}" first`,
      mode,
    );
  }
  // The data folder's own OS lock too: an instance of this app booted from
  // ANOTHER lock scope (--instance, an appDir app) holds it, and copying or
  // swapping data/ under it is the torn copy the lock exists to prevent.
  const claim = claimHome(home, { appId, port: 0, key: lock.key });
  if (!claim.ok) {
    lock.release();
    fail(
      `"${appId}" is running from ${home}${
        claim.holder?.pid ? ` (pid ${claim.holder.pid})` : ""
      } under another lock scope — stop it first`,
      mode,
    );
  }
  lock.attach(claim.close);
  const since = Date.now();
  let mark = maintenanceMark(`am ${op}`, since);
  lock.update(mark);
  // Keep `startedAt` fresh: an `am` that predates `LockData.maintenance`
  // reads this hold as a booting app, and reclaims a "starting" lock whose
  // startedAt (and log) stopped moving for STUCK_STARTING_MS — a long copy
  // must never look stalled to it.
  const beat = setInterval(
    () => lock.update({ startedAt: Date.now() }),
    beatMs,
  );
  Deno.unrefTimer(beat);
  let signal: string | null = null;
  // First signal: graceful — the copy stops at the next file, cleans up and
  // exits 130/143. A SECOND one (Ctrl-C twice, SIGTERM after a patient
  // wait) means "now": the file in flight is abandoned (see `copyTree`).
  // Measured before: 2×SIGTERM + 2×SIGINT were all ignored for the 20 s a
  // large file took.
  let abandonNow!: (e: Interrupted) => void;
  const abandon = new Promise<never>((_, reject) => abandonNow = reject);
  abandon.catch(() => {
    // aio-ok: raced only while a file copies; this keeps an unraced
    // rejection from being unhandled
  });
  const on = (s: "SIGINT" | "SIGTERM") => () => {
    if (signal !== null) abandonNow(new Interrupted(signal));
    signal ??= s;
    lock.update(mark); // AppLock's own listener just wrote `stopping`
  };
  const handlers = [["SIGINT", on("SIGINT")], [
    "SIGTERM",
    on("SIGTERM"),
  ]] as const;
  for (const [s, h] of handlers) {
    try {
      Deno.addSignalListener(s, h);
    } catch {
      // aio-ok: no such signal on this platform (windows SIGTERM)
    }
  }
  return {
    interrupted: () => signal,
    abandon,
    leaves(path: string) {
      mark = maintenanceMark(`am ${op}`, since, path);
      lock.update(mark);
    },
    release() {
      for (const [s, h] of handlers) {
        try {
          Deno.removeSignalListener(s, h);
        } catch {
          // aio-ok: never added (see above)
        }
      }
      clearInterval(beat);
      lock.release();
    },
  };
}

/** End a failed copy: an interruption exits with the signal's code, any
 *  other failure with 1 — both after the caller cleaned up, both with the
 *  same message. */
function failCopy(
  e: unknown,
  msg: string,
  mode: ReturnType<typeof detectMode>,
): never {
  if (e instanceof Interrupted) {
    outError(msg, mode);
    Deno.exit(e.signal === "SIGINT" ? 130 : 143);
  }
  fail(msg, mode);
}

// ── am restore ─────────────────────────────────────────────

/** Read an archive's `meta.json`: the meta, `null` when the file is absent (a
 *  hand-made copy has none), or `"corrupt"` when it exists but cannot be
 *  parsed. The caller must NOT treat corrupt as absent — that silently blinds
 *  the wrong-app check, which is half this command's reason to exist. */
function readArchiveMeta(src: string): AppMeta | null | "corrupt" {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(join(src, "meta.json"));
  } catch {
    return null; // genuinely absent
  }
  try {
    return JSON.parse(raw) as AppMeta;
  } catch {
    return "corrupt";
  }
}

/** `am restore <src> [--force]` — put a backup back. The current `data/` is
 *  MOVED aside (never deleted) so a restore of the wrong archive is undoable. */
export async function cmdRestore(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const d = appDirs(appId);
  const force = args.includes("--force") || flags.force === true;
  const srcArg = args.find((a) => !a.startsWith("--"));
  if (!srcArg) {
    outError(`usage: am restore <backup-dir> [--app=<appId>] [--force]`, mode);
    Deno.exit(1);
  }
  const src = resolve(srcArg);
  try {
    if (!Deno.statSync(src).isDirectory) throw new Error("not a directory");
  } catch {
    outError(`no backup directory at ${src}`, mode);
    Deno.exit(1);
  }
  if (within(src, d.data) || within(d.data, src)) {
    outError(
      `${src} overlaps the live data directory ${d.data} — a restore must ` +
        `come from a copy outside it (the current data is moved aside during ` +
        `the restore, which would take the source with it).`,
      mode,
    );
    Deno.exit(1);
  }
  const pid = livePid(appId);
  if (pid !== null) {
    // Not overridable: the running app has the databases open and would write
    // its in-memory pages over whatever we just restored.
    outError(
      `"${appId}" is running (pid ${pid}) — run "am stop --app=${appId}" first`,
      mode,
    );
    Deno.exit(1);
  }
  // Is it a backup AT ALL? `meta.json` (every archive am writes) or `state.db`
  // (a hand-made copy, or one from before meta.json) — one of the two must be
  // there. Without this check a directory that is simply not an archive passed
  // every guard below (a null meta is the "hand-made copy" case), the live data
  // was moved aside, `copyTree` copied its zero files, and `am restore` said
  // `{"files":0}` and exited 0 with the app's data directory EMPTY. Only the
  // `.replaced-*` copy stood between that and total loss. `files: 0` is never
  // a successful restore, and this is the honest place to say so: before
  // anything has been moved.
  const looksLikeArchive = ["meta.json", "state.db"].some((f) => {
    try {
      return Deno.statSync(join(src, f)).isFile;
    } catch {
      return false;
    }
  });
  if (!looksLikeArchive) {
    outError(
      `${src} is not an aio backup — it holds neither meta.json nor ` +
        `state.db, so there is nothing to restore from it. Restoring it ` +
        `would empty ${d.data}.\n` +
        `  a backup is what "am backup" writes: the whole of ${d.data}` +
        (force
          ? `\n  (--force does not apply: this is not "the wrong archive", ` +
            `it is no archive)`
          : ""),
      mode,
    );
    Deno.exit(1);
  }
  const meta = readArchiveMeta(src);
  if (meta === "corrupt" && !force) {
    outError(
      `${join(src, "meta.json")} exists but cannot be parsed — whether this ` +
        `archive belongs to "${appId}" is unverifiable (a backup taken with ` +
        `--force on a live app can tear meta.json). Use --force to restore ` +
        `it anyway.`,
      mode,
    );
    Deno.exit(1);
  }
  if (meta !== null && meta !== "corrupt" && meta.appId !== appId && !force) {
    outError(
      `${
        basename(src)
      } belongs to "${meta.appId}", not "${appId}" — restoring ` +
        `it would overwrite the wrong app's data. Use --app=${meta.appId}, or ` +
        `--force if you really mean to.`,
      mode,
    );
    Deno.exit(1);
  }

  // HOLD the app's lock from the copy to the swap: "stopped" was checked
  // once above, and an app started mid-restore wrote into the data that was
  // then moved aside — the restore reported success and those writes were
  // gone. Holding the lock makes that start refuse instead.
  const hold = await holdForMaintenance(appId, d.home, "restore", mode);
  try {
    await swapIn();
  } finally {
    hold.release();
  }
  async function swapIn(): Promise<void> {
    ensureAppDirs(d);
    // Copy FIRST, into a sibling, and only then swap: a copy that died half-way
    // (an unreadable file, a full disk) used to run AFTER the live data had been
    // moved aside, leaving data/ nearly empty and never saying where the aside
    // went. Now a failed copy leaves data/ untouched, and the swap is two
    // renames — the only window left, and it is covered below.
    // Earlier restores that were killed mid-copy leave `data.restoring-*`
    // behind — never swept (a copy is user data until the user says it is
    // not), but NAMED, so it is not disk quietly eaten forever.
    for (const left of siblingsOf(d.data, ".restoring-")) {
      sayErr(
        `am: note: ${left} was left by an interrupted restore — an ` +
          `incomplete copy, not the live data. Delete it once you no longer ` +
          `need it.`,
      );
    }
    // Copy FIRST, into a sibling, and only then swap: a copy that died half-way
    // (an unreadable file, a full disk) used to run AFTER the live data had been
    // moved aside, leaving data/ nearly empty and never saying where the aside
    // went. Now a failed copy leaves data/ untouched, and the swap is two
    // renames — the only window left, and it is covered below.
    // FREE names, never assumed ones: the stamp has one-second resolution, and
    // a second restore inside that second collided with the first one's aside
    // — the swap failed, and its message named the FIRST restore's aside as
    // "the previous data".
    const at = stamp();
    const staging = freeSibling(`${d.data}.restoring-${at}`);
    hold.leaves(staging);
    let files: number;
    try {
      files = await copyTree(src, staging, hold.interrupted, hold.abandon);
      // A signal that landed during the LAST file is seen here: the swap
      // below is synchronous, so after this check nothing can interrupt it
      // half-way — an interrupted restore never changes data/.
      const sig = hold.interrupted();
      if (sig) throw new Interrupted(sig);
    } catch (e) {
      removeTracked(staging);
      failCopy(
        e,
        `restore of ${appId} failed while copying ${src} — ${d.data} was not ` +
          `touched: ${e instanceof Error ? e.message : String(e)}`,
        mode,
      );
    }
    // Move the current data aside rather than deleting: a restore is exactly when
    // the user is already having a bad day, and "wrong archive" must be recoverable.
    // `aside` names a directory ONLY once the previous data is really in it.
    let aside: string | null = null;
    let emptied = false;
    try {
      if ([...Deno.readDirSync(d.data)].length > 0) {
        const to = freeSibling(`${d.data}.replaced-${at}`);
        Deno.renameSync(d.data, to);
        aside = to;
      } else {
        Deno.removeSync(d.data); // empty: nothing to keep, and rename wants it gone
        emptied = true;
      }
      Deno.renameSync(staging, d.data);
    } catch (e) {
      // Put the old data back if it was moved; either way NAME every directory,
      // so nothing is left somewhere the user has to guess.
      let back = false;
      if (aside !== null) {
        try {
          Deno.statSync(d.data);
        } catch {
          try {
            Deno.renameSync(aside, d.data);
            back = true;
          } catch {
            // aio-ok: could not move it back — the message below names it.
          }
        }
      } else if (emptied) {
        try {
          Deno.mkdirSync(d.data); // it was an empty dir; leave one there
        } catch {
          // aio-ok: re-created by the app's next boot (ensureAppDirs)
        }
      }
      fail(
        `restore of ${appId} failed while swapping the copy into place: ` +
          `${e instanceof Error ? e.message : String(e)}\n` +
          `  the restored copy is at ${staging}\n` +
          (aside === null
            ? emptied
              ? `  ${d.data} was empty — there was no previous data`
              : `  the previous data was not moved — it is still at ${d.data}`
            : back
            ? `  the previous data was put back at ${d.data}`
            : `  the previous data is at ${aside}`),
        mode,
      );
    }
    out(
      mode === "pretty"
        ? `restored ${appId}: ${files} files → ${d.data}` +
          (meta && meta !== "corrupt"
            ? `\n  archive: aio ${meta.aio}, saved ${meta.updatedAt}`
            : "") +
          (aside ? `\n  previous data kept at ${aside}` : "")
        : { appId, src, files, replaced: aside ?? undefined },
      mode,
    );
  }
}

/** `base`, or `base-2`, `base-3`, … — the first name nothing is at. Taken
 *  under the maintenance hold, so no other restore of this app races it. */
function freeSibling(base: string): string {
  // Bounded: a thousand taken names is a directory to clean, not a loop to
  // spin on forever.
  for (let n = 1; n <= 1000; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    try {
      Deno.lstatSync(name);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return name;
      throw e;
    }
  }
  throw new Error(
    `${base}: 1000 names already taken beside it — clear the old ones out`,
  );
}

/** Sibling directories of `dir` named `<basename(dir)><infix>…`. */
function siblingsOf(dir: string, infix: string): string[] {
  const prefix = basename(dir) + infix;
  try {
    return [...Deno.readDirSync(resolve(dir, ".."))]
      .filter((e) => e.isDirectory && e.name.startsWith(prefix))
      .map((e) => join(resolve(dir, ".."), e.name))
      .sort();
  } catch {
    return []; // aio-ok: no parent to list — nothing was left there
  }
}

/** Remove a directory THIS command created (a `.partial` / `.restoring-*`
 *  it named itself) — best-effort, because it runs on the way out of a
 *  failure whose own message is the one worth reading. */
function removeTracked(path: string): void {
  try {
    Deno.removeSync(path, { recursive: true });
  } catch {
    // aio-ok: absent (the copy never started) or stuck — the failure being
    // reported already names what happened; this is cleanup.
  }
}

/** Exported for tests — the copy is the only non-trivial part. */
export const _internals = {
  copyTree,
  dirSize,
  human,
  holdForMaintenance,
} as const;

/** Re-exported so callers don't need the app-dirs module. */
export type { AppDirs };
