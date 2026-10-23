// Boot restore — loading and migrating the persisted snapshot, the new-field
// summary, the restore drop watcher and the shape-drift refusal. Split out of
// aio-boot.ts, which re-exports every name here, so no importer changes.

import type { SkvInstance } from "./skv.ts";
import {
  detectShapeDrift,
  DRIFT_MAX_DEPTH,
  kindOf,
  MAX_DRIFT,
  type MigrationReport,
  type ShapeDriftEntry,
} from "../state/cell-migrate.ts";
import { resolve, SEPARATOR } from "@std/path";
import { migrateSchema, PERSIST_SCHEMA_VERSION } from "./persist-schema.ts";
import type { Log } from "../diagnostics/logger-api.ts";
import { applyCellFieldFilter } from "../state/state-filter.ts";
import type { CellFieldFilter } from "../state/cell-types.ts";
import { count } from "../diagnostics/fmt.ts";
import { _isObj } from "./boot-db-bindings.ts";

/** Same JSON document, key order aside — the two layouts read back through
 *  different paths (one blob vs rows ordered by key), so their key order can
 *  differ while every value agrees. */
function sameDocument(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
        Object.keys(v as Record<string, unknown>).sort().map((k) => [
          k,
          canon((v as Record<string, unknown>)[k]),
        ]),
      )
      : Array.isArray(v)
      ? v.map(canon)
      : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** The store row naming the layout (`"single"` | `"multi"`) the app booted
 *  on when the store holds the document in BOTH, with different contents. */
export const storedLayoutKey = (appId: string): string => `${appId}:__layout`;

/** Load the persisted snapshot and bring it to the current persistence
 *  schema (A4). Alpha-era snapshots have no `<appId>:__schema` stamp and
 *  read as version 0; snapshots from a NEWER schema throw `PERSIST_SCHEMA`
 *  (loud downgrade refusal). The stamp itself is written by the persistence
 *  manager AFTER successful state writes, so it can never be newer than the
 *  state it describes. Returns null when nothing is stored. */
export async function loadAndMigrateSnapshot(
  kvDb: SkvInstance,
  appId: string,
  persistKey: string,
  persistMode: "single" | "multi",
  log: Log,
): Promise<Record<string, unknown> | null> {
  const readCurrent = () =>
    persistMode === "multi"
      ? kvDb.getMulti<Record<string, unknown>>(persistKey)
      : kvDb.get<Record<string, unknown>>(persistKey);
  const readOther = () =>
    persistMode === "multi"
      ? kvDb.get<Record<string, unknown>>(persistKey)
      : kvDb.getMulti<Record<string, unknown>>(persistKey);
  const otherMode = persistMode === "multi" ? "single" : "multi";
  const retireOther = async (other: Record<string, unknown>) => {
    if (otherMode === "single") await kvDb.del(persistKey);
    else await kvDb.setMulti(persistKey, {}, Object.keys(other));
  };

  // A stored document is an object of cells. Anything else (a hand-edited or
  // foreign `42`) used to boot on defaults without a word, and the first
  // save replaced it: refused here, with the malformed-store advice the boot
  // wraps every restore failure in.
  const asDocument = (v: unknown, layout: string) => {
    if (v == null || _isObj(v)) return v as Record<string, unknown> | null;
    throw new Error(
      `persist: the stored "${layout}" document is ${
        Array.isArray(v) ? "an array" : `a ${typeof v}`
      } (${
        JSON.stringify(v).slice(0, 80)
      }), not an object of cells — refusing to boot over it, which would ` +
        `replace it at the first save`,
    );
  };
  let persisted = asDocument(await readCurrent(), persistMode);
  // `persistMode` decides the LAYOUT of the stored document (one JSON blob vs
  // one row per cell). Reading only the current layout meant that flipping the
  // mode — which docs/persistence/auto-persist.md actively recommends —
  // silently looked like a fresh install: the app booted EMPTY over a full
  // store (and, the other way round, resurrected the stale pre-switch blob).
  // Nothing is "not there" until BOTH layouts have been asked.
  const other = persisted ? await readOther() : asDocument(
    await readOther(),
    otherMode,
  );

  if (!persisted && other) {
    // Adopt: copy into the current layout, verify it reads back, and only THEN
    // retire the source — so a crash anywhere in here leaves the data readable
    // in at least one layout, never in neither.
    log.warn(
      `persist: persistMode is "${persistMode}" but the stored document is in ` +
        `the "${otherMode}" layout (${
          count(
            Object.keys(other).length,
            "key",
          )
        }) — migrating it to "${persistMode}" now. Booting empty over ` +
        `it is what this used to do, silently.`,
    );
    if (persistMode === "multi") await kvDb.setMulti(persistKey, other);
    else await kvDb.set(persistKey, other);
    const verified = await readCurrent();
    if (!verified) {
      throw new Error(
        `persist: failed to migrate the stored document from "${otherMode}" ` +
          `to "${persistMode}" layout — it was NOT copied, and nothing was ` +
          `removed. Set persistMode back to "${otherMode}" to boot on your ` +
          `data.`,
      );
    }
    // The copy is readable in the new layout; the old one is now a trap (a
    // later switch back would resurrect it as authoritative). Retire it.
    await retireOther(other);
    log.info(
      `persist: migrated the stored document ${otherMode} → ${persistMode} ` +
        `(${count(Object.keys(other).length, "key")})`,
    );
    persisted = verified;
  } else if (persisted && other && sameDocument(persisted, other)) {
    // Both layouts, byte-for-byte the SAME document: not an ambiguity but the
    // exact signature of the migration above dying between its copy and its
    // retire. Left alone, this used to take the branch below on every boot —
    // the app wrote to its layout, the twin stayed frozen at the crash, and
    // the next switch back booted on the twin: every acknowledged write since
    // silently gone from view. Retiring an identical copy loses nothing.
    await retireOther(other);
    log.warn(
      `persist: finished an interrupted ${otherMode} → ${persistMode} ` +
        `layout migration — the "${otherMode}" copy was identical to the ` +
        `"${persistMode}" one and has been retired (${
          count(Object.keys(other).length, "key")
        })`,
    );
  } else if (persisted && other) {
    // Both layouts hold data — an older aio, or a hand-edited store. Never
    // guess which is newer; boot on the configured one and say what is being
    // ignored, byte for byte still on disk. The store records which one, so
    // a reader without the app's config (`am state --offline`,
    // `readStoredState`) reads the copy the app runs on.
    if (await kvDb.get(storedLayoutKey(appId)) !== persistMode) {
      await kvDb.set(storedLayoutKey(appId), persistMode);
    }
    log.warn(
      `persist: stored state exists in BOTH layouts. Booting on the ` +
        `"${persistMode}" one (persistMode); the "${otherMode}" copy (${
          count(
            Object.keys(other).length,
            "key",
          )
        }) is IGNORED and left untouched — switch persistMode to read ` +
        `it, or delete it once you know which one you want.`,
    );
  }
  if (!persisted) return null;

  const storedSchema = await kvDb.get<number>(`${appId}:__schema`) ?? 0;
  if (storedSchema === PERSIST_SCHEMA_VERSION) return persisted;

  const result = migrateSchema(persisted, storedSchema); // throws on downgrade
  if (result.applied.length) {
    log.info(
      `persist: schema migrated v${storedSchema} → v${PERSIST_SCHEMA_VERSION} (${result.applied.length} step${
        result.applied.length === 1 ? "" : "s"
      })`,
    );
  }
  return result.state;
}

/** The boot migration picture, surfaced live via the trojan `migrations` route
 *  and `am migrations`: declared vs stored per-cell versions, what the pass did,
 *  and any unaccounted shape drift. */
export type MigrationSummary = {
  declared: Record<string, number>;
  stored: Record<string, number>;
  report: MigrationReport;
  drift: ShapeDriftEntry[];
};

/** One field the code declares that the stored snapshot does not have — a NEW
 *  state key. */
export type ShapeAdditionEntry = {
  cell: string;
  /** Dotted path within the cell. */
  path: string;
  /** The declared type, so the line can say what arrived. */
  declaredType: string;
};

/** Declared fields absent from the stored snapshot.
 *
 *  THE OTHER HALF OF `detectShapeDrift`, and the reason it exists: adding a
 *  field is SAFE — a stored blob without it deep-merges and the declared value
 *  fills the gap — but the author of one report had to reason that out from
 *  first principles, because the tool said nothing (report 8 §10). Silence
 *  on the safe case and a loud warning on the unsafe one are indistinguishable
 *  from "nobody checked": both are the absence of a sentence. The detector
 *  already walks both shapes; it simply threw this direction away.
 *
 *  A SEPARATE type and a separate line, not a fifth `issue` on
 *  `ShapeDriftEntry`, because the remedy is different — there isn't one — and
 *  because a reader scanning for problems must not have to filter the
 *  reassurance out of the warning.
 *
 *  Same caps and the same rules as the drift walk: an empty declared object is
 *  an open record (a dynamic-key map), so its keys are data rather than shape,
 *  and nothing inside one is reported. */
export function detectNewFields(
  initial: Record<string, unknown>,
  stored: Record<string, unknown>,
  opts: {
    skip?: Set<string>;
    /** Cell id → its `persist` filter. A field the cell never persists is
     *  never in the stored data, so it is not news: without this every boot of
     *  an app with updates said the built-in `updates` cell's twelve
     *  unpersisted fields were "new, or a method deleted it". */
    persist?: Record<string, CellFieldFilter>;
  } = {},
): ShapeAdditionEntry[] {
  const out: ShapeAdditionEntry[] = [];
  const skip = opts.skip ?? new Set<string>();
  const isPlainObj = (v: unknown): v is Record<string, unknown> =>
    kindOf(v) === "object";

  const walk = (
    cell: string,
    decl: unknown,
    stor: unknown,
    path: string,
    depth: number,
  ): void => {
    if (out.length >= MAX_DRIFT || depth > DRIFT_MAX_DEPTH) return;
    if (!isPlainObj(decl)) return;
    // An open record declares no keys, so it has no new ones — everything in
    // it is data.
    if (Object.keys(decl).length === 0) return;
    if (!isPlainObj(stor)) return;
    for (const [k, dv] of Object.entries(decl)) {
      // CHECKED IN THE LOOP, not only on entry. A single level with 300 new
      // keys pushes 300 before the next call ever tests the cap, which is
      // exactly the unbounded report the cap exists to prevent.
      if (out.length >= MAX_DRIFT) return;
      const p = path ? `${path}.${k}` : k;
      if (!Object.hasOwn(stor, k)) {
        out.push({ cell, path: p, declaredType: kindOf(dv) });
        // Do not descend into a field that is wholly new: "cfg.retry arrived"
        // is the fact, and listing its five sub-keys as five more arrivals is
        // the same news five times.
        continue;
      }
      walk(cell, dv, stor[k], p, depth + 1);
    }
  };

  for (const [cellId, declState] of Object.entries(initial)) {
    if (skip.has(cellId)) continue;
    const storedCell = stored[cellId];
    // A cell absent from storage entirely is a NEW CELL, not a new field. It
    // is its own event (nothing was persisted for it yet), and reporting every
    // one of its keys as an addition would bury a real one on the first boot
    // after `am create`.
    if (storedCell === undefined) continue;
    const filter = opts.persist?.[cellId];
    const persisted = filter && isPlainObj(declState)
      ? applyCellFieldFilter(filter, declState, {
        wildcard: true,
        declared: declState,
      })
      : declState;
    if (persisted === undefined) continue; // persist: "none" stores nothing
    walk(cellId, persisted, storedCell, "", 0);
  }
  return out;
}

/** The reassuring counterpart to {@linkcode shapeDriftSummary}. */
export function newFieldsSummary(added: ShapeAdditionEntry[]): string {
  if (added.length === 0) return "";
  const show = added.slice(0, 5).map((a) =>
    `${a.cell}.${a.path} (${a.declaredType})`
  );
  const more = added.length > show.length
    ? ` …and ${added.length - show.length} more`
    : "";
  // NOT "new field(s)": the stored data cannot say WHY a declared key is
  // missing. A field this build added is one reason; a method that ran
  // `delete s.key` is the other — and calling that resurrection "new … safe"
  // hid that the delete never survived the restart.
  return `state shape: ${added.length} declared field(s) not in the stored ` +
    `data, filled from \`state:\` — no migration needed — ` +
    `${show.join(", ")}${more}. Either the field is new in this build ` +
    `(adding one is safe on its own), or a method deleted it — a deleted ` +
    `declared key always comes back with its default (write null to clear ` +
    `one). (Renaming or removing a field from \`state:\` is not safe — that ` +
    `is the "shape drift" line.)`;
}

/** A persisted-document getter that also shows each document to `watch`. The
 *  watcher is observe-only: a throw inside it is swallowed with a note, so a
 *  diagnostic can never become the reason a write did not happen. */
export function withRestoreDropWatch(
  get: (s: Record<string, unknown>) => unknown,
  watch: (doc: unknown) => void,
  warn: (msg: string) => void,
): (s: Record<string, unknown>) => unknown {
  return (s) => {
    const doc = get(s);
    try {
      watch(doc);
    } catch (e) {
      warn(`persist (dev): the restore-drop check itself threw — ${e}`);
    }
    return doc;
  };
}

/** Dev only: name — once per path — a value this app WRITES that the next
 *  boot will not restore.
 *
 *  A method that adds a key to a declared non-empty object (`opts: { a: 1 }`,
 *  then `s.opts.b = 3`) or changes a field's type persisted it faithfully, and
 *  nothing was said until the NEXT boot: dev refused to start over it (it no
 *  longer does — the write stamps its declaration, see `selfWrittenDrift`),
 *  and production restored without it and wrote that back, so it was gone. The
 *  same `detectShapeDrift` the boot check runs, pointed at the document being
 *  written instead of the one being read, says it while the code that wrote
 *  it is still on screen.
 *
 *  Only cells whose slice changed since the last write are walked, and the
 *  walk is the boot check's (depth- and count-capped). `skip` holds cells a
 *  migration handled this boot — a downgrade deliberately carries fields this
 *  build does not declare. */
export function restoreDropWatcher(
  initial: Record<string, unknown>,
  skip: ReadonlySet<string>,
  warn: (msg: string) => void,
  /** `cell.path` strings already said — shared with the write-time guard
   *  (declared-shape-guard.ts), which names the method, so one fact is one
   *  line. */
  said: Set<string> = new Set<string>(),
): (doc: unknown) => void {
  const lastSlice = new Map<string, unknown>();
  return (doc) => {
    if (!_isObj(doc)) return;
    const changed: Record<string, unknown> = {};
    for (const [cell, slice] of Object.entries(doc)) {
      if (skip.has(cell) || !Object.hasOwn(initial, cell)) continue;
      if (lastSlice.get(cell) === slice) continue;
      lastSlice.set(cell, slice);
      changed[cell] = slice;
    }
    // A `null` over a declared object is not drift to the boot check (`T |
    // null` is ordinary), but restore does not keep it — see
    // `reportNullHealed` in deep-merge.ts. Said here, where it is written.
    const nulls: string[] = [];
    const walkNulls = (decl: unknown, stor: unknown, at: string, depth = 0) => {
      if (!_isObj(decl) || !_isObj(stor) || depth > 8) return;
      if (Object.keys(decl).length === 0) return; // an open record: keys are data
      for (const k of Object.keys(stor)) {
        if (nulls.length >= 20 || !Object.hasOwn(decl, k)) continue;
        if (stor[k] === null && _isObj(decl[k])) nulls.push(`${at}.${k}`);
        else walkNulls(decl[k], stor[k], `${at}.${k}`, depth + 1);
      }
    };
    for (const [cell, slice] of Object.entries(changed)) {
      walkNulls(initial[cell], slice, cell);
    }
    for (const where of nulls) {
      if (said.has(where)) continue;
      said.add(where);
      warn(
        `persist (dev): ${where} is being written as null but is declared as ` +
          `an object in the cell's \`state:\` — the next boot restores the ` +
          `declared default instead of the null (a declared object never ` +
          `takes a stored null). If null is a value it holds, declare it ` +
          `\`null as T | null\`.`,
      );
    }
    for (const d of detectShapeDrift(initial, changed)) {
      if (d.issue !== "unknown-field" && d.issue !== "type-changed") continue;
      // An undeclared key holding `undefined` loses nothing: JSON never
      // stores the key, so the next boot reads it absent — `undefined`, the
      // value that was written. The boot check never sees it either, so
      // "dev refuses to boot over it … declare a default" was advice about a
      // refusal that cannot happen (`clear() { s.meta = { a: 2, b: undefined } }`).
      if (d.issue === "unknown-field" && d.storedType === "undefined") continue;
      const where = d.path ? `${d.cell}.${d.path}` : d.cell;
      if (said.has(where)) continue;
      said.add(where);
      const dot = where.lastIndexOf(".");
      const parent = dot > 0 ? where.slice(where.indexOf(".") + 1, dot) : "";
      // A DECLARED key written as `undefined` does come back different — the
      // key is dropped, so restore puts the declared default back — but again
      // nothing is stored for dev to refuse over, so it gets its own sentence.
      if (d.storedType === "undefined") {
        warn(
          `persist (dev): ${where} is being written as undefined, which JSON ` +
            `does not store — the key is dropped, so the next boot restores ` +
            `the declared ${d.declaredType} default instead. For "no value" ` +
            `write null (declare it \`null as T | null\`).`,
        );
        continue;
      }
      warn(
        d.issue === "unknown-field"
          ? `persist (dev): ${where} (${d.storedType}) is being written but is ` +
            `not declared in the cell's \`state:\` — the next boot will NOT ` +
            `restore it (it boots without it, says so, and its next write ` +
            `deletes it). Declare it with a default` +
            `${
              parent
                ? `, or declare \`${parent}\` as \`{}\` if its keys are data`
                : ""
            }.`
          : `persist (dev): ${where} is being written as ${d.storedType} but ` +
            `is declared ${d.declaredType} in the cell's \`state:\` — the next ` +
            `boot restores the declared default instead (and says so). Keep ` +
            `the declared type, or change the declaration.`,
      );
    }
  };
}

/** The stored per-cell shape stamps (`<appId>:__shapes`, written by the
 *  persistence manager beside each slice). `{}` when absent or unreadable —
 *  which only keeps the drift check as strict as it was before stamps. */
export async function readStoredShapes(
  kvDb: { get: <T>(k: string) => Promise<T | null> },
  appId: string,
  log: Log,
): Promise<Record<string, string>> {
  try {
    return await kvDb.get<Record<string, string>>(`${appId}:__shapes`) ?? {};
  } catch (e) {
    log.warn(
      `persist: could not read the stored shape stamps (${appId}:__shapes) — ` +
        `${e}. Every drift is treated as a declaration change.`,
    );
    return {};
  }
}

/** The sentence for drift THIS declaration's own methods wrote — restored as
 *  the declared default, in dev and production alike. Pure. */
export function selfWrittenDrift(entries: ShapeDriftEntry[]): string {
  const fields = entries.map((d) => {
    const where = d.path ? `${d.cell}.${d.path}` : d.cell;
    return d.issue === "type-changed"
      ? `${where} (${d.storedType} stored, ${d.declaredType} declared)`
      : `${where} (${d.storedType} stored, not declared)`;
  });
  return `persist: ${entries.length} stored field(s) do not match the ` +
    `declared shape — ${fields.join(", ")} — and this app's own methods ` +
    `wrote them under the current \`state:\` (it has not changed since), so ` +
    `boot goes on: they are NOT restored (the declared default is used; an ` +
    `undeclared key is dropped) and the next write replaces them on disk. ` +
    `Fix the method that wrote them — a value of the wrong type (e.g. an ` +
    `\`am dispatch\` argument that arrived as text) or a key \`state:\` does ` +
    `not declare — or change the declaration to hold it.`;
}

/** The dev-mode refusal for unmigrated structural drift: per cell, the
 *  drifted keys, then the two ways out. Pure — testable without a boot. */
export function shapeDriftRefusal(
  structural: ShapeDriftEntry[],
  summary: string,
  store?: DriftStore,
): string {
  const byCell = new Map<string, string[]>();
  for (const d of structural) {
    const keys = byCell.get(d.cell) ?? [];
    keys.push(
      d.issue === "type-changed"
        ? `${d.path} (${d.storedType} stored, ${d.declaredType} declared)`
        : `${d.path} (stored, not declared)`,
    );
    byCell.set(d.cell, keys);
  }
  const cells = [...byCell].map(([cell, keys]) =>
    `  cell "${cell}": ${keys.join(", ")}`
  );
  return (
    `persist: REFUSING to boot (dev) — ${structural.length} stored field(s) ` +
    `no longer match the declared shape and no onMigrate accounts for ` +
    `them:\n${cells.join("\n")}\n` +
    `fix: bump the cell's \`version\` and add \`onMigrate\` to transform ` +
    `the stored slice — or, if the field is not meant to persist at all, ` +
    `exclude it (\`persist: { exclude: [...] }\`); if the app writes it on ` +
    `purpose, declare it in \`state:\`. In production this is a ` +
    `warning and those stored values are dropped by the first write; dev ` +
    `refuses so it is fixed before it ships.\n` +
    (store ? driftStoreLines(store) : "") +
    `(${summary})`
  );
}

/** Where the drifted data actually lives — the paths THIS boot opened. */
export type DriftStore = {
  /** The app's `data/` directory (appDirs(appId).data) — the backup unit. */
  dataDir: string;
  /** The SQLite file persistence read from (differs under `dbPath`). */
  dbPath: string;
  /** `AIO_APPS_DIR` when it placed the home, so an `am` run in a shell
   *  without it (which resolves `~/.<appId>`) is not a surprise. */
  appsDir?: string;
};

/** The refusal's "where, and the way out" lines (report 9b §2). The message
 *  named the cell, the key and the fix, and then "clear the stored data" with
 *  no path: the boot banner's `data` row would have answered it, but the
 *  refusal comes first, so the banner never prints. An agent spent six
 *  minutes in whole-disk `find` for a directory `appHome()` already knew.
 *  The path printed is the one opened, never re-derived. */
function driftStoreLines(store: DriftStore): string {
  // A Windows path's `\\` is a plain character to its shells: quoted as JSON
  // every one was doubled (`rm -r "C:\\\\Users\\\\…"`), so there the path is
  // printed as it is, in plain quotes when it needs any.
  const win = Deno.build.os === "windows";
  const q = (p: string) =>
    (win ? /^[\w.\\/~:@+-]+$/ : /^[\w./~:@+-]+$/).test(p)
      ? p
      : win
      ? `"${p}"`
      : JSON.stringify(p);
  const inData = resolve(store.dbPath).startsWith(
    resolve(store.dataDir) + SEPARATOR,
  );
  const env = store.appsDir
    ? ` (placed by AIO_APPS_DIR=${store.appsDir} ` +
      `— run \`am\` with the same AIO_APPS_DIR)`
    : "";
  return (
    `data: ${store.dataDir}${env} — \`am data\` lists every path\n` +
    (inData ? "" : `db: ${store.dbPath} (dbPath — outside the data dir)\n`) +
    `start fresh (DISCARDS the stored state): \`am backup\`, then ` +
    (inData
      ? `\`rm -r ${q(store.dataDir)}\``
      // PowerShell's `rm` takes its paths as ONE comma-separated list: three
      // words were "a positional parameter cannot be found" there.
      : `\`rm ${
        [store.dbPath, store.dbPath + "-wal", store.dbPath + "-shm"].map(q)
          .join(win ? ", " : " ")
      }\``) +
    `\n` +
    // The escape that keeps this data untouched. Not under AIO_APPS_DIR:
    // there `--instance` is ignored (said loudly), so offering it misleads.
    (store.appsDir
      ? ""
      : `or run this build against a PRIVATE, empty data home and leave ` +
        `this one untouched: \`am start --instance=<name>\`\n`)
  );
}
