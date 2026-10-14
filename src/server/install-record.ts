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

import { basename, dirname, join, resolve } from "@std/path";
import { installedAppPaths } from "./app-dirs.ts";
import { log } from "../diagnostics/logger-api.ts";
import { HeldOpenError, renameOver } from "../diagnostics/rename-over.ts";
import {
  ownPidNs,
  ownPidTag,
  taggedOwnerGone,
} from "./single-instance-lock.ts";

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

/** `rec` with the one field 1.0.19's `run.ps1` damaged put right. Under
 *  Windows PowerShell 5.1 its `--aio=$conf.aioVersion` expanded the whole
 *  parsed `deno.json` and kept `.aioVersion` as text, so the record names
 *  `@{name=…; aioVersion=1.0.19-beta; …}.aioVersion` as the aio version — the
 *  true pin is inside it. (The same call lost `artifact` and `commit`: the
 *  next update or install writes the first, nothing reads the second.) Any
 *  other record is returned as it is. Pure. */
export function repairedRecord(rec: InstallRecord): InstallRecord {
  const dump = typeof rec.aioVersion === "string"
    ? rec.aioVersion.match(/^@\{(.*)\}\.aioVersion$/s)?.[1]
    : undefined;
  if (dump === undefined) return rec;
  const pin = dump.match(/(?:^|; )aioVersion=([^;]*)/)?.[1];
  return { ...rec, aioVersion: pin || undefined };
}

export async function readRecord(name: string): Promise<InstallRecord | null> {
  try {
    const text = await Deno.readTextFile(recordPath(name));
    const parsed = JSON.parse(text) as InstallRecord;
    return parsed && typeof parsed.name === "string"
      ? repairedRecord(parsed)
      : null;
  } catch {
    return null; // absent or unreadable — an install from before this existed
  }
}

/** Put `rec` at `path` WHOLE: a temp beside it, on disk, renamed over it.
 *
 *  It was written in place — truncated, then filled — and a record that is
 *  read while it is empty reads as "no record": `am installed` drops the app,
 *  the next boot's check takes the install for one `am` does not manage, and a
 *  process killed in that instant leaves it so for good (found on macOS: a
 *  reader took `Unexpected end of JSON input` from a record being corrected).
 *
 *  What the in-place write did for the FILE is kept: a record that is a
 *  symbolic link is written THROUGH it (the temp goes beside what it names,
 *  the link stays), and the file keeps its mode. */
async function writeWhole(path: string, rec: InstallRecord): Promise<void> {
  const file = await throughLink(path);
  sweepDeadTemps(file);
  const text = JSON.stringify(rec, null, 2) + "\n";
  // A name of this CALL's own, made new: two writes of one record that
  // overlap in a process (a boot's correction beside the updater's) shared
  // `.tmp-<pid>` — the second emptied what the first had filled, and the
  // first renamed that into place.
  const tmp = `${file}.tmp-${ownPidTag()}-${_recordDeps.nonce()}`;
  const f = await Deno.open(tmp, { write: true, createNew: true });
  try {
    try {
      const bytes = new TextEncoder().encode(text);
      for (let n = 0; n < bytes.length;) n += await f.write(bytes.subarray(n));
      await f.sync();
    } finally {
      f.close();
    }
    const mode = await modeOf(file);
    if (mode !== null) await Deno.chmod(tmp, mode);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {
      // aio-ok: not removable — `e` is what is said
    });
    throw e;
  }
  try {
    await renameOver(tmp, file); // removes `tmp` itself when it fails
  } catch (e) {
    // Windows: a program that has the record open (a reader without delete
    // sharing, a backup tool) refuses the rename for as long as it looks —
    // and a held record must not stop an update. So, as before 1.0.19: over
    // the file in place, which such a holder allows. Said, since a reader may
    // catch that write half done; a failure of it is the rename's error.
    if (!(e instanceof HeldOpenError)) throw e;
    try {
      await Deno.writeTextFile(file, text);
    } catch {
      throw e; // aio-ok: the rename's refusal names the file and the cause
    }
    if (!e.repeat) {
      log.warn(
        `${file} is open in another program and could not be ` +
          `replaced — written in place instead (${e.message})`,
      );
    }
  }
}

/** The file a write to `path` lands in: what a symbolic link there names
 *  (itself not there yet, when the link names nothing), else `path`. */
async function throughLink(path: string): Promise<string> {
  try {
    if (!(await Deno.lstat(path)).isSymlink) return path;
  } catch {
    return path; // aio-ok: no record yet — it is made at `path`
  }
  try {
    return await Deno.realPath(path);
  } catch {
    // aio-ok: a link to a file that is not there — where the link points
    return resolve(dirname(path), await Deno.readLink(path));
  }
}

/** The permission bits of the file at `path`; null when there is none, or
 *  on Windows, where they are not the file's access. */
async function modeOf(path: string): Promise<number | null> {
  if (Deno.build.os === "windows") return null;
  try {
    const mode = (await Deno.stat(path)).mode;
    return mode === null ? null : mode & 0o777;
  } catch {
    return null; // aio-ok: a new record — the umask's default, as ever
  }
}

/** What a test replaces: the part of a temp's name that is one write's own.
 *  @internal */
export const _recordDeps = {
  nonce: (): string => crypto.randomUUID().slice(0, 8),
};

/** A record's temp: `<record>.tmp-<pid tag>-<nonce>` — and the shapes older
 *  builds wrote, `.tmp-<pid>-<nonce>` (1.0.19) and `.tmp-<pid>`. Groups: pid,
 *  namespace hex, nonce. */
const TEMP_TAG = /^(\d+)(?:d([0-9a-f]{8}))?(-[0-9a-z]+)?$/;

/** Remove the temps beside the record at `path` whose writer is gone: a
 *  process killed between the write and the rename left its
 *  `installed.json.tmp-<pid tag>-<nonce>` for good. One a LIVE process names
 *  is a write in flight and stays — this process's own too, except in the
 *  older `.tmp-<pid>` shape, which this build never writes.
 *
 *  A pid is judged only in the namespace that wrote it (`taggedOwnerGone`):
 *  a container and its host share `~/app/<name>` through a bind mount, and
 *  the host took the container's write in flight for a dead process's — its
 *  pid is nobody's out here. Another namespace's temp, or one that names
 *  none where there is one, goes by age alone. */
function sweepDeadTemps(path: string): void {
  const name = basename(path);
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dirname(path))];
  } catch {
    return; // aio-ok: no folder yet — nothing to remove
  }
  // EACH one: a remove that failed (a sibling swept it first) used to end
  // the sweep for every temp after it.
  for (const e of entries) {
    if (!e.isFile || !e.name.startsWith(`${name}.tmp-`)) continue;
    const m = TEMP_TAG.exec(e.name.slice(name.length + 5));
    if (!m) continue;
    const file = join(dirname(path), e.name);
    const pid = Number(m[1]);
    const ours = pid === Deno.pid &&
      (m[2] === undefined ? undefined : parseInt(m[2], 16)) === ownPidNs();
    if (ours ? m[3] !== undefined : !taggedOwnerGone(file, pid, m[2])) continue;
    try {
      Deno.removeSync(file);
    } catch { /* aio-ok: swept by a sibling first — the next one is tried */ }
  }
}

export async function writeRecord(rec: InstallRecord): Promise<string> {
  const path = recordPath(rec.name);
  await Deno.mkdir(installedAppPaths(rec.name).dir, { recursive: true });
  const full: InstallRecord = {
    ...rec,
    installedAt: rec.installedAt ?? new Date().toISOString(),
  };
  await writeWhole(path, full);
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
    ...repairedRecord(rec),
    version: next.version ?? rec.version,
    artifact: next.artifact ?? rec.artifact,
    installedAt: new Date().toISOString(),
  };
  try {
    await writeWhole(path, updated);
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
  // `basename`, not "after the last `/`": a Windows install path has no `/`,
  // so the RUNNING version was not recognised as current and could be pruned.
  const currentName = opts.current ? basename(opts.current) : "";
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
//
// What a command ANSWERS is printed as plain lines: the scripts take stdout as
// the value (`prev_src=$(… conflict …)`), and through the logger each line
// arrived as "2026-… INFO aio <value>" — which is what `run.sh` then showed as
// the pruned versions and as "installed from:". A refusal goes to stderr
// through the logger as before; no script reads it.

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
    console.log(path); // aio-ok: the answer itself — a script reads it
    Deno.exit(0);
  }
  if (cmd === "conflict") {
    const prev = await conflictingSource(name, kv.get("source") ?? "");
    if (prev) console.log(prev); // aio-ok: the answer itself, as above
    Deno.exit(0);
  }
  if (cmd === "prune") {
    const removed = await pruneVersions({
      dir: installedAppPaths(name).dir,
      keep: Number(kv.get("keep") ?? "3"),
      current: kv.get("current") || undefined,
    });
    for (const r of removed) console.log(r); // aio-ok: the answer itself
    Deno.exit(0);
  }
  log.error(`install-record: unknown command "${cmd}"`);
  Deno.exit(2);
}
