// install-record.ts — what is installed in ~/app/<name>/, and where it came from.
//
// The install directory used to be files and nothing else: an artifact, a
// symlink, an icon. Three questions had no answer.
//
//   • WHERE DID THIS COME FROM? `am installed` could only guess a version out
//     of a filename, and "which repo is this?" was unanswerable.
//   • IS THIS THE SAME APP? Two repos named `demo` install to the same
//     directory AND share `~/.demo/` — so the second silently replaced the
//     first's program and inherited its data. Silent, and data-adjacent.
//   • HOW DO I UPDATE IT? Nothing recorded the source, so `am upgrade` had
//     nothing to re-run.
//
// One small JSON file answers all three. The FORMAT lives here rather than in
// the shell that writes it: `run.sh` calls this module's CLI, `am` reads it
// through these functions, and a format known to two writers is a format that
// drifts.

import { join } from "@std/path";
import { installedAppPaths } from "./app-dirs.ts";
import { log } from "../diagnostics/logger-api.ts";

/** What an install knows about itself. Every field is optional except `name`:
 *  a record written from a directory with no git, no version and no remote is
 *  still worth more than no record. */
export type InstallRecord = {
  name: string;
  /** The app's own version (deno.json `version`) at install time. */
  version?: string;
  /** File name of the artifact this record was written for. */
  artifact?: string;
  /** Where it was installed FROM: a git URL, or a local path. */
  source?: string;
  /** The commit that was built, when the source was a git checkout. */
  commit?: string;
  /** Effective client at install time (electron, browser, cli, …). */
  target?: string;
  /** The aio version the app built against — its pin, not the installer's. */
  aioVersion?: string;
  installedAt?: string;
};

export function recordPath(name: string): string {
  return join(installedAppPaths(name).dir, "installed.json");
}

export async function readRecord(name: string): Promise<InstallRecord | null> {
  try {
    const text = await Deno.readTextFile(recordPath(name));
    const parsed = JSON.parse(text) as InstallRecord;
    return parsed && typeof parsed.name === "string" ? parsed : null;
  } catch {
    return null; // absent or unreadable — an install from before this existed
  }
}

export async function writeRecord(rec: InstallRecord): Promise<string> {
  const path = recordPath(rec.name);
  await Deno.mkdir(installedAppPaths(rec.name).dir, { recursive: true });
  const full: InstallRecord = {
    ...rec,
    installedAt: rec.installedAt ?? new Date().toISOString(),
  };
  await Deno.writeTextFile(path, JSON.stringify(full, null, 2) + "\n");
  return path;
}

/** Bring an install record in line with a version the IN-APP updater just
 *  swapped in.
 *
 *  `installed.json` had exactly one writer — `run.sh` — so an app that updated
 *  itself five times still reported the version it was first installed at.
 *  `am installed` was wrong, `am upgrade` decided what to rebuild from a stale
 *  number, and its prune could delete the very version an in-flight rollback
 *  marker names as `previous`.
 *
 *  A no-op when there is no record: a bare binary somebody copied to
 *  `/usr/local/bin` is not an `am`-managed install, and inventing a record for
 *  it would make `am` claim to manage something it cannot. Never fatal — an
 *  update that worked must not be reported as failed because a bookkeeping file
 *  could not be rewritten — but never silent either. */
export async function reconcileInstalledVersion(
  dir: string,
  next: { version?: string; artifact?: string },
): Promise<boolean> {
  const path = join(dir, "installed.json");
  let rec: InstallRecord;
  try {
    rec = JSON.parse(await Deno.readTextFile(path)) as InstallRecord;
  } catch {
    return false; // not an `am`-managed install — nothing to keep in sync
  }
  if (!rec || typeof rec.name !== "string") return false;
  const updated: InstallRecord = {
    ...rec,
    version: next.version ?? rec.version,
    artifact: next.artifact ?? rec.artifact,
    installedAt: new Date().toISOString(),
  };
  try {
    await Deno.writeTextFile(path, JSON.stringify(updated, null, 2) + "\n");
    return true;
  } catch (e) {
    log.warn(
      `[aio] update: installed ${updated.version ?? "the new version"} but ` +
        `could not update ${path} (${e}) — \`am installed\` will report the ` +
        `previous version until it is fixed by hand.`,
    );
    return false;
  }
}

/** Would installing `source` over the existing install replace a DIFFERENT
 *  app? Returns the previous source when it disagrees, else null.
 *
 *  Two projects called `demo` are not the same program, but they resolve to
 *  the same install directory and the same `~/.demo/` data. Overwriting the
 *  binary is recoverable; the data underneath it is not, and nothing said a
 *  word. Comparison is deliberately loose — the same repo over https and ssh,
 *  or with and without `.git`, is the same source. */
export async function conflictingSource(
  name: string,
  source: string,
): Promise<string | null> {
  const prev = await readRecord(name);
  if (!prev?.source || !source) return null;
  return normalizeSource(prev.source) === normalizeSource(source)
    ? null
    : prev.source;
}

/** `git@github.com:o/r.git`, `https://github.com/o/r`, `…/r/` → `github.com/o/r` */
export function normalizeSource(s: string): string {
  return s
    .trim()
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Keep the `keep` newest versioned artifacts, delete the rest — never the one
 *  the stable symlink points at.
 *
 *  Without this, `~/app/<name>/` grows by one ~156 MB AppImage per update,
 *  forever. That is the same unbounded-retention shape as a log directory with
 *  no ceiling: nothing fails, the disk just fills, and the person who notices
 *  is the one who runs out of space at an unrelated moment. Returns what was
 *  removed so the caller can say so. */
export async function pruneVersions(opts: {
  dir: string;
  /** Kept for callers that still name a base; unused by the directory layout. */
  base?: string;
  ext?: string;
  keep: number;
  /** The version DIRECTORY in use — never removed, whatever its age. */
  current?: string;
}): Promise<string[]> {
  const versionsDir = join(opts.dir, "versions");
  const dirs: { name: string; mtime: number }[] = [];
  try {
    for await (const e of Deno.readDir(versionsDir)) {
      if (!e.isDirectory) continue;
      let mtime = 0;
      try {
        mtime = (await Deno.stat(join(versionsDir, e.name))).mtime?.getTime() ??
          0;
      } catch {
        continue;
      }
      dirs.push({ name: e.name, mtime });
    }
  } catch {
    return []; // no versions/ — an install from before this layout, or none
  }
  const currentName = opts.current
    ? opts.current.replace(/\/+$/, "").split("/").pop() ?? ""
    : "";
  const doomed = dirs
    .filter((d) => d.name !== currentName)
    .sort((a, b) => b.mtime - a.mtime) // newest first
    .slice(Math.max(0, opts.keep - (currentName ? 1 : 0)));
  const removed: string[] = [];
  for (const d of doomed) {
    try {
      await Deno.remove(join(versionsDir, d.name), { recursive: true });
      removed.push(d.name);
    } catch {
      /* in use or gone — not worth failing an install over */
    }
  }
  return removed;
}

// ── CLI seam (used by run.sh) ───────────────────────────────────────────
//
// `run.sh` has every value at hand and no business formatting JSON in shell:
// a second writer of this format is how the reader and the writer come to
// disagree about a field name, silently, months later.

if (import.meta.main) {
  const [cmd, ...rest] = Deno.args;
  const kv = new Map<string, string>();
  for (const a of rest) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) kv.set(m[1]!, m[2]!);
  }
  const name = kv.get("name") ?? "";
  if (!name) {
    log.error("install-record: --name=<app> is required");
    Deno.exit(2);
  }
  if (cmd === "write") {
    const path = await writeRecord({
      name,
      version: kv.get("version") || undefined,
      artifact: kv.get("artifact") || undefined,
      source: kv.get("source") || undefined,
      commit: kv.get("commit") || undefined,
      target: kv.get("target") || undefined,
      aioVersion: kv.get("aio") || undefined,
    });
    log.info(path);
    Deno.exit(0);
  }
  if (cmd === "conflict") {
    const prev = await conflictingSource(name, kv.get("source") ?? "");
    if (prev) log.info(prev);
    Deno.exit(0);
  }
  if (cmd === "prune") {
    const removed = await pruneVersions({
      dir: installedAppPaths(name).dir,
      keep: Number(kv.get("keep") ?? "3"),
      current: kv.get("current") || undefined,
    });
    for (const r of removed) log.info(r);
    Deno.exit(0);
  }
  log.error(`install-record: unknown command "${cmd}"`);
  Deno.exit(2);
}
