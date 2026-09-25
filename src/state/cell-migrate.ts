// cell-migrate.ts — a cell's `version`/`onMigrate` and its `onRestore`, at boot.
//
// ONE implementation for every runtime. It lived in `src/server/aio-boot.ts`,
// so only the server ran it: the standalone/Android runtime
// (`src/standalone-air.ts`, which the in-process harnesses boot too) restored
// with a bare `deepMerge` and stamped no versions — an APK update whose cell
// renamed a field lost the value (the merge dropped the old key, and
// `onMigrate` never ran to carry it over), and a cell's `onRestore` never ran
// at all. Pinned by tests/standalone-migrate-restore.test.ts. Isomorphic and
// dependency-light, so the browser bundle can carry it.
import { deepMerge, MAX_DEPTH as DEEP_MERGE_MAX_DEPTH } from "./deep-merge.ts";
import { createAioError } from "../diagnostics/error.ts";
import type { Log } from "../diagnostics/logger-api.ts";

const _isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Per-cell migration metadata — version + optional onMigrate hook */
export interface CellMigrationInfo {
  version: number;
  initialState: Record<string, unknown>;
  onMigrate?: (
    state: Record<string, unknown>,
    fromVersion: number,
  ) => Record<string, unknown>;
}

/** One stored field whose shape no longer matches the declared `initialState`. */
export type ShapeDriftEntry = {
  cell: string;
  /** Dotted path within the cell ("" = the cell itself). */
  path: string;
  issue: "unknown-field" | "type-changed" | "unknown-cell" | "seed-erased";
  storedType: string;
  /** Declared type — present for "type-changed". */
  declaredType?: string;
  /** How many declared entries the stored empty collection erases —
   *  present for "seed-erased". */
  declaredCount?: number;
};

export const MAX_DRIFT = 100;
// ONE cap with the restore: `deepMerge` prunes undeclared keys down to its
// stack guard and keeps everything below it verbatim (and says so). A drift
// walk that stopped earlier (it was 8) let the merge DROP a field 9+ levels
// down with no drift line — dev booted, prod did not warn. The merge starts
// at the whole state (depth 0 = the cells), this walk at one cell's slice, so
// the same cut is one level less here.
export const DRIFT_MAX_DEPTH = DEEP_MERGE_MAX_DEPTH - 1;

export const kindOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

/** Diff persisted cell data against the declared shape (`initialState`) and
 *  report structural drift: a stored field the current shape no longer declares
 *  (a rename/removal that `deepMerge` would silently keep → stale-shape load),
 *  or a field whose type changed. This is "declared vs stored shape" using
 *  `initialState` as the schema — no separate schema declaration to drift from
 *  the code. Data-level differences (array lengths, values) are NOT drift; only
 *  structure is — and a declared EMPTY object is an open record (dynamic-key
 *  map), so its stored keys are data too, not drift. `skip` suppresses cells a
 *  migration already accounted for.
 *
 *  Pure + capped (MAX_DRIFT entries, DRIFT_MAX_DEPTH deep) so a large stored
 *  blob can't produce an unbounded or runaway report. */
export function detectShapeDrift(
  initial: Record<string, unknown>,
  stored: Record<string, unknown>,
  opts: { skip?: Set<string> } = {},
): ShapeDriftEntry[] {
  const out: ShapeDriftEntry[] = [];
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
    if (out.length >= MAX_DRIFT) return;
    const dk = kindOf(decl);
    const sk = kindOf(stor);
    // `null` on either side carries NO shape, so there is nothing to compare
    // and nothing to migrate. `T | null` is how every app spells "not yet":
    // `user: null`, `vault: null`, `me: null` in `initialState`, holding an
    // object the moment someone signs in. Reading the declared `null` as a
    // schema made that ordinary case look like a type change, and dev REFUSED
    // TO BOOT for every app that had ever been used once — the drift this
    // check exists for is a field renamed or removed (declared `undefined`),
    // which is still caught below.
    if (dk === "null" || sk === "null") return;
    if (dk !== sk) {
      out.push({
        cell,
        path,
        issue: "type-changed",
        storedType: sk,
        declaredType: dk,
      });
      return;
    }
    // A declared collection with entries, stored empty: the restore wipes
    // whatever `state:` seeded (a field report #2 — a curated token registry
    // vanished, every holding rendered as a raw mint, nothing said). `state:`
    // reads like a default and behaves like a first-run value; both are
    // legitimate, so this is reported rather than overruled — unless the cell
    // says which it meant with `persist: { seed: [...] }`.
    // Arrays only: they are the one shape `deepMerge` replaces wholesale, so an
    // empty stored array is the only value that can delete declared entries (an
    // empty stored OBJECT merges key-by-key and erases nothing).
    if (
      Array.isArray(decl) && decl.length > 0 && Array.isArray(stor) &&
      stor.length === 0
    ) {
      out.push({
        cell,
        path,
        issue: "seed-erased",
        storedType: sk,
        declaredCount: decl.length,
      });
      return;
    }
    // Same kind. Recurse into plain objects only — arrays/primitives are data.
    if (isPlainObj(decl) && isPlainObj(stor) && depth < DRIFT_MAX_DEPTH) {
      // An EMPTY declared object is an open record (`{} as Record<K,V>` — a
      // dynamic-key map whose keys are DATA, not schema, e.g. balances keyed by
      // pubkey). Its stored keys are all legitimate, so don't flag them and
      // don't recurse — exactly how an array's elements are treated as data
      //.
      if (Object.keys(decl).length === 0) return;
      for (const key of Object.keys(stor)) {
        if (out.length >= MAX_DRIFT) return;
        const child = path ? `${path}.${key}` : key;
        if (!(key in decl)) {
          out.push({
            cell,
            path: child,
            issue: "unknown-field",
            storedType: kindOf(stor[key]),
          });
          continue;
        }
        walk(cell, decl[key], stor[key], child, depth + 1);
      }
    }
  };

  for (const cell of Object.keys(stored)) {
    if (out.length >= MAX_DRIFT) break;
    if (skip.has(cell)) continue;
    // `__…` keys are framework-parked data, not app shape.
    if (cell.startsWith("__")) continue;
    if (!(cell in initial)) {
      out.push({
        cell,
        path: "",
        issue: "unknown-cell",
        storedType: kindOf(stored[cell]),
      });
      continue;
    }
    walk(cell, initial[cell], stored[cell], "", 0);
  }
  return out;
}

/** The STRUCTURE `detectShapeDrift` judges a stored slice against, hashed:
 *  kinds and (sorted) keys, never values. Two declarations with the same
 *  fingerprint give the same structural verdict (unknown-field /
 *  type-changed) for any stored slice.
 *
 *  Stamped per cell beside every write (`<appId>:__shapes`), so the next boot
 *  can tell the two sources of drift apart: a DECLARATION that changed since
 *  the slice was written (a rename with no migration — dev refuses), and a
 *  slice THIS declaration's own methods wrote off-shape (`s.count += "abc"` —
 *  refusing there bricked the app on its own committed state). Capped at the
 *  drift walk's depth, and an empty object is an open record — both exactly
 *  as the walk treats them. */
export function shapeFingerprint(decl: unknown): string {
  // FNV-1a over the skeleton: the stamp rides in every write transaction that
  // changes it, so it is kept to 8 hex digits however large `state:` is. A
  // collision can only turn a refusal into the loud degrade, never lose data.
  const text = _skeleton(decl, 0);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function _skeleton(decl: unknown, depth: number): string {
  const k = kindOf(decl);
  if (k !== "object") return k;
  const obj = decl as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (keys.length === 0) return "{}";
  if (depth >= DRIFT_MAX_DEPTH) return "{…}";
  return `{${
    keys.map((key) =>
      `${JSON.stringify(key)}:${_skeleton(obj[key], depth + 1)}`
    )
      .join(",")
  }}`;
}

/** Per-cell outcome of the boot migration pass — inspectable + testable. */
export type CellMigrationOutcome =
  | "migrated" // onMigrate ran, version advanced
  | "stale" // version bumped but no onMigrate — kept as-is, may be stale
  | "stamped" // first `version` this cell ever declared — nothing to convert
  | "downgrade" // stored version NEWER than code — running old code on new data
  | "sync-quarantined" // a sync cell's op-log could not be folded — held at its snapshot
  | "sync-unversioned"; // a sync cell has a persisted log and no `version` (field report §3.1)
// (There is no "reset": a throwing onMigrate used to reset the cell to its
//  defaults, and the debounced persist then wrote that emptiness over the data
//  the migration was supposed to transform. It now refuses to boot instead —
//  nothing is written, so the stored bytes are still there for a fixed build.)

/** Structured report of what the migration pass did — one entry per cell that
 *  was NOT a clean no-op. Returned for inspection (`am`/tests); also logged. */
export type MigrationReport = {
  cell: string;
  from: number;
  to: number;
  outcome: CellMigrationOutcome;
}[];

/** Stored values the declared shape dropped, put back — deep, depth-capped.
 *  `deepMerge` uses `initialState` as the template and drops every stored key
 *  the running build does not declare. That is right for a rename; it is data
 *  loss for a DOWNGRADE, where the "unknown" fields are what a NEWER build
 *  wrote and a later roll-forward still needs. Declared keys are untouched —
 *  the running build's types win for anything it actually reads. */
/** One cell's `onRestore`, run the way boot runs it — error-guarded: a throw
 *  is logged and the slice is kept as it was.
 *
 *  `shaped` is set for a cell whose `onPersist` SHAPES what it writes. The
 *  restore merge drops every stored key the cell does not declare, and a
 *  reshape stores exactly such keys: the documented pair —
 *  `onPersist: (s) => ({ key: s.thumbKey })`, `onRestore` reading `s.key` —
 *  had its `key` pruned before the hook ran, so the value was gone (and dev
 *  refused to boot over the "drift"). The hook is handed the declared shape
 *  PLUS what the store holds, the way `onMigrate` is, and what it returns is
 *  narrowed back to the declared shape with the restore's own merge.
 *
 *  `retyped`: a stored value whose TYPE differs from the declared one is
 *  handed over too. The merge keeps the declared value on a type mismatch
 *  (schema wins), and a shape that changes a type is the ordinary compact
 *  one — `onPersist: (s) => ({ items: Object.values(s.items) })` stores a
 *  list where a record is declared — so its partner was handed `items: {}`
 *  and the list was gone. Off for a cell the migration pass rewrote this
 *  boot: its slice is the migration's, not the store's. */
/** Throw when a restore hook handed back a THENABLE instead of state.
 *
 *  Restore runs before the server starts and is awaited nowhere, so
 *  `onRestore: async (s) => …` returns a Promise. A Promise is an object, so
 *  every shape check passed it: the app-level hook made the whole app state a
 *  Promise (`Object.keys` of one is `[]`, so boot reported "state: 0 keys" and
 *  started), and a cell's made that cell's slice one — every read `undefined`,
 *  every method writing into a Promise, and the first persist storing `{}`
 *  over the real data. Both hooks are error-guarded, so this is reported and
 *  the restored state kept. */
export function refuseThenable(v: unknown): void {
  if (
    v !== null && typeof v === "object" &&
    typeof (v as { then?: unknown }).then === "function"
  ) {
    throw new Error(
      `returned a Promise — the restore hooks are SYNCHRONOUS (they run ` +
        `before the server starts and nothing awaits them), so an \`async\` ` +
        `hook hands back a Promise instead of state. Drop the \`async\` and ` +
        `do the awaiting work in \`onStart\` instead.`,
    );
  }
}

export function runCellRestore(
  id: string,
  hook: (state: Record<string, unknown>) => Record<string, unknown> | void,
  slice: Record<string, unknown>,
  shaped:
    | { stored: unknown; declared: unknown; retyped?: boolean }
    | undefined,
  log: Log,
): Record<string, unknown> {
  try {
    const input = shaped && _isObj(shaped.stored)
      ? reattachUndeclared(slice, shaped.stored, 0, shaped.retyped === true)
      : slice;
    const next = hook(input);
    refuseThenable(next);
    const out = next !== undefined ? next : input;
    return shaped && _isObj(shaped.declared) && _isObj(out) && out !== slice
      ? deepMerge(shaped.declared, out)
      : out;
  } catch (e) {
    log.error(`hook onRestore(${id}): ${e}`);
    return slice;
  }
}

export function reattachUndeclared(
  merged: Record<string, unknown>,
  stored: Record<string, unknown>,
  depth = 0,
  /** Also hand back a stored value the merge refused for its TYPE (never a
   *  stored `null`, which carries no type) — see `runCellRestore`. */
  retyped = false,
): Record<string, unknown> {
  if (depth >= 32) return merged;
  let out = merged;
  for (const k of Object.keys(stored)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (!(k in out)) {
      out = { ...out, [k]: stored[k] };
    } else if (_isObj(out[k]) && _isObj(stored[k])) {
      const child = reattachUndeclared(
        out[k] as Record<string, unknown>,
        stored[k] as Record<string, unknown>,
        depth + 1,
        retyped,
      );
      if (child !== out[k]) out = { ...out, [k]: child };
    } else if (
      retyped && out[k] !== null && stored[k] !== null &&
      kindOf(out[k]) !== kindOf(stored[k])
    ) {
      out = { ...out, [k]: stored[k] };
    }
  }
  return out;
}

/** Key a downgrade boot parks the pre-downgrade slice under. Framework-owned
 *  (`__` prefix ⇒ never restored into state, always carried into every
 *  persisted document verbatim). */
export const downgradeParkKey = (cell: string): string =>
  `__downgraded:${cell}`;

/** Apply cell migrations — pure logic, extracted for testability.
 *  Mutates stateObj in place for cells that need migration. */
export function applyCellMigrations(
  stateObj: Record<string, unknown>,
  cellMigrations: Map<string, CellMigrationInfo>,
  persistedVersions: Record<string, number>,
  log: Log,
  /** The RAW stored snapshot (pre-deepMerge) — lets a downgrade keep the
   *  fields the merge narrowed away. Omitted ⇒ no re-attachment. */
  storedSnapshot?: Record<string, unknown>,
  /** The declared `initialState` — onMigrate's result is narrowed to it.
   *  Omitted ⇒ the result is taken as-is (the pure unit tests). */
  initialState?: Record<string, unknown>,
  /** Cells whose `onPersist` SHAPES what they store → what that shape looks
   *  like for the declared state (as stored). Their migration is handed the
   *  stored value even where its TYPE differs from the declared one (a record
   *  stored as a list), its output is read against the shape as well as the
   *  declaration, and the raw output is left in `migratedRaw` so the cell's
   *  `onRestore` receives it the way it receives a stored slice. */
  shaped?: {
    schema: Record<string, unknown>;
    migratedRaw: Map<string, Record<string, unknown>>;
  },
): MigrationReport {
  const report: MigrationReport = [];
  for (const [cellId, info] of cellMigrations) {
    if (info.version === 0) continue; // default — no migration needed
    const persisted = persistedVersions[cellId] ?? 0;
    const cellState = stateObj[cellId] as Record<string, unknown> | undefined;
    if (persisted > info.version) {
      // Downgrade: the DB was written by NEWER code than is now running. The
      // stored shape is ahead of what this build understands, so proceeding
      // silently risks reading fields that moved or vanished. Loud + explicit —
      // mirrors the framework-schema downgrade guard, dev/prod alike.
      //
      // The old warning said "State kept as-is", which was a MISDIAGNOSIS: the
      // restore had already narrowed the slice to this build's shape (deepMerge
      // drops undeclared keys), and the next persist wrote that narrowed slice
      // back — the newer build's fields deleted, silently. Put them back before
      // anything can persist over them.
      const stored = storedSnapshot?.[cellId];
      let kept: string[] = [];
      if (_isObj(cellState) && _isObj(stored)) {
        const widened = reattachUndeclared(cellState, stored);
        kept = Object.keys(stored).filter((k) => !(k in cellState));
        stateObj[cellId] = widened;
      }
      log.warn(
        `migrate: ${cellId} stored v${persisted} is NEWER than code v${info.version} — ` +
          `running an older build against newer data. ${
            kept.length
              ? `Fields this build does not declare (${
                kept.join(", ")
              }) were kept — the restore had narrowed them away. `
              : ""
          }A verbatim copy of the stored slice is parked at ` +
          `"${downgradeParkKey(cellId)}", and the stored version stamp stays ` +
          `v${persisted} (it never regresses), so rolling forward will NOT ` +
          `re-run onMigrate over already-migrated data. Re-deploy the build ` +
          `that wrote it, or bump ${cellId}'s version and add an onMigrate ` +
          `that down-converts. Fields this build DOES declare may be misread.`,
      );
      report.push({
        cell: cellId,
        from: persisted,
        to: info.version,
        outcome: "downgrade",
      });
      continue;
    }
    if (persisted < info.version) {
      if (cellState && info.onMigrate) {
        try {
          // What the hook is HANDED matters: the restore ran `deepMerge`
          // against the NEW `initialState`, which drops every stored key the
          // new shape no longer declares — i.e. exactly the old fields a
          // rename migration exists to read (`s.cents` was already gone by the
          // time `onMigrate` looked for it, so the value it was meant to carry
          // over was lost every time). The hook sees the declared shape PLUS
          // whatever the store still holds; declared fields keep the merged
          // (typed) value.
          const stored = storedSnapshot?.[cellId];
          // A shaped cell stores its SHAPE, whose field types may differ from
          // the declaration (a record stored as a list): the merge kept the
          // declared `{}` there, so hand the stored value back — the data the
          // migration exists to carry over.
          const shape = shaped && cellId in shaped.schema
            ? shaped.schema[cellId]
            : undefined;
          const input = _isObj(stored)
            ? reattachUndeclared(cellState, stored, 0, shape !== undefined)
            : cellState;
          const migrated = info.onMigrate(input, persisted);
          // The hook was HANDED the undeclared stored keys (so a rename can
          // read the old field) — whatever it leaves behind is not this
          // build's shape. Kept, it rode into the next write and the FOLLOWING
          // boot refused over "shape drift" the migration had just handled.
          // Narrow with the SAME merge the restore runs, so this boot's state
          // is exactly what the next boot will restore.
          const declared = initialState?.[cellId];
          if (_isObj(declared) && _isObj(migrated)) {
            const off = (schema: unknown) =>
              new Set(
                detectShapeDrift(
                  { [cellId]: schema },
                  { [cellId]: migrated },
                ).filter((d) =>
                  d.issue === "unknown-field" || d.issue === "type-changed"
                ).map((d) => d.path),
              );
            // A shaped cell's output may be in the STORED form (what it was
            // handed): a field is dropped only when it fits neither the
            // declaration nor the shape. What fits the shape is its
            // `onRestore`'s to turn back, exactly as on every other boot.
            const offShape = _isObj(shape) ? off(shape) : undefined;
            const dropped = detectShapeDrift(
              { [cellId]: declared },
              { [cellId]: migrated },
            ).filter((d) =>
              (d.issue === "unknown-field" || d.issue === "type-changed") &&
              (!offShape || offShape.has(d.path))
            );
            if (_isObj(shape)) shaped!.migratedRaw.set(cellId, migrated);
            if (dropped.length) {
              log.warn(
                `migrate: ${cellId} onMigrate (v${persisted} → ` +
                  `v${info.version}) left ${dropped.length} field(s) this ` +
                  `build does not declare — ${
                    dropped.map((d) => d.path).join(", ")
                  } — dropped from state, and from disk at the first write. ` +
                  `The migration owned this version, so that is taken as ` +
                  `meant; declare a field in \`state:\` to keep it.`,
              );
            }
            stateObj[cellId] = deepMerge(declared, migrated);
          } else {
            stateObj[cellId] = migrated;
          }
          log.info(`migrate: ${cellId} v${persisted} → v${info.version}`);
          report.push({
            cell: cellId,
            from: persisted,
            to: info.version,
            outcome: "migrated",
          });
        } catch (e) {
          // REFUSE TO BOOT. This used to reset the cell to `initialState` and
          // carry on — and ~5ms later the debounced persist wrote that empty
          // slice over the stored data and stamped the new version, so a FIXED
          // build found nothing left to migrate. The data the hook failed on is
          // still on disk right now; the only way to keep it that way is to
          // write nothing at all.
          throw createAioError(
            "PERSIST_SCHEMA",
            new Error(
              `migrate: ${cellId} onMigrate (v${persisted} → v${info.version}) ` +
                `threw — refusing to boot: ${e}\n` +
                `NOTHING was written: the stored v${persisted} data is intact ` +
                `on disk, and a build with a fixed onMigrate will migrate it. ` +
                `(Booting on defaults would have persisted an empty ` +
                `"${cellId}" over it within the debounce window.) Fix the ` +
                `hook, or take a backup and clear the cell's stored slice to ` +
                `start clean.`,
            ),
            { cellName: cellId },
          );
        }
      } else if (cellState && !info.onMigrate) {
        // `persisted === 0` means NEVER STAMPED, not "version zero". The shape
        // on disk is the shape this build writes; nothing migrated, and there
        // is nothing a hook could have done. Warning here fired once per cell
        // on the first boot after an app adopts `version:` — twenty lines of
        // "may be stale" about data that is not, which is how the real warning
        // (a version GAP with no hook) gets skipped.
        const firstStamp = persisted === 0;
        if (firstStamp) {
          log.info(
            `migrate: stamping ${cellId} at version ${info.version} — first ` +
              `time this cell declares one, so there is no older shape to ` +
              `convert`,
          );
        } else {
          log.warn(
            `migrate: ${cellId} version ${persisted} → ${info.version} but no onMigrate hook — state may be stale`,
          );
        }
        report.push({
          cell: cellId,
          from: persisted,
          to: info.version,
          outcome: firstStamp ? "stamped" : "stale",
        });
      }
    }
  }
  return report;
}

/** One teachable line summarizing all shape drift found at boot.
 *  Seed erasure is reported separately — same detector, different remedy. */
export function shapeDriftSummary(drift: ShapeDriftEntry[]): string {
  const erased = drift.filter((d) => d.issue === "seed-erased");
  const structural = drift.filter((d) => d.issue !== "seed-erased");
  const lines: string[] = [];
  if (erased.length > 0) {
    const show = erased.slice(0, 5).map((d) =>
      `${
        d.path ? `${d.cell}.${d.path}` : d.cell
      } (${d.declaredCount} declared ` +
      `→ stored empty)`
    );
    const more = erased.length > show.length
      ? ` …and ${erased.length - show.length} more`
      : "";
    lines.push(
      `restore erased seeded data: ${erased.length} declared list(s) were ` +
        `replaced by an empty stored value — ${show.join(", ")}${more}. ` +
        `A persisted array replaces the declared one wholesale, so whatever ` +
        `\`state:\` seeded is gone. If the list is a fixed seed, keep it out ` +
        `of persistence (\`persist: { exclude: [...] }\`); if it is a cache ` +
        `that may legitimately empty, this is expected; if it must be merged, ` +
        `bump the cell version and re-seed it in \`onMigrate\`.`,
    );
  }
  if (structural.length === 0) return lines.join("\n");
  drift = structural;
  const show = drift.slice(0, 5).map((d) => {
    const where = d.path ? `${d.cell}.${d.path}` : d.cell;
    if (d.issue === "unknown-cell") {
      return `${where} (stored, no longer declared)`;
    }
    if (d.issue === "type-changed") {
      return `${where} (${d.storedType}≠declared ${d.declaredType})`;
    }
    return `${where} (${d.storedType}, not in initialState)`;
  });
  const more = drift.length > show.length
    ? ` …and ${drift.length - show.length} more`
    : "";
  lines.push(
    `shape drift: ${drift.length} stored field(s) no longer match the ` +
      `declared shape — ${show.join(", ")}${more}. ` +
      // This used to say the stale value stays on disk ("persistence
      // preserves it"). Measured: it does not. Restore drops an undeclared
      // field from live state and puts the DECLARED default back over a
      // changed type, and the first write after boot — which happens on boot,
      // before any method runs — stores exactly that. A warning promising the
      // data was safe is how the one copy of it was lost without anyone
      // looking.
      (drift.some((d) => d.issue !== "unknown-cell")
        ? `Those stored fields are NOT restored — live state drops an ` +
          `undeclared field and takes the declared default for a changed ` +
          `type — and the next write replaces them on disk too, so they are ` +
          `gone after this boot. If the app still writes the field, declare ` +
          `it in \`state:\` (or declare the object as \`{}\`, an open ` +
          `record). If it was renamed, bump the cell's version + add ` +
          `onMigrate to carry it over, before this build writes.`
        : "") +
      (drift.some((d) => d.issue === "unknown-cell")
        ? `${
          drift.some((d) => d.issue !== "unknown-cell") ? " " : ""
        }A stored cell no longer declared is kept on disk verbatim, but is ` +
          `not in live state — declare the cell again, or clear its data.`
        : ""),
  );
  return lines.join("\n");
}
