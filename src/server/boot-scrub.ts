// Boot scrub — what a boot removes from storage before it restores: the
// slices and stray store copies of cells that must not be kept, and the
// persist-off-but-stored check. Split out of aio-boot.ts, which re-exports
// every name here, so no importer changes.

import { scrubUnstoredLines } from "./journal.ts";
import type { SkvInstance } from "./skv.ts";
import { sqliteKv } from "./skv-sqlite.ts";
import type { DB } from "../db/types.ts";
import { createDB } from "../db/async-db.ts";
import { basename, dirname, join, resolve } from "@std/path";
import type { Log } from "../diagnostics/logger-api.ts";
import { applyCellFieldFilter } from "../state/state-filter.ts";
import { unpersistedFromBase } from "../state/cell-persist-filter.ts";
import type { CellFieldFilter } from "../state/cell-types.ts";
import type { BootConfig } from "./aio-boot.ts";
import type { DbBinding } from "./boot-db-bindings.ts";

/** Delete the slices of `persist: "none"` cells that an OLDER build (or a
 *  downgrade) left in the store — and make the delete reach the disk.
 *
 *  A plain SQLite delete only unlinks: the row's bytes sit in a free page, and
 *  in the -wal, until something happens to reuse them. For the slice of a
 *  cell that declared it must never be kept (a session token, a passphrase),
 *  "gone from the table" is not "gone". So, for this one rare delete only:
 *  `secure_delete` ON (per connection — the app db is one writer worker, and
 *  nothing else runs this early in boot), delete, restore the previous
 *  setting, then `VACUUM` (older revisions of the slice sit in pages earlier
 *  saves already freed) and `wal_checkpoint(TRUNCATE)` so the old frames
 *  leave the -wal too. Every ordinary write keeps its speed. Single layout: the one blob is
 *  rewritten without the slice (the old blob's page is zeroed as it is freed);
 *  multi layout: the slice's rows are deleted. */
export async function scrubStaleSlices(
  db: DB,
  kv: SkvInstance,
  persistKey: string,
  persistMode: "single" | "multi",
  stale: string[],
): Promise<void> {
  const was = (await db.query<{ secure_delete: number }>(
    "PRAGMA secure_delete",
  )).rows[0]?.secure_delete === 1;
  await db.execute("PRAGMA secure_delete = 1");
  try {
    if (persistMode === "multi") {
      await kv.setMulti(persistKey, {}, stale);
    } else {
      const doc = await kv.get<Record<string, unknown>>(persistKey);
      if (doc) {
        const rest = { ...doc };
        for (const k of stale) delete rest[k];
        await kv.set(persistKey, rest);
      }
    }
  } finally {
    await db.execute(`PRAGMA secure_delete = ${was ? 1 : 0}`);
  }
  // secure_delete zeroes what THIS delete frees — not the older revisions of
  // the slice, which every earlier save left in pages SQLite had already
  // freed (tests/hosts.test.ts plants several and finds them). VACUUM
  // rebuilds the file from the live rows only; the checkpoint then moves it
  // out of the WAL and truncates that too.
  await db.execute("VACUUM");
  await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
}

/** The copies of the store aio keeps OUTSIDE the live file, each of which may
 *  hold a `persist: "none"` slice an older build wrote — found after the live
 *  file was scrubbed, when the slice survived intact in every one of them.
 *
 *  - `<db>.snapshot` — the rolling snapshot `checkIntegrityOnBoot` restores
 *    (`db.snapshot(path)`, VACUUM INTO): a byte-for-byte older store.
 *  - `<data>/backups/**` — the pre-migration copy `updates` takes before it
 *    installs (updates-runtime.ts).
 *  - `<home>/backups/**` — `am backup`'s default destination.
 *  - `<home>/<data>.replaced-*` — the data `am restore` moved aside, whole
 *    (store, snapshot, update backups, journal).
 *  - every JOURNAL among them, and a journal set aside beside the live one
 *    (`<journal>.unreplayed-*`): a line written before `JournalEntry.unstored`
 *    holds a `persist: "none"` call's arguments — for such a cell, its state.
 *    Rewritten over the same bytes by `scrubUnstoredLines`; the live journal
 *    is not a copy (boot replays it, and its next compaction drops the line).
 *
 *  Each is scrubbed IN PLACE rather than re-taken or deleted: a snapshot or a
 *  backup is a point in time (a rollback restores the store the old build ran
 *  on, not this one's), and only the slice that must not be kept goes.
 *
 *  Two kinds are NOT rewritten, and each is said: a quarantined database
 *  (`<db>.corrupt-*`) is the damaged original kept for a recovery tool — a
 *  rewrite could destroy what is being recovered — so it is named in a
 *  warning; and a `<db>.snapshot.tmp-*` is a snapshot a crash cut off before
 *  it was verified, which nothing ever installs — it is deleted.
 *
 *  INDEPENDENT OF THE LIVE FILE. This ran only on a boot whose live store
 *  still held a stale slice — so a crash between the live scrub and this one
 *  (or a copy put back later) left every copy holding the slice for good: the
 *  next boot found the live file clean and never looked again. Now every boot
 *  of an app with a `persist: "none"` cell checks each copy it has not already
 *  verified — cheaply: a copy is verified once, and recorded by its file
 *  signature (mtime, size, inode) in the live store's `scrubbedCopiesKey`
 *  row, only AFTER it was found clean or scrubbed. A crash at any point
 *  leaves the unrecorded copies to the next boot; a copy that changed is
 *  checked again; a different set of `persist: "none"` cells voids the record.
 *  `force` (the live file had stale slices — the cells' set just changed, or
 *  an older build ran) checks every copy regardless. */
export async function scrubStoreCopies(
  dbPath: string,
  dirs: { data: string; home: string },
  persistKey: string,
  staleOf: (stored: Record<string, unknown>) => string[],
  log: Log,
  verified: {
    kv: SkvInstance;
    key: string;
    /** The declared `persist: "none"` cells — what "clean" was judged by. */
    none: readonly string[];
    /** Action types some cell `listensTo` (`scrubUnstoredLines`). */
    listened?: readonly string[];
    force: boolean;
  },
): Promise<void> {
  const none = [...verified.none].sort();
  const prior = verified.force
    ? null
    : await verified.kv.get<ScrubbedCopies>(verified.key);
  // What a journal copy keeps depends on the listened set too: a listener
  // removed since means its kept calls can go now.
  const listened = [...new Set(verified.listened ?? [])].sort();
  const was = prior && JSON.stringify(prior.none) === JSON.stringify(none) &&
      JSON.stringify(prior.listened ?? []) === JSON.stringify(listened)
    ? prior.files
    : {};
  const seen: Record<string, string> = {};
  const sigOf = (p: string): string | null => {
    try {
      const st = Deno.statSync(p);
      return `${st.mtime?.getTime() ?? 0}:${st.size}:${st.ino ?? ""}`;
    } catch {
      return null;
    }
  };
  /** Verified before, and unchanged since — recorded again, not reopened. */
  const known = (p: string): boolean => {
    const sig = sigOf(p);
    if (sig === null || was[p] !== sig) return false;
    seen[p] = sig;
    return true;
  };
  const record = (p: string) => {
    const sig = sigOf(p);
    if (sig !== null) seen[p] = sig;
  };
  const { snapshotPathFor } = await import("./db-integrity.ts");
  const snapshot = snapshotPathFor(dbPath);
  const dbDir = dirname(resolve(dbPath));
  const dbName = basename(dbPath);
  const lstat = (p: string) => {
    try {
      return Deno.lstatSync(p);
    } catch {
      return null;
    }
  };
  const copies: string[] = lstat(snapshot)?.isFile ? [snapshot] : [];
  const quarantined: string[] = [];
  const journals: string[] = [];
  for (const e of readDirOrEmpty(dbDir)) {
    if (!e.isFile) continue;
    if (e.name.startsWith(`${dbName}.snapshot.tmp-`)) {
      const p = join(dbDir, e.name);
      // Unforced, only one a crash surely left: under `singleton: false` a
      // sibling instance may be writing a fresh one right now. FORCED (a cell
      // just became persist:"none"), every one goes, fresh or not — on
      // purpose: a torn file from before the change may hold the secret, and
      // deleting a sibling's in-flight one costs it that one snapshot (its
      // `snapshot()` rejects at the rename); the live store is untouched.
      if (!verified.force && !tornLongAgo(p)) continue;
      try {
        Deno.removeSync(p);
        log.info(
          `persist: removed ${p} — a snapshot a crash cut off before it was ` +
            `verified (nothing installs it), which may hold the ` +
            `persist:"none" slice(s) just scrubbed`,
        );
      } catch (err) {
        log.error(`persist: could not remove the torn snapshot ${p}: ${err}`);
      }
    } else if (
      e.name.startsWith(`${dbName}.corrupt-`) && !/-(wal|shm)$/.test(e.name)
    ) quarantined.push(join(dbDir, e.name));
    else if (SET_ASIDE_JOURNAL.test(e.name)) journals.push(join(dbDir, e.name));
  }
  // `am restore` moves the data it replaces aside, whole, to
  // `<data>.replaced-<stamp>[-n]` (am-cmd-data.ts) — the store, its snapshot
  // and its update backups, a copy like any other. Not scanned, a secret an
  // older build wrote stayed there for good, unsaid.
  const replacedPrefix = `${basename(dirs.data)}.replaced-`;
  const replaced = readDirOrEmpty(dirs.home)
    .filter((e) => e.isDirectory && e.name.startsWith(replacedPrefix))
    .map((e) => join(dirs.home, e.name));
  for (
    const root of [
      join(dirs.data, "backups"),
      join(dirs.home, "backups"),
      ...replaced,
    ]
  ) {
    const walk = (d: string) => {
      for (const e of readDirOrEmpty(d)) {
        const p = join(d, e.name);
        if (e.isDirectory) walk(p);
        else if (!e.isFile || /-(wal|shm|journal)$/.test(e.name)) continue;
        else if (JOURNAL_COPY.test(e.name)) journals.push(p);
        else if (e.name.includes(".corrupt-")) quarantined.push(p);
        else if (isSqliteFile(p)) copies.push(p);
      }
    };
    walk(root);
  }
  for (const p of copies) {
    if (known(p)) continue; // verified before, unchanged since
    try {
      const gone = await scrubCopy(p, persistKey, staleOf);
      // Recorded only once clean: a copy that failed is tried (and said)
      // again next boot, never marked done.
      record(p);
      if (gone.length) {
        log.info(
          `persist: removed the persist:"none" slice(s) ${gone.join(", ")} ` +
            `from the copy ${p} too — overwritten, not just unlinked`,
        );
      }
    } catch (err) {
      log.error(
        `persist: could not scrub the copy ${p} — it may still hold the ` +
          `persist:"none" slice(s) an older build wrote. Delete it (or ` +
          `take it again) if it is not needed: ${err}`,
      );
    }
  }
  const noneSet = new Set(none);
  const listenedSet = new Set(listened);
  for (const p of journals) {
    if (known(p)) continue; // this journal copy: verified before, unchanged
    try {
      const before = Deno.readFileSync(p);
      const { text, cells, kept } = scrubUnstoredLines(
        new TextDecoder().decode(before),
        noneSet,
        listenedSet,
      );
      if (cells.length > 0) overwriteInPlace(p, text, before.length);
      record(p);
      if (cells.length > 0) {
        log.info(
          `persist: removed the persist:"none" slice(s) ${cells.join(", ")} ` +
            `from the copy ${p} too — overwritten, not just unlinked`,
        );
      }
      const keptCalls = Object.values(kept).flat();
      if (keptCalls.length > 0) {
        log.warn(
          `persist: ${p} still holds the arguments of ${
            keptCalls.join(", ")
          } ` +
            `— calls on persist:"none" cell(s) ${
              Object.keys(kept).join(", ")
            } that an older build journalled as the ONLY record of the ` +
            `listensTo reaction they caused on a persisted cell. Scrubbing ` +
            `them would lose that acked write when this copy is restored, so ` +
            `they are kept. Restore the copy and let one boot replay it (its ` +
            `save compacts them away), or delete the copy once you no longer ` +
            `need it.`,
        );
      }
    } catch (err) {
      log.error(
        `persist: could not scrub the copy ${p} — it may still hold the ` +
          `persist:"none" slice(s) an older build wrote. Delete it (or ` +
          `take it again) if it is not needed: ${err}`,
      );
    }
  }
  for (const p of quarantined) {
    if (known(p)) continue; // said once already, and unchanged since
    record(p);
    log.warn(
      `persist: ${p} is a damaged copy of the store an earlier recovery ` +
        `quarantined, kept untouched for a recovery tool — it may still hold ` +
        `the persist:"none" slice(s) an older build wrote. Delete it (with ` +
        `its -wal/-shm) once you no longer need it.`,
    );
  }
  const next: ScrubbedCopies = {
    none,
    ...(listened.length > 0 ? { listened } : {}),
    files: seen,
  };
  if (JSON.stringify(next) !== JSON.stringify(prior)) {
    await verified.kv.set(verified.key, next);
  }
}

/** The declared cells outside the persist decider's answer — the
 *  `persist: "none"` cells. Empty when every cell persists (no answer).
 *  Pure. */
export function unstoredCells(
  initialState: Record<string, unknown>,
  persisting: readonly string[] | undefined,
): Set<string> {
  if (!persisting) return new Set();
  const kept = new Set(persisting);
  return new Set(Object.keys(initialState).filter((k) => !kept.has(k)));
}

/** The live-store row naming the copies verified free of `persist: "none"`
 *  slices — see `scrubStoreCopies`. Outside the snapshot's key space (`:` is
 *  not the store's separator), so no restore, store-gen trigger or journal
 *  watermark ever reads it. */
export const scrubbedCopiesKey = (appId: string): string =>
  `${appId}:__scrubbed_copies`;
type ScrubbedCopies = {
  none: string[];
  /** Absent when no cell listens to anything (the record's older shape). */
  listened?: string[];
  files: Record<string, string>;
};

/** A journal inside a copied data folder: `journal` (appDirs), `<db>.journal`
 *  (an explicit db path), or one set aside (`…journal.unreplayed-<stamp>`).
 *  Never its `.base`/`.wm` (watermarks only) or a tmp. */
const JOURNAL_COPY = /(?:^|\.)journal(?:\.unreplayed-[^.]+)?$/;
/** Beside the live store only the set-aside ones: the live journal is not a
 *  copy. */
const SET_ASIDE_JOURNAL = /(?:^|\.)journal\.unreplayed-[^.]+$/;

/** Write `text` over the file's own bytes — never a new file renamed over
 *  it, which leaves the old blocks (the secret) on the disk, unreferenced.
 *  Shorter text is padded with a blank line (every journal reader skips one)
 *  so no old byte is left past the new end. */
function overwriteInPlace(p: string, text: string, oldLen: number): void {
  let bytes = new TextEncoder().encode(text);
  if (bytes.length < oldLen) {
    const pad = oldLen - bytes.length;
    const nl = text.endsWith("\n") ? "" : "\n";
    bytes = new TextEncoder().encode(
      text + nl + " ".repeat(Math.max(0, pad - nl.length - 1)) + "\n",
    );
  }
  const f = Deno.openSync(p, { write: true });
  try {
    let at = 0;
    while (at < bytes.length) at += f.writeSync(bytes.subarray(at));
    f.syncSync();
  } finally {
    f.close();
  }
}

/** A torn snapshot old enough that no live writer can still own it. */
function tornLongAgo(p: string): boolean {
  try {
    const m = Deno.statSync(p).mtime?.getTime();
    return m !== undefined && Date.now() - m > 60 * 60_000;
  } catch {
    return false;
  }
}

function readDirOrEmpty(d: string): Deno.DirEntry[] {
  try {
    return [...Deno.readDirSync(d)];
  } catch {
    return [];
  }
}

/** Does `p` start with SQLite's 16-byte header magic? */
function isSqliteFile(p: string): boolean {
  let f: Deno.FsFile | undefined;
  try {
    f = Deno.openSync(p, { read: true });
    const b = new Uint8Array(16);
    return f.readSync(b) === 16 &&
      new TextDecoder().decode(b) === "SQLite format 3\0";
  } catch {
    return false;
  } finally {
    f?.close();
  }
}

/** Scrub one copy of the store in place: the stale slices out of BOTH layouts
 *  (a copy an older build took may hold either), with `secure_delete` and a
 *  `VACUUM` so no freed page keeps them. Its journal mode is left as it was
 *  (`PRAGMA journal_mode` with no value only reads it). Returns the slices
 *  removed; a copy that holds none is not written. */
async function scrubCopy(
  path: string,
  persistKey: string,
  staleOf: (stored: Record<string, unknown>) => string[],
): Promise<string[]> {
  const db = createDB(path, { pragmas: ["PRAGMA journal_mode"] });
  try {
    const { rows } = await db.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'aio_kv'",
    );
    if (rows.length === 0) return [];
    const kv = sqliteKv(db);
    const single = await kv.get<Record<string, unknown>>(persistKey);
    const multi = await kv.getMulti<Record<string, unknown>>(persistKey);
    const inSingle = single && typeof single === "object"
      ? staleOf(single)
      : [];
    const inMulti = multi ? staleOf(multi) : [];
    if (inSingle.length === 0 && inMulti.length === 0) return [];
    await db.execute("PRAGMA secure_delete = 1");
    if (inMulti.length) await kv.setMulti(persistKey, {}, inMulti);
    if (inSingle.length) {
      const rest = { ...single };
      for (const k of inSingle) delete rest[k];
      await kv.set(persistKey, rest);
    }
    await db.execute("VACUUM");
    await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    return [...new Set([...inSingle, ...inMulti])];
  } finally {
    await db.close();
  }
}

/** A stored document minus the declared cells that must never come back
 *  (outside `persistingCellIds` — i.e. `persist: "none"`). Undeclared keys
 *  (renamed cells, parked `__` slices) pass: boot handles those itself. */
export function restorableSlices(
  stored: Record<string, unknown>,
  persisting: readonly string[],
  declared: Record<string, unknown>,
): Record<string, unknown> {
  const keep = new Set(persisting);
  return Object.fromEntries(
    Object.entries(stored).filter(([k]) =>
      !Object.hasOwn(declared, k) || keep.has(k)
    ),
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A state document with each cell narrowed by its `persist` field filter —
 *  `applyCellFieldFilter`, the call the store's getter makes, WITHOUT the
 *  `onPersist` shape (see the checkpoint view in `bootStorage`). Cells with
 *  no filter entry, or `"all"`, pass by identity. */
export function persistedFields(
  state: Record<string, unknown>,
  filters: Record<string, CellFieldFilter> | undefined,
): Record<string, unknown> {
  if (!filters) return state;
  let out: Record<string, unknown> | null = null;
  for (const [id, filter] of Object.entries(filters)) {
    const slice = state[id];
    if (filter === "all" || !isRecord(slice)) continue;
    const kept = applyCellFieldFilter(filter, slice);
    if (kept === slice) continue;
    out ??= { ...state };
    if (kept) out[id] = kept;
    else delete out[id];
  }
  return out ?? state;
}

/** A checkpoint's state with every field `persist` keeps off disk taken from
 *  `restart` (the store-restored boot state) — so restoring a checkpoint and
 *  restarting agree on those fields (`unpersistedFromBase`, the rule journal
 *  replay uses). */
export function fieldsAsRestart(
  state: Record<string, unknown>,
  filters: Record<string, CellFieldFilter> | undefined,
  restart: Record<string, unknown>,
): Record<string, unknown> {
  if (!filters) return state;
  let out: Record<string, unknown> | null = null;
  for (const [id, filter] of Object.entries(filters)) {
    const slice = state[id];
    const base = restart[id];
    if (filter === "all" || !isRecord(slice) || !isRecord(base)) continue;
    const next = unpersistedFromBase(filter, base, slice);
    if (next === slice) continue;
    out ??= { ...state };
    out[id] = next;
  }
  return out ?? state;
}

/** What reaches `state.db` although a `persist` setting says it does not.
 *
 *  A `db:` binding and a sync cell's op-log write the file — and are restored
 *  from it — whatever `persist` says: `persist: false` / `--no-persist` turns
 *  off the state SNAPSHOT only, and a cell's `persist: "none"` / `exclude`
 *  does not reach its bound table. Both used to be silent, so a
 *  `--no-persist` session's deletes landed in the real tables, and a field an
 *  app excluded as secret was on disk in a table row. */
export function persistOffButStored(
  cfg: Pick<
    BootConfig<unknown>,
    "shouldPersist" | "dbPath" | "syncCellIds" | "cellPersist"
  >,
  bindings: readonly DbBinding[],
): string[] {
  const out: string[] = [];
  const bound = bindings.filter((b) => b.path.length > 0);
  const inMemory = cfg.dbPath !== undefined &&
    (cfg.dbPath.startsWith(":memory:") ||
      cfg.dbPath.startsWith("file::memory:"));
  if (!cfg.shouldPersist && !inMemory) {
    const what = [
      ...bound.map((b) => `db: table "${b.table}"`),
      ...cfg.syncCellIds.map((c) => `sync cell "${c}"`),
    ];
    if (what.length) {
      out.push(
        `persist: persistence is off (persist: false / --no-persist), but ` +
          `${what.join(", ")} still write${what.length === 1 ? "s" : ""} ` +
          `${cfg.dbPath ?? "the app's state.db"} and ${
            what.length === 1 ? "is" : "are"
          } restored from it — persist: false turns off the state snapshot ` +
          `only. For a throwaway run, pass dbPath: ":memory:" ` +
          `(--db-path=:memory:).`,
      );
    }
  }
  for (const b of bound) {
    const [cell, ...inner] = b.path;
    const f = cfg.cellPersist?.[cell!];
    if (!f || f === "all") continue;
    const field = inner.join(".");
    const under = (p: string) =>
      p === field || p.startsWith(field + ".") || field.startsWith(p + ".");
    const kept = f !== "none" &&
      ("exclude" in f
        ? !f.exclude.some(under)
        : f.include.some((p) => p === field || field.startsWith(p + ".")));
    if (kept) continue;
    const off = f !== "none" && "exclude" in f
      ? f.exclude.filter(under).join(", ")
      : field;
    out.push(
      `persist: cell "${cell}"'s persist filter (${
        JSON.stringify(f)
      }) keeps "${off}" off disk, but db: table "${b.table}" is bound to ` +
        `"${field}" — the table writes those rows, with every declared ` +
        `column, and restores them at boot, whatever persist says. To keep ` +
        `them off disk, remove the binding (or the column); otherwise take ` +
        `"${off}" out of the filter.`,
    );
  }
  return out;
}
