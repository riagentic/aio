// updates-owned.ts — what this app's updater made beside the install, on
// record.
//
// An update leaves things beside the install: a download, an unpacked tree,
// the version it replaced. Some are leftovers a later boot has to remove. The
// folder they sit in is not the updater's — it is the user's (`~/Apps`,
// `Downloads`) — so a NAME proves nothing: `notes.staged-1.2.3` can be
// somebody's folder, `notes.zip-2024` somebody's archive, and a sweep that
// went by name deleted both.
//
// So every such thing is written down in the app's own data directory BEFORE
// it is made (a crash leaves a record with nothing behind it, never a thing
// with no record), with the filesystem's own identity of it once it exists.
// The updater deletes a path only when the record names it AND what is there
// now is the very object it made. Nothing is written INTO what it makes: an
// unpacked macOS bundle is sealed, and one more file breaks the seal.
//
// What builds older than the record made is on no record. A look at it can
// say "this is a copy of the app", never "the updater made it" — so that
// look is taken ONCE (`adoptOlder`), for the exact names those builds used,
// and what passes goes on the record. After that the record alone decides.

import { createHash } from "node:crypto";
import { basename, dirname, join } from "@std/path";
import { renameOverSync } from "../diagnostics/rename-over.ts";
import { isProcessAlive } from "./single-instance-lock.ts";

/** One thing the updater made, or is about to make. */
export type Owned = {
  path: string;
  kind: "file" | "dir";
  /** `temp`: a leftover once nobody is working on it — a boot removes it.
   *  `kept`: a version set aside for a rollback — only pruning removes it. */
  role: "temp" | "kept";
  /** {@linkcode identity} of the thing. Absent between the record and the
   *  creation: then only an EMPTY directory is provably ours. */
  is?: string;
  /** A FILE's `<bytes>:<sha256>` ({@linkcode sumOf}), taken when it was made.
   *  Identity alone is only a hint for a file: on NTFS a file made under a
   *  deleted one's name inherits its creation time (tunnelling), and Deno's
   *  file number there is rounded (the 64-bit id is above 2^53) — two files
   *  can share an identity string. The bytes cannot. */
  sum?: string;
  /** `filling`: a kept copy that is being written — not a whole build until
   *  this goes. A boot removes one nobody is filling any more.
   *  `moving`: an intent, not a fact — the object `is` names (the install)
   *  is about to be moved to `path` by the swap helper. It never replaces the
   *  entry for what IS at `path` now; it matches only once that object is
   *  there, and a start with no update in flight settles it: kept as a plain
   *  entry when the move happened, dropped when it did not. */
  state?: "filling" | "moving";
  pid: number;
  /** Which run of that pid: in a container the app is pid 1 at every boot. */
  boot: string;
  at: string;
};

const BOOT = crypto.randomUUID();

/** The stat, replaceable by a test (a file system with no creation time).
 *  @internal */
export const _ownedDeps = {
  lstat: (path: string): Deno.FileInfo => Deno.lstatSync(path),
};

export function ownedPath(dataDir: string): string {
  return join(dataDir, "update-artifacts.json");
}

/** What the filesystem says a path IS, in a form a rename keeps and another
 *  object at the same name does not have: kind, device, file number, creation
 *  time. Null for nothing, for a link (never followed, never ours), and where
 *  the filesystem gives no creation time: a file number alone is handed to
 *  the next object made after a delete, so it proves nothing. */
export function identity(path: string): string | null {
  let s: Deno.FileInfo;
  try {
    s = _ownedDeps.lstat(path);
  } catch {
    return null; // aio-ok: nothing there (or unreadable) — no identity
  }
  if (!s.isFile && !s.isDirectory) return null; // a link is neither
  const born = s.birthtime?.getTime();
  if (born === undefined) return null;
  return `${s.isDirectory ? "dir" : "file"}:${s.dev}:${s.ino}:${born}`;
}

/** `<bytes>:<sha256>` of the file at `path`, or null when it cannot be read
 *  as one. About 80 ms for 150 MB (measured, warm cache): it runs when the
 *  updater makes a file, and before it removes or rolls back to one. */
export function sumOf(path: string): string | null {
  try {
    using f = Deno.openSync(path);
    const h = createHash("sha256");
    const buf = new Uint8Array(1 << 20);
    let size = 0;
    for (let n = f.readSync(buf); n !== null && n > 0; n = f.readSync(buf)) {
      size += n;
      h.update(buf.subarray(0, n));
    }
    return `${size}:${h.digest("hex")}`;
  } catch {
    return null; // aio-ok: a folder, gone, or unreadable — no bytes to prove
  }
}

/** Is `path` a real file or folder on a file system that gives no creation
 *  time — a thing the record can name and never prove? */
function unprovable(path: string): boolean {
  try {
    const s = _ownedDeps.lstat(path);
    return (s.isFile || s.isDirectory) && !s.birthtime;
  } catch {
    return false; // aio-ok: nothing there
  }
}

/** Bytes in the file or tree at `path` (links not followed). */
function sizeOf(path: string): number {
  try {
    const s = Deno.lstatSync(path);
    if (!s.isDirectory) return s.isFile ? s.size : 0;
    return [...Deno.readDirSync(path)].reduce(
      (n, e) => n + sizeOf(join(path, e.name)),
      0,
    );
  } catch {
    return 0; // aio-ok: gone or unreadable meanwhile — the size is for a log line
  }
}

/** Why `path` cannot be looked at — null when it can, or is not there. */
function cannotLook(path: string): string | null {
  try {
    _ownedDeps.lstat(path);
    return null;
  } catch (e) {
    return e instanceof Deno.errors.NotFound ? null : String(e);
  }
}

function exists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false; // aio-ok: nothing there
  }
}

/** The file: what was made, and when the one look at older builds' things
 *  was taken (absent: not yet). */
type Rec = { adopted?: string; made: Owned[] };

/** The record. A missing file is an empty record; one that cannot be read or
 *  parsed THROWS — with no record nothing is provably ours, and saying so is
 *  the caller's job. */
function read(dataDir: string): Rec {
  let text: string;
  try {
    text = Deno.readTextFileSync(ownedPath(dataDir));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return { made: [] };
    throw e;
  }
  const rec = JSON.parse(text);
  if (!Array.isArray(rec?.made)) throw new Error("not a record");
  return {
    ...(typeof rec.adopted === "string" ? { adopted: rec.adopted } : {}),
    made: rec.made.filter((e: Owned): e is Owned =>
      typeof e?.path === "string" && (e.kind === "file" || e.kind === "dir")
    ),
  };
}

/** What the record says was made. */
export function readOwned(dataDir: string): Owned[] {
  return read(dataDir).made;
}

function write(dataDir: string, rec: Rec): void {
  const path = ownedPath(dataDir);
  const tmp = `${path}.tmp-${Deno.pid}`;
  const f = Deno.openSync(tmp, { write: true, create: true, truncate: true });
  try {
    f.writeSync(new TextEncoder().encode(JSON.stringify(rec, null, 2) + "\n"));
    f.syncSync();
  } finally {
    f.close();
  }
  renameOverSync(tmp, path);
}

function writeOwned(dataDir: string, made: Owned[]): void {
  write(dataDir, { ...read(dataDir), made });
}

/** Is what is at `path` now the thing `e` records? An entry with no identity
 *  yet proves only an empty directory — removing one loses nothing. A file
 *  needs its bytes too (`sum`); `deep: false` checks only their count — for
 *  naming and counting, never before removing or rolling back. */
function matches(e: Owned, path: string, deep = true): boolean {
  const is = identity(path);
  if (is === null) return false;
  if (e.is !== undefined) {
    if (e.is !== is) return false; // the kind is part of it
    if (is.startsWith("dir:")) return true;
    if (e.sum === undefined) return false;
    return deep
      ? sumOf(path) === e.sum
      : `${_ownedDeps.lstat(path).size}` === e.sum.split(":")[0];
  }
  try {
    return [...Deno.readDirSync(path)].length === 0;
  } catch {
    return false; // aio-ok: a file, or unreadable — not provably empty
  }
}

/** Did this app's updater make what is at `path`? */
export function isOwn(dataDir: string, path: string): boolean {
  return ownEntry(dataDir, path) !== undefined;
}

/** The record's entry for what is at `path`, while it is that very thing. */
export function ownEntry(
  dataDir: string,
  path: string,
  deep = true,
): Owned | undefined {
  return readOwned(dataDir).find((e) =>
    e.path === path && matches(e, path, deep)
  );
}

/** Refuse when something that is not ours is at `path`. */
export function assertNotInTheWay(dataDir: string, path: string): void {
  try {
    _ownedDeps.lstat(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return;
    // Denied, say: something is there that this app may not even look at —
    // not "nothing", or the update downloads and then fails on it.
    throw new Error(
      `${path} is in the way of the update: it cannot be looked at (${e}) — ` +
        `nothing was changed. Move it or remove it, then update again.`,
    );
  }
  if (isOwn(dataDir, path)) return;
  throw new Error(
    `${path} is in the way of the update, and it was not made by this ` +
      `app's updater — nothing was changed. Move it or remove it, then ` +
      `update again.`,
  );
}

/** Write down that `path` is about to be made — BEFORE making it. `is` when
 *  the thing already exists under another name and is about to be renamed
 *  here. Refuses (`assertNotInTheWay`) when something foreign is there. */
export function record(
  dataDir: string,
  path: string,
  kind: Owned["kind"],
  o: {
    role?: Owned["role"];
    is?: string | null;
    sum?: string | null;
    moving?: true;
  } = {},
): void {
  assertNotInTheWay(dataDir, path);
  writeOwned(dataDir, [
    // A move only intended keeps the entry for what is there now.
    ...readOwned(dataDir).filter((e) =>
      e.path !== path || (o.moving && e.state !== "moving")
    ),
    {
      path,
      kind,
      role: o.role ?? "temp",
      ...(o.is ? { is: o.is } : {}),
      ...(o.sum ? { sum: o.sum } : {}),
      ...(o.moving ? { state: "moving" as const } : {}),
      pid: Deno.pid,
      boot: BOOT,
      at: new Date().toISOString(),
    },
  ]);
}

/** {@linkcode record}, and remove a leftover of ours that is already there. */
export function claim(
  dataDir: string,
  path: string,
  kind: Owned["kind"],
  o: Parameters<typeof record>[3] = {},
): void {
  record(dataDir, path, kind, o);
  try {
    Deno.removeSync(path, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

/** What was at `path` is gone: off the record. */
export function forget(dataDir: string, path: string): void {
  writeOwned(dataDir, readOwned(dataDir).filter((e) => e.path !== path));
}

/** The thing at a recorded `path` now exists: write down which one it is. */
export function made(
  dataDir: string,
  path: string,
  o: { filling?: true } = {},
): void {
  const is = identity(path);
  const sum = is?.startsWith("file:") ? sumOf(path) : null;
  writeOwned(
    dataDir,
    readOwned(dataDir).map((e) => {
      if (e.path !== path || is === null) return e;
      const { state: _, sum: _was, ...made } = e;
      return {
        ...made,
        is,
        ...(sum ? { sum } : {}),
        ...(o.filling ? { state: "filling" as const } : {}),
      };
    }),
  );
}

/** Is `name`, in the folder of the install `base`, a name an update gives
 *  what it makes? Only these are looked at — and one with no record is named,
 *  never removed. `.aio-update-<8 hex>` is the download folder of builds up
 *  to 1.0.16, which names no app. */
function looksLikeOurs(name: string, base: string): boolean {
  return name.startsWith(base) &&
      /^\.(?:(?:staged|zip|new|old|failed|swept)-.+|rollback.*)$/.test(
        name.slice(base.length),
      ) ||
    name.startsWith(`.aio-update-${base}.`) || OLD_STAGE.test(name);
}

/** The names builds up to 1.0.16 gave what they made beside the install —
 *  `<install>.old-<version>` and so on, a version as those builds wrote it —
 */
const OLD_NAME = /^\.(?:(staged|old|zip|new)-\d[0-9A-Za-z.+-]*|failed-\d+)$/;
const OLD_STAGE = /^\.aio-update-[0-9a-f]{8}$/;

/** How long an older build's leftover must have been untouched before it is
 *  taken over — the hour those builds themselves waited before removing one.
 *  Younger, somebody may still be making it: another copy of the app running
 *  from the same folder with its own data directory. */
export const OLD_STAGE_AGE_MS = 60 * 60_000;

/** Take over what builds older than the record made beside `install` — ONCE
 *  per record: the first call that finds no mark of it.
 *
 *  A thing is taken only under one of the exact names those builds used AND
 *  when `proof` holds for its content. That cannot tell the updater's copy
 *  from a copy somebody made by hand under the very same name — which is why
 *  it happens once, at the moment those builds' things are most likely all
 *  there is, and never again. What passes goes on the record as the very
 *  object it is (`.old-<v>` kept, the rest leftovers), as if this build had
 *  made it. A leftover that passes and is younger than an hour is not taken
 *  yet, and the look stays open until a boot finds none such. Returns the
 *  names taken; null when the look was taken before (the record's mark). */
export function adoptOlder(
  dataDir: string,
  install: string,
  proof: (path: string) => boolean,
): string[] | null {
  const rec = read(dataDir);
  if (rec.adopted) return null;
  const dir = dirname(install), base = basename(install);
  const at = new Date().toISOString();
  // What each is by nature: an unpacked tree, a download, and a kept-aside
  // copy of whatever the install itself is.
  const natural: Record<string, string> = {
    staged: "dir",
    zip: "file",
    new: "file",
    old: identity(install)?.startsWith("dir:") ? "dir" : "file",
  };
  const taken: Owned[] = [];
  let waiting = false;
  for (const d of [...Deno.readDirSync(dir)]) {
    const old = d.name.startsWith(base)
      ? OLD_NAME.exec(d.name.slice(base.length))
      : null;
    if (!old && !OLD_STAGE.test(d.name)) continue;
    const path = join(dir, d.name);
    // Already on the record (a look taken again after its mark was lost):
    // what the record says of it — a copy still filling, say — stands.
    if (rec.made.some((e) => e.path === path)) continue;
    const is = identity(path);
    if (is === null) continue;
    const kind = is.startsWith("dir:") ? "dir" : "file";
    if (old?.[1] && natural[old[1]] !== kind) continue;
    if (!proof(path)) continue;
    const touched = Deno.lstatSync(path).mtime?.getTime() ?? 0;
    if (old?.[1] !== "old" && Date.now() - touched < OLD_STAGE_AGE_MS) {
      waiting = true;
      continue;
    }
    const sum = kind === "file" ? sumOf(path) : null;
    if (kind === "file" && sum === null) continue;
    taken.push({
      path,
      kind,
      role: old?.[1] === "old" ? "kept" : "temp",
      is,
      ...(sum ? { sum } : {}),
      pid: Deno.pid,
      boot: "",
      at,
    });
  }
  write(dataDir, {
    ...(waiting ? {} : { adopted: at }),
    made: [...rec.made, ...taken],
  });
  return taken.map((e) => basename(e.path));
}

/** Remove the leftovers of unfinished updates beside `install` — a boot's
 *  job when no update is in flight.
 *
 *  Removed: a `temp` entry of the record that nobody is working on (its
 *  process is gone; the same pid in an earlier run counts as gone) and whose
 *  path still holds the very thing recorded. Each is renamed aside before
 *  this returns — under a name that is on record first — and deleted after.
 *  An entry with nothing behind it is dropped.
 *
 *  `left`: names beside the install that look like the updater's and are not
 *  provably ours — never touched. `unproven`: recorded things on a file
 *  system that gives no creation time — on the record, never provable, so
 *  never removed either (nor pruned). */
export function sweepOwned(
  dataDir: string,
  install: string,
  o: { alive?: (pid: number) => boolean } = {},
): Promise<{
  removed: string[];
  left: string[];
  unproven: { path: string; bytes: number }[];
  /** Kept copies whose name now holds something else: off the record. */
  dropped: string[];
  /** Names that look like the updater's and cannot be looked at (denied):
   *  whose they are cannot be known — left, and on the record if they were. */
  unreadable: { name: string; error: string }[];
}> {
  const alive = o.alive ?? isProcessAlive;
  const dir = dirname(install), base = basename(install);
  const busy = (e: Owned) =>
    e.boot === BOOT || (e.pid !== Deno.pid && alive(e.pid));
  const before = readOwned(dataDir);
  let ledger = before;
  const claimed: { name: string; at: string }[] = [];
  const unproven: string[] = [];
  const dropped: string[] = [];
  // Ours or not, it cannot be told: kept on the record, and said as it is.
  const unreadable = new Map<string, string>();
  let n = 0;
  const take = (e: Owned) => {
    // A free name: a rename onto a file that is there would replace it, and
    // what is there may be anybody's.
    let at = join(dir, `${base}.swept-${Deno.pid}-${n++}`);
    while (exists(at)) at = join(dir, `${base}.swept-${Deno.pid}-${n++}`);
    const aside = { ...e, path: at, pid: Deno.pid, boot: "" };
    try {
      // On record under its new name FIRST: a crash right after the rename
      // leaves a record of it, not an unknown folder.
      writeOwned(dataDir, [...ledger, aside]);
      Deno.renameSync(e.path, at);
      ledger = [...ledger.filter((x) => x !== e), aside];
      claimed.push({ name: basename(e.path), at });
    } catch {
      // aio-ok: held open, or not ours to move — the next boot tries again
    }
  };
  for (const e of ledger) {
    if (busy(e)) continue;
    const denied = cannotLook(e.path);
    if (denied !== null) {
      unreadable.set(basename(e.path), denied);
      continue;
    }
    if (!exists(e.path)) ledger = ledger.filter((x) => x !== e);
    else if (unprovable(e.path)) unproven.push(e.path);
    else if (e.state === "moving") {
      // No update in flight: the move happened (that object is there now —
      // the entry it replaces is void) or it never will.
      const { state: _, ...moved } = e;
      ledger = matches(e, e.path)
        ? [...ledger.filter((x) => x.path !== e.path), moved]
        : ledger.filter((x) => x !== e);
    } else if (e.role !== "temp" && e.state !== "filling") {
      // A kept copy replaced by something else (a copy made by hand under
      // its name): the entry is void — dropped, and said once.
      if (!matches(e, e.path, false)) {
        ledger = ledger.filter((x) => x !== e);
        // Replaced by the updater's own newer copy (on the record as well):
        // nothing to say. Only something not ours is "something else".
        const ours = before.some((x) =>
          x !== e && x.path === e.path && matches(x, x.path, false)
        );
        if (!ours) dropped.push(basename(e.path));
      }
      continue;
    } else if (matches(e, e.path)) take(e);
    // Something else has the name now: the record of ours is void.
    else ledger = ledger.filter((x) => x !== e);
  }
  const left: string[] = [];
  try {
    for (const d of [...Deno.readDirSync(dir)]) {
      const path = join(dir, d.name);
      if (!looksLikeOurs(d.name, base)) continue;
      const denied = cannotLook(path);
      if (denied !== null) {
        unreadable.set(d.name, denied);
        continue;
      }
      if (
        !unproven.includes(path) &&
        !ledger.some((e) =>
          e.path === path && (busy(e) || matches(e, path, false))
        )
      ) left.push(d.name);
    }
  } catch {
    // aio-ok: the install's folder cannot be listed — nothing to look at
  }
  if (ledger !== before) writeOwned(dataDir, ledger);
  return Promise.all(claimed.map(async ({ name, at }) => {
    try {
      await Deno.remove(at, { recursive: true });
      return name;
    } catch {
      return null; // aio-ok: a file in it is held — it goes at a later boot
    }
  })).then((names) => ({
    removed: names.filter((n) => n !== null),
    left,
    unproven: unproven.map((path) => ({ path, bytes: sizeOf(path) })),
    dropped,
    unreadable: [...unreadable].map(([name, error]) => ({ name, error })),
  }));
}
