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
import { detectMode, out, outError } from "./am-output.ts";
import { resolveAmAppId } from "./am-utils.ts";
import { type AppDirs, appDirs, ensureAppDirs } from "../server/app-dirs.ts";
import type { AppMeta } from "../server/app-dirs.ts";
import {
  isProcessAlive,
  lockDir,
  readLock,
} from "../server/single-instance-lock.ts";

// ── Shared helpers ─────────────────────────────────────────

/** The running pid, or null when the app isn't up. */
function livePid(appId: string): number | null {
  const lock = readLock(appId);
  return lock && isProcessAlive(lock.pid) ? lock.pid : null;
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
function copyTree(from: string, to: string): number {
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
  Deno.mkdirSync(to, { recursive: true });
  for (const e of Deno.readDirSync(from)) {
    const src = join(from, e.name);
    const dst = join(to, e.name);
    if (e.isDirectory) {
      files += copyTree(src, dst);
    } else if (e.isFile) {
      Deno.copyFileSync(src, dst); // preserves mode
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

/** `am backup [dest] [--force]` — copy `<data>/` to `dest`
 *  (default `./<appId>-backup-<stamp>`). */
export function cmdBackup(args: string[], flags: GlobalFlags): void {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const d = appDirs(appId);
  const force = args.includes("--force") || flags.force === true;
  const destArg = args.find((a) => !a.startsWith("--"));
  const dest = resolve(destArg ?? `${appId}-backup-${stamp()}`);

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
        `capture a torn write. Run "am stop ${appId}" first, or ` +
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

  const files = copyTree(d.data, dest);
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
export function cmdRestore(args: string[], flags: GlobalFlags): void {
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
      `"${appId}" is running (pid ${pid}) — run "am stop ${appId}" first`,
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

  ensureAppDirs(d);
  // Move the current data aside rather than deleting: a restore is exactly when
  // the user is already having a bad day, and "wrong archive" must be recoverable.
  let aside: string | null = null;
  if ([...Deno.readDirSync(d.data)].length > 0) {
    aside = `${d.data}.replaced-${stamp()}`;
    Deno.renameSync(d.data, aside);
    ensureAppDirs(d);
  }
  const files = copyTree(src, d.data);
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

/** Exported for tests — the copy is the only non-trivial part. */
export const _internals = { copyTree, dirSize, human } as const;

/** Re-exported so callers don't need the app-dirs module. */
export type { AppDirs };
